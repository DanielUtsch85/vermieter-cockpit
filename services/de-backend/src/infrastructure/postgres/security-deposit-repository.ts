import { sql, type Kysely, type Transaction } from 'kysely';
import {
  planAmend,
  planVoid,
  type AmendDepositOutcome,
  type CreateDepositOutcome,
  type CreatePrecheck,
  type DepositChanges,
  type DepositFilter,
  type DepositPage,
  type DepositRefusal,
  type DepositRequest,
  type DepositStatus,
  type ExpectedAmountSource,
  type NewDeposit,
  type SecurityDeposit,
  type SecurityDepositId,
  type SecurityDepositRepository,
  type VoidDepositOutcome,
} from '../../domains/security-deposit/index.js';
import { checkVersion, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'SecurityDeposit';
const CREATE_SCOPE = 'security-deposit.create';

/** Every column, the amount as text (exact). */
const COLUMNS = [
  'id',
  'mre_realm_id',
  'status',
  'mre_tenant_id',
  sql<string>`expected_amount::text`.as('expected_amount'),
  'currency',
  'expected_amount_source',
  'holding_financial_account_id',
  'interest_bearing',
  'notes',
  'voided_at',
  'void_reason',
  'created_at',
  'version',
] as const;

interface DepositRow {
  id: string;
  mre_realm_id: string;
  status: string;
  mre_tenant_id: string;
  expected_amount: string;
  currency: string;
  expected_amount_source: string;
  holding_financial_account_id: string | null;
  interest_bearing: boolean;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  version: number;
}

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateDepositOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the SecurityDeposit port (api-design.md §47.1). */
export class PostgresSecurityDepositRepository implements SecurityDepositRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createPrecheck(request: DepositRequest, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreatePrecheck> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx): Promise<CreatePrecheck> => {
        if (idempotency !== undefined) {
          const existing = await trx
            .selectFrom('idempotency_key')
            .select(['request_fingerprint', 'result'])
            .where('mre_realm_id', '=', request.mreRealmId)
            .where('scope', '=', CREATE_SCOPE)
            .where('key', '=', idempotency.key)
            .executeTakeFirst();
          // A key claimed but not yet recorded belongs to a request still running: create decides.
          if (existing !== undefined && existing.request_fingerprint !== idempotency.fingerprint) return { kind: 'IDEMPOTENCY_CONFLICT' };
          if (existing?.result != null) return { kind: 'REPLAYED', deposit: fromSnapshot(existing.result) };
        }
        const refusal = await accountRefusalOf(trx, request.mreRealmId, request.holdingFinancialAccountId, false);
        if (refusal !== undefined) return refusal;
        const existing = await activeDepositOf(trx, request.mreRealmId, request.mreTenantId);
        return existing === undefined ? { kind: 'PROCEED' } : { kind: 'DEPOSIT_EXISTS', securityDepositId: existing };
      });
  }

  async create(deposit: NewDeposit, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateDepositOutcome> {
    try {
      // READ COMMITTED explicitly: the idempotency claim and the re-reads after the locks rely on it.
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateDepositOutcome> => {
          const keyed =
            idempotency === undefined
              ? undefined
              : { ref: { mreRealmId: deposit.mreRealmId, scope: CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
          if (keyed !== undefined) {
            const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', deposit: fromSnapshot(claim.result) };
          }
          // Check 2 again, the holding account FOR SHARE (its type cannot change meanwhile).
          const refusal = await accountRefusalOf(trx, deposit.mreRealmId, deposit.holdingFinancialAccountId, true);
          if (refusal !== undefined) throw new Rejected(refusal);
          // Check 3 is the partial unique index alone: an insert waits on a concurrent void of the Tenant's deposit and
          // succeeds once it commits (§47.1), where a read of the committed row would refuse too early.
          const inserted = await trx
            .insertInto('security_deposit')
            .values({
              mre_realm_id: deposit.mreRealmId,
              status: 'ACTIVE' satisfies DepositStatus,
              mre_tenant_id: deposit.mreTenantId,
              expected_amount: toNumericAmount(deposit.expectedAmount),
              currency: deposit.expectedAmount.currency,
              expected_amount_source: deposit.expectedAmountSource,
              holding_financial_account_id: deposit.holdingFinancialAccountId,
              interest_bearing: deposit.interestBearing,
              notes: deposit.notes,
              created_by: actor.actorId,
            })
            .onConflict((oc) => oc.columns(['mre_realm_id', 'mre_tenant_id']).where('status', '<>', 'VOID').doNothing())
            .returning('id')
            .executeTakeFirst();
          if (inserted === undefined) {
            const existing = await activeDepositOf(trx, deposit.mreRealmId, deposit.mreTenantId);
            throw new Rejected({ kind: 'DEPOSIT_EXISTS', securityDepositId: existing ?? '' });
          }
          const created = await readOne(trx, inserted.id);
          if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, inserted.id, toSnapshot(created));
          await writeAudit(trx, { type: ENTITY_TYPE, id: inserted.id }, 'CREATED', actor, {
            newVersion: created.version,
            metadata: {
              mreTenantId: created.mreTenantId,
              expectedAmount: created.expectedAmount.toJSON(),
              expectedAmountSource: created.expectedAmountSource,
              holdingFinancialAccountId: created.holdingFinancialAccountId,
              interestBearing: created.interestBearing,
            },
          });
          return { kind: 'CREATED', deposit: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async findById(id: string, mreRealmId: string): Promise<SecurityDeposit | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.selectFrom('security_deposit').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
    return row === undefined ? undefined : toDeposit(row);
  }

  async list(mreRealmId: string, filter: DepositFilter, page: { readonly page: number; readonly pageSize: number }): Promise<DepositPage> {
    // Count and page in one snapshot, so `total` and `items` agree.
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const filtered = () => {
          let query = trx.selectFrom('security_deposit').where('mre_realm_id', '=', mreRealmId);
          if (filter.statuses !== undefined && filter.statuses.length > 0) query = query.where('status', 'in', [...filter.statuses]);
          if (filter.mreTenantId !== undefined) query = query.where('mre_tenant_id', '=', filter.mreTenantId);
          const account = filter.holdingFinancialAccountId;
          // A malformed account id matches nothing, as an unknown one (§30.1: a read filter, never 404).
          if (account !== undefined) query = UUID.test(account) ? query.where('holding_financial_account_id', '=', account) : query.where(sql<boolean>`false`);
          return query;
        };
        const { n } = await filtered()
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        const rows = await filtered()
          .select(COLUMNS)
          .orderBy('created_at', 'desc')
          .orderBy('id')
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize)
          .execute();
        return { items: rows.map(toDeposit), page: page.page, pageSize: page.pageSize, total: Number(n) };
      });
  }

  async amend(id: string, mreRealmId: string, changes: DepositChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendDepositOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<AmendDepositOutcome> => {
        // Account → deposit: a newly named account FOR SHARE first, as the holding-account guard reads it.
        const named = changes.holdingFinancialAccountId ?? null;
        const account = named === null ? undefined : await accountOf(trx, named, mreRealmId, true);
        const row = await trx
          .selectFrom('security_deposit')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toDeposit(row);
        const plan = planAmend(current, changes);
        if (plan.kind === 'UNCHANGED') return { kind: 'AMENDED', deposit: current, changed: false };
        if (plan.kind !== 'AMEND') return plan;
        if (plan.newHoldingAccountId !== null) {
          if (account === undefined) return { kind: 'ACCOUNT_NOT_FOUND', financialAccountId: plan.newHoldingAccountId };
          if (account.accountType !== 'SECURITY_DEPOSIT') {
            return { kind: 'NOT_A_SECURITY_DEPOSIT_ACCOUNT', financialAccountId: plan.newHoldingAccountId, accountType: account.accountType };
          }
        }
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('security_deposit')
          .set((eb) => ({
            expected_amount: toNumericAmount(plan.values.expectedAmount),
            // An amended amount is the user's, whatever it was on create.
            expected_amount_source: (plan.changed.includes('expectedAmount') ? 'REQUEST' : current.expectedAmountSource) satisfies ExpectedAmountSource,
            holding_financial_account_id: plan.values.holdingFinancialAccountId,
            interest_bearing: plan.values.interestBearing,
            notes: plan.values.notes,
            version: eb('version', '+', 1),
            updated_at: new Date(),
          }))
          .where('id', '=', id)
          .execute();
        const amended = await readOne(trx, id);
        const json = (field: (typeof plan.changed)[number], d: SecurityDeposit) => (field === 'expectedAmount' ? d.expectedAmount.toJSON() : d[field]);
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'AMENDED', actor, {
          previousVersion: current.version,
          newVersion: amended.version,
          metadata: { changes: Object.fromEntries(plan.changed.map((field) => [field, { from: json(field, current), to: json(field, amended) }])) },
        });
        return { kind: 'AMENDED', deposit: amended, changed: true };
      });
  }

  async void(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidDepositOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<VoidDepositOutcome> => {
        const row = await trx
          .selectFrom('security_deposit')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toDeposit(row);
        // Splits naming the deposit come with VC-5-02 (P5-D3); until then none can.
        const plan = planVoid(current, reason, at, []);
        if (plan.kind === 'UNCHANGED') return { kind: 'VOIDED', deposit: current, changed: false };
        if (plan.kind !== 'VOID') return plan;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('security_deposit')
          .set({ status: plan.next.status, voided_at: at, voided_by: actor.actorId, void_reason: reason, version: plan.next.version, updated_at: at })
          .where('id', '=', id)
          .execute();
        const voided = await readOne(trx, id);
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'VOIDED', actor, {
          previousVersion: current.version,
          newVersion: voided.version,
          metadata: { reason },
        });
        return { kind: 'VOIDED', deposit: voided, changed: true };
      });
  }
}

/** §47.1 check 2: the holding account, if one is named. */
async function accountRefusalOf(
  trx: Transaction<Database>,
  mreRealmId: string,
  holdingFinancialAccountId: string | null,
  lock: boolean,
): Promise<DepositRefusal | undefined> {
  if (holdingFinancialAccountId === null) return undefined;
  const account = await accountOf(trx, holdingFinancialAccountId, mreRealmId, lock);
  if (account === undefined) return { kind: 'ACCOUNT_NOT_FOUND', financialAccountId: holdingFinancialAccountId };
  if (account.accountType !== 'SECURITY_DEPOSIT') {
    return { kind: 'NOT_A_SECURITY_DEPOSIT_ACCOUNT', financialAccountId: holdingFinancialAccountId, accountType: account.accountType };
  }
  return undefined;
}

/** The account of the Realm with its type, `FOR SHARE` when the caller writes; undefined for unknown or foreign. */
async function accountOf(trx: Transaction<Database>, id: string, mreRealmId: string, lock: boolean): Promise<{ readonly accountType: string } | undefined> {
  if (!UUID.test(id)) return undefined;
  const query = trx.selectFrom('financial_account').select('account_type').where('id', '=', id).where('mre_realm_id', '=', mreRealmId);
  const row = await (lock ? query.forShare() : query).executeTakeFirst();
  return row === undefined ? undefined : { accountType: row.account_type };
}

async function activeDepositOf(trx: Transaction<Database>, mreRealmId: string, mreTenantId: string): Promise<string | undefined> {
  const row = await trx
    .selectFrom('security_deposit')
    .select('id')
    .where('mre_realm_id', '=', mreRealmId)
    .where('mre_tenant_id', '=', mreTenantId)
    .where('status', '<>', 'VOID')
    .executeTakeFirst();
  return row?.id;
}

async function readOne(trx: Transaction<Database>, id: string): Promise<SecurityDeposit> {
  return toDeposit(await trx.selectFrom('security_deposit').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

function toDeposit(row: DepositRow): SecurityDeposit {
  return {
    id: row.id as SecurityDepositId,
    mreRealmId: row.mre_realm_id,
    status: row.status as DepositStatus,
    mreTenantId: row.mre_tenant_id,
    expectedAmount: fromNumericAmount(row.expected_amount, row.currency),
    expectedAmountSource: row.expected_amount_source as ExpectedAmountSource,
    holdingFinancialAccountId: row.holding_financial_account_id,
    interestBearing: row.interest_bearing,
    notes: row.notes,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created deposit as JSON for the idempotency store: Money as `{ amount, currency }`, timestamps ISO. */
interface DepositSnapshot extends Omit<SecurityDeposit, 'expectedAmount' | 'createdAt' | 'voidedAt'> {
  readonly expectedAmount: { readonly amount: string; readonly currency: string };
  readonly createdAt: string;
  readonly voidedAt: string | null;
}

function toSnapshot(deposit: SecurityDeposit): DepositSnapshot {
  return {
    ...deposit,
    expectedAmount: { amount: deposit.expectedAmount.amount, currency: deposit.expectedAmount.currency },
    createdAt: deposit.createdAt.toISOString(),
    voidedAt: deposit.voidedAt?.toISOString() ?? null,
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): SecurityDeposit {
  const s = result as DepositSnapshot;
  return {
    ...s,
    expectedAmount: fromNumericAmount(s.expectedAmount.amount, s.expectedAmount.currency),
    createdAt: new Date(s.createdAt),
    voidedAt: s.voidedAt === null ? null : new Date(s.voidedAt),
  };
}

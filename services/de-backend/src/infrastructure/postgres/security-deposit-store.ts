import { sql, type Kysely, type Transaction } from 'kysely';
import {
  deriveFigures,
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
  type DepositView,
  type ExpectedAmountSource,
  type NewDeposit,
  type SecurityDeposit,
  type VoidDepositOutcome,
} from '../../domains/security-deposit/index.js';
import { checkVersion, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { COLUMNS, ENTITY_TYPE, UUID, countedCashOf, fromSnapshot, readOne, toDeposit, toSnapshot, viewsOf } from './security-deposit-rows.js';

/** The SecurityDeposit record (api-design.md §47.1–§47.3): the precheck, create, find, list, amend and void. */

const CREATE_SCOPE = 'security-deposit.create';

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateDepositOutcome) {
    super(outcome.kind);
  }
}

export async function createPrecheck(
  db: Kysely<Database>,
  request: DepositRequest,
  idempotency?: { readonly key: string; readonly fingerprint: string },
): Promise<CreatePrecheck> {
  return db
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
        if (existing?.result != null) return { kind: 'REPLAYED', deposit: asCreated(fromSnapshot(existing.result)) };
      }
      const refusal = await accountRefusalOf(trx, request.mreRealmId, request.holdingFinancialAccountId, false);
      if (refusal !== undefined) return refusal;
      const existing = await activeDepositOf(trx, request.mreRealmId, request.mreTenantId);
      return existing === undefined ? { kind: 'PROCEED' } : { kind: 'DEPOSIT_EXISTS', securityDepositId: existing };
    });
}

export async function create(
  db: Kysely<Database>,
  deposit: NewDeposit,
  actor: AuditActor,
  idempotency?: { readonly key: string; readonly fingerprint: string },
): Promise<CreateDepositOutcome> {
  try {
    // READ COMMITTED explicitly: the idempotency claim and the re-reads after the locks rely on it.
    return await db
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
          if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', deposit: asCreated(fromSnapshot(claim.result)) };
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
        return { kind: 'CREATED', deposit: asCreated(created) };
      });
  } catch (error) {
    if (error instanceof Rejected) return error.outcome;
    throw error;
  }
}

export async function findById(db: Kysely<Database>, id: string, mreRealmId: string): Promise<DepositView | undefined> {
  if (!UUID.test(id)) return undefined;
  // The record and its cash in one snapshot (§47.3).
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const row = await trx.selectFrom('security_deposit').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
      if (row === undefined) return undefined;
      const deposit = toDeposit(row);
      const cash = (await countedCashOf(trx, [deposit.id])).get(deposit.id) ?? [];
      return { ...deposit, figures: deriveFigures(deposit, cash), cash };
    });
}

export async function list(
  db: Kysely<Database>,
  mreRealmId: string,
  filter: DepositFilter,
  page: { readonly page: number; readonly pageSize: number },
): Promise<DepositPage> {
  // Count and page in one snapshot, so `total` and `items` agree.
  return db
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
      const ordered = () => filtered().select(COLUMNS).orderBy('created_at', 'desc').orderBy('id');
      const offset = (page.page - 1) * page.pageSize;
      if (filter.states === undefined || filter.states.length === 0) {
        const { n } = await filtered()
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        const rows = (await ordered().limit(page.pageSize).offset(offset).execute()).map(toDeposit);
        return { items: await viewsOf(trx, rows), page: page.page, pageSize: page.pageSize, total: Number(n) };
      }
      // The state is derived (§47.3): every deposit the other filters leave, then the state, then the page. A Realm
      // holds one deposit per lease, so this stays small.
      const states = new Set(filter.states);
      const matching = (await viewsOf(trx, (await ordered().execute()).map(toDeposit))).filter((d) => states.has(d.figures.state));
      return { items: matching.slice(offset, offset + page.pageSize), page: page.page, pageSize: page.pageSize, total: matching.length };
    });
}

export async function amend(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  changes: DepositChanges,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<AmendDepositOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
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
      if (plan.kind === 'UNCHANGED') return { kind: 'AMENDED', deposit: (await viewsOf(trx, [current]))[0] as DepositView, changed: false };
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
      return { kind: 'AMENDED', deposit: (await viewsOf(trx, [amended]))[0] as DepositView, changed: true };
    });
}

export async function voidDeposit(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  reason: string,
  at: Date,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<VoidDepositOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
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
      // §47.2: every split naming it, a reversal's included, read after the deposit's lock; a split write locks the
      // deposit too (P5-D9), so none can appear meanwhile. security_deposit_void_unreferenced is the backstop.
      const referencing = await trx.selectFrom('transaction_split').select('transaction_id').where('security_deposit_id', '=', id).execute();
      const plan = planVoid(
        current,
        reason,
        at,
        referencing.map((r) => r.transaction_id),
      );
      if (plan.kind === 'UNCHANGED') return { kind: 'VOIDED', deposit: (await viewsOf(trx, [current]))[0] as DepositView, changed: false };
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
      return { kind: 'VOIDED', deposit: (await viewsOf(trx, [voided]))[0] as DepositView, changed: true };
    });
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

/** A new deposit has no cash yet: zeros, `EXPECTED`, no flags; a replay answers it as created. */
function asCreated(deposit: SecurityDeposit): DepositView {
  return { ...deposit, figures: deriveFigures(deposit, []) };
}

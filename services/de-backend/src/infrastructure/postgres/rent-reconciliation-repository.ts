import { sql, type Kysely, type Transaction } from 'kysely';
import {
  RENT_CATEGORIES,
  checkMatch,
  planRelease,
  type CreateMatchOutcome,
  type MatchCash,
  type MreWriteBackState,
  type NewMatch,
  type PrecheckOutcome,
  type ReconciliationFilter,
  type ReconciliationPage,
  type ReconciliationStatus,
  type ReleaseOutcome,
  type RentPaymentReconciliation,
  type RentPaymentReconciliationId,
  type RentReconciliationRepository,
  type TransactionRentSide,
} from '../../domains/rent-reconciliation/index.js';
import { checkVersion, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'RentPaymentReconciliation';
const CREATE_SCOPE = 'rent-reconciliation.create';

/** Every column, the amount as text (exact). */
const COLUMNS = [
  'id',
  'mre_realm_id',
  'status',
  'transaction_id',
  'mre_tenant_id',
  'mre_rent_term',
  sql<string>`matched_amount::text`.as('matched_amount'),
  'currency',
  'confidence',
  'suggestion_reason',
  'confirmed_at',
  'confirmed_by',
  'released_at',
  'released_by',
  'release_reason',
  'notes',
  'mre_write_back_state',
  'created_at',
  'version',
] as const;

interface ReconciliationRow {
  id: string;
  mre_realm_id: string;
  status: string;
  transaction_id: string;
  mre_tenant_id: string;
  mre_rent_term: string;
  matched_amount: string;
  currency: string;
  confidence: string | null;
  suggestion_reason: string | null;
  confirmed_at: Date | null;
  confirmed_by: string | null;
  released_at: Date | null;
  released_by: string | null;
  release_reason: string | null;
  notes: string | null;
  mre_write_back_state: string;
  created_at: Date;
  version: number;
}

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateMatchOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of api-design.md §37.1. */
export class PostgresRentReconciliationRepository implements RentReconciliationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async precheck(match: NewMatch, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<PrecheckOutcome> {
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx): Promise<PrecheckOutcome> => {
      if (idempotency !== undefined) {
        const existing = await trx
          .selectFrom('idempotency_key')
          .select(['request_fingerprint', 'result'])
          .where('mre_realm_id', '=', match.mreRealmId)
          .where('scope', '=', CREATE_SCOPE)
          .where('key', '=', idempotency.key)
          .executeTakeFirst();
        // A key claimed but not yet recorded belongs to a request still running: create decides.
        if (existing !== undefined && existing.request_fingerprint !== idempotency.fingerprint) return { kind: 'IDEMPOTENCY_CONFLICT' };
        if (existing?.result != null) return { kind: 'REPLAYED', reconciliation: fromSnapshot(existing.result) };
      }
      const refusal = checkMatch(await cashOf(trx, match.transactionId, match.mreRealmId, false), match);
      return refusal ?? { kind: 'PROCEED' };
    });
  }

  async create(match: NewMatch, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateMatchOutcome> {
    try {
      // READ COMMITTED explicitly: the idempotency claim and the re-reads after the Transaction lock rely on it.
      return await this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<CreateMatchOutcome> => {
        const ref = { mreRealmId: match.mreRealmId, scope: CREATE_SCOPE, key: idempotency?.key ?? '' };
        if (idempotency !== undefined) {
          const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
          if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
          if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', reconciliation: fromSnapshot(claim.result) };
        }
        // P4-D8: the Transaction row first; checks 2–7 again under it (MRE was read outside any transaction).
        const refusal = checkMatch(await cashOf(trx, match.transactionId, match.mreRealmId, true), match);
        if (refusal !== undefined) throw new Rejected(refusal);
        const at = new Date();
        // The partial unique index is the arbiter for the same match: a lost insert yields no row and is re-read.
        const inserted = await trx
          .insertInto('rent_payment_reconciliation')
          .values({
            mre_realm_id: match.mreRealmId,
            status: 'CONFIRMED' satisfies ReconciliationStatus,
            transaction_id: match.transactionId,
            mre_tenant_id: match.mreTenantId,
            mre_rent_term: match.mreRentTerm,
            matched_amount: toNumericAmount(match.matchedAmount),
            currency: match.matchedAmount.currency,
            confirmed_at: at,
            confirmed_by: actor.actorId,
            notes: match.notes,
            created_by: actor.actorId,
          })
          .onConflict((oc) => oc.columns(['transaction_id', 'mre_tenant_id', 'mre_rent_term']).where('status', '=', 'CONFIRMED').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (inserted === undefined) {
          const winner = await trx
            .selectFrom('rent_payment_reconciliation')
            .select('id')
            .where('transaction_id', '=', match.transactionId)
            .where('mre_tenant_id', '=', match.mreTenantId)
            .where('mre_rent_term', '=', match.mreRentTerm)
            .where('status', '=', 'CONFIRMED')
            .executeTakeFirstOrThrow();
          throw new Rejected({ kind: 'ALREADY_MATCHED', reconciliationId: winner.id });
        }
        const created = await readIn(trx, inserted.id);
        if (idempotency !== undefined) await recordIdempotentResult(trx, ref, created.id, toSnapshot(created));
        await writeAudit(trx, { type: ENTITY_TYPE, id: created.id }, 'CONFIRMED', actor, {
          newVersion: 1,
          metadata: {
            transactionId: created.transactionId,
            mreTenantId: created.mreTenantId,
            mreRentTerm: created.mreRentTerm,
            matchedAmount: created.matchedAmount.toJSON(),
            manual: true,
          },
        });
        return { kind: 'CREATED', reconciliation: created };
      });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async termSide(mreRealmId: string, mreTenantId: string, mreRentTerm: string): Promise<readonly RentPaymentReconciliation[]> {
    const rows = await this.db
      .selectFrom('rent_payment_reconciliation')
      .select(COLUMNS)
      .where('mre_realm_id', '=', mreRealmId)
      .where('mre_tenant_id', '=', mreTenantId)
      .where('mre_rent_term', '=', mreRentTerm)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toReconciliation);
  }

  async transactionSide(transactionId: string, mreRealmId: string): Promise<TransactionRentSide | undefined> {
    if (!UUID.test(transactionId)) return undefined;
    // The cash view and the reconciliations in one snapshot, so `available` agrees with the list.
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const cash = await cashOf(trx, transactionId, mreRealmId, false);
      if (cash === undefined) return undefined;
      const rows = await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('transaction_id', '=', transactionId).orderBy('created_at').orderBy('id').execute();
      return {
        transactionId,
        status: cash.status,
        direction: cash.direction,
        correctionRole: cash.correctionRole,
        rentCash: cash.rentCash,
        reconciliations: rows.map(toReconciliation),
      };
    });
  }

  async findById(id: string, mreRealmId: string): Promise<RentPaymentReconciliation | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
    return row === undefined ? undefined : toReconciliation(row);
  }

  async list(mreRealmId: string, filter: ReconciliationFilter, page: { readonly page: number; readonly pageSize: number }): Promise<ReconciliationPage> {
    // Count and page in one snapshot, so `total` and `items` agree.
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const filtered = () => {
        let query = trx.selectFrom('rent_payment_reconciliation').where('mre_realm_id', '=', mreRealmId);
        if (filter.status !== undefined) query = query.where('status', 'in', filter.status);
        // An unknown or foreign Transaction is an empty page, not 404 (a read filter, §30.1).
        if (filter.transactionId !== undefined) query = query.where('transaction_id', '=', filter.transactionId);
        if (filter.mreTenantId !== undefined) query = query.where('mre_tenant_id', '=', filter.mreTenantId);
        if (filter.mreRentTerm !== undefined) query = query.where('mre_rent_term', '=', filter.mreRentTerm);
        return query;
      };
      const { n } = await filtered()
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const rows = await filtered()
        .select(COLUMNS)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(page.pageSize)
        .offset((page.page - 1) * page.pageSize)
        .execute();
      return { items: rows.map(toReconciliation), page: page.page, pageSize: page.pageSize, total: Number(n) };
    });
  }

  async release(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ReleaseOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<ReleaseOutcome> => {
      const named = await trx.selectFrom('rent_payment_reconciliation').select('transaction_id').where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
      if (named === undefined) return { kind: 'NOT_FOUND' };
      // P4-D8: the Transaction row first, then the reconciliation; a release and a create on it serialise.
      await lockTransaction(trx, named.transaction_id, mreRealmId);
      const current = toReconciliation(await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).forUpdate().executeTakeFirstOrThrow());
      const plan = planRelease(current, reason, at, actor);
      if (plan.kind === 'UNCHANGED') return { kind: 'RELEASED', reconciliation: current, changed: false };
      if (plan.kind !== 'RELEASE') return plan;
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      await trx
        .updateTable('rent_payment_reconciliation')
        .set({ status: 'RELEASED', released_at: at, released_by: actor.actorId, release_reason: reason, version: plan.next.version, updated_at: at })
        .where('id', '=', id)
        .execute();
      const released = await readIn(trx, id);
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'RELEASED', actor, {
        previousVersion: current.version,
        newVersion: released.version,
        metadata: { transactionId: released.transactionId, reason, matchedAmount: released.matchedAmount.toJSON() },
      });
      return { kind: 'RELEASED', reconciliation: released, changed: true };
    });
  }
}

/**
 * P3-D8's no-op write of the Transaction row (0013 allows it on a confirmed row): it serialises every confirm and
 * release on the Transaction, and a stale one fails under REPEATABLE READ.
 */
async function lockTransaction(trx: Transaction<Database>, transactionId: string, mreRealmId: string) {
  return trx
    .updateTable('ledger_transaction')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', transactionId)
    .where('mre_realm_id', '=', mreRealmId)
    .returning(['status', 'direction', 'correction_role'])
    .executeTakeFirst();
}

/** The cash rules' view of a Transaction of the Realm (P4-D3); `lock` takes the Transaction row first. */
async function cashOf(trx: Transaction<Database>, transactionId: string, mreRealmId: string, lock: boolean): Promise<MatchCash | undefined> {
  if (!UUID.test(transactionId)) return undefined;
  const tx = lock
    ? await lockTransaction(trx, transactionId, mreRealmId)
    : await trx.selectFrom('ledger_transaction').select(['status', 'direction', 'correction_role']).where('id', '=', transactionId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
  if (tx === undefined) return undefined;
  // New statements after the lock: under READ COMMITTED they see every confirm that committed before it.
  const rent = await trx
    .selectFrom('transaction_split as s')
    .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
    .select([sql<string | null>`sum(s.amount)::text`.as('total'), sql<string | null>`min(s.currency)`.as('currency')])
    .where('s.transaction_id', '=', transactionId)
    .where('c.code', 'in', RENT_CATEGORIES)
    .executeTakeFirstOrThrow();
  const confirmed = await trx
    .selectFrom('rent_payment_reconciliation')
    .select(['id', 'mre_tenant_id', 'mre_rent_term', sql<string>`matched_amount::text`.as('matched_amount'), 'currency'])
    .where('transaction_id', '=', transactionId)
    .where('status', '=', 'CONFIRMED')
    .orderBy('id')
    .execute();
  return {
    status: tx.status,
    direction: tx.direction,
    correctionRole: tx.correction_role,
    rentCash: rent.total === null || rent.currency === null ? null : fromNumericAmount(rent.total, rent.currency),
    confirmed: confirmed.map((c) => ({ id: c.id, mreTenantId: c.mre_tenant_id, mreRentTerm: c.mre_rent_term, matchedAmount: fromNumericAmount(c.matched_amount, c.currency) })),
  };
}

async function readIn(trx: Transaction<Database>, id: string): Promise<RentPaymentReconciliation> {
  return toReconciliation(await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

function toReconciliation(row: ReconciliationRow): RentPaymentReconciliation {
  return {
    id: row.id as RentPaymentReconciliationId,
    mreRealmId: row.mre_realm_id,
    status: row.status as ReconciliationStatus,
    transactionId: row.transaction_id,
    mreTenantId: row.mre_tenant_id,
    mreRentTerm: row.mre_rent_term,
    matchedAmount: fromNumericAmount(row.matched_amount, row.currency),
    confidence: row.confidence,
    suggestionReason: row.suggestion_reason,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    releasedAt: row.released_at,
    releasedBy: row.released_by,
    releaseReason: row.release_reason,
    notes: row.notes,
    mreWriteBackState: row.mre_write_back_state as MreWriteBackState,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created reconciliation as JSON for the idempotency store. */
function toSnapshot(r: RentPaymentReconciliation): unknown {
  return {
    ...r,
    matchedAmount: r.matchedAmount.toJSON(),
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    releasedAt: r.releasedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): RentPaymentReconciliation {
  const r = result as Omit<RentPaymentReconciliation, 'matchedAmount' | 'confirmedAt' | 'releasedAt' | 'createdAt'> & {
    matchedAmount: { amount: string; currency: string };
    confirmedAt: string | null;
    releasedAt: string | null;
    createdAt: string;
  };
  return {
    ...r,
    matchedAmount: fromNumericAmount(r.matchedAmount.amount, r.matchedAmount.currency),
    confirmedAt: r.confirmedAt === null ? null : new Date(r.confirmedAt),
    releasedAt: r.releasedAt === null ? null : new Date(r.releasedAt),
    createdAt: new Date(r.createdAt),
  };
}

import { sql, type Transaction } from 'kysely';
import {
  RENT_CATEGORIES,
  type MrePaymentSnapshot,
  type WriteBackError,
  type MatchCash,
  type MreWriteBackState,
  type ReconciliationStatus,
  type RentPaymentReconciliation,
  type RentPaymentReconciliationId,
} from '../../domains/rent-reconciliation/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

/** The rent reconciliation rows (§37): columns, mapping, and the reads and locks every write shares. */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ENTITY_TYPE = 'RentPaymentReconciliation';

/** Every column, the amount as text (exact). */
export const COLUMNS = [
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
  'rejected_at',
  'rejected_by',
  'reject_reason',
  'notes',
  'mre_write_back_state',
  'mre_write_back_attempt_id',
  'mre_write_back_lease_until',
  'mre_written_back_at',
  'mre_written_back_by',
  'mre_payment',
  'mre_write_back_error',
  'mre_write_back_failed_at',
  'mre_last_lease_until',
  'mre_removed_at',
  'mre_removed_by',
  'created_at',
  'version',
] as const;

export interface ReconciliationRow {
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
  rejected_at: Date | null;
  rejected_by: string | null;
  reject_reason: string | null;
  notes: string | null;
  mre_write_back_state: string;
  mre_write_back_attempt_id: string | null;
  mre_write_back_lease_until: Date | null;
  mre_written_back_at: Date | null;
  mre_written_back_by: string | null;
  mre_payment: unknown;
  mre_write_back_error: string | null;
  mre_write_back_failed_at: Date | null;
  mre_last_lease_until: Date | null;
  mre_removed_at: Date | null;
  mre_removed_by: string | null;
  created_at: Date;
  version: number;
}

/** `mre_payment` as stored: DE's payment as MRE stores it, the amount as Money JSON. */
export interface PaymentColumn {
  date: string;
  amount: { amount: string; currency: string };
  type: string;
  reference: string;
}

/** The database's clock, the one the frozen trigger compares leases with. */
export async function databaseNow(trx: Transaction<Database>): Promise<Date> {
  return (await sql<{ now: Date }>`SELECT now() AS now`.execute(trx)).rows[0]?.now ?? new Date();
}

export function toPaymentColumn(payment: MrePaymentSnapshot): PaymentColumn {
  return { date: payment.date, amount: payment.amount.toJSON(), type: payment.type, reference: payment.reference };
}

export function fromPaymentColumn(value: unknown): MrePaymentSnapshot | null {
  if (value === null || value === undefined) return null;
  const p = value as PaymentColumn;
  return { date: p.date, amount: fromNumericAmount(p.amount.amount, p.amount.currency), type: p.type, reference: p.reference };
}

/** A confirm's cash refusal: the Transaction is known (the foreign key), so TRANSACTION_NOT_FOUND cannot occur. */
export function withTransaction<T extends { readonly kind: string }>(refusal: T): Exclude<T, { kind: 'TRANSACTION_NOT_FOUND' }> {
  if (refusal.kind === 'TRANSACTION_NOT_FOUND') throw new Error('a reconciliation names an unknown Transaction');
  return refusal as Exclude<T, { kind: 'TRANSACTION_NOT_FOUND' }>;
}

/**
 * P3-D8's no-op write of the Transaction row (0013 allows it on a confirmed row): it serialises every confirm and
 * release on the Transaction, and a stale one fails under REPEATABLE READ.
 */
export async function lockTransaction(trx: Transaction<Database>, transactionId: string, mreRealmId: string) {
  return trx
    .updateTable('ledger_transaction')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', transactionId)
    .where('mre_realm_id', '=', mreRealmId)
    .returning(['status', 'direction', 'correction_role'])
    .executeTakeFirst();
}

/** The cash rules' view of a Transaction of the Realm (P4-D3); `lock` takes the Transaction row first. */
export async function cashOf(trx: Transaction<Database>, transactionId: string, mreRealmId: string, lock: boolean): Promise<MatchCash | undefined> {
  if (!UUID.test(transactionId)) return undefined;
  const tx = lock
    ? await lockTransaction(trx, transactionId, mreRealmId)
    : await trx
        .selectFrom('ledger_transaction')
        .select(['status', 'direction', 'correction_role'])
        .where('id', '=', transactionId)
        .where('mre_realm_id', '=', mreRealmId)
        .executeTakeFirst();
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
    confirmed: confirmed.map((c) => ({
      id: c.id,
      mreTenantId: c.mre_tenant_id,
      mreRentTerm: c.mre_rent_term,
      matchedAmount: fromNumericAmount(c.matched_amount, c.currency),
    })),
  };
}

export async function readIn(trx: Transaction<Database>, id: string): Promise<RentPaymentReconciliation> {
  return toReconciliation(await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

export function toReconciliation(row: ReconciliationRow): RentPaymentReconciliation {
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
    rejectedAt: row.rejected_at,
    rejectedBy: row.rejected_by,
    rejectReason: row.reject_reason,
    notes: row.notes,
    mreWriteBackState: row.mre_write_back_state as MreWriteBackState,
    mreWriteBackAttemptId: row.mre_write_back_attempt_id,
    mreWriteBackLeaseUntil: row.mre_write_back_lease_until,
    mreWrittenBackAt: row.mre_written_back_at,
    mreWrittenBackBy: row.mre_written_back_by,
    mrePayment: fromPaymentColumn(row.mre_payment),
    mreWriteBackError: row.mre_write_back_error as WriteBackError | null,
    mreWriteBackFailedAt: row.mre_write_back_failed_at,
    mreLastLeaseUntil: row.mre_last_lease_until,
    mreRemovedAt: row.mre_removed_at,
    mreRemovedBy: row.mre_removed_by,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created reconciliation as JSON for the idempotency store. */
export function toSnapshot(r: RentPaymentReconciliation): unknown {
  return {
    ...r,
    matchedAmount: r.matchedAmount.toJSON(),
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    releasedAt: r.releasedAt?.toISOString() ?? null,
    rejectedAt: r.rejectedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    // A created reconciliation is NOT_WRITTEN: nothing of the write-back is stored with its replay.
    mreWriteBackAttemptId: null,
    mreWriteBackLeaseUntil: null,
    mreWrittenBackAt: null,
    mreWrittenBackBy: null,
    mrePayment: null,
    mreWriteBackError: null,
    mreWriteBackFailedAt: null,
    mreLastLeaseUntil: null,
    mreRemovedAt: null,
    mreRemovedBy: null,
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
export function fromSnapshot(result: unknown): RentPaymentReconciliation {
  const r = result as Omit<RentPaymentReconciliation, 'matchedAmount' | 'confirmedAt' | 'releasedAt' | 'rejectedAt' | 'createdAt'> & {
    rejectedAt?: string | null;
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
    rejectedAt: r.rejectedAt == null ? null : new Date(r.rejectedAt),
    rejectedBy: r.rejectedBy ?? null,
    rejectReason: r.rejectReason ?? null,
    mreWriteBackAttemptId: null,
    mreWriteBackLeaseUntil: null,
    mreWrittenBackAt: null,
    mreWrittenBackBy: null,
    mrePayment: null,
    mreWriteBackError: null,
    mreWriteBackFailedAt: null,
    mreLastLeaseUntil: null,
    mreRemovedAt: null,
    mreRemovedBy: null,
    createdAt: new Date(r.createdAt),
  };
}

import { sql, type Transaction } from 'kysely';
import {
  cashKindOf,
  deriveFigures,
  type CountedCash,
  type DepositClosingReason,
  type DepositStatus,
  type DepositView,
  type ExpectedAmountSource,
  type SecurityDeposit,
  type SecurityDepositId,
} from '../../domains/security-deposit/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

/**
 * The SecurityDeposit rows (api-design.md §47.1–§47.4): columns, mapping, the idempotency snapshot, §47.3's counted cash
 * and the figures, and the deposit locks of a split write (P5-D9).
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ENTITY_TYPE = 'SecurityDeposit';

/** Every column, the amount as text (exact). */
export const COLUMNS = [
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
  sql<string | null>`to_char(closing_date, 'YYYY-MM-DD')`.as('closing_date'),
  'closing_reason',
  'closing_note',
  sql<string | null>`held_at_closing::text`.as('held_at_closing'),
  'created_at',
  'version',
] as const;

export interface DepositRow {
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
  closing_date: string | null;
  closing_reason: string | null;
  closing_note: string | null;
  held_at_closing: string | null;
  created_at: Date;
  version: number;
}

/**
 * The deposits a split write names, locked `FOR UPDATE` in id order after the Transaction and its Loans (P5-D9), with
 * their status; unknown, foreign and malformed ids are left out (§47.2's 404).
 */
export async function lockDepositsOf(trx: Transaction<Database>, mreRealmId: string, depositIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(depositIds)].filter((id) => UUID.test(id)).sort();
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('security_deposit')
    .select(['id', 'status'])
    .where('id', 'in', ids)
    .where('mre_realm_id', '=', mreRealmId)
    .orderBy('id')
    .forUpdate()
    .execute();
  return new Map(rows.map((r) => [r.id, r.status]));
}

/** The deposits with their figures, from one read of their counted cash. */
export async function viewsOf(trx: Transaction<Database>, deposits: readonly SecurityDeposit[]): Promise<DepositView[]> {
  const cash = await countedCashOf(
    trx,
    deposits.map((d) => d.id),
  );
  return deposits.map((d) => ({ ...d, figures: deriveFigures(d, cash.get(d.id) ?? []) }));
}

/**
 * §47.3's cash that counts, per deposit: its splits on current Transactions (`CONFIRMED`, `RECONCILED`, not a
 * reversal), in booking-date order, then Transaction id and position.
 */
export async function countedCashOf(trx: Transaction<Database>, depositIds: readonly string[]): Promise<Map<string, CountedCash[]>> {
  const out = new Map<string, CountedCash[]>();
  if (depositIds.length === 0) return out;
  const rows = await trx
    .selectFrom('transaction_split as s')
    .innerJoin('ledger_transaction as t', 't.id', 's.transaction_id')
    .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
    .select([
      's.security_deposit_id',
      's.amount',
      's.currency',
      'c.code',
      't.id as transaction_id',
      't.direction',
      't.financial_account_id',
      sql<string>`to_char(t.booking_date, 'YYYY-MM-DD')`.as('booking_date'),
    ])
    .where('s.security_deposit_id', 'in', [...depositIds])
    .where('t.status', 'in', ['CONFIRMED', 'RECONCILED'])
    .where(sql<boolean>`t.correction_role IS DISTINCT FROM 'REVERSAL'`)
    .orderBy('t.booking_date')
    .orderBy('t.id')
    .orderBy('s.position')
    .execute();
  for (const r of rows) {
    const kind = cashKindOf(r.code, r.direction);
    // The split guard admits nothing else on a counted Transaction (0038); skip rather than miscount.
    if (kind === undefined || r.security_deposit_id === null) continue;
    const list = out.get(r.security_deposit_id) ?? [];
    list.push({
      transactionId: r.transaction_id,
      bookingDate: r.booking_date as BusinessDate,
      financialAccountId: r.financial_account_id,
      kind,
      amount: fromNumericAmount(r.amount, r.currency),
    });
    out.set(r.security_deposit_id, list);
  }
  return out;
}

export async function readOne(trx: Transaction<Database>, id: string): Promise<SecurityDeposit> {
  return toDeposit(await trx.selectFrom('security_deposit').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

export function toDeposit(row: DepositRow): SecurityDeposit {
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
    // The closing columns are set together while CLOSED (security_deposit_closing_fields).
    closing:
      row.closing_date === null || row.held_at_closing === null
        ? null
        : {
            closingDate: row.closing_date as BusinessDate,
            reason: row.closing_reason as DepositClosingReason,
            closingNote: row.closing_note,
            heldAtClosing: fromNumericAmount(row.held_at_closing, row.currency),
          },
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created deposit as JSON for the idempotency store: Money as `{ amount, currency }`, timestamps ISO. */
export interface DepositSnapshot extends Omit<SecurityDeposit, 'expectedAmount' | 'createdAt' | 'voidedAt' | 'closing'> {
  readonly expectedAmount: { readonly amount: string; readonly currency: string };
  readonly createdAt: string;
  readonly voidedAt: string | null;
}

export function toSnapshot({ closing: _closing, ...deposit }: SecurityDeposit): DepositSnapshot {
  return {
    ...deposit,
    expectedAmount: { amount: deposit.expectedAmount.amount, currency: deposit.expectedAmount.currency },
    createdAt: deposit.createdAt.toISOString(),
    voidedAt: deposit.voidedAt?.toISOString() ?? null,
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
export function fromSnapshot(result: unknown): SecurityDeposit {
  const s = result as DepositSnapshot;
  return {
    ...s,
    expectedAmount: fromNumericAmount(s.expectedAmount.amount, s.expectedAmount.currency),
    createdAt: new Date(s.createdAt),
    voidedAt: s.voidedAt === null ? null : new Date(s.voidedAt),
    // A created deposit is ACTIVE, never closed.
    closing: null,
  };
}

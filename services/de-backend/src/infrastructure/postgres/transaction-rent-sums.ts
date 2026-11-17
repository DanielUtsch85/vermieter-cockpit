import { sql, type Kysely, type RawBuilder } from 'kysely';
import { CURRENT_STATUSES, type ListedRentSums, type TransactionFilter } from '../../domains/ledger/index.js';
import { RENT_CATEGORIES } from '../../domains/rent-reconciliation/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

/**
 * The rent allocation of the Transaction list (api-design.md §30.1A, VC-X-81): the two sums behind it, as one SQL
 * fragment that the page aggregate and the list's filter (`filtered`) both use, so the field and the filter cannot
 * disagree. Both sums are correlated to the outer `ledger_transaction` row and held to the caller's Realm besides the
 * composite foreign keys (0030, 0045):
 * - `rent_cash`: Σ of its splits in `RENT_CATEGORIES` (§37.2's `rentCash`), `NULL` without one; read through
 *   `transaction_split_position_key (transaction_id, position)` (0008);
 * - `matched_total`: Σ `matched_amount` of its `CONFIRMED` reconciliations (§37.2's `matchedTotal`), `0` when none; read
 *   through the partial index `rent_payment_reconciliation_confirmed_key … WHERE status = 'CONFIRMED'` (0030).
 */
export function rentSums(mreRealmId: string): RawBuilder<{ rent_cash: string | null; matched_total: string }> {
  return sql`SELECT
    (SELECT sum(s.amount) FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id
      WHERE s.transaction_id = ledger_transaction.id AND s.mre_realm_id = ${mreRealmId}
        AND c.code IN (${sql.join(RENT_CATEGORIES.map((code) => sql`${code}`))})) AS rent_cash,
    (SELECT coalesce(sum(r.matched_amount), 0) FROM rent_payment_reconciliation r
      WHERE r.transaction_id = ledger_transaction.id AND r.mre_realm_id = ${mreRealmId} AND r.status = 'CONFIRMED') AS matched_total`;
}

/**
 * The filter `rentAllocation` (§30.1A) as a predicate on `ledger_transaction`: allocatable (counted, `INFLOW`, rent cash
 * > 0; checks 3–5 of §37.1) and its state among `states`. The states follow `rentAllocationOf`: `NONE` at 0 allocated,
 * `FULL` at allocated ≥ rent cash, `PARTIAL` between.
 */
export function rentAllocationPredicate(mreRealmId: string, states: NonNullable<TransactionFilter['rentAllocation']>): RawBuilder<boolean> {
  return sql<boolean>`(ledger_transaction.status IN (${sql.join(CURRENT_STATUSES.map((status) => sql`${status}`))})
    AND ledger_transaction.correction_role IS DISTINCT FROM 'REVERSAL'
    AND ledger_transaction.direction = 'INFLOW'
    AND EXISTS (SELECT 1 FROM (${rentSums(mreRealmId)}) AS sums
      WHERE sums.rent_cash > 0
        AND (CASE WHEN sums.matched_total = 0 THEN 'NONE' WHEN sums.matched_total < sums.rent_cash THEN 'PARTIAL' ELSE 'FULL' END)
          IN (${sql.join(states.map((state) => sql`${state}`))})))`;
}

/**
 * The page aggregate of §30.1A: one statement for the page's ids only, on `db` (the list's snapshot), never a query
 * per row and never for the rows the offset skips. Every id of the Realm gets its sums; another Realm's id none.
 */
export async function rentSumsOfPage(db: Kysely<Database>, mreRealmId: string, transactionIds: readonly string[]): Promise<Map<string, ListedRentSums>> {
  const byTransaction = new Map<string, ListedRentSums>();
  if (transactionIds.length === 0) return byTransaction;
  const { rows } = await sql<{ id: string; currency: string; rent_cash: string | null; matched_total: string }>`
    SELECT ledger_transaction.id, ledger_transaction.currency, sums.rent_cash::text AS rent_cash, sums.matched_total::text AS matched_total
    FROM ledger_transaction CROSS JOIN LATERAL (${rentSums(mreRealmId)}) AS sums
    WHERE ledger_transaction.mre_realm_id = ${mreRealmId} AND ledger_transaction.id = ANY(${[...transactionIds]}::uuid[])`.execute(db);
  for (const row of rows) {
    // A split's and a reconciliation's currency is the Transaction's (composite foreign keys of 0008 and 0030).
    byTransaction.set(row.id, {
      rentCash: row.rent_cash === null ? null : fromNumericAmount(row.rent_cash, row.currency),
      matchedTotal: fromNumericAmount(row.matched_total, row.currency),
    });
  }
  return byTransaction;
}

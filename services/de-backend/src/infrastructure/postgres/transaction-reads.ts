import type { Kysely } from 'kysely';
import { CURRENT_STATUSES, type TransactionFilter, type TransactionSplit } from '../../domains/ledger/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { UUID } from './transaction-repository.js';

/**
 * What `GET /transactions` (api-design.md §30.1) and the Kassenbuch export (§58S) both read: the filter, built by this
 * one function so the two never diverge, and the splits of Transactions in `position` order.
 */

/** True when no Transaction can match: no status left (`IN ()` would be a syntax error) or a malformed id filter. */
export function matchesNothing(filter: TransactionFilter): boolean {
  if (filter.statuses?.length === 0) return true;
  if (filter.financialAccountId !== undefined && !UUID.test(filter.financialAccountId)) return true;
  return filter.propertyReferenceId !== undefined && !UUID.test(filter.propertyReferenceId);
}

/** The Realm's Transactions matching `filter` (§30.1), on `db` (the caller's snapshot). The Realm condition comes first. */
export function filtered(db: Kysely<Database>, mreRealmId: string, filter: TransactionFilter) {
  let query = db.selectFrom('ledger_transaction').where('ledger_transaction.mre_realm_id', '=', mreRealmId);
  if (filter.financialAccountId !== undefined) query = query.where('financial_account_id', '=', filter.financialAccountId);
  if (filter.statuses !== undefined) query = query.where('status', 'in', filter.statuses);
  if (filter.provenances !== undefined) query = query.where('provenance', 'in', filter.provenances);
  if (filter.bookingDateFrom !== undefined) query = query.where('booking_date', '>=', filter.bookingDateFrom);
  if (filter.bookingDateTo !== undefined) query = query.where('booking_date', '<=', filter.bookingDateTo);
  if (filter.financialCategoryCode !== undefined) {
    const code = filter.financialCategoryCode;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('transaction_split')
          .innerJoin('financial_category', 'financial_category.id', 'transaction_split.financial_category_id')
          .select('transaction_split.id')
          .whereRef('transaction_split.transaction_id', '=', 'ledger_transaction.id')
          .where('financial_category.code', '=', code),
      ),
    );
  }
  if (filter.current === true) {
    query = query.where('status', 'in', CURRENT_STATUSES).where((eb) => eb.or([eb('correction_role', 'is', null), eb('correction_role', '<>', 'REVERSAL')]));
  }
  if (filter.propertyReferenceId !== undefined) {
    const reference = filter.propertyReferenceId;
    query = query.where((eb) =>
      eb.or([
        eb('ledger_transaction.property_reference_id', '=', reference),
        eb.exists(
          eb
            .selectFrom('transaction_split')
            .select('transaction_split.id')
            .whereRef('transaction_split.transaction_id', '=', 'ledger_transaction.id')
            .where('transaction_split.property_reference_id', '=', reference),
        ),
      ]),
    );
  }
  return query;
}

/** The splits of the given Transactions, each list in `position` order; a Transaction without splits has none in the map. */
export async function splitsOf(db: Kysely<Database>, transactionIds: readonly string[]): Promise<Map<string, TransactionSplit[]>> {
  const byTransaction = new Map<string, TransactionSplit[]>();
  if (transactionIds.length === 0) return byTransaction;
  const rows = await db
    .selectFrom('transaction_split')
    .innerJoin('financial_category', 'financial_category.id', 'transaction_split.financial_category_id')
    .select([
      'transaction_split.id',
      'transaction_split.transaction_id',
      'transaction_split.position',
      'transaction_split.amount',
      'transaction_split.currency',
      'transaction_split.property_reference_id',
      'transaction_split.loan_id',
      'transaction_split.security_deposit_id',
      'transaction_split.weg_annual_statement_id',
      'transaction_split.weg_special_assessment_id',
      'transaction_split.description',
      'financial_category.code',
    ])
    .where('transaction_split.transaction_id', 'in', [...transactionIds])
    .orderBy('transaction_split.transaction_id')
    .orderBy('transaction_split.position')
    .execute();
  for (const s of rows) {
    const list = byTransaction.get(s.transaction_id) ?? [];
    list.push({
      id: s.id,
      position: s.position,
      amount: fromNumericAmount(s.amount, s.currency),
      financialCategoryCode: s.code,
      propertyReferenceId: s.property_reference_id,
      loanId: s.loan_id,
      securityDepositId: s.security_deposit_id,
      wegAnnualStatementId: s.weg_annual_statement_id,
      wegSpecialAssessmentId: s.weg_special_assessment_id,
      description: s.description,
    });
    byTransaction.set(s.transaction_id, list);
  }
  return byTransaction;
}

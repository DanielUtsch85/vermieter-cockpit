import type { Kysely } from 'kysely';
import {
  CURRENT_STATUSES,
  type PageRequest,
  type Transaction,
  type TransactionFilter,
  type TransactionPage,
  type TransactionQueries,
  type TransactionSplit,
} from '../../domains/ledger/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { COLUMNS, UUID, toDomain } from './transaction-repository.js';

/** PostgreSQL implementation of the Transaction read port (api-design.md §30). Plain reads, no locks. */
export class PostgresTransactionQueries implements TransactionQueries {
  constructor(private readonly db: Kysely<Database>) {}

  async get(id: string, mreRealmId: string): Promise<{ transaction: Transaction; splits: TransactionSplit[] } | undefined> {
    if (!UUID.test(id)) return undefined;
    // One snapshot for both, so the splits belong to the version read (a concurrent replacement is all or nothing).
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const row = await trx
        .selectFrom('ledger_transaction')
        .select(COLUMNS)
        .where('id', '=', id)
        .where('mre_realm_id', '=', mreRealmId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const splits = await trx
        .selectFrom('transaction_split')
        .innerJoin('financial_category', 'financial_category.id', 'transaction_split.financial_category_id')
        .select([
          'transaction_split.id',
          'transaction_split.position',
          'transaction_split.amount',
          'transaction_split.currency',
          'transaction_split.property_reference_id',
          'transaction_split.loan_id',
          'transaction_split.description',
          'financial_category.code',
        ])
        .where('transaction_split.transaction_id', '=', id)
        .orderBy('transaction_split.position')
        .execute();
      return {
        transaction: toDomain(row),
        splits: splits.map((s) => ({
          id: s.id,
          position: s.position,
          amount: fromNumericAmount(s.amount, s.currency),
          financialCategoryCode: s.code,
          propertyReferenceId: s.property_reference_id,
          loanId: s.loan_id,
          description: s.description,
        })),
      };
    });
  }

  async list(mreRealmId: string, filter: TransactionFilter, page: PageRequest): Promise<TransactionPage> {
    const empty: TransactionPage = { items: [], page: page.page, pageSize: page.pageSize, total: 0 };
    // No status can match (e.g. `status` and `reviewable` without overlap); `IN ()` would be a syntax error.
    if (filter.statuses?.length === 0) return empty;
    if (filter.financialAccountId !== undefined && !UUID.test(filter.financialAccountId)) return empty;
    if (filter.propertyReferenceId !== undefined && !UUID.test(filter.propertyReferenceId)) return empty;
    // Built on the transaction below, so count and page run in its snapshot.
    const filtered = (db: Kysely<Database>) => {
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
        query = query
          .where('status', 'in', CURRENT_STATUSES)
          .where((eb) => eb.or([eb('correction_role', 'is', null), eb('correction_role', '<>', 'REVERSAL')]));
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
    };
    // Count and page in one snapshot, so `total` and `items` agree.
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const { n } = await filtered(trx)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const total = Number(n);
      // First the page's ids, read in order from `ledger_transaction_realm_page_idx` and stopping at the limit; then
      // the DTO for those rows only. The link subqueries of COLUMNS would otherwise also run for every row the
      // offset skips (VC-X-19).
      const newestFirst = <Q extends ReturnType<typeof filtered>>(query: Q) =>
        query
          .orderBy('ledger_transaction.booking_date', 'desc')
          .orderBy('ledger_transaction.created_at', 'desc')
          .orderBy('ledger_transaction.id', 'desc');
      const pageIds = newestFirst(filtered(trx))
        .select('ledger_transaction.id')
        .limit(page.pageSize)
        .offset((page.page - 1) * page.pageSize);
      const rows = await newestFirst(trx.selectFrom('ledger_transaction'))
        .select(COLUMNS)
        .where('ledger_transaction.id', 'in', pageIds)
        .execute();
      return { items: rows.map(toDomain), page: page.page, pageSize: page.pageSize, total };
    });
  }
}

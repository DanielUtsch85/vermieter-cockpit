import type { Kysely } from 'kysely';
import type {
  PageRequest,
  Transaction,
  TransactionFilter,
  TransactionPage,
  TransactionQueries,
  TransactionSplit,
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
          description: s.description,
        })),
      };
    });
  }

  async list(mreRealmId: string, filter: TransactionFilter, page: PageRequest): Promise<TransactionPage> {
    const empty: TransactionPage = { items: [], page: page.page, pageSize: page.pageSize, total: 0 };
    // No status can match (e.g. `status` and `reviewable` without overlap); `IN ()` would be a syntax error.
    if (filter.statuses?.length === 0) return empty;
    let query = this.db.selectFrom('ledger_transaction').where('ledger_transaction.mre_realm_id', '=', mreRealmId);
    if (filter.financialAccountId !== undefined) {
      if (!UUID.test(filter.financialAccountId)) return empty;
      query = query.where('financial_account_id', '=', filter.financialAccountId);
    }
    if (filter.statuses !== undefined) query = query.where('status', 'in', filter.statuses);
    if (filter.bookingDateFrom !== undefined) query = query.where('booking_date', '>=', filter.bookingDateFrom);
    if (filter.bookingDateTo !== undefined) query = query.where('booking_date', '<=', filter.bookingDateTo);
    if (filter.propertyReferenceId !== undefined) {
      const reference = filter.propertyReferenceId;
      if (!UUID.test(reference)) return empty;
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
    // Count and page in one snapshot, so `total` and `items` agree.
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const { n } = await trx
        .selectFrom(query.select('ledger_transaction.id').as('filtered'))
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const total = Number(n);
      const rows = await trx
        .selectFrom('ledger_transaction')
        .select(COLUMNS)
        .where('ledger_transaction.id', 'in', query.select('ledger_transaction.id'))
        .orderBy('ledger_transaction.booking_date', 'desc')
        .orderBy('ledger_transaction.created_at', 'desc')
        .orderBy('ledger_transaction.id', 'desc')
        .limit(page.pageSize)
        .offset((page.page - 1) * page.pageSize)
        .execute();
      return { items: rows.map(toDomain), page: page.page, pageSize: page.pageSize, total };
    });
  }
}

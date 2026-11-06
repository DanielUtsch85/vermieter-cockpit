import type { Kysely } from 'kysely';
import type { PageRequest, Transaction, TransactionFilter, TransactionPage, TransactionQueries, TransactionSplit } from '../../domains/ledger/index.js';
import type { Database } from './schema.js';
import { COLUMNS, UUID, toDomain } from './transaction-repository.js';
import { filtered, matchesNothing, splitsOf } from './transaction-reads.js';

/** PostgreSQL implementation of the Transaction read port (api-design.md §30). Plain reads, no locks. */
export class PostgresTransactionQueries implements TransactionQueries {
  constructor(private readonly db: Kysely<Database>) {}

  async get(id: string, mreRealmId: string): Promise<{ transaction: Transaction; splits: TransactionSplit[] } | undefined> {
    if (!UUID.test(id)) return undefined;
    // One snapshot for both, so the splits belong to the version read (a concurrent replacement is all or nothing).
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const row = await trx.selectFrom('ledger_transaction').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
        if (row === undefined) return undefined;
        return { transaction: toDomain(row), splits: (await splitsOf(trx, [id])).get(id) ?? [] };
      });
  }

  async list(mreRealmId: string, filter: TransactionFilter, page: PageRequest): Promise<TransactionPage> {
    const empty: TransactionPage = { items: [], page: page.page, pageSize: page.pageSize, total: 0 };
    if (matchesNothing(filter)) return empty;
    // Count and page in one snapshot, so `total` and `items` agree.
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const { n } = await filtered(trx, mreRealmId, filter)
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        const total = Number(n);
        // First the page's ids, read in order from `ledger_transaction_realm_page_idx` and stopping at the limit; then
        // the DTO for those rows only. The link subqueries of COLUMNS would otherwise also run for every row the
        // offset skips (VC-X-19).
        const newestFirst = <Q extends ReturnType<typeof filtered>>(query: Q) =>
          query.orderBy('ledger_transaction.booking_date', 'desc').orderBy('ledger_transaction.created_at', 'desc').orderBy('ledger_transaction.id', 'desc');
        const pageIds = newestFirst(filtered(trx, mreRealmId, filter))
          .select('ledger_transaction.id')
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize);
        const rows = await newestFirst(trx.selectFrom('ledger_transaction')).select(COLUMNS).where('ledger_transaction.id', 'in', pageIds).execute();
        return { items: rows.map(toDomain), page: page.page, pageSize: page.pageSize, total };
      });
  }
}

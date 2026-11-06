import { sql, type Kysely } from 'kysely';
import type { TransactionExportQueries, TransactionExportSink, TransactionFilter } from '../../domains/ledger/index.js';
import type { Database } from './schema.js';
import { COLUMNS, toDomain } from './transaction-repository.js';
import { filtered, matchesNothing, splitsOf } from './transaction-reads.js';

/**
 * The Kassenbuch export (api-design.md §58S, VC-X-04): §30.1's filter (`filtered`, the list's own function), oldest
 * booking first, read in keyset batches inside one `REPEATABLE READ READ ONLY` snapshot. The count goes to the sink
 * first, in the same snapshot, so a limit is checked before the first byte and the file agrees with its count.
 */
export class PostgresTransactionExport implements TransactionExportQueries {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async exportAll(
    mreRealmId: string,
    filter: TransactionFilter,
    options: { readonly batchSize: number; readonly countRows: boolean },
    sink: TransactionExportSink,
  ): Promise<void> {
    await this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        // The snapshot starts with its first statement; the clock is read right after it.
        await sql`SELECT 1`.execute(trx);
        const generatedAt = this.now();
        if (matchesNothing(filter)) {
          await sink.begin({ generatedAt, transactionCount: 0, rowCount: options.countRows ? 0 : undefined });
          return;
        }
        const counts = await filtered(trx, mreRealmId, filter)
          .select((eb) => [
            eb.fn.countAll<string>().as('n'),
            // A Transaction without splits is one row of `rows=splits`.
            sql<string>`coalesce(sum(greatest(1, (SELECT count(*) FROM transaction_split s WHERE s.transaction_id = ledger_transaction.id))), 0)`.as('rows'),
          ])
          .executeTakeFirstOrThrow();
        await sink.begin({ generatedAt, transactionCount: Number(counts.n), rowCount: options.countRows ? Number(counts.rows) : undefined });

        // Keyset batches, read backwards from `ledger_transaction_realm_page_idx` (booking date, creation, id): the last
        // key of a batch is read back from its row, so the cursor is exact to the microsecond.
        let after: string | undefined;
        for (;;) {
          let page = filtered(trx, mreRealmId, filter).select('ledger_transaction.id');
          if (after !== undefined) {
            const last = after;
            page = page.where(
              sql<boolean>`(ledger_transaction.booking_date, ledger_transaction.created_at, ledger_transaction.id) > (SELECT k.booking_date, k.created_at, k.id FROM ledger_transaction k WHERE k.id = ${last})`,
            );
          }
          const ids = (
            await page
              .orderBy('ledger_transaction.booking_date', 'asc')
              .orderBy('ledger_transaction.created_at', 'asc')
              .orderBy('ledger_transaction.id', 'asc')
              .limit(options.batchSize)
              .execute()
          ).map((r) => r.id);
          if (ids.length === 0) return;
          const rows = await trx
            .selectFrom('ledger_transaction')
            .select(COLUMNS)
            .where('ledger_transaction.id', 'in', ids)
            .orderBy('ledger_transaction.booking_date', 'asc')
            .orderBy('ledger_transaction.created_at', 'asc')
            .orderBy('ledger_transaction.id', 'asc')
            .execute();
          const splits = await splitsOf(trx, ids);
          await sink.batch(rows.map((row) => ({ transaction: toDomain(row), splits: splits.get(row.id) ?? [] })));
          if (ids.length < options.batchSize) return;
          after = ids[ids.length - 1];
        }
      });
  }
}

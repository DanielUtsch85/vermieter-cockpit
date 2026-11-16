import type { Kysely, Selectable } from 'kysely';
import type {
  FinancialAccountId,
  ImportBatchFilter,
  ImportBatchId,
  ImportBatchPage,
  ImportBatchQueries,
  ImportBatchStatus,
  ImportBatchSummary,
  PageRequest,
} from '../../domains/ledger/index.js';
import { bookingRanges, NO_BOOKING_RANGE, type BookingRange } from './import-booking-range.js';
import type { Database, ImportBatchTable } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every column of a listed batch: never `rows` or `continuity` (§32.6), which stay on the single read. */
const SUMMARY_COLUMNS = [
  'id',
  'mre_realm_id',
  'financial_account_id',
  'adapter_id',
  'adapter_version',
  'source_filename',
  'content_hash',
  'status',
  'transaction_count',
  'duplicate_count',
  'needs_review_count',
  'error_count',
  'skipped_count',
  'imported_at',
  'imported_by',
] as const;
type SummaryRow = Pick<Selectable<ImportBatchTable>, (typeof SUMMARY_COLUMNS)[number]>;

/**
 * `GET /imports` (api-design.md §32.6, #369, VC-X-74): the Realm's batches, newest first. Count and page in one
 * `REPEATABLE READ READ ONLY` snapshot; the page's ids are read in order from `import_batch_realm_imported_idx` (0078)
 * and stop at offset + limit, only then are the page's rows read, then the booking range of those batches (VC-X-75,
 * `import-booking-range.ts`) in the same snapshot. No lock, no write.
 */
export class PostgresImportBatchQueries implements ImportBatchQueries {
  constructor(private readonly db: Kysely<Database>) {}

  async list(mreRealmId: string, filter: ImportBatchFilter, page: PageRequest): Promise<ImportBatchPage> {
    const empty: ImportBatchPage = { items: [], page: page.page, pageSize: page.pageSize, total: 0 };
    if (filter.financialAccountId !== undefined && !UUID.test(filter.financialAccountId)) return empty;
    if (filter.statuses?.length === 0) return empty;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        // The Realm condition first, always.
        let filtered = trx.selectFrom('import_batch').where('mre_realm_id', '=', mreRealmId);
        if (filter.financialAccountId !== undefined) filtered = filtered.where('financial_account_id', '=', filter.financialAccountId);
        if (filter.statuses !== undefined) filtered = filtered.where('status', 'in', filter.statuses);
        const { n } = await filtered.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
        // Newest first; the id breaks a tie of equal timestamps, so pages are stable.
        const pageIds = filtered
          .select('id')
          .orderBy('imported_at', 'desc')
          .orderBy('id', 'desc')
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize);
        const rows = await trx
          .selectFrom('import_batch')
          .select(SUMMARY_COLUMNS)
          .where('id', 'in', pageIds)
          .orderBy('imported_at', 'desc')
          .orderBy('id', 'desc')
          .execute();
        const ranges = await bookingRanges(
          trx,
          mreRealmId,
          rows.map((r) => r.id),
        );
        return {
          items: rows.map((r) => toSummary(r, ranges.get(r.id) ?? NO_BOOKING_RANGE)),
          page: page.page,
          pageSize: page.pageSize,
          total: Number(n),
        };
      });
  }
}

function toSummary(row: SummaryRow, range: BookingRange): ImportBatchSummary {
  return {
    id: row.id as ImportBatchId,
    mreRealmId: row.mre_realm_id,
    financialAccountId: row.financial_account_id as FinancialAccountId,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    sourceFilename: row.source_filename,
    contentHash: row.content_hash,
    status: row.status as ImportBatchStatus,
    transactionCount: row.transaction_count,
    duplicateCount: row.duplicate_count,
    needsReviewCount: row.needs_review_count,
    errorCount: row.error_count,
    skippedCount: row.skipped_count,
    importedAt: row.imported_at,
    importedBy: row.imported_by,
    ...range,
  };
}

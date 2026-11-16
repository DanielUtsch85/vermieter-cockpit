import type { ImportBatch, ImportBatchStatus } from './bank-import.js';
import type { PageRequest } from './transaction-query.js';

/**
 * The list of a Realm's imports (api-design.md §32.6, #369, backlog VC-X-74): the port the application reads through
 * and PostgreSQL implements. Reads only.
 */

export const IMPORT_BATCH_STATUSES: readonly ImportBatchStatus[] = ['COMPLETED', 'NEEDS_REVIEW'];

/** A batch as listed: the single read's batch without `rows` and `continuity`, which can hold 10,000 rows (§32.6). */
export type ImportBatchSummary = Omit<ImportBatch, 'rows' | 'continuity'>;

/** All optional, combined with AND (§32.6). */
export interface ImportBatchFilter {
  readonly financialAccountId?: string;
  /** Any of them. */
  readonly statuses?: readonly ImportBatchStatus[];
}

export interface ImportBatchPage {
  readonly items: readonly ImportBatchSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface ImportBatchQueries {
  /**
   * The Realm's batches matching `filter`, newest `importedAt` first, then the id descending; `total` and `items` in one
   * `REPEATABLE READ READ ONLY` snapshot. An unknown or foreign account matches nothing.
   */
  list(mreRealmId: string, filter: ImportBatchFilter, page: PageRequest): Promise<ImportBatchPage>;
}

import type { Money } from '../../shared/index.js';
import type { TransactionSplit } from './transaction-split.js';
import type { BusinessDate, Provenance, Transaction, TransactionStatus } from './transaction.js';

/**
 * Reading Transactions (api-design.md §30, backlog VC-X-21): one Transaction with its splits, or a page of them,
 * always within the caller's Realm. The read gives the current `version` for the next `If-Match` (§16.1).
 */

export interface TransactionFilter {
  readonly financialAccountId?: string;
  /** Any of these statuses. */
  readonly statuses?: readonly TransactionStatus[];
  /** Any of these sources (`provenance`, data-model §17.6), e.g. only imported ones. */
  readonly provenances?: readonly Provenance[];
  /** The Transaction's own PropertyReference **or** one of its splits' (a split can carry the property, §33). */
  readonly propertyReferenceId?: string;
  /** Transactions with at least one split of this category (by code); an unknown code matches nothing. */
  readonly financialCategoryCode?: string;
  /** Inclusive booking-date range. */
  readonly bookingDateFrom?: BusinessDate;
  readonly bookingDateTo?: BusinessDate;
  /**
   * Only the current Transactions of api-design §35.3: `CONFIRMED` or `RECONCILED` and not a reversal, so neither a
   * `CORRECTED` original nor its reversal. Combined with `statuses` like any other filter (AND).
   */
  readonly current?: true;
  /**
   * §30.1A (VC-X-81): only Transactions whose rent allocation is in any of these states, so never one whose
   * `rentAllocation` would be `null`. The states and their rule are rent-reconciliation's (`RENT_ALLOCATION_STATES`,
   * `rentAllocationOf`); the Ledger names them only to carry the filter to the adapter.
   */
  readonly rentAllocation?: readonly ('NONE' | 'PARTIAL' | 'FULL')[];
}

export interface PageRequest {
  /** 1-based. */
  readonly page: number;
  readonly pageSize: number;
}

/**
 * A listed Transaction's rent sums (api-design.md §30.1A), read for the page's rows in the list's snapshot: Σ of its
 * splits in the rent categories (`null` without one) and Σ `matchedAmount` of its `CONFIRMED` reconciliations (`0.00`
 * when none), both of the caller's Realm. The Ledger only carries them; rent-reconciliation's `rentAllocationOf` turns
 * them into the list's `rentAllocation`.
 */
export interface ListedRentSums {
  readonly rentCash: Money | null;
  readonly matchedTotal: Money;
}

export interface TransactionPage {
  readonly items: readonly Transaction[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  /** By Transaction id, one for every item of the page (§30.1A). */
  readonly rentSums: ReadonlyMap<string, ListedRentSums>;
}

/** `reviewable` of §30: the pre-classification states. */
export const REVIEWABLE_STATUSES = ['IMPORTED', 'UNREVIEWED'] as const satisfies readonly TransactionStatus[];

/** `current` of §30.1: the statuses a current Transaction can have (§35.3); a reversal among them is still not current. */
export const CURRENT_STATUSES = ['CONFIRMED', 'RECONCILED'] as const satisfies readonly TransactionStatus[];

/** Read port, implemented in infrastructure/postgres. */
export interface TransactionQueries {
  /** The Transaction and its splits (in position order), or undefined when unknown or of another Realm. */
  get(id: string, mreRealmId: string): Promise<{ readonly transaction: Transaction; readonly splits: readonly TransactionSplit[] } | undefined>;
  /** A page in booking order, newest first (booking date, then creation, then id). */
  list(mreRealmId: string, filter: TransactionFilter, page: PageRequest): Promise<TransactionPage>;
}

/** The head of a Kassenbuch export (api-design.md §58S), read in its snapshot before the first row. */
export interface TransactionExportHead {
  /** The snapshot's start, as the server clock reads it. */
  readonly generatedAt: Date;
  readonly transactionCount: number;
  /** One per split, or one for a Transaction without splits; counted only when asked for (`rows=splits`). */
  readonly rowCount: number | undefined;
}

export interface TransactionWithSplits {
  readonly transaction: Transaction;
  /** In `position` order. */
  readonly splits: readonly TransactionSplit[];
}

/** Receives an export: the head once, then the batches in order. A throw ends the read and its snapshot. */
export interface TransactionExportSink {
  begin(head: TransactionExportHead): void | Promise<void>;
  batch(items: readonly TransactionWithSplits[]): Promise<void>;
}

/** Export read port (§58S): every Transaction of the filter, oldest booking first, in keyset batches of one snapshot. */
export interface TransactionExportQueries {
  exportAll(
    mreRealmId: string,
    filter: TransactionFilter,
    options: { readonly batchSize: number; readonly countRows: boolean },
    sink: TransactionExportSink,
  ): Promise<void>;
}

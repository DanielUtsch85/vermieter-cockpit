import type { TransactionSplit } from './transaction-split.js';
import type { BusinessDate, Transaction, TransactionStatus } from './transaction.js';

/**
 * Reading Transactions (api-design.md §30, backlog VC-X-21): one Transaction with its splits, or a page of them,
 * always within the caller's Realm. The read gives the current `version` for the next `If-Match` (§16.1).
 */

export interface TransactionFilter {
  readonly financialAccountId?: string;
  /** Any of these statuses. */
  readonly statuses?: readonly TransactionStatus[];
  /** The Transaction's own PropertyReference **or** one of its splits' (a split can carry the property, §33). */
  readonly propertyReferenceId?: string;
  /** Inclusive booking-date range. */
  readonly bookingDateFrom?: BusinessDate;
  readonly bookingDateTo?: BusinessDate;
  /**
   * Only the current Transactions of api-design §35.3: `CONFIRMED` or `RECONCILED` and not a reversal, so neither a
   * `CORRECTED` original nor its reversal. Combined with `statuses` like any other filter (AND).
   */
  readonly current?: true;
}

export interface PageRequest {
  /** 1-based. */
  readonly page: number;
  readonly pageSize: number;
}

export interface TransactionPage {
  readonly items: readonly Transaction[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
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

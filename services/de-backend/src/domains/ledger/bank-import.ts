import type { AuditActor } from '../../shared/index.js';
import type { NormalizedBankRow, ParsedStatement, RowError } from './bank-statement.js';
import type { FinancialAccount, FinancialAccountId } from './financial-account.js';
import type { BusinessDate, Provenance } from './transaction.js';

/**
 * Bank import (api-design.md §32.1, data-model.md §20, §20A, §70): turns a
 * parsed statement into an ImportBatch. Each row gets exactly one outcome; only
 * genuinely new rows become Transactions, and ambiguous rows become review
 * items instead — the system neither silently merges nor silently duplicates.
 */

export type ImportBatchId = string & { readonly __brand: 'ImportBatchId' };
export type ReviewItemId = string & { readonly __brand: 'ReviewItemId' };

export type ImportBatchStatus = 'COMPLETED' | 'NEEDS_REVIEW';
export type ReviewResolution = 'CREATE' | 'SKIP';

export type AmbiguityReason =
  /** Same content fingerprint as an imported row of another statement (§70.4). */
  | 'AMBIGUOUS_CROSS_FILE_MATCH'
  /** Same source row already imported or reviewed under another adapter version (§70.4). */
  | 'ADAPTER_VERSION_CONFLICT';

/** Per-row result of an import (api-design.md §32.1). */
export type RowOutcome =
  | { readonly outcome: 'created'; readonly position: number; readonly transactionId: string }
  | { readonly outcome: 'duplicate'; readonly position: number; readonly duplicateOf: 'TRANSACTION'; readonly transactionId: string }
  | {
      readonly outcome: 'duplicate';
      readonly position: number;
      readonly duplicateOf: 'RESOLVED_REVIEW_ITEM';
      readonly reviewItemId: string;
      readonly importBatchId: string;
      readonly resolution: ReviewResolution;
      /** Present only after CREATE; absent by definition after SKIP. */
      readonly createdTransactionId?: string;
    }
  | {
      readonly outcome: 'needs_review';
      readonly position: number;
      readonly reviewItemId: string;
      /** The owning batch: this one for a new item, the first-seen batch for a re-presented pending one. */
      readonly importBatchId: string;
      readonly reason: AmbiguityReason;
      readonly conflictingTransactionIds: readonly string[];
    }
  | { readonly outcome: 'error'; readonly position: number; readonly errors: readonly RowError[] }
  /** Not a cash movement (e.g. a 0,00 balance or closing line); reported, never booked, not an error. */
  | { readonly outcome: 'skipped'; readonly position: number; readonly reason: 'ZERO_AMOUNT' };

export interface ImportBatch {
  readonly id: ImportBatchId;
  readonly mreRealmId: string;
  readonly financialAccountId: FinancialAccountId;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sourceFilename: string | null;
  readonly contentHash: string;
  readonly status: ImportBatchStatus;
  readonly transactionCount: number;
  readonly duplicateCount: number;
  /** This batch's own PENDING review items (§20A Ownership and Retry). */
  readonly needsReviewCount: number;
  readonly errorCount: number;
  readonly skippedCount: number;
  readonly importedAt: Date;
  readonly importedBy: string;
  readonly rows: readonly RowOutcome[];
}

/** Statement identity and source-row identity within it (§70.2 fallback key, minus Realm and account). */
export interface SourceRowKey {
  /** The source's statement id, else the file's content hash. */
  readonly statementKey: string;
  /** The source's row id, else the row's position in the file. */
  readonly rowKey: string;
}

export function sourceRowKey(statement: ParsedStatement, row: { position: number; sourceRowId: string | null }): SourceRowKey {
  return {
    statementKey: statement.sourceStatementId === null ? `sha256:${statement.contentHash}` : `id:${statement.sourceStatementId}`,
    rowKey: row.sourceRowId === null ? `pos:${row.position}` : `id:${row.sourceRowId}`,
  };
}

/** A review item as far as row decisions need it. */
export interface KnownReviewItem {
  readonly id: string;
  readonly importBatchId: string;
  readonly status: 'PENDING' | 'RESOLVED';
  readonly resolution: ReviewResolution | null;
  readonly createdTransactionId: string | null;
}

/** What the ledger already holds that concerns one row; looked up by the repository. */
export interface RowLookup {
  /** External-id branch: the Transaction with this external id in the account. */
  readonly transactionByExternalId?: string;
  /** Fallback branch: the Transaction with the full identity (same adapter id and version). */
  readonly transactionByIdentity?: string;
  /** Fallback branch: the review item with the full identity. */
  readonly reviewItemByIdentity?: KnownReviewItem;
  /** Fallback branch: the same source row recorded under another adapter id or version. */
  readonly otherAdapterVersion?: {
    readonly transactionIds: readonly string[];
    readonly reviewItemIds: readonly string[];
  };
  /** Fallback branch: imported Transactions of other statements with the same content fingerprint. */
  readonly fingerprintMatches: readonly string[];
}

export type RowDecision =
  | { readonly kind: 'CREATE' }
  | { readonly kind: 'DUPLICATE_TRANSACTION'; readonly transactionId: string }
  | { readonly kind: 'DUPLICATE_RESOLVED_ITEM'; readonly item: KnownReviewItem }
  | { readonly kind: 'REFERENCE_PENDING_ITEM'; readonly item: KnownReviewItem }
  | {
      readonly kind: 'NEW_REVIEW_ITEM';
      readonly reason: AmbiguityReason;
      readonly conflictingTransactionIds: readonly string[];
      /** Prior review items the reason refers to (adapter-version conflict, provenance preserved). */
      readonly priorReviewItemIds: readonly string[];
    };

/**
 * The binding order of §70.1/§70.4 and §20A for one row:
 *
 * 1. A stable external id decides alone (adapter-independent): duplicate or create.
 * 2. Otherwise the full source-row identity: an imported Transaction → duplicate;
 *    a review item → reference it while PENDING, duplicate once RESOLVED (the
 *    decision stands, nothing new is created).
 * 3. The same source row under another adapter version → a new review item, never automatic.
 * 4. The same content in another statement → a new review item (sameness cannot be proven).
 * 5. Otherwise create.
 */
export function decideRow(hasExternalId: boolean, lookup: RowLookup): RowDecision {
  if (hasExternalId) {
    return lookup.transactionByExternalId === undefined
      ? { kind: 'CREATE' }
      : { kind: 'DUPLICATE_TRANSACTION', transactionId: lookup.transactionByExternalId };
  }
  if (lookup.transactionByIdentity !== undefined) {
    return { kind: 'DUPLICATE_TRANSACTION', transactionId: lookup.transactionByIdentity };
  }
  if (lookup.reviewItemByIdentity !== undefined) {
    const item = lookup.reviewItemByIdentity;
    return item.status === 'PENDING' ? { kind: 'REFERENCE_PENDING_ITEM', item } : { kind: 'DUPLICATE_RESOLVED_ITEM', item };
  }
  const prior = lookup.otherAdapterVersion;
  if (prior !== undefined && (prior.transactionIds.length > 0 || prior.reviewItemIds.length > 0)) {
    return {
      kind: 'NEW_REVIEW_ITEM',
      reason: 'ADAPTER_VERSION_CONFLICT',
      conflictingTransactionIds: prior.transactionIds,
      priorReviewItemIds: prior.reviewItemIds,
    };
  }
  if (lookup.fingerprintMatches.length > 0) {
    return {
      kind: 'NEW_REVIEW_ITEM',
      reason: 'AMBIGUOUS_CROSS_FILE_MATCH',
      conflictingTransactionIds: lookup.fingerprintMatches,
      priorReviewItemIds: [],
    };
  }
  return { kind: 'CREATE' };
}

/**
 * Imports post to closed accounts too, but only up to the day of closing:
 * statements typically arrive after the account was closed, with booking dates
 * before it. Manual Transactions stay refused on closed accounts (§31.2).
 * The closing day is the UTC date of `closedAt`.
 */
export function importPostable(account: FinancialAccount, bookingDate: BusinessDate): boolean {
  if (account.status === 'OPEN' || account.closedAt === null) return true;
  return bookingDate <= account.closedAt.toISOString().slice(0, 10);
}

/** Outcome tally and status for a batch (§20: needsReviewCount counts own PENDING items only). */
export function summarize(rows: readonly RowOutcome[], ownPendingItems: number) {
  const count = (outcome: RowOutcome['outcome']) => rows.filter((r) => r.outcome === outcome).length;
  return {
    transactionCount: count('created'),
    duplicateCount: count('duplicate'),
    needsReviewCount: ownPendingItems,
    errorCount: count('error'),
    skippedCount: count('skipped'),
    status: (ownPendingItems > 0 ? 'NEEDS_REVIEW' : 'COMPLETED') as ImportBatchStatus,
  };
}

/** A row-level ParsedRow error that is not a fault in the data: reported as skipped. */
export function isSkippable(errors: readonly RowError[]): boolean {
  return errors.length === 1 && errors[0]?.code === 'ZERO_AMOUNT';
}

export type ImportOutcome = { readonly kind: 'IMPORTED'; readonly batch: ImportBatch } | { readonly kind: 'ACCOUNT_NOT_FOUND' };

export interface NewImport {
  readonly mreRealmId: string;
  readonly financialAccountId: string;
  readonly statement: ParsedStatement;
  /** Provenance of the adapter that parsed the statement (data-model.md §17.6). */
  readonly provenance: Provenance;
  readonly sourceFilename: string | null;
}

/** Persistence port, implemented in infrastructure/postgres. */
export interface ImportRepository {
  /**
   * In one transaction: locks the account (imports into one account serialize),
   * decides every row with `decideRow`, creates the Transactions and review items,
   * stores the batch with its row outcomes and writes the AuditRecord.
   */
  importStatement(input: NewImport, actor: AuditActor): Promise<ImportOutcome>;
  /** Only within the given Realm: another Realm's batch is not found. */
  findBatch(id: string, mreRealmId: string): Promise<ImportBatch | undefined>;
}

/** The normalized row as stored on a review item (§20A `normalizedRow`). */
export function normalizedRowJson(row: NormalizedBankRow): Record<string, unknown> {
  return { ...row, amount: row.amount.toJSON() };
}

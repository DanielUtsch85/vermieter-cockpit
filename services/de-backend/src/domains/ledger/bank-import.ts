import type { AuditActor, Money } from '../../shared/index.js';
import type { NormalizedBankRow, ParsedStatement, RowError } from './bank-statement.js';
import type { FinancialAccount, FinancialAccountId } from './financial-account.js';
import type { BusinessDate, Direction, Provenance } from './transaction.js';

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
  | 'ADAPTER_VERSION_CONFLICT'
  /** Same external id as an imported Transaction, but different content (§70.4): not provably the same payment. */
  | 'EXTERNAL_ID_CONTENT_CONFLICT';

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
  /** The review item with the row's full source identity (same adapter id and version), in either branch. */
  readonly reviewItemByIdentity?: KnownReviewItem;
  /** External-id branch: the Transaction with this external id in the account, with its content fingerprint. */
  readonly transactionByExternalId?: { readonly id: string; readonly contentFingerprint: string };
  /** External-id branch: the row's content fingerprint, compared with `transactionByExternalId`. */
  readonly contentFingerprint?: string;
  /**
   * External-id branch: earlier imported Transactions without an external id (any statement)
   * with the same content fingerprint — the same payment imported before without its id.
   */
  readonly fallbackFingerprintMatches?: readonly string[];
  /** Fallback branch: the Transaction with the full identity (same adapter id and version). */
  readonly transactionByIdentity?: string;
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
 * 1. A review item with the row's full source identity → reference it while
 *    PENDING, duplicate once RESOLVED (the decision stands, nothing new is created).
 * 2. A stable external id (adapter-independent):
 *    - the same id with the same content → duplicate; with other content → a new
 *      review item (a reused or placeholder id must not swallow a payment);
 *    - no id match, but the same content imported earlier without an id → a new
 *      review item (the same payment must not be booked twice);
 *    - otherwise create.
 * 3. Otherwise the full source-row identity: an imported Transaction → duplicate.
 * 4. The same source row under another adapter version → a new review item, never automatic.
 * 5. The same content in another statement → a new review item (sameness cannot be proven).
 * 6. Otherwise create.
 */
export function decideRow(hasExternalId: boolean, lookup: RowLookup): RowDecision {
  if (lookup.reviewItemByIdentity !== undefined) {
    const item = lookup.reviewItemByIdentity;
    return item.status === 'PENDING' ? { kind: 'REFERENCE_PENDING_ITEM', item } : { kind: 'DUPLICATE_RESOLVED_ITEM', item };
  }
  if (hasExternalId) return decideByExternalId(lookup);
  if (lookup.transactionByIdentity !== undefined) {
    return { kind: 'DUPLICATE_TRANSACTION', transactionId: lookup.transactionByIdentity };
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

function decideByExternalId(lookup: RowLookup): RowDecision {
  const byId = lookup.transactionByExternalId;
  if (byId !== undefined) {
    if (lookup.contentFingerprint !== undefined && byId.contentFingerprint === lookup.contentFingerprint) {
      return { kind: 'DUPLICATE_TRANSACTION', transactionId: byId.id };
    }
    return {
      kind: 'NEW_REVIEW_ITEM',
      reason: 'EXTERNAL_ID_CONTENT_CONFLICT',
      conflictingTransactionIds: [byId.id],
      priorReviewItemIds: [],
    };
  }
  const sameContent = lookup.fallbackFingerprintMatches ?? [];
  if (sameContent.length > 0) {
    return {
      kind: 'NEW_REVIEW_ITEM',
      reason: 'AMBIGUOUS_CROSS_FILE_MATCH',
      conflictingTransactionIds: sameContent,
      priorReviewItemIds: [],
    };
  }
  return { kind: 'CREATE' };
}

/** Business days are German calendar days (the landlord's day, not UTC). */
const BUSINESS_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The `Europe/Berlin` calendar day of an instant, as `YYYY-MM-DD`. */
export function businessDayOf(instant: Date): BusinessDate {
  return BUSINESS_DAY.format(instant) as BusinessDate;
}

/**
 * Imports post to closed accounts too, but only up to the day of closing:
 * statements typically arrive after the account was closed, with booking dates
 * before it. Manual Transactions stay refused on closed accounts (§31.2).
 * The closing day is the `Europe/Berlin` calendar day of `closedAt`.
 */
export function importPostable(account: FinancialAccount, bookingDate: BusinessDate): boolean {
  if (account.status === 'OPEN' || account.closedAt === null) return true;
  return bookingDate <= businessDayOf(account.closedAt);
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

/** An ImportReviewItem (data-model.md §20A) as listed and resolved. */
export interface ReviewItem {
  readonly id: ReviewItemId;
  /** The owning batch (first seen). */
  readonly importBatchId: ImportBatchId;
  readonly mreRealmId: string;
  readonly financialAccountId: FinancialAccountId;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sourceStatementKey: string;
  readonly sourceRowKey: string;
  /** The normalized row as imported (§70.2–70.3), with its position and source keys. */
  readonly normalizedRow: Readonly<Record<string, unknown>>;
  readonly ambiguityReason: AmbiguityReason;
  readonly conflictingTransactionIds: readonly string[];
  readonly priorReviewItemIds: readonly string[];
  readonly status: 'PENDING' | 'RESOLVED';
  readonly resolution: ReviewResolution | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: Date | null;
  readonly createdTransactionId: string | null;
  readonly createdAt: Date;
}

/** A Transaction an item may duplicate, shown next to the row so the decision can be made (review note on #14). */
export interface ConflictingTransaction {
  readonly id: string;
  readonly bookingDate: BusinessDate;
  readonly valueDate: BusinessDate | null;
  readonly amount: Money;
  readonly direction: Direction;
  readonly description: string | null;
  readonly counterpartyNameRaw: string | null;
  readonly counterpartyIbanRaw: string | null;
  readonly externalTransactionId: string | null;
  readonly importBatchId: string | null;
}

/**
 * What a resolve request does with an item (api-design.md §32.2): a PENDING item
 * is decided; a RESOLVED one answers the same resolution as a no-op replay and
 * refuses a different one — a review decision is never silently reversed.
 */
export function planResolution(item: Pick<ReviewItem, 'status' | 'resolution'>, resolution: ReviewResolution): 'APPLY' | 'REPLAY' | 'CONFLICT' {
  if (item.status === 'PENDING') return 'APPLY';
  return item.resolution === resolution ? 'REPLAY' : 'CONFLICT';
}

/**
 * Whether a `CREATE` resolution keeps the row's external id on the new
 * Transaction. Not after an EXTERNAL_ID_CONTENT_CONFLICT (the id belongs to the
 * other payment), and not when another Transaction holds it meanwhile: an
 * external id stays unique per account (§70.1). The Transaction keeps its
 * source-row identity either way, so a re-import references the resolved item.
 */
export function keepsExternalId(reason: AmbiguityReason, idTaken: boolean): boolean {
  return reason !== 'EXTERNAL_ID_CONTENT_CONFLICT' && !idTaken;
}

export type ResolveOutcome =
  | { readonly kind: 'RESOLVED'; readonly item: ReviewItem; readonly replayed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  /** Already RESOLVED with the other resolution (→ 409). */
  | { readonly kind: 'RESOLUTION_CONFLICT'; readonly item: ReviewItem }
  /** CREATE on an account closed before the row's booking date (→ 409, as for imports). */
  | { readonly kind: 'ACCOUNT_CLOSED'; readonly item: ReviewItem };

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
  /**
   * The items owned by the batch (never those of other batches it re-presented),
   * in file order, with the Transactions they conflict with. Undefined when the
   * batch is not in the Realm.
   */
  listReviewItems(
    importBatchId: string,
    mreRealmId: string,
    status?: ReviewItem['status'],
  ): Promise<{ readonly items: readonly ReviewItem[]; readonly conflicting: readonly ConflictingTransaction[] } | undefined>;
  /**
   * In one transaction, serialized with imports into the account: applies
   * `planResolution`; on CREATE inserts exactly one IMPORTED Transaction; marks
   * the item RESOLVED, decrements the owning batch's needsReviewCount and writes
   * the AuditRecord. The item must be owned by `importBatchId`.
   */
  resolveReviewItem(importBatchId: string, reviewItemId: string, mreRealmId: string, resolution: ReviewResolution, actor: AuditActor): Promise<ResolveOutcome>;
}

/** The normalized row as stored on a review item (§20A `normalizedRow`). */
export function normalizedRowJson(row: NormalizedBankRow): Record<string, unknown> {
  return { ...row, amount: row.amount.toJSON() };
}

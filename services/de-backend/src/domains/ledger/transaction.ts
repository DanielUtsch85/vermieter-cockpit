import type { ConfirmOutcome } from './confirm-transaction.js';
import type { CorrectionRole } from './correct-transaction.js';
import type { AuditActor, Money } from '../../shared/index.js';
import type { FinancialAccount, FinancialAccountId } from './financial-account.js';

/**
 * Transaction (data-model.md §17): one canonical, actual cash movement on a
 * FinancialAccount. Sign model (§17.4, binding): `amount` is non-negative Money
 * and the cash sign is expressed solely by `direction`.
 */

export type TransactionId = string & { readonly __brand: 'TransactionId' };

export const DIRECTIONS = ['INFLOW', 'OUTFLOW'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const TRANSACTION_STATUSES = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED', 'CONFIRMED', 'RECONCILED', 'CORRECTED', 'IGNORED'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const PROVENANCES = ['MANUAL', 'BANK_CSV', 'BANK_API', 'MIGRATION', 'CORRECTION'] as const;
export type Provenance = (typeof PROVENANCES)[number];

// Business dates live in the shared kernel since Ownership (VC-2-03) uses them too; re-exported for existing imports.
export {
  BUSINESS_DATE_MAX_YEAR,
  BUSINESS_DATE_MIN_YEAR,
  checkBusinessDate,
  parseBusinessDate,
  type BusinessDate,
  type BusinessDateError,
} from '../../shared/index.js';
import type { BusinessDate } from '../../shared/index.js';

export interface Transaction {
  readonly id: TransactionId;
  readonly mreRealmId: string;
  readonly financialAccountId: FinancialAccountId;
  readonly amount: Money;
  readonly direction: Direction;
  readonly bookingDate: BusinessDate;
  readonly valueDate: BusinessDate | null;
  readonly description: string | null;
  readonly propertyReferenceId: string | null;
  readonly provenance: Provenance;
  readonly status: TransactionStatus;
  readonly createdAt: Date;
  readonly version: number;
  /** Set once confirmed (api-design.md §34); null before. */
  readonly confirmedAt: Date | null;
  readonly confirmedBy: string | null;
  /** Correction chain (api-design.md §35.4): set on a reversal or replacement, null otherwise. */
  readonly correctionOfTransactionId: TransactionId | null;
  readonly correctionRole: CorrectionRole | null;
  /** Set on a CORRECTED original: its reversal and replacement. */
  readonly reversalTransactionId: TransactionId | null;
  readonly replacementTransactionId: TransactionId | null;
}

// Optimistic concurrency (api-design.md §16.1) is shared with other aggregates: shared/version.ts.
export { checkVersion, type VersionConflict } from '../../shared/index.js';

/** A validated manual Transaction about to be created (api-design.md §31). */
export interface NewManualTransaction {
  readonly mreRealmId: string;
  readonly financialAccountId: string;
  readonly amount: Money;
  readonly direction: Direction;
  readonly bookingDate: BusinessDate;
  readonly valueDate: BusinessDate | null;
  readonly description: string | null;
  readonly propertyReferenceId: string | null;
}

export type PostingRejection =
  /** Unknown account, or one of another Realm (→ 404). */
  | 'ACCOUNT_NOT_FOUND'
  /** No new Transactions on a closed account (→ 409). */
  | 'ACCOUNT_CLOSED'
  /** Transaction and account currency differ; there is no FX handling (§17.7). */
  | 'CURRENCY_MISMATCH'
  /** Unknown PropertyReference, or one of another Realm (→ 404). */
  | 'PROPERTY_REFERENCE_NOT_FOUND';

/**
 * Whether a new Transaction may be posted to `account` (looked up in the
 * Transaction's Realm, undefined if there is none). Historical Transactions of a
 * closed account stay valid (§16); only new ones are refused.
 */
export function checkPosting(account: FinancialAccount | undefined, transaction: NewManualTransaction): PostingRejection | undefined {
  if (account === undefined || account.mreRealmId !== transaction.mreRealmId) return 'ACCOUNT_NOT_FOUND';
  if (account.status === 'CLOSED') return 'ACCOUNT_CLOSED';
  if (account.currency !== transaction.amount.currency) return 'CURRENCY_MISMATCH';
  return undefined;
}

/** Identity of a create request for `Idempotency-Key` replays: the normalized payload. */
export function manualTransactionFingerprint(transaction: NewManualTransaction): string {
  return JSON.stringify([
    transaction.financialAccountId.toLowerCase(),
    transaction.amount.amount,
    transaction.amount.currency,
    transaction.direction,
    transaction.bookingDate,
    transaction.valueDate,
    transaction.description,
    transaction.propertyReferenceId?.toLowerCase() ?? null,
  ]);
}

export type CreateTransactionOutcome =
  | { readonly kind: 'CREATED'; readonly transaction: Transaction }
  /** Same key, same payload: the Transaction as the first request created it. */
  | { readonly kind: 'REPLAYED'; readonly transaction: Transaction }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'REJECTED'; readonly reason: PostingRejection };

/** Persistence port, implemented in infrastructure/postgres. */
export interface TransactionRepository {
  /**
   * In one transaction: claims the idempotency key (a replay answers with the
   * recorded result before any check), locks the account against a concurrent
   * close, applies `checkPosting` and the PropertyReference check, inserts the
   * Transaction and writes its AuditRecord. A rejection rolls everything back,
   * so the key is not consumed.
   */
  createManual(
    transaction: NewManualTransaction,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateTransactionOutcome>;
  /**
   * Under the Transaction's row lock, with its splits and their categories:
   * applies `planConfirm` and, if confirmable, sets CONFIRMED with
   * `confirmedAt`/`confirmedBy`, bumps the version and writes the AuditRecord.
   */
  confirm(id: string, mreRealmId: string, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ConfirmOutcome>;
}

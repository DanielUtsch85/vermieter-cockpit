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

export const TRANSACTION_STATUSES = [
  'IMPORTED',
  'UNREVIEWED',
  'CLASSIFIED',
  'CONFIRMED',
  'RECONCILED',
  'CORRECTED',
  'IGNORED',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const PROVENANCES = ['MANUAL', 'BANK_CSV', 'BANK_API', 'MIGRATION', 'CORRECTION'] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Business date `YYYY-MM-DD` (api-design.md §88); never a timestamp. */
export type BusinessDate = string & { readonly __brand: 'BusinessDate' };

const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Plausible years for a cash movement (api-design.md §88). A typo like `0202`
 * would otherwise book silently into the year 202 and distort every period.
 */
export const BUSINESS_DATE_MIN_YEAR = 1900;
export const BUSINESS_DATE_MAX_YEAR = 2100;

export type BusinessDateError = 'INVALID_FORMAT' | 'OUT_OF_RANGE';

/** A real calendar date `YYYY-MM-DD` within the plausible years, or why not. */
export function checkBusinessDate(value: string): { readonly date: BusinessDate } | { readonly error: BusinessDateError } {
  const match = BUSINESS_DATE.exec(value);
  if (match === null) return { error: 'INVALID_FORMAT' };
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0–99 to 1900–1999.
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return { error: 'INVALID_FORMAT' };
  if (y < BUSINESS_DATE_MIN_YEAR || y > BUSINESS_DATE_MAX_YEAR) return { error: 'OUT_OF_RANGE' };
  return { date: value as BusinessDate };
}

/** A valid, plausible business date, or undefined (see checkBusinessDate for the reason). */
export function parseBusinessDate(value: string): BusinessDate | undefined {
  const result = checkBusinessDate(value);
  return 'date' in result ? result.date : undefined;
}

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

/**
 * Optimistic concurrency (api-design.md §16, backlog VC-X-20): a command that would change a Transaction may name
 * the version it was based on (`If-Match`). A stale one is refused, so two people editing one draft do not
 * overwrite each other unseen. A command that changes nothing (a repeat, the same values) is answered as a no-op
 * without the check: it cannot lose an update, and a retry stays a retry.
 */
export interface VersionConflict {
  readonly kind: 'VERSION_CONFLICT';
  readonly expectedVersions: readonly number[];
  readonly currentVersion: number;
}

/**
 * `expectedVersions`: the versions named by the strong entity tags of `If-Match` (any one matches, RFC 9110
 * §13.1.1); `undefined` = no check (no header, or `*`). An empty list (only weak or foreign tags) never matches.
 */
export function checkVersion(currentVersion: number, expectedVersions: readonly number[] | undefined): VersionConflict | undefined {
  if (expectedVersions === undefined || expectedVersions.includes(currentVersion)) return undefined;
  return { kind: 'VERSION_CONFLICT', expectedVersions, currentVersion };
}

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

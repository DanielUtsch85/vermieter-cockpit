import type { AuditActor, Money } from '../../shared/index.js';
import { sameSplits, type LoanSplitRefusal, type SplitInput } from './transaction-split.js';
import type { BusinessDate, Direction, Transaction, TransactionId, TransactionStatus, VersionConflict } from './transaction.js';

/**
 * Correcting a confirmed Transaction (api-design.md §35, ADR-037): in one step
 * a confirmed reversal negates the original, a confirmed replacement carries
 * the corrected values, and the original becomes CORRECTED. The original itself
 * never changes otherwise.
 */

export const CORRECTION_ROLES = ['REVERSAL', 'REPLACEMENT'] as const;
export type CorrectionRole = (typeof CORRECTION_ROLES)[number];

/**
 * The fields of the replacement that differ from the original (§35.2).
 * `undefined` = copy the original's value; `null` clears an optional value.
 */
export interface ReplacementInput {
  readonly financialAccountId?: string;
  readonly amount?: Money;
  readonly direction?: Direction;
  readonly bookingDate?: BusinessDate;
  readonly valueDate?: BusinessDate | null;
  readonly description?: string | null;
  readonly propertyReferenceId?: string | null;
  /** A full split set (§33); omitted = the original's splits, copied. */
  readonly splits?: readonly SplitInput[];
}

export interface CorrectionRequest {
  readonly reason: string;
  /** `null`: reverse only, without a replacement (`reverse`, §35.9, VC-X-15). */
  readonly replacement: ReplacementInput | null;
}

/** The replacement as it will be written: the original overlaid with the request. */
export interface PlannedReplacement {
  readonly financialAccountId: string;
  readonly amount: Money;
  readonly direction: Direction;
  readonly bookingDate: BusinessDate;
  readonly valueDate: BusinessDate | null;
  readonly description: string | null;
  readonly propertyReferenceId: string | null;
  readonly splits: readonly SplitInput[];
  /** Whether `splits` came from the request (unknown categories → 400) or were copied (inactive → 422). */
  readonly splitsRequested: boolean;
}

/** The original as far as planning a correction needs it. */
export type CorrectionOriginal = Pick<
  Transaction,
  | 'financialAccountId'
  | 'amount'
  | 'direction'
  | 'bookingDate'
  | 'valueDate'
  | 'description'
  | 'propertyReferenceId'
  | 'status'
  | 'correctionRole'
  | 'reversalTransactionId'
  | 'replacementTransactionId'
>;

export type CorrectionPlan =
  /** `replacement` null: the original is reversed only (§35.9). */
  | { readonly kind: 'CORRECT'; readonly replacement: PlannedReplacement | null }
  /** Already CORRECTED: the ids of the existing correction, so a client that lost the answer finds it (§35.5). */
  | {
      readonly kind: 'ALREADY_CORRECTED';
      readonly reversalTransactionId: TransactionId;
      /** Null when the original was reversed without a replacement (§35.9). */
      readonly replacementTransactionId: TransactionId | null;
    }
  /** Not confirmed, IGNORED, RECONCILED (until Phase 4), or a reversal (`correctionRole`). */
  | { readonly kind: 'NOT_CORRECTABLE'; readonly status: TransactionStatus; readonly correctionRole?: 'REVERSAL' }
  /** `CONFIRMED` rent reconciliations name it: release them first (api-design §37.1, P4-D7). */
  | { readonly kind: 'TRANSACTION_RENT_RECONCILED'; readonly reconciliationIds: readonly string[] }
  /** The replacement would equal the original in every field and split (§35.2). */
  | { readonly kind: 'NO_CHANGE' };

/**
 * The checks of §35 that need no other rows: correctability, then the
 * replacement as the original overlaid with the request, then "must change
 * something". Accounts, categories, PropertyReferences and the split sum are
 * checked against the database afterwards.
 */
export function planCorrection(
  original: CorrectionOriginal,
  originalSplits: readonly SplitInput[],
  request: ReplacementInput | null,
  /** The ids of the `CONFIRMED` rent reconciliations naming the original (§37.1), in id order. */
  rentReconciliationIds: readonly string[] = [],
): CorrectionPlan {
  switch (original.status) {
    case 'CORRECTED':
      if (original.reversalTransactionId === null) {
        throw new Error('a CORRECTED Transaction without its reversal (api-design §35.6)');
      }
      return {
        kind: 'ALREADY_CORRECTED',
        reversalTransactionId: original.reversalTransactionId,
        replacementTransactionId: original.replacementTransactionId,
      };
    case 'CONFIRMED':
      if (original.correctionRole === 'REVERSAL') return { kind: 'NOT_CORRECTABLE', status: original.status, correctionRole: 'REVERSAL' };
      break;
    case 'IMPORTED':
    case 'UNREVIEWED':
    case 'CLASSIFIED':
    case 'IGNORED':
    case 'RECONCILED':
      return { kind: 'NOT_CORRECTABLE', status: original.status };
  }
  // Right after NOT_CORRECTABLE (§37.1): a matched Transaction is released first, for correct and reverse alike.
  if (rentReconciliationIds.length > 0) return { kind: 'TRANSACTION_RENT_RECONCILED', reconciliationIds: rentReconciliationIds };
  // Reverse only: nothing to overlay, and the reversal itself is the change.
  if (request === null) return { kind: 'CORRECT', replacement: null };

  const replacement: PlannedReplacement = {
    financialAccountId: request.financialAccountId ?? original.financialAccountId,
    amount: request.amount ?? original.amount,
    direction: request.direction ?? original.direction,
    bookingDate: request.bookingDate ?? original.bookingDate,
    valueDate: request.valueDate === undefined ? original.valueDate : request.valueDate,
    description: request.description === undefined ? original.description : request.description,
    propertyReferenceId: request.propertyReferenceId === undefined ? original.propertyReferenceId : request.propertyReferenceId,
    splits: request.splits ?? originalSplits,
    splitsRequested: request.splits !== undefined,
  };
  const unchanged =
    replacement.financialAccountId === original.financialAccountId &&
    replacement.amount.equals(original.amount) &&
    replacement.direction === original.direction &&
    replacement.bookingDate === original.bookingDate &&
    replacement.valueDate === original.valueDate &&
    replacement.description === original.description &&
    replacement.propertyReferenceId === original.propertyReferenceId &&
    sameSplits(originalSplits, replacement.splits);
  if (unchanged) return { kind: 'NO_CHANGE' };
  return { kind: 'CORRECT', replacement };
}

/** Which part of a replacement leaves the target account's currency: its amount, and splits by position (1-based). */
export interface CurrencyMismatch {
  readonly amount: boolean;
  readonly positions: readonly number[];
}

/** No FX (data-model.md §17.7): the replacement's amount and every split must be in the target account's currency. */
export function currencyMismatch(replacement: Pick<PlannedReplacement, 'amount' | 'splits'>, currency: string): CurrencyMismatch | undefined {
  const amount = replacement.amount.currency !== currency;
  const positions = replacement.splits.flatMap((split, i) => (split.amount.currency === currency ? [] : [i + 1]));
  return amount || positions.length > 0 ? { amount, positions } : undefined;
}

/** Opposite direction: a reversal negates the original with the same non-negative amount (data-model.md §17.4). */
export function opposite(direction: Direction): Direction {
  return direction === 'INFLOW' ? 'OUTFLOW' : 'INFLOW';
}

/** Identity of a correct request for `Idempotency-Key` replays: the original and the normalized request (§35.5). */
export function correctionFingerprint(originalId: string, request: CorrectionRequest): string {
  const r = request.replacement;
  if (r === null) return JSON.stringify([originalId.toLowerCase(), request.reason, 'reverse-only']);
  return JSON.stringify([
    originalId.toLowerCase(),
    request.reason,
    r.financialAccountId?.toLowerCase() ?? '-',
    r.amount === undefined ? '-' : [r.amount.amount, r.amount.currency],
    r.direction ?? '-',
    r.bookingDate ?? '-',
    r.valueDate === undefined ? '-' : r.valueDate,
    r.description === undefined ? '-' : r.description,
    r.propertyReferenceId === undefined ? '-' : (r.propertyReferenceId?.toLowerCase() ?? null),
    // `loanId` only when set, so keys recorded before VC-3-05 keep their fingerprint.
    r.splits?.map((s) => [
      s.amount.amount,
      s.amount.currency,
      s.financialCategoryCode,
      s.propertyReferenceId?.toLowerCase() ?? null,
      s.description,
      ...(s.loanId === null ? [] : [s.loanId.toLowerCase()]),
    ]) ?? '-',
  ]);
}

export interface CorrectionResult {
  readonly original: Transaction;
  readonly reversal: Transaction;
  /** Null when reversed only (§35.9). */
  readonly replacement: Transaction | null;
}

export type CorrectOutcome =
  | { readonly kind: 'CORRECTED'; readonly result: CorrectionResult; readonly replayed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | Exclude<CorrectionPlan, { kind: 'CORRECT' }>
  /** The target account (a changed `financialAccountId`) is unknown or of another Realm (→ 404). */
  | { readonly kind: 'ACCOUNT_NOT_FOUND'; readonly financialAccountId: string }
  /** Moving to a different, closed account (→ 409); the original's own closed account is fine (§35.2). */
  | { readonly kind: 'ACCOUNT_CLOSED'; readonly financialAccountId: string }
  /** Replacement amount or splits not in the target account's currency (no FX, §17.7); see `currencyMismatch`. */
  | ({ readonly kind: 'CURRENCY_MISMATCH' } & CurrencyMismatch)
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND'; readonly propertyReferenceIds: readonly string[] }
  /** Requested split categories unknown or inactive (→ 400, as §33). */
  | { readonly kind: 'UNKNOWN_CATEGORY'; readonly codes: readonly string[] }
  /** Copied split categories deactivated since (→ 422, as §34.2). */
  | { readonly kind: 'INACTIVE_CATEGORY'; readonly codes: readonly string[] }
  | { readonly kind: 'SUM_MISMATCH'; readonly expected: Money; readonly actual: Money }
  /** The replacement's splits with `loanId` (§41.5); the reversal mirrors the original's and is exempt. */
  | LoanSplitRefusal;

/** Persistence port, implemented in infrastructure/postgres. */
export interface CorrectionRepository {
  /**
   * In one transaction (§35.1, §35.5): claims the idempotency key (a replay
   * answers as recorded), locks the original `FOR UPDATE` and then the
   * account(s) `FOR SHARE` in id order, applies `planCorrection` and the
   * database checks, writes reversal and replacement (unconfirmed, splits,
   * confirmed), sets the original CORRECTED and writes one AuditRecord. Any
   * rejection rolls everything back, so the key is not consumed.
   */
  correct(
    originalId: string,
    mreRealmId: string,
    request: CorrectionRequest,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
    expectedVersions?: readonly number[],
  ): Promise<CorrectOutcome>;
}

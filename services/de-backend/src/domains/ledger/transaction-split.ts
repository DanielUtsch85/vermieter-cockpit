import { Money, type AuditActor, type BusinessDate } from '../../shared/index.js';
import type { Direction, TransactionId, TransactionStatus, VersionConflict } from './transaction.js';

/**
 * TransactionSplit (data-model.md §18, api-design.md §33): the economically
 * distinct components of one Transaction, e.g. a loan payment split into
 * interest and principal. Splits are non-negative and inherit the
 * Transaction's direction; their sum equals the Transaction amount exactly —
 * no rounding tolerance.
 */

/** One split as requested: validated Money, a category code and optional references. */
export interface SplitInput {
  readonly amount: Money;
  readonly financialCategoryCode: string;
  readonly propertyReferenceId: string | null;
  /** A Loan payment's interest or principal (P3-D4, api-design §41.5); never together with `propertyReferenceId`. */
  readonly loanId: string | null;
  /**
   * A security deposit's receipt, repayment or interest credit (P5-D3, api-design §47.2); never together with
   * `propertyReferenceId` or `loanId`.
   */
  readonly securityDepositId: string | null;
  readonly description: string | null;
}

export interface TransactionSplit extends SplitInput {
  readonly id: string;
  /** 1-based, in request order. */
  readonly position: number;
}

/** States whose split proposal may still change (domain-model.md §21); later ones are frozen. */
export const SPLITTABLE_STATUSES = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'] as const satisfies readonly TransactionStatus[];

export type SplitPlan =
  /** A valid, complete split set: the Transaction becomes CLASSIFIED. */
  | { readonly kind: 'APPLY'; readonly nextStatus: 'CLASSIFIED' }
  /** CONFIRMED and later are frozen (correct via reversal, ADR-037); IGNORED is out of the ledger. */
  | { readonly kind: 'FROZEN'; readonly status: TransactionStatus }
  | { readonly kind: 'CURRENCY_MISMATCH'; readonly positions: readonly number[] }
  | { readonly kind: 'SUM_MISMATCH'; readonly expected: Money; readonly actual: Money };

/**
 * Checks a full replacement split set against its Transaction, in this order:
 * frozen status, currency (no FX, §17.7), exact sum (§18).
 */
export function planSplits(transaction: { readonly amount: Money; readonly status: TransactionStatus }, splits: readonly SplitInput[]): SplitPlan {
  if (!(SPLITTABLE_STATUSES as readonly TransactionStatus[]).includes(transaction.status)) {
    return { kind: 'FROZEN', status: transaction.status };
  }
  const currency = transaction.amount.currency;
  const foreign = splits.flatMap((split, i) => (split.amount.currency === currency ? [] : [i + 1]));
  if (foreign.length > 0) return { kind: 'CURRENCY_MISMATCH', positions: foreign };
  const actual = Money.sum(
    splits.map((s) => s.amount),
    currency,
  );
  if (!actual.equals(transaction.amount)) return { kind: 'SUM_MISMATCH', expected: transaction.amount, actual };
  return { kind: 'APPLY', nextStatus: 'CLASSIFIED' };
}

/** Whether a replacement would change nothing (same splits in the same order): then no new version, no AuditRecord. */
export function sameSplits(current: readonly SplitInput[], next: readonly SplitInput[]): boolean {
  return (
    current.length === next.length &&
    current.every((c, i) => {
      const n = next[i];
      return (
        n !== undefined &&
        c.amount.equals(n.amount) &&
        c.financialCategoryCode === n.financialCategoryCode &&
        c.propertyReferenceId === n.propertyReferenceId &&
        c.loanId === n.loanId &&
        c.securityDepositId === n.securityDepositId &&
        c.description === n.description
      );
    })
  );
}

/** The categories a split with `loanId` may carry (§41.5, data-model §72). */
export const LOAN_SPLIT_CATEGORIES = ['LOAN_INTEREST', 'LOAN_PRINCIPAL'] as const;

/**
 * Why a split set's Loans refuse it (api-design §41.5, §41.7): 404, 422 INVALID_LOAN_SPLIT, 409 LOAN_NOT_ACTIVE,
 * 409 LOAN_CLOSED.
 */
export type LoanSplitRefusal =
  | { readonly kind: 'LOAN_NOT_FOUND'; readonly loanId: string }
  | { readonly kind: 'INVALID_LOAN_SPLIT'; readonly position: number; readonly reason: 'CATEGORY' | 'DIRECTION' }
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly loanId: string; readonly status: string }
  | { readonly kind: 'LOAN_CLOSED'; readonly loanId: string; readonly closingDate: BusinessDate };

/** A Loan as the split rules read it: its status and, while `CLOSED`, its closing date. */
export interface SplitLoan {
  readonly status: string;
  readonly closingDate: BusinessDate | null;
}

/**
 * The rules of §41.5 for the splits with `loanId`, in its order: every unknown or foreign Loan first, then the
 * category, then the direction (a reversal is exempt), then a `VOID` Loan, then a `CLOSED` one whose closing date is
 * before the booking date (§41.7, a reversal exempt); each for the first split in position order. `loans` holds the
 * Loans found in the Realm.
 */
export function checkLoanSplits(
  transaction: { readonly direction: Direction; readonly reversal: boolean; readonly bookingDate: BusinessDate },
  splits: readonly SplitInput[],
  loans: ReadonlyMap<string, SplitLoan>,
): LoanSplitRefusal | undefined {
  const withLoan = splits.flatMap((split, i) => (split.loanId === null ? [] : [{ split, loanId: split.loanId, position: i + 1 }]));
  const unknown = withLoan.find((s) => !loans.has(s.loanId));
  if (unknown !== undefined) return { kind: 'LOAN_NOT_FOUND', loanId: unknown.loanId };
  const category = withLoan.find((s) => !(LOAN_SPLIT_CATEGORIES as readonly string[]).includes(s.split.financialCategoryCode));
  if (category !== undefined) return { kind: 'INVALID_LOAN_SPLIT', position: category.position, reason: 'CATEGORY' };
  if (withLoan.length > 0 && transaction.direction !== 'OUTFLOW' && !transaction.reversal) {
    return { kind: 'INVALID_LOAN_SPLIT', position: (withLoan[0] as (typeof withLoan)[number]).position, reason: 'DIRECTION' };
  }
  const inactive = withLoan.find((s) => loans.get(s.loanId)?.status === 'VOID');
  if (inactive !== undefined) return { kind: 'LOAN_NOT_ACTIVE', loanId: inactive.loanId, status: 'VOID' };
  if (transaction.reversal) return undefined;
  for (const s of withLoan) {
    const loan = loans.get(s.loanId);
    if (loan?.status === 'CLOSED' && loan.closingDate !== null && transaction.bookingDate > loan.closingDate) {
      return { kind: 'LOAN_CLOSED', loanId: s.loanId, closingDate: loan.closingDate };
    }
  }
  return undefined;
}

/** The categories a split with `securityDepositId` may carry (§47.2, P5-D5). */
export const DEPOSIT_SPLIT_CATEGORIES = ['SECURITY_DEPOSIT', 'SECURITY_DEPOSIT_INTEREST'] as const;

/**
 * Why a split set's security deposits refuse it (api-design §47.2, §47.4): 404, 422 INVALID_SECURITY_DEPOSIT_SPLIT,
 * 409 DEPOSIT_NOT_ACTIVE, 409 DEPOSIT_CLOSED.
 */
export type DepositSplitRefusal =
  | { readonly kind: 'SECURITY_DEPOSIT_NOT_FOUND'; readonly securityDepositId: string }
  | { readonly kind: 'INVALID_SECURITY_DEPOSIT_SPLIT'; readonly position: number; readonly reason: 'CATEGORY' | 'DIRECTION' }
  | { readonly kind: 'DEPOSIT_NOT_ACTIVE'; readonly securityDepositId: string; readonly status: string }
  | { readonly kind: 'DEPOSIT_CLOSED'; readonly securityDepositId: string };

/**
 * The rules of §47.2 for the splits with `securityDepositId`, in its order: every unknown or foreign deposit first, then
 * the category, then the direction of an interest credit (a reversal is exempt), then a `VOID` deposit, then a
 * `CLOSED` one (§47.4: a reversal is exempt, and a replacement for the deposits its original names, `keeps`); each for
 * the first split in position order. `deposits` holds the statuses of the deposits found in the Realm.
 */
export function checkDepositSplits(
  transaction: { readonly direction: Direction; readonly reversal: boolean; readonly keeps?: ReadonlySet<string> },
  splits: readonly SplitInput[],
  deposits: ReadonlyMap<string, string>,
): DepositSplitRefusal | undefined {
  const withDeposit = splits.flatMap((split, i) =>
    split.securityDepositId === null ? [] : [{ split, securityDepositId: split.securityDepositId, position: i + 1 }],
  );
  const unknown = withDeposit.find((s) => !deposits.has(s.securityDepositId));
  if (unknown !== undefined) return { kind: 'SECURITY_DEPOSIT_NOT_FOUND', securityDepositId: unknown.securityDepositId };
  const category = withDeposit.find((s) => !(DEPOSIT_SPLIT_CATEGORIES as readonly string[]).includes(s.split.financialCategoryCode));
  if (category !== undefined) return { kind: 'INVALID_SECURITY_DEPOSIT_SPLIT', position: category.position, reason: 'CATEGORY' };
  // A receipt (INFLOW) and a repayment (OUTFLOW) are both SECURITY_DEPOSIT; only interest has a direction rule.
  const interest = withDeposit.find((s) => s.split.financialCategoryCode === 'SECURITY_DEPOSIT_INTEREST');
  if (interest !== undefined && transaction.direction !== 'INFLOW' && !transaction.reversal) {
    return { kind: 'INVALID_SECURITY_DEPOSIT_SPLIT', position: interest.position, reason: 'DIRECTION' };
  }
  const inactive = withDeposit.find((s) => deposits.get(s.securityDepositId) === 'VOID');
  if (inactive !== undefined) return { kind: 'DEPOSIT_NOT_ACTIVE', securityDepositId: inactive.securityDepositId, status: 'VOID' };
  const closed = withDeposit.find(
    (s) => deposits.get(s.securityDepositId) === 'CLOSED' && !transaction.reversal && !(transaction.keeps?.has(s.securityDepositId) ?? false),
  );
  if (closed !== undefined) return { kind: 'DEPOSIT_CLOSED', securityDepositId: closed.securityDepositId };
  return undefined;
}

/** The categories whose splits name their unit and need a WEG membership on the booking date (§49.3, P6-D2). */
export const WEG_SPLIT_CATEGORIES = ['WEG_RECOVERABLE', 'WEG_NON_RECOVERABLE', 'WEG_RESERVE_CONTRIBUTION'] as const;

/** Why a split set's WEG splits refuse it (api-design §49.3): 422 NO_WEG_MEMBERSHIP. */
export type WegSplitRefusal =
  | { readonly kind: 'NO_WEG_MEMBERSHIP'; readonly position: number; readonly reason: 'NO_UNIT' }
  | {
      readonly kind: 'NO_WEG_MEMBERSHIP';
      readonly position: number;
      readonly reason: 'NO_MEMBERSHIP';
      readonly propertyReferenceId: string;
      readonly bookingDate: BusinessDate;
    };

export const isWegSplit = (split: Pick<SplitInput, 'financialCategoryCode'>) =>
  (WEG_SPLIT_CATEGORIES as readonly string[]).includes(split.financialCategoryCode);

/**
 * The rule of §49.3 in its order: every WEG split without a unit first (`NO_UNIT`), then one whose unit has no
 * `ACTIVE` membership on the booking date (`NO_MEMBERSHIP`); each for the first split in position order. A reversal is
 * exempt. `unitsWithMembership` holds the units with such a membership, read after the unit's lock.
 */
export function checkWegSplits(
  transaction: { readonly reversal: boolean; readonly bookingDate: BusinessDate },
  splits: readonly SplitInput[],
  unitsWithMembership: ReadonlySet<string>,
): WegSplitRefusal | undefined {
  if (transaction.reversal) return undefined;
  const weg = splits.flatMap((split, i) => (isWegSplit(split) ? [{ split, position: i + 1 }] : []));
  const noUnit = weg.find((s) => s.split.propertyReferenceId === null);
  if (noUnit !== undefined) return { kind: 'NO_WEG_MEMBERSHIP', position: noUnit.position, reason: 'NO_UNIT' };
  const noMembership = weg.find((s) => !unitsWithMembership.has(s.split.propertyReferenceId as string));
  if (noMembership !== undefined) {
    return {
      kind: 'NO_WEG_MEMBERSHIP',
      position: noMembership.position,
      reason: 'NO_MEMBERSHIP',
      propertyReferenceId: noMembership.split.propertyReferenceId as string,
      bookingDate: transaction.bookingDate,
    };
  }
  return undefined;
}

/** The Transaction as far as a split response needs it. */
export interface SplitTransaction {
  readonly id: TransactionId;
  readonly amount: Money;
  readonly direction: Direction;
  readonly status: TransactionStatus;
  readonly version: number;
}

export type ReplaceSplitsOutcome =
  | {
      readonly kind: 'REPLACED';
      readonly transaction: SplitTransaction;
      readonly splits: readonly TransactionSplit[];
      /** false when the request repeated the current split set (naturally idempotent, §33.1). */
      readonly changed: boolean;
    }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict
  | Exclude<SplitPlan, { kind: 'APPLY' }>
  /** Unknown or inactive category codes. */
  | { readonly kind: 'UNKNOWN_CATEGORY'; readonly codes: readonly string[] }
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND'; readonly propertyReferenceIds: readonly string[] }
  | LoanSplitRefusal
  | DepositSplitRefusal
  | WegSplitRefusal;

/** Persistence port, implemented in infrastructure/postgres. */
export interface TransactionSplitRepository {
  /**
   * In one transaction, under the Transaction's row lock: applies `planSplits`,
   * resolves categories and PropertyReferences in the Realm, then locks the
   * Loans `FOR UPDATE` in id order and applies `checkLoanSplits` (Transaction →
   * Loan, P3-D8), then the security deposits in id order and `checkDepositSplits`
   * (→ SecurityDeposit, P5-D9), replaces the split
   * set atomically, sets the status and version and writes the AuditRecord.
   */
  replaceSplits(
    transactionId: string,
    mreRealmId: string,
    splits: readonly SplitInput[],
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ReplaceSplitsOutcome>;
}

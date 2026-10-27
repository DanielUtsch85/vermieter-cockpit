import type { BusinessDate, VersionConflict } from '../../shared/index.js';
import { actualOn, type CountedSplit } from './debt.js';
import { debtFrom, type ClosingReason, type Loan, type LoanStatus } from './loan.js';

/**
 * Closing a Loan (api-design.md §41.7, backlog VC-3-07, phase-3-plan P3-D7): repaid, taken over by another Loan
 * (Umschuldung: a new Loan plus this close), or for another reason. `CLOSED` is final; afterwards no split may name the
 * Loan on a later booking date and the remaining debt is 0.
 */

export interface CloseRequest {
  readonly closingDate: BusinessDate;
  readonly reason: ClosingReason;
  /** Exactly for `REFINANCED`, never the Loan itself (the API checks both). */
  readonly refinancedByLoanId: string | null;
  /** Required for `OTHER`. */
  readonly closingNote: string | null;
}

/** A split that could still count, on a Transaction booked after the closing date (review on #71). */
export interface SplitAfterClosing {
  readonly transactionId: string;
  readonly bookingDate: BusinessDate;
}

export type ClosePlan =
  /** `settledAmount`: the actual remaining debt on `closingDate`, signed cents; for `REFINANCED` what the other Loan took over. */
  | { readonly kind: 'CLOSE'; readonly next: Loan; readonly settledAmount: bigint }
  /** Already `CLOSED` with exactly these values: a 200 no-op whatever the version. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  | { readonly kind: 'CLOSING_BEFORE_DEBT'; readonly debtFrom: BusinessDate }
  | { readonly kind: 'REFINANCING_LOAN_NOT_FOUND'; readonly refinancedByLoanId: string }
  | { readonly kind: 'REFINANCING_LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  | { readonly kind: 'SPLITS_AFTER_CLOSING'; readonly transactionIds: readonly string[] }
  /** `actual`: signed cents, positive while debt is left, negative when more was paid. */
  | { readonly kind: 'REMAINING_DEBT_NOT_ZERO'; readonly actual: bigint };

const sameClose = (loan: Loan, request: CloseRequest) =>
  loan.closingDate === request.closingDate &&
  loan.closingReason === request.reason &&
  loan.refinancedByLoanId === request.refinancedByLoanId &&
  loan.closingNote === request.closingNote;

/**
 * Checks 3–7 of §41.7's order. `refinancing`: the named Loan of the Realm, undefined when unknown or foreign (only read
 * for `REFINANCED`); `splitsAfter`: the splits that could still count after `closingDate`; `counted`: the Loan's
 * counted splits (§41.5).
 */
export function planClose(
  loan: Loan,
  request: CloseRequest,
  refinancing: Loan | undefined,
  splitsAfter: readonly SplitAfterClosing[],
  counted: readonly CountedSplit[],
): ClosePlan {
  if (loan.status === 'CLOSED' && sameClose(loan, request)) return { kind: 'UNCHANGED' };
  if (loan.status !== 'ACTIVE') return { kind: 'LOAN_NOT_ACTIVE', status: loan.status };
  const from = debtFrom(loan);
  if (request.closingDate < from) return { kind: 'CLOSING_BEFORE_DEBT', debtFrom: from };
  if (request.reason === 'REFINANCED') {
    if (refinancing === undefined) return { kind: 'REFINANCING_LOAN_NOT_FOUND', refinancedByLoanId: request.refinancedByLoanId as string };
    if (refinancing.status !== 'ACTIVE') return { kind: 'REFINANCING_LOAN_NOT_ACTIVE', status: refinancing.status };
  }
  if (splitsAfter.length > 0) {
    const ordered = [...splitsAfter].sort((x, y) => (x.bookingDate !== y.bookingDate ? (x.bookingDate < y.bookingDate ? -1 : 1) : x.transactionId < y.transactionId ? -1 : 1));
    return { kind: 'SPLITS_AFTER_CLOSING', transactionIds: [...new Set(ordered.map((s) => s.transactionId))] };
  }
  const settledAmount = actualOn(loan, counted, request.closingDate);
  if (request.reason === 'REPAID' && settledAmount !== 0n) return { kind: 'REMAINING_DEBT_NOT_ZERO', actual: settledAmount };
  return {
    kind: 'CLOSE',
    settledAmount,
    next: {
      ...loan,
      status: 'CLOSED',
      closingDate: request.closingDate,
      closingReason: request.reason,
      refinancedByLoanId: request.refinancedByLoanId,
      closingNote: request.closingNote,
      version: loan.version + 1,
    },
  };
}

export type CloseLoanOutcome =
  | { readonly kind: 'CLOSED'; readonly loan: Loan; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<ClosePlan, { kind: 'CLOSE' | 'UNCHANGED' }>
  | VersionConflict;

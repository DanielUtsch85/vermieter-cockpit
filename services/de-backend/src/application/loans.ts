import {
  createFingerprint,
  type CloseRequest,
  type Loan,
  type LoanChanges,
  type LoanData,
  type LoanFieldError,
  type LoanFilter,
  type LoanPage,
  type LoanRepository,
  type LoanStatus,
} from '../domains/financing/index.js';
import type { BusinessDate } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { AcquisitionNotFoundError, OwnerInactiveError } from './ownerships.js';
import { PartyNotFoundError } from './parties.js';

/**
 * Loan commands and reads (api-design.md §41.1, backlog VC-3-01), in the caller's verified Realm. Input arrives
 * validated and normalized from the API boundary (principal > 0, texts trimmed, the cross-field rules checked).
 */

export class LoanNotFoundError extends Error {
  override readonly name = 'LoanNotFoundError';

  constructor(readonly loanId: string) {
    super(`Loan ${loanId} not found`);
  }
}

/** `VOID` or `CLOSED`: no amend, a no-op included (→ 409 LOAN_NOT_ACTIVE). */
export class LoanNotActiveError extends Error {
  override readonly name = 'LoanNotActiveError';

  constructor(
    readonly loanId: string,
    readonly status: LoanStatus,
  ) {
    super(`Loan ${loanId} is ${status}`);
  }
}

/** A closed Loan is final (→ 409 LOAN_CLOSED). */
export class LoanClosedError extends Error {
  override readonly name = 'LoanClosedError';

  constructor(readonly loanId: string) {
    super(`Loan ${loanId} is closed`);
  }
}

/** Splits reference the Loan (→ 409 LOAN_HAS_SPLITS; from VC-3-05). */
export class LoanHasSplitsError extends Error {
  override readonly name = 'LoanHasSplitsError';

  constructor(
    readonly loanId: string,
    readonly transactionIds: readonly string[],
  ) {
    super(`Loan ${loanId} is referenced by splits of ${transactionIds.join(', ')}`);
  }
}

/** A `CLOSED` Loan names this one as its refinancing (→ 409 LOAN_REFINANCES; §41.7, review on #71). */
export class LoanRefinancesError extends Error {
  override readonly name = 'LoanRefinancesError';

  constructor(
    readonly loanId: string,
    readonly loanIds: readonly string[],
  ) {
    super(`Loan ${loanId} took over ${loanIds.join(', ')}`);
  }
}

/** A split or a booking date after a `CLOSED` Loan's closing date (→ 409 LOAN_CLOSED; §41.7). */
export class LoanClosedOnError extends Error {
  override readonly name = 'LoanClosedOnError';

  constructor(
    readonly loanId: string,
    readonly closingDate: BusinessDate,
  ) {
    super(`Loan ${loanId} was closed on ${closingDate}`);
  }
}

/** The closing date is before the debt starts (→ 422 CLOSING_BEFORE_DEBT). */
export class ClosingBeforeDebtError extends Error {
  override readonly name = 'ClosingBeforeDebtError';

  constructor(readonly debtFrom: BusinessDate) {
    super(`The closing date is before the debt starts on ${debtFrom}`);
  }
}

/** The named refinancing Loan is unknown or of another Realm (→ 404 with `details.refinancedByLoanId`). */
export class RefinancingLoanNotFoundError extends Error {
  override readonly name = 'RefinancingLoanNotFoundError';

  constructor(readonly refinancedByLoanId: string) {
    super(`Loan ${refinancedByLoanId} not found`);
  }
}

/** The named refinancing Loan is not `ACTIVE` (→ 422 REFINANCING_LOAN_NOT_ACTIVE). */
export class RefinancingLoanNotActiveError extends Error {
  override readonly name = 'RefinancingLoanNotActiveError';

  constructor(readonly status: LoanStatus) {
    super(`The refinancing Loan is ${status}`);
  }
}

/** Splits that could still count lie after the closing date (→ 409 SPLITS_AFTER_CLOSING). */
export class SplitsAfterClosingError extends Error {
  override readonly name = 'SplitsAfterClosingError';

  constructor(readonly transactionIds: readonly string[]) {
    super(`Transactions ${transactionIds.join(', ')} are booked after the closing date`);
  }
}

/** `REPAID` while the actual remaining debt on the closing date is not 0 (→ 409 REMAINING_DEBT_NOT_ZERO). */
export class RemainingDebtNotZeroError extends Error {
  override readonly name = 'RemainingDebtNotZeroError';

  /** `actual`: signed cents. */
  constructor(readonly actual: bigint) {
    super(`The remaining debt on the closing date is ${actual} cents, not 0`);
  }
}

/** A rule over the amended Loan's merged fields (→ 400 with the field and code). */
export class LoanFieldsInvalidError extends Error {
  override readonly name = 'LoanFieldsInvalidError';

  constructor(readonly errors: readonly LoanFieldError[]) {
    super(errors.map((e) => `${e.field}: ${e.code}`).join(', '));
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export interface CreateLoanInput extends LoanData {
  readonly principal: RealmPrincipal;
  readonly idempotencyKey?: string;
}

export type CreateLoan = (input: CreateLoanInput) => Promise<{ readonly loan: Loan; readonly replayed: boolean }>;

export function createLoan(deps: { readonly repository: LoanRepository }): CreateLoan {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const loan = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.create(
      loan,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: createFingerprint(loan) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { loan: outcome.loan, replayed: false };
      case 'REPLAYED':
        return { loan: outcome.loan, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(outcome.partyId);
      case 'ACQUISITION_NOT_FOUND':
        throw new AcquisitionNotFoundError(outcome.acquisitionId);
      case 'PARTY_INACTIVE':
        throw new OwnerInactiveError(outcome.partyId);
    }
  };
}

export type GetLoan = (input: { readonly principal: RealmPrincipal; readonly loanId: string }) => Promise<Loan>;

export function getLoan(deps: { readonly repository: LoanRepository }): GetLoan {
  return async ({ principal, loanId }) => {
    const loan = await deps.repository.findById(loanId, principal.mreRealmId);
    // Unknown and other-Realm Loans look the same, so existence does not leak.
    if (loan === undefined) throw new LoanNotFoundError(loanId);
    return loan;
  };
}

export type ListLoans = (input: {
  readonly principal: RealmPrincipal;
  readonly filter: LoanFilter;
  readonly page: { readonly page: number; readonly pageSize: number };
}) => Promise<LoanPage>;

export function listLoans(deps: { readonly repository: LoanRepository }): ListLoans {
  return ({ principal, filter, page }) => deps.repository.list(principal.mreRealmId, filter, page);
}

export type AmendLoan = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly changes: LoanChanges;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly loan: Loan; readonly changed: boolean }>;

export function amendLoan(deps: { readonly repository: LoanRepository }): AmendLoan {
  return async ({ principal, loanId, changes, expectedVersions }) => {
    const outcome = await deps.repository.amend(loanId, principal.mreRealmId, changes, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'AMENDED':
        return { loan: outcome.loan, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new LoanNotFoundError(loanId);
      case 'LOAN_NOT_ACTIVE':
        throw new LoanNotActiveError(loanId, outcome.status);
      case 'INVALID':
        throw new LoanFieldsInvalidError(outcome.errors);
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(outcome.partyId);
      case 'PARTY_INACTIVE':
        throw new OwnerInactiveError(outcome.partyId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type VoidLoan = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly loan: Loan; readonly changed: boolean }>;

export function voidLoan(deps: { readonly repository: LoanRepository; readonly now?: () => Date }): VoidLoan {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, loanId, reason, expectedVersions }) => {
    const outcome = await deps.repository.void(loanId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { loan: outcome.loan, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new LoanNotFoundError(loanId);
      case 'LOAN_CLOSED':
        throw new LoanClosedError(loanId);
      case 'LOAN_HAS_SPLITS':
        throw new LoanHasSplitsError(loanId, outcome.transactionIds);
      case 'LOAN_REFINANCES':
        throw new LoanRefinancesError(loanId, outcome.loanIds);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type CloseLoan = (
  input: CloseRequest & { readonly principal: RealmPrincipal; readonly loanId: string; readonly expectedVersions?: readonly number[] },
) => Promise<{
  readonly loan: Loan;
  readonly changed: boolean;
}>;

/** §41.7's close; a repeat with the same values is a no-op. */
export function closeLoan(deps: { readonly repository: LoanRepository }): CloseLoan {
  return async ({ principal, loanId, expectedVersions, ...request }) => {
    const outcome = await deps.repository.close(loanId, principal.mreRealmId, request, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'CLOSED':
        return { loan: outcome.loan, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new LoanNotFoundError(loanId);
      case 'LOAN_NOT_ACTIVE':
        throw new LoanNotActiveError(loanId, outcome.status);
      case 'CLOSING_BEFORE_DEBT':
        throw new ClosingBeforeDebtError(outcome.debtFrom);
      case 'REFINANCING_LOAN_NOT_FOUND':
        throw new RefinancingLoanNotFoundError(outcome.refinancedByLoanId);
      case 'REFINANCING_LOAN_NOT_ACTIVE':
        throw new RefinancingLoanNotActiveError(outcome.status);
      case 'SPLITS_AFTER_CLOSING':
        throw new SplitsAfterClosingError(outcome.transactionIds);
      case 'REMAINING_DEBT_NOT_ZERO':
        throw new RemainingDebtNotZeroError(outcome.actual);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

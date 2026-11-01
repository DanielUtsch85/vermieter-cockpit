import type {
  AssessmentSplitRefusal,
  DepositSplitRefusal,
  FinancialCategory,
  FinancialCategoryRepository,
  LoanSplitRefusal,
  SplitInput,
  SplitTransaction,
  StatementSplitRefusal,
  TransactionSplit,
  TransactionSplitRepository,
  TransactionStatus,
  WegSplitRefusal,
} from '../domains/ledger/index.js';
import type { LoanStatus } from '../domains/financing/index.js';
import type { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { VersionConflictError } from './errors.js';
import { LoanClosedOnError, LoanNotActiveError, LoanNotFoundError } from './loans.js';
import { DepositClosedError, DepositNotActiveError, SecurityDepositNotFoundError } from './security-deposits.js';
import { CurrencyMismatchError } from './errors.js';

/**
 * Set Transaction splits (api-design.md §33, backlog VC-1-07): replaces the
 * unconfirmed split proposal of a Transaction in the caller's Realm. Input
 * arrives validated from the API boundary (non-negative Money, no direction).
 */

export class TransactionNotFoundError extends Error {
  override readonly name = 'TransactionNotFoundError';

  constructor(readonly transactionId: string) {
    super(`Transaction ${transactionId} not found`);
  }
}

/** CONFIRMED and later are frozen; IGNORED is excluded from the ledger (→ 409). */
export class TransactionFrozenError extends Error {
  override readonly name = 'TransactionFrozenError';

  constructor(
    readonly transactionId: string,
    readonly status: TransactionStatus,
  ) {
    super(`Transaction ${transactionId} is ${status}; its splits cannot change`);
  }
}

/** sum(splits) ≠ Transaction amount (→ 409; checked exactly, data-model.md §18). */
export class SplitSumMismatchError extends Error {
  override readonly name = 'SplitSumMismatchError';

  constructor(
    readonly expected: Money,
    readonly actual: Money,
  ) {
    super(`Splits sum to ${actual.toString()}, the Transaction amount is ${expected.toString()}`);
  }
}

export class FinancialCategoryNotFoundError extends Error {
  override readonly name = 'FinancialCategoryNotFoundError';

  constructor(readonly codes: readonly string[]) {
    super(`Unknown or inactive financial categories: ${codes.join(', ')}`);
  }
}

/** A split with `loanId` breaks a rule of §41.5 (→ 422 INVALID_LOAN_SPLIT). */
export class InvalidLoanSplitError extends Error {
  override readonly name = 'InvalidLoanSplitError';

  constructor(
    readonly position: number,
    readonly reason: 'CATEGORY' | 'DIRECTION',
  ) {
    super(`Split ${position}: a split with a Loan is LOAN_INTEREST or LOAN_PRINCIPAL of an OUTFLOW (${reason})`);
  }
}

/** A split with `securityDepositId` breaks a rule of §47.2 (→ 422 INVALID_SECURITY_DEPOSIT_SPLIT). */
export class InvalidSecurityDepositSplitError extends Error {
  override readonly name = 'InvalidSecurityDepositSplitError';

  constructor(
    readonly position: number,
    readonly reason: 'CATEGORY' | 'DIRECTION',
  ) {
    super(`Split ${position}: a split with a security deposit is SECURITY_DEPOSIT, or SECURITY_DEPOSIT_INTEREST of an INFLOW (${reason})`);
  }
}

/** A WEG split without a unit, or whose unit has no membership on the booking date (§49.3 → 422 NO_WEG_MEMBERSHIP). */
export class NoWegMembershipError extends Error {
  override readonly name = 'NoWegMembershipError';

  constructor(
    readonly position: number | null,
    readonly reason: 'NO_UNIT' | 'NO_MEMBERSHIP',
    readonly propertyReferenceId: string | null = null,
    readonly bookingDate: string | null = null,
  ) {
    super(reason === 'NO_UNIT' ? 'A WEG split names its unit' : `Unit ${propertyReferenceId} has no WEG membership on ${bookingDate}`);
  }
}

/** A split names a statement unknown in the Realm (§51 → 404 NOT_FOUND with `details.wegAnnualStatementId`). */
export class WegStatementNotFoundError extends Error {
  override readonly name = 'WegStatementNotFoundError';

  constructor(readonly wegAnnualStatementId: string) {
    super(`WEG annual statement ${wegAnnualStatementId} not found`);
  }
}

/** A split naming a statement is not in a WEG category, or not of the statement's unit (§51 → 422 INVALID_WEG_STATEMENT_SPLIT). */
export class InvalidWegStatementSplitError extends Error {
  override readonly name = 'InvalidWegStatementSplitError';

  constructor(
    readonly position: number,
    readonly reason: 'CATEGORY' | 'UNIT',
  ) {
    super(`Split ${position}: a split naming a statement is a WEG split of the statement's unit (${reason})`);
  }
}

/** A settlement names a statement that is not `CONFIRMED` (§51 → 409 STATEMENT_NOT_CURRENT). */
export class StatementNotCurrentError extends Error {
  override readonly name = 'StatementNotCurrentError';

  constructor(
    readonly wegAnnualStatementId: string,
    readonly status: string,
    readonly supersededBy: string | null,
  ) {
    super(`WEG annual statement ${wegAnnualStatementId} is ${status}`);
  }
}

/** A split names a Sonderumlage unknown in the Realm (§51A → 404 NOT_FOUND with `details.wegSpecialAssessmentId`). */
export class WegAssessmentNotFoundError extends Error {
  override readonly name = 'WegAssessmentNotFoundError';

  constructor(readonly wegSpecialAssessmentId: string) {
    super(`WEG special assessment ${wegSpecialAssessmentId} not found`);
  }
}

/** A split naming a Sonderumlage is not WEG_SPECIAL_ASSESSMENT, or not of its unit (§51A → 422 INVALID_WEG_ASSESSMENT_SPLIT). */
export class InvalidWegAssessmentSplitError extends Error {
  override readonly name = 'InvalidWegAssessmentSplitError';

  constructor(
    readonly position: number,
    readonly reason: 'CATEGORY' | 'UNIT',
  ) {
    super(`Split ${position}: a split naming a Sonderumlage is WEG_SPECIAL_ASSESSMENT of its unit (${reason})`);
  }
}

/** The Sonderumlage is `VOID` (§51A → 409 ASSESSMENT_NOT_ACTIVE). */
export class AssessmentNotActiveError extends Error {
  override readonly name = 'AssessmentNotActiveError';

  constructor(
    readonly wegSpecialAssessmentId: string,
    readonly status: string,
  ) {
    super(`WEG special assessment ${wegSpecialAssessmentId} is ${status}`);
  }
}

/** The refusals of §41.5, §47.2, §49.3, §51 and §51A as errors, shared by the splits command and `correct`. */
export function throwSplitRefusal(refusal: LoanSplitRefusal | DepositSplitRefusal | WegSplitRefusal | StatementSplitRefusal | AssessmentSplitRefusal): never {
  switch (refusal.kind) {
    case 'WEG_ASSESSMENT_NOT_FOUND':
      throw new WegAssessmentNotFoundError(refusal.wegSpecialAssessmentId);
    case 'INVALID_WEG_ASSESSMENT_SPLIT':
      throw new InvalidWegAssessmentSplitError(refusal.position, refusal.reason);
    case 'ASSESSMENT_NOT_ACTIVE':
      throw new AssessmentNotActiveError(refusal.wegSpecialAssessmentId, refusal.status);
    case 'WEG_STATEMENT_NOT_FOUND':
      throw new WegStatementNotFoundError(refusal.wegAnnualStatementId);
    case 'INVALID_WEG_STATEMENT_SPLIT':
      throw new InvalidWegStatementSplitError(refusal.position, refusal.reason);
    case 'STATEMENT_NOT_CURRENT':
      throw new StatementNotCurrentError(refusal.wegAnnualStatementId, refusal.status, refusal.supersededBy);
    case 'NO_WEG_MEMBERSHIP':
      throw refusal.reason === 'NO_UNIT'
        ? new NoWegMembershipError(refusal.position, 'NO_UNIT')
        : new NoWegMembershipError(refusal.position, 'NO_MEMBERSHIP', refusal.propertyReferenceId, refusal.bookingDate);
    case 'SECURITY_DEPOSIT_NOT_FOUND':
      throw new SecurityDepositNotFoundError(refusal.securityDepositId);
    case 'INVALID_SECURITY_DEPOSIT_SPLIT':
      throw new InvalidSecurityDepositSplitError(refusal.position, refusal.reason);
    case 'DEPOSIT_NOT_ACTIVE':
      throw new DepositNotActiveError(refusal.securityDepositId, 'VOID');
    case 'DEPOSIT_CLOSED':
      throw new DepositClosedError(refusal.securityDepositId);
    case 'LOAN_NOT_FOUND':
      throw new LoanNotFoundError(refusal.loanId);
    case 'INVALID_LOAN_SPLIT':
      throw new InvalidLoanSplitError(refusal.position, refusal.reason);
    case 'LOAN_NOT_ACTIVE':
      throw new LoanNotActiveError(refusal.loanId, refusal.status as LoanStatus);
    case 'LOAN_CLOSED':
      throw new LoanClosedOnError(refusal.loanId, refusal.closingDate);
  }
}

export interface SetTransactionSplitsResult {
  readonly transaction: SplitTransaction;
  readonly splits: readonly TransactionSplit[];
}

export type SetTransactionSplits = (input: {
  readonly principal: RealmPrincipal;
  readonly transactionId: string;
  readonly splits: readonly SplitInput[];
  /** From `If-Match` (api-design §16); omitted = no version check. */
  readonly expectedVersions?: readonly number[];
}) => Promise<SetTransactionSplitsResult>;

export function setTransactionSplits(deps: { readonly repository: TransactionSplitRepository }): SetTransactionSplits {
  return async ({ principal, transactionId, splits, expectedVersions }) => {
    const outcome = await deps.repository.replaceSplits(
      transactionId,
      principal.mreRealmId,
      splits,
      { actorType: 'USER', actorId: principal.email },
      expectedVersions,
    );
    switch (outcome.kind) {
      case 'REPLACED':
        return { transaction: outcome.transaction, splits: outcome.splits };
      case 'NOT_FOUND':
        throw new TransactionNotFoundError(transactionId);
      case 'FROZEN':
        throw new TransactionFrozenError(transactionId, outcome.status);
      case 'SUM_MISMATCH':
        throw new SplitSumMismatchError(outcome.expected, outcome.actual);
      case 'CURRENCY_MISMATCH':
        throw new CurrencyMismatchError(`Split currency differs from the Transaction currency (positions ${outcome.positions.join(', ')})`, {
          amount: false,
          splitPositions: outcome.positions,
        });
      case 'UNKNOWN_CATEGORY':
        throw new FinancialCategoryNotFoundError(outcome.codes);
      case 'PROPERTY_REFERENCE_NOT_FOUND':
        throw new PropertyReferenceNotFoundError(outcome.propertyReferenceIds[0] ?? '');
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
      default:
        return throwSplitRefusal(outcome);
    }
  };
}

export type ListFinancialCategories = () => Promise<readonly FinancialCategory[]>;
export type GetFinancialCategory = (code: string) => Promise<FinancialCategory>;

/** Financial Categories (api-design.md §36): read-only reference data, the same for every Realm. */
export function listFinancialCategories(deps: { readonly categories: FinancialCategoryRepository }): ListFinancialCategories {
  return () => deps.categories.list();
}

export function getFinancialCategory(deps: { readonly categories: FinancialCategoryRepository }): GetFinancialCategory {
  return async (code) => {
    const category = await deps.categories.findByCode(code);
    if (category === undefined) throw new FinancialCategoryNotFoundError([code]);
    return category;
  };
}

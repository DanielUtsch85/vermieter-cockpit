import type {
  FinancialCategory,
  FinancialCategoryRepository,
  LoanSplitRefusal,
  SplitInput,
  SplitTransaction,
  TransactionSplit,
  TransactionSplitRepository,
  TransactionStatus,
} from '../domains/ledger/index.js';
import type { LoanStatus } from '../domains/financing/index.js';
import type { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { VersionConflictError } from './errors.js';
import { LoanClosedOnError, LoanNotActiveError, LoanNotFoundError } from './loans.js';
import { CurrencyMismatchError } from './transactions.js';

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

/** The refusals of §41.5 as errors, shared by the splits command and `correct`. */
export function throwLoanSplitRefusal(refusal: LoanSplitRefusal): never {
  switch (refusal.kind) {
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
        return throwLoanSplitRefusal(outcome);
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

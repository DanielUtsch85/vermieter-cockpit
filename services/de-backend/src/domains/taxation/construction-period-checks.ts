import type { BusinessDate, RuleRef, RuleRegistry } from '../../shared/index.js';
import { interestPolicyOn, isInterestSplit, type ConstructionPeriodStatus } from './construction-period-interest.js';
import type { TaxCategory, Treatment } from './vocabulary.js';

/**
 * The checks of a classification's create for Bauzeitzinsen (api-design.md §59E "Order of checks on create"), after
 * `TREATMENT_NOT_ALLOWED` and before `supersedes`, in order: `CAPITALIZED` interest needs a record; the record known in
 * the Realm and not `VOID`; matching the split; not deductible (case A: no free choice); named only on interest.
 */

/** The record as the create reads it (written first, as a no-op, so the create serialises with amend and void). */
export interface ConstructionPeriodRecordFacts {
  readonly id: string;
  readonly loanId: string | null;
  readonly propertyReferenceIds: readonly string[];
  readonly advanceExpenseDeductible: boolean;
  readonly status: ConstructionPeriodStatus;
}

export type ConstructionPeriodRefusal =
  | {
      readonly kind: 'TREATMENT_NOT_ALLOWED';
      readonly categoryType: string | null;
      readonly allowed: readonly Treatment[];
      readonly reason: 'CONSTRUCTION_PERIOD_INTEREST_REQUIRED';
    }
  | { readonly kind: 'CONSTRUCTION_PERIOD_INTEREST_NOT_FOUND'; readonly constructionPeriodInterestId: string }
  | { readonly kind: 'CONSTRUCTION_PERIOD_INTEREST_VOID'; readonly constructionPeriodInterestId: string }
  | {
      readonly kind: 'CONSTRUCTION_PERIOD_INTEREST_MISMATCH';
      readonly loanId: string | null;
      readonly propertyReferenceId: string | null;
      readonly recordLoanId: string | null;
      readonly recordPropertyReferenceIds: readonly string[];
    }
  | { readonly kind: 'CONSTRUCTION_PERIOD_INTEREST_DEDUCTIBLE'; readonly constructionPeriodInterestId: string }
  /** A `400 NOT_ALLOWED` on `constructionPeriodInterestId`: not interest, or another treatment. */
  | { readonly kind: 'CONSTRUCTION_PERIOD_INTEREST_NOT_ALLOWED'; readonly reason: 'NOT_INTEREST' | 'TREATMENT' };

export interface ConstructionPeriodRequest {
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly constructionPeriodInterestId: string | null;
}

/** The split as the checks read it. */
export interface InterestSplitFacts {
  readonly bookingDate: BusinessDate;
  readonly loanId: string | null;
  readonly propertyReferenceId: string | null;
  readonly financialCategoryCode: string;
  readonly categoryType: string;
}

/**
 * §59E's five checks in order. `record` is `undefined` when none is named, `null` when the named one is not of the Realm.
 * Returns the rule the classification stores as `treatmentRule` (`DE_CONSTRUCTION_PERIOD_INTEREST` on the booking date)
 * when a record is named, or the refusal.
 */
export function constructionPeriodCheck(
  split: InterestSplitFacts,
  request: ConstructionPeriodRequest,
  record: ConstructionPeriodRecordFacts | null | undefined,
  registry: RuleRegistry,
  allowedTreatments: readonly Treatment[],
): { readonly treatmentRule: RuleRef | null } | ConstructionPeriodRefusal {
  const { rule, policy } = interestPolicyOn(registry, split.bookingDate);
  const interest = isInterestSplit({ loanId: split.loanId, financialCategoryCode: split.financialCategoryCode, taxCategory: request.taxCategory }, policy);
  const id = request.constructionPeriodInterestId;
  // 1. Interest is capitalised only as Bauzeitzinsen with their facts recorded.
  if (interest && request.treatment === 'CAPITALIZED' && id === null && policy.capitalizedRequiresRecord) {
    return {
      kind: 'TREATMENT_NOT_ALLOWED',
      categoryType: split.categoryType,
      allowed: allowedTreatments.filter((t) => t !== 'CAPITALIZED'),
      reason: 'CONSTRUCTION_PERIOD_INTEREST_REQUIRED',
    };
  }
  if (id === null) return { treatmentRule: null };
  // 2. Known in the Realm, not void.
  if (record === null || record === undefined) return { kind: 'CONSTRUCTION_PERIOD_INTEREST_NOT_FOUND', constructionPeriodInterestId: id };
  if (record.status === 'VOID') return { kind: 'CONSTRUCTION_PERIOD_INTEREST_VOID', constructionPeriodInterestId: id };
  // 3. The record covers the split: the same Loan (none for a PropertyReference's split), and its PropertyReference named.
  const mismatch = record.loanId !== split.loanId || (split.propertyReferenceId !== null && !record.propertyReferenceIds.includes(split.propertyReferenceId));
  if (mismatch) {
    return {
      kind: 'CONSTRUCTION_PERIOD_INTEREST_MISMATCH',
      loanId: split.loanId,
      propertyReferenceId: split.propertyReferenceId,
      recordLoanId: record.loanId,
      recordPropertyReferenceIds: record.propertyReferenceIds,
    };
  }
  // 4. Case A: no free choice to move deductible interest into the AfA.
  if (request.treatment === 'CAPITALIZED' && record.advanceExpenseDeductible && policy.deductibleBlocksCapitalization) {
    return { kind: 'CONSTRUCTION_PERIOD_INTEREST_DEDUCTIBLE', constructionPeriodInterestId: id };
  }
  // 5. Named only on interest, and only with CAPITALIZED or DEDUCTIBLE.
  if (!interest) return { kind: 'CONSTRUCTION_PERIOD_INTEREST_NOT_ALLOWED', reason: 'NOT_INTEREST' };
  if (request.treatment !== 'CAPITALIZED' && request.treatment !== 'DEDUCTIBLE')
    return { kind: 'CONSTRUCTION_PERIOD_INTEREST_NOT_ALLOWED', reason: 'TREATMENT' };
  return { treatmentRule: rule };
}

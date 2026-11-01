import type { BusinessDate, RuleRef, RuleRegistry, RuleVersion } from '../../shared/index.js';
import { CONSTRUCTION_PERIOD_INTEREST, type ConstructionPeriodInterestParameters } from './rules/de-construction-period-interest.js';
import type { TaxCategory, Treatment } from './vocabulary.js';

/**
 * Bauzeitzinsen (api-design.md §59E, VC-X-36; tax review of 2026-11-01, question 23, mündlich bestätigt durch den
 * Steuerberater, laut Projektinhaber am 2026-11-01): the record `ConstructionPeriodInterest` states once the facts of the
 * interest of one financing of one Herstellung measure; a classification names it. Interest is a capitalised source only
 * when the record's conditions hold (`interestReasonOf`), and only for the building (the land share is separated in the
 * cash, `buildingFundsShare`). Pure; the repository reads and writes, the view and the basis both call these functions.
 */

export const CONSTRUCTION_PERIOD_REVIEW_STATES = ['UNREVIEWED', 'CONFIRMED', 'ADVISOR_CONFIRMED', 'NEEDS_REVIEW'] as const;
export type ConstructionPeriodReviewState = (typeof CONSTRUCTION_PERIOD_REVIEW_STATES)[number];
export const CONSTRUCTION_PERIOD_STATUSES = ['VALID', 'VOID'] as const;
export type ConstructionPeriodStatus = (typeof CONSTRUCTION_PERIOD_STATUSES)[number];
/** At most this many PropertyReferences per record, and the largest denominator of `buildingFundsShare`. */
export const MAX_CONSTRUCTION_PERIOD_PROPERTIES = 50;
export const MAX_FUNDS_SHARE_DENOMINATOR = 10_000n;

export interface FundsShare {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** The facts a person states (and amends). */
export interface ConstructionPeriodFacts {
  readonly propertyReferenceIds: readonly string[];
  readonly measure: string;
  readonly herstellungFrom: BusinessDate;
  readonly herstellungUntil: BusinessDate | null;
  readonly useIntent: string;
  readonly advanceExpenseDeductible: boolean;
  readonly buildingFundsShare: FundsShare;
  readonly earlierYearsTreatment: string;
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

export interface ConstructionPeriodInterest extends ConstructionPeriodFacts {
  readonly id: string;
  readonly mreRealmId: string;
  /** The Loan whose interest it covers; `null` for interest booked on a PropertyReference. Never amended. */
  readonly loanId: string | null;
  readonly reviewState: ConstructionPeriodReviewState;
  readonly advisorPartyId: string | null;
  readonly status: ConstructionPeriodStatus;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface NewConstructionPeriodInterest extends ConstructionPeriodFacts {
  readonly mreRealmId: string;
  readonly loanId: string | null;
}

/** What an amend may change: the facts, each optional (`undefined` keeps it). */
export type ConstructionPeriodChanges = { readonly [K in keyof ConstructionPeriodFacts]?: ConstructionPeriodFacts[K] };

/** The facts whose change resets the review state: every fact but `sourceReferences` and `notes` (§59E "A changed fact"). */
const RESETTING: readonly (keyof ConstructionPeriodFacts)[] = [
  'propertyReferenceIds',
  'measure',
  'herstellungFrom',
  'herstellungUntil',
  'useIntent',
  'advanceExpenseDeductible',
  'buildingFundsShare',
  'earlierYearsTreatment',
];

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ===
  JSON.stringify(b, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/** The facts in a canonical order: the PropertyReferences sorted (a set), the references as given. */
export const canonicalFacts = <T extends ConstructionPeriodFacts>(facts: T): T => ({
  ...facts,
  propertyReferenceIds: [...new Set(facts.propertyReferenceIds)].sort(),
});

export type AmendPlan =
  | { readonly kind: 'RECORD_VOID' }
  | {
      readonly kind: 'AMEND';
      readonly facts: ConstructionPeriodFacts;
      readonly changed: readonly (keyof ConstructionPeriodFacts)[];
      readonly reviewState: ConstructionPeriodReviewState;
      readonly advisorPartyId: string | null;
    };

/** An amend (§59E): a changed fact is never carried under an old confirmation, so it resets to `UNREVIEWED`. */
export function planAmend(current: ConstructionPeriodInterest, changes: ConstructionPeriodChanges): AmendPlan {
  if (current.status === 'VOID') return { kind: 'RECORD_VOID' };
  const facts = canonicalFacts({ ...pickFacts(current), ...definedOnly(changes) });
  const changed = (Object.keys(facts) as (keyof ConstructionPeriodFacts)[]).filter((k) => !same(facts[k], pickFacts(current)[k]));
  const reset = changed.some((k) => RESETTING.includes(k));
  return {
    kind: 'AMEND',
    facts,
    changed,
    reviewState: reset ? 'UNREVIEWED' : current.reviewState,
    advisorPartyId: reset ? null : current.advisorPartyId,
  };
}

export function pickFacts(r: ConstructionPeriodFacts): ConstructionPeriodFacts {
  return {
    propertyReferenceIds: r.propertyReferenceIds,
    measure: r.measure,
    herstellungFrom: r.herstellungFrom,
    herstellungUntil: r.herstellungUntil,
    useIntent: r.useIntent,
    advanceExpenseDeductible: r.advanceExpenseDeductible,
    buildingFundsShare: r.buildingFundsShare,
    earlierYearsTreatment: r.earlierYearsTreatment,
    sourceReferences: r.sourceReferences,
    notes: r.notes,
  };
}

const definedOnly = (changes: ConstructionPeriodChanges): Partial<ConstructionPeriodFacts> =>
  Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) as Partial<ConstructionPeriodFacts>;

// ---------------------------------------------------------------------------------------------------------------------
// The conditions (§59E "What becomes a capitalised source")

/** What a source and the view read of a record, with the current classifications of counting splits naming it. */
export interface ConstructionPeriodView {
  readonly id: string;
  readonly loanId: string | null;
  readonly propertyReferenceIds: readonly string[];
  readonly herstellungFrom: BusinessDate;
  readonly herstellungUntil: BusinessDate | null;
  readonly advanceExpenseDeductible: boolean;
  readonly buildingFundsShare: FundsShare;
  readonly reviewState: ConstructionPeriodReviewState;
  readonly status: ConstructionPeriodStatus;
  /** The counting splits whose current classification names the record, by treatment, sorted. */
  readonly deductibleSplitIds: readonly string[];
  readonly capitalizedSplitIds: readonly string[];
}

export type InterestPolicy = Pick<
  ConstructionPeriodInterestParameters,
  'interestCategoryCodes' | 'interestTaxCategories' | 'capitalizedRequiresRecord' | 'recordReviewStates' | 'deductibleBlocksCapitalization'
>;

/**
 * Without a version of the rule on a date (a test registry only): every condition holds strictly, as version 1 has
 * it, so nothing is capitalised on a guess (as §59D's `NO_RULE_COST_CLASSIFICATION`).
 */
export const STRICT_INTEREST_POLICY: InterestPolicy = {
  interestCategoryCodes: ['LOAN_INTEREST'],
  interestTaxCategories: ['LOAN_INTEREST', 'FINANCING_COSTS'],
  capitalizedRequiresRecord: true,
  recordReviewStates: ['CONFIRMED', 'ADVISOR_CONFIRMED'],
  deductibleBlocksCapitalization: true,
};

/** `DE_CONSTRUCTION_PERIOD_INTEREST` on `date`: the version and its policy, else no rule and the strict policy. */
export function interestPolicyOn(registry: RuleRegistry, date: BusinessDate): { readonly rule: RuleRef | null; readonly policy: InterestPolicy } {
  const version = registry.select(CONSTRUCTION_PERIOD_INTEREST, date) as RuleVersion<ConstructionPeriodInterestParameters> | undefined;
  return version === undefined
    ? { rule: null, policy: STRICT_INTEREST_POLICY }
    : { rule: { ruleCode: version.ruleCode, version: version.version }, policy: version.parameters };
}

/**
 * Whether a split is interest (§59E "Which splits are interest"): a Loan's `LOAN_INTEREST` split, a split whose
 * financial category is an interest code, or one whose classification names an interest line, whatever line the user
 * put it on, so the conditions cannot be avoided by classifying interest as `MAINTENANCE`.
 */
export function isInterestSplit(
  split: { readonly loanId: string | null; readonly financialCategoryCode: string; readonly taxCategory: TaxCategory | null },
  policy: Pick<InterestPolicy, 'interestCategoryCodes' | 'interestTaxCategories'>,
): boolean {
  if (policy.interestCategoryCodes.includes(split.financialCategoryCode)) return true;
  return split.taxCategory !== null && policy.interestTaxCategories.includes(split.taxCategory);
}

/** What the conditions read of one interest split, in the read's snapshot. */
export interface InterestFacts {
  readonly splitId: string;
  readonly loanId: string | null;
  readonly bookingDate: BusinessDate;
  /** The split's whole amount, unsigned, and the interest of its Loan (or PropertyReference) in its Transaction, itself included. */
  readonly amountCents: bigint;
  readonly transactionInterestCents: bigint;
  /** The record the current classification names; `record` `null` when none is named. */
  readonly constructionPeriodInterestId: string | null;
  readonly record: ConstructionPeriodView | null;
  readonly policy: InterestPolicy;
}

/** Why a `CAPITALIZED` interest split is no source (§59E "The flag's lifecycle"), in the order checked. */
export const INTEREST_REASONS = [
  'CONSTRUCTION_PERIOD_INTEREST_MISSING',
  'RECORD_VOID',
  'RECORD_NOT_CONFIRMED',
  'RECORD_DEDUCTIBLE',
  'RECORD_MISMATCH',
  'PROPERTY_NOT_NAMED',
  'LAND_SHARE_NOT_SEPARATED',
] as const;
export type InterestReason = (typeof INTEREST_REASONS)[number];

/**
 * Whether a `CAPITALIZED` interest split is a capitalised source of `propertyReferenceId` (conditions 2 of §59E): `null`
 * when it is, else the first reason it is not. `RECORD_MISMATCH` (the record names another Loan) is defensive: the
 * classification's create and 0055 refuse it, and a record's Loan never changes.
 */
export function interestReasonOf(facts: InterestFacts, propertyReferenceId: string): InterestReason | null {
  const { record, policy } = facts;
  if (record === null) return policy.capitalizedRequiresRecord ? 'CONSTRUCTION_PERIOD_INTEREST_MISSING' : null;
  if (record.status === 'VOID') return 'RECORD_VOID';
  if (!policy.recordReviewStates.includes(record.reviewState)) return 'RECORD_NOT_CONFIRMED';
  if (policy.deductibleBlocksCapitalization && record.advanceExpenseDeductible) return 'RECORD_DEDUCTIBLE';
  if (record.loanId !== facts.loanId) return 'RECORD_MISMATCH';
  if (!record.propertyReferenceIds.includes(propertyReferenceId)) return 'PROPERTY_NOT_NAMED';
  // The land (§59E "Land"): the split at most the building's share of the Transaction's interest, exactly.
  const share = record.buildingFundsShare;
  if (facts.amountCents * share.denominator > share.numerator * facts.transactionInterestCents) return 'LAND_SHARE_NOT_SEPARATED';
  return null;
}

/** The open item flag on interest of a PropertyReference that is no source (§59E, open question 3). */
export const INTEREST_CAPITALIZED_CONDITIONS_MISSING = 'INTEREST_CAPITALIZED_CONDITIONS_MISSING';
export const CONSTRUCTION_PERIOD_DATE_OUTSIDE = 'CONSTRUCTION_PERIOD_DATE_OUTSIDE';
export const CONSTRUCTION_PERIOD_TREATMENT_MIXED = 'CONSTRUCTION_PERIOD_TREATMENT_MIXED';

/**
 * The record's own item flags (§59E): `CONSTRUCTION_PERIOD_DATE_OUTSIDE` on a `CAPITALIZED` item naming a record whose
 * Herstellung period does not hold its booking date (both edges inside), and `CONSTRUCTION_PERIOD_TREATMENT_MIXED` on
 * every item naming a record whose splits are partly `DEDUCTIBLE` and partly `CAPITALIZED` (informative once the record
 * is `ADVISOR_CONFIRMED`, `details.recordReviewState`).
 */
export function constructionPeriodFlags(
  facts: Pick<InterestFacts, 'bookingDate' | 'record'>,
  treatment: Treatment | null,
): { readonly code: string; readonly details: Readonly<Record<string, unknown>> }[] {
  const r = facts.record;
  if (r === null) return [];
  const flags: { code: string; details: Readonly<Record<string, unknown>> }[] = [];
  const outside = facts.bookingDate < r.herstellungFrom || (r.herstellungUntil !== null && facts.bookingDate > r.herstellungUntil);
  if (treatment === 'CAPITALIZED' && outside) {
    flags.push({
      code: CONSTRUCTION_PERIOD_DATE_OUTSIDE,
      details: { bookingDate: facts.bookingDate, herstellungFrom: r.herstellungFrom, herstellungUntil: r.herstellungUntil },
    });
  }
  if (r.deductibleSplitIds.length > 0 && r.capitalizedSplitIds.length > 0) {
    flags.push({
      code: CONSTRUCTION_PERIOD_TREATMENT_MIXED,
      details: {
        constructionPeriodInterestId: r.id,
        deductibleSplitIds: r.deductibleSplitIds,
        capitalizedSplitIds: r.capitalizedSplitIds,
        recordReviewState: r.reviewState,
      },
    });
  }
  return flags;
}

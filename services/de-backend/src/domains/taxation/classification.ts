import type { AuditActor, BusinessDate, Money, VersionConflict } from '../../shared/index.js';
import type { CategoryType, Direction, TransactionStatus } from '../ledger/index.js';
import { anschaffungsnaheWindow, type AnschaffungsnaheCheck, type CheckEntryFlag } from './anschaffungsnahe.js';
import { ANSCHAFFUNGSNAHE, type AnschaffungsnaheParameters } from './rules/de-anschaffungsnahe.js';
import { CATEGORY_DEFAULTS, type CategoryDefault, type CategoryDefaultsParameters } from './rules/de-category-defaults.js';
import { DISTRIBUTION_82B } from './rules/de-82b-distribution.js';
import type { RuleRegistry } from './rules/registry.js';
import type { RuleRef, RuleVersion } from './rules/rule-version.js';
import {
  attributeTaxYear,
  refundOf,
  yearOf,
  type RefundFlag,
  type RefundInfo,
  type TaxYearAttribution,
  type TaxYearFlag,
  type TimingInput,
} from './cash-timing.js';
import type { DepositTaxMeaning } from './deposit-closing.js';
import type { TaxYearRead } from './tax-year-view.js';
import type { Distribution, DistributionFlag } from './distribution-82b.js';
import type { WegNotCounted, WegTaxMeaning } from './weg-sources.js';
import type { CreateReviewState, Origin, ReviewState, SourceType, StoredReviewState, TaxCategory, Treatment } from './vocabulary.js';

/**
 * TaxClassification (data-model.md §36, api-design.md §55–§58A, phase-7-plan P7-D2, P7-D4): the stored interpretation
 * of a split, or of a retained deposit (VC-7-02), made when a user confirms or changes the default. It never changes its
 * source, the split's amount, category or Transaction, or the deposit (ADR-006). One current classification per
 * source; a change supersedes it.
 */

export type TaxClassificationId = string & { readonly __brand: 'TaxClassificationId' };

export interface TaxClassification {
  readonly id: TaxClassificationId;
  readonly mreRealmId: string;
  readonly sourceType: SourceType;
  readonly sourceId: string;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: StoredReviewState;
  readonly rule: RuleRef;
  readonly advisorPartyId: string | null;
  readonly notes: string | null;
  readonly sourceReferences: readonly string[];
  /** VC-7-02 (§58A): the tax year a split counts in, overriding the rule; `null` keeps the rule's year. */
  readonly taxYear: number | null;
  /** VC-7-02: the year a refund refunds (or a repayment repays, for information). */
  readonly refundOfYear: number | null;
  /** A `DEPOSIT_CLOSING`'s closing, as it was when classified; a later closing needs a new classification. */
  readonly depositClosing: { readonly closingDate: BusinessDate; readonly retainedAmount: Money } | null;
  /** VC-7-03 (§58B): the reserve line's or the use's `position` of a WEG source; `null` for a split or a deposit. */
  readonly sourcePosition: number | null;
  /** The withdrawal's unit share as classified (a confirmed statement never changes it). */
  readonly reserveWithdrawal: { readonly unitShare: Money } | null;
  /** The use as classified: a replace of the uses that changes it stops the classification counting. */
  readonly assessmentUse: { readonly date: BusinessDate; readonly unitShare: Money } | null;
  /** The amount without VAT, for the anschaffungsnahe check only (P7-D6). */
  readonly netAmount: Money | null;
  /** Annually recurring maintenance: left out of the anschaffungsnahe check (A2). */
  readonly annuallyRecurring: boolean;
  /** The § 82b election: its years (2–5) and the user's confirmation that the building is mostly residential. */
  readonly distributionYears: number | null;
  readonly mostlyResidentialConfirmed: boolean | null;
  /** A capitalisation that follows the anschaffungsnahe check of this Acquisition. */
  readonly anschaffungsnaheAcquisitionId: string | null;
  /** The second rule reference: `DE_82B_DISTRIBUTION` for an election, `DE_ANSCHAFFUNGSNAHE` for such a capitalisation. */
  readonly treatmentRule: RuleRef | null;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  readonly supersededAt: Date | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly version: number;
}

/** What a create carries (§56, §58A). */
export interface NewTaxClassification {
  readonly mreRealmId: string;
  readonly sourceType: SourceType;
  readonly sourceId: string;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: CreateReviewState;
  readonly supersedes: string | null;
  readonly notes: string | null;
  readonly sourceReferences: readonly string[];
  /** Splits (§58A) and undated withdrawals (§58B) only; omitted means `null`. */
  readonly taxYear?: number | null;
  readonly refundOfYear?: number | null;
  /** VC-7-03 (§58B): the WEG sources' `position`; the fields below, each omitted meaning `null` (or `false`). */
  readonly sourcePosition?: number | null;
  readonly netAmount?: Money | null;
  readonly annuallyRecurring?: boolean;
  readonly distributionYears?: number | null;
  readonly mostlyResidentialConfirmed?: boolean | null;
  readonly anschaffungsnaheAcquisitionId?: string | null;
}

/** The Acquisition a capitalisation following the check names, as a create reads it (without a lock, §58B). */
export interface AcquisitionFacts {
  readonly id: string;
  readonly propertyReferenceId: string;
  readonly status: string;
  readonly transferDate: BusinessDate;
}

/** A split as tax reads it: its cash, its category and its Transaction's state. */
export interface SplitFacts {
  readonly splitId: string;
  readonly transactionId: string;
  readonly position: number;
  readonly bookingDate: BusinessDate;
  readonly direction: Direction;
  readonly amount: Money;
  readonly financialCategoryCode: string;
  readonly categoryType: CategoryType;
  readonly propertyReferenceId: string | null;
  readonly transactionStatus: TransactionStatus;
  readonly correctionRole: 'REVERSAL' | 'REPLACEMENT' | null;
}

/** A split counts for tax when its Transaction is current: `CONFIRMED` or `RECONCILED`, not a reversal (§55). */
export const splitCounts = (facts: Pick<SplitFacts, 'transactionStatus' | 'correctionRole'>) =>
  (facts.transactionStatus === 'CONFIRMED' || facts.transactionStatus === 'RECONCILED') && facts.correctionRole !== 'REVERSAL';

export type TaxMeaningFlag =
  | { readonly code: 'NOT_COUNTED'; readonly details: { readonly transactionStatus: TransactionStatus; readonly correctionRole: string | null } }
  | {
      readonly code: 'CLASSIFICATION_ON_CORRECTED_SPLIT';
      readonly details: { readonly originalTransactionId: string; readonly classificationIds: readonly string[] };
    }
  | RuleSupersededFlag
  | TaxYearFlag
  | RefundFlag
  | DistributionFlag
  | CheckEntryFlag;

export type RuleSupersededFlag = {
  readonly code: 'RULE_SUPERSEDED';
  readonly details: { readonly ruleCode: string; readonly version: number; readonly applicableVersion: number };
};

/** The anschaffungsnahe check's suggestion on a source above 15 % (§58B); the meaning itself stays as it is. */
export interface TreatmentSuggestion {
  readonly treatment: 'CAPITALIZED';
  readonly reason: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN';
  readonly acquisitionIds: readonly string[];
  readonly final: boolean;
}

/** `RULE_SUPERSEDED` for each stored reference that a later version applicable today replaces (§58, §58B: both). */
export function ruleSupersededFlags(registry: RuleRegistry, today: BusinessDate, refs: readonly (RuleRef | null)[]): RuleSupersededFlag[] {
  return refs.flatMap((ref) => {
    if (ref === null) return [];
    const applicable = registry.select(ref.ruleCode, today);
    return applicable !== undefined && applicable.version > ref.version
      ? [{ code: 'RULE_SUPERSEDED', details: { ruleCode: ref.ruleCode, version: ref.version, applicableVersion: applicable.version } } as const]
      : [];
  });
}

export interface TaxMeaning extends SplitFacts {
  readonly sourceType: 'TRANSACTION_SPLIT';
  readonly sourceId: string;
  readonly counts: boolean;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: ReviewState;
  readonly origin: Origin;
  /** `null` only for a default on a date no version of the rule covers (before 2000). */
  readonly rule: RuleRef | null;
  readonly classificationId: string | null;
  /** VC-7-02 (§58A): the year it counts in, and how. */
  readonly taxYear: number;
  readonly attribution: TaxYearAttribution;
  readonly refund: RefundInfo | null;
  /** VC-7-03 (§58B): the classification's net amount, its second rule reference, the § 82b parts and the check's suggestion. */
  readonly netAmount: Money | null;
  readonly treatmentRule: RuleRef | null;
  readonly distribution: Distribution | null;
  readonly suggestion: TreatmentSuggestion | null;
  readonly flags: readonly TaxMeaningFlag[];
}

/** What the tax year and the refund read besides the split (§58A); both optional, so a split outside a window needs none. */
export interface TaxYearInputs {
  /** The source's economic period and due date, read only where the 10-day rule could apply (`needsTiming`). */
  readonly timing?: TimingInput;
  /** The `financialYear` of the WEG statement the split names. */
  readonly statementYear?: number | null;
}

/** The original of a replacement whose splits had classifications (P7-D2: nothing moves silently). */
export interface CorrectedOriginal {
  readonly originalTransactionId: string;
  readonly classificationIds: readonly string[];
}

/** The category defaults applicable on `date`, typed. */
export function categoryDefaultsOn(registry: RuleRegistry, date: BusinessDate): RuleVersion<CategoryDefaultsParameters> | undefined {
  return registry.select(CATEGORY_DEFAULTS, date) as RuleVersion<CategoryDefaultsParameters> | undefined;
}

/** The default of a category code; a code the rule does not list reads as `OTHER` (§55). */
export const defaultOf = (rule: RuleVersion<CategoryDefaultsParameters>, code: string): CategoryDefault =>
  rule.parameters.defaults[code] ?? rule.parameters.unlisted;

const NO_RULE_DEFAULT: CategoryDefault = { taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' };

/**
 * The tax meaning of a split (§55): its current classification, else the default of its category by the rule version
 * applicable on its booking date. `today` decides `RULE_SUPERSEDED` (informational: it never changes the meaning).
 */
export function deriveTaxMeaning(
  facts: SplitFacts,
  classification: TaxClassification | null,
  correctedOriginal: CorrectedOriginal | null,
  registry: RuleRegistry,
  today: BusinessDate,
  inputs: TaxYearInputs = {},
): TaxMeaning {
  const base = meaningOf(facts, classification, correctedOriginal, registry, today);
  const year = attributeTaxYear(facts, inputs.timing, classification?.taxYear ?? null, registry);
  // A split that does not count (a reversal above all, whose direction is the original's mirrored) refunds nothing.
  const refund = base.counts
    ? refundOf(facts.direction, base.taxCategory, year.taxYear, inputs.statementYear ?? null, classification?.refundOfYear ?? null)
    : { refund: null, flags: [] };
  return {
    ...base,
    taxYear: year.taxYear,
    attribution: year.attribution,
    refund: refund.refund,
    distribution: null,
    suggestion: null,
    flags: [...base.flags, ...year.flags, ...refund.flags],
  };
}

function meaningOf(
  facts: SplitFacts,
  classification: TaxClassification | null,
  correctedOriginal: CorrectedOriginal | null,
  registry: RuleRegistry,
  today: BusinessDate,
): Omit<TaxMeaning, 'taxYear' | 'attribution' | 'refund' | 'distribution' | 'suggestion'> {
  const counts = splitCounts(facts);
  const flags: TaxMeaningFlag[] = [];
  const source = { sourceType: 'TRANSACTION_SPLIT', sourceId: facts.splitId } as const;
  if (!counts) flags.push({ code: 'NOT_COUNTED', details: { transactionStatus: facts.transactionStatus, correctionRole: facts.correctionRole } });
  if (classification !== null) {
    flags.push(...ruleSupersededFlags(registry, today, [classification.rule, classification.treatmentRule]));
    return {
      ...facts,
      ...source,
      counts,
      taxCategory: classification.taxCategory,
      treatment: classification.treatment,
      reviewState: classification.reviewState,
      origin: 'CLASSIFICATION',
      rule: classification.rule,
      treatmentRule: classification.treatmentRule,
      netAmount: classification.netAmount,
      classificationId: classification.id,
      flags,
    };
  }
  if (correctedOriginal !== null && correctedOriginal.classificationIds.length > 0) {
    flags.push({
      code: 'CLASSIFICATION_ON_CORRECTED_SPLIT',
      details: { originalTransactionId: correctedOriginal.originalTransactionId, classificationIds: [...correctedOriginal.classificationIds].sort() },
    });
  }
  const rule = categoryDefaultsOn(registry, facts.bookingDate);
  const meaning = rule === undefined ? NO_RULE_DEFAULT : defaultOf(rule, facts.financialCategoryCode);
  return {
    ...facts,
    ...source,
    counts,
    ...meaning,
    origin: 'DEFAULT',
    rule: rule === undefined ? null : { ruleCode: rule.ruleCode, version: rule.version },
    treatmentRule: null,
    netAmount: null,
    classificationId: null,
    flags,
  };
}

/** `TREATMENT_NOT_ALLOWED` (§56): the hard rules by the split's category type and code; `undefined` when allowed. */
export function treatmentRefusal(
  rule: RuleVersion<CategoryDefaultsParameters>,
  category: { readonly code: string; readonly categoryType: string },
  treatment: Treatment | null,
): { readonly categoryType: string; readonly allowed: readonly Treatment[] } | undefined {
  const p = rule.parameters;
  if (p.notRelevantOnlyCategoryTypes.includes(category.categoryType)) {
    return treatment === 'NOT_RELEVANT' ? undefined : { categoryType: category.categoryType, allowed: ['NOT_RELEVANT'] };
  }
  const forbidden = p.forbiddenTreatmentsByCode[category.code] ?? [];
  if (treatment !== null && forbidden.includes(treatment)) {
    return { categoryType: category.categoryType, allowed: p.treatments.filter((t) => !forbidden.includes(t)) };
  }
  return undefined;
}

/** Why a retained deposit does not count (§58A): not `CLOSED`, nothing retained, or closed again since it was classified. */
export type DepositNotCountedReason = 'NOT_CLOSED' | 'NOTHING_RETAINED' | 'CLOSING_CHANGED';

export type DepositNotCounted = {
  readonly kind: 'DEPOSIT_NOT_COUNTED';
  readonly depositStatus: string;
  readonly retainedAmount: Money;
  readonly reason: DepositNotCountedReason;
};

/** A WEG source that does not count (§58B), with the details its `notCountedReason` names. */
export type WegSourceNotCounted = {
  readonly kind: 'WEG_SOURCE_NOT_COUNTED';
  readonly sourceType: 'WEG_RESERVE_WITHDRAWAL' | 'WEG_ASSESSMENT_USE';
} & WegNotCounted;

export type DistributionNotAllowedReason = 'NOT_MOSTLY_RESIDENTIAL' | 'NOT_AN_OUTFLOW';
export type AnschaffungsnaheNotApplicableReason = 'OTHER_PROPERTY_REFERENCE' | 'ACQUISITION_NOT_CONFIRMED' | 'OUTSIDE_WINDOW' | 'NO_APPLICABLE_RULE';

export type CreateRefusal =
  | { readonly kind: 'SOURCE_NOT_COUNTED'; readonly transactionStatus: TransactionStatus; readonly correctionRole: string | null }
  | DepositNotCounted
  | WegSourceNotCounted
  /** A field the found source does not take (§58B: `taxYear` on a withdrawal with its own date): a `400 NOT_SUPPORTED`. */
  | { readonly kind: 'FIELD_NOT_SUPPORTED'; readonly field: string }
  | { readonly kind: 'NO_APPLICABLE_RULE'; readonly ruleCode: string; readonly date: BusinessDate }
  | {
      readonly kind: 'TREATMENT_NOT_ALLOWED';
      /** The split's category type; `null` for a deposit or a WEG source, whose lines are named in `taxCategories`. */
      readonly categoryType: string | null;
      readonly allowed: readonly Treatment[];
      readonly taxCategories?: readonly TaxCategory[];
      /** The source type where it decides (a deposit, a WEG source; §58B). */
      readonly sourceType?: SourceType;
      /** `WEG_SPENDING_ONLY_FOR_WEG_SOURCES` (§58B). */
      readonly reason?: string;
    }
  | { readonly kind: 'DISTRIBUTION_NOT_ALLOWED'; readonly reason: DistributionNotAllowedReason }
  | { readonly kind: 'NET_AMOUNT_EXCEEDS_GROSS'; readonly netAmount: Money; readonly grossAmount: Money }
  | { readonly kind: 'ACQUISITION_NOT_FOUND'; readonly acquisitionId: string }
  | { readonly kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE'; readonly reason: AnschaffungsnaheNotApplicableReason; readonly acquisitionId: string }
  | { readonly kind: 'TAX_YEAR_OUT_OF_RANGE'; readonly taxYear: number; readonly bookingYear: number }
  /** An undated withdrawal's `taxYear` outside the years its statement's period touches (§58B). */
  | { readonly kind: 'WITHDRAWAL_TAX_YEAR_OUT_OF_RANGE'; readonly taxYear: number; readonly allowedYears: readonly number[] }
  | { readonly kind: 'REFUND_YEAR_OUT_OF_RANGE'; readonly refundOfYear: number; readonly taxYear: number }
  | { readonly kind: 'CLASSIFICATION_EXISTS'; readonly currentClassificationId: string }
  | { readonly kind: 'NOT_CURRENT_CLASSIFICATION'; readonly currentClassificationId: string | null };

/** The fields of an election or a capitalisation following the check (§58B), as a create carries them. */
export type TreatmentRequest = Pick<
  NewTaxClassification,
  'taxCategory' | 'treatment' | 'netAmount' | 'mostlyResidentialConfirmed' | 'anschaffungsnaheAcquisitionId'
>;

/** What the checks after the treatment read of a source (§58B). */
export interface TreatmentSource {
  readonly date: BusinessDate;
  readonly direction: Direction;
  /** The split's amount, the withdrawal's or use's unit share. */
  readonly grossAmount: Money;
  readonly propertyReferenceId: string | null;
}

/**
 * `DE_82B_DISTRIBUTION` on the source's date for an election (§58B: `NO_APPLICABLE_RULE` after the source's default
 * rule); `undefined` when no election is asked for.
 */
export function distributionRuleCheck(
  source: Pick<TreatmentSource, 'date'>,
  treatment: Treatment | null,
  registry: RuleRegistry,
): { readonly rule: RuleRef } | CreateRefusal | undefined {
  if (treatment !== 'DISTRIBUTED_82B') return undefined;
  const rule = registry.select(DISTRIBUTION_82B, source.date);
  if (rule === undefined) return { kind: 'NO_APPLICABLE_RULE', ruleCode: DISTRIBUTION_82B, date: source.date };
  return { rule: { ruleCode: rule.ruleCode, version: rule.version } };
}

/**
 * §58B's checks after `TREATMENT_NOT_ALLOWED`, in order: `DISTRIBUTION_NOT_ALLOWED` (no confirmation, not an outflow),
 * `NET_AMOUNT_EXCEEDS_GROSS`, the Acquisition named (`undefined`: none named; `null`: not found in the Realm) and
 * `ANSCHAFFUNGSNAHE_NOT_APPLICABLE`. Returns the second rule reference (`treatmentRule`) the classification records.
 */
export function treatmentFieldsCheck(
  source: TreatmentSource,
  request: TreatmentRequest,
  distributionRule: RuleRef | null,
  acquisition: AcquisitionFacts | null | undefined,
  registry: RuleRegistry,
): { readonly treatmentRule: RuleRef | null } | CreateRefusal {
  if (request.treatment === 'DISTRIBUTED_82B') {
    if (request.mostlyResidentialConfirmed !== true) return { kind: 'DISTRIBUTION_NOT_ALLOWED', reason: 'NOT_MOSTLY_RESIDENTIAL' };
    if (source.direction !== 'OUTFLOW') return { kind: 'DISTRIBUTION_NOT_ALLOWED', reason: 'NOT_AN_OUTFLOW' };
  }
  const net = request.netAmount ?? null;
  // Equal is allowed: no VAT (a craftsman under § 19 UStG).
  if (net !== null && net.compare(source.grossAmount) > 0) return { kind: 'NET_AMOUNT_EXCEEDS_GROSS', netAmount: net, grossAmount: source.grossAmount };
  const acquisitionId = request.anschaffungsnaheAcquisitionId ?? null;
  if (acquisitionId === null) return { treatmentRule: distributionRule };
  if (acquisition === null || acquisition === undefined) return { kind: 'ACQUISITION_NOT_FOUND', acquisitionId };
  const notApplicable = (reason: AnschaffungsnaheNotApplicableReason): CreateRefusal => ({ kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE', reason, acquisitionId });
  if (acquisition.propertyReferenceId !== source.propertyReferenceId) return notApplicable('OTHER_PROPERTY_REFERENCE');
  if (acquisition.status !== 'CONFIRMED') return notApplicable('ACQUISITION_NOT_CONFIRMED');
  const rule = registry.select(ANSCHAFFUNGSNAHE, acquisition.transferDate);
  if (rule === undefined) return notApplicable('NO_APPLICABLE_RULE');
  const window = anschaffungsnaheWindow(acquisition.transferDate, (rule.parameters as AnschaffungsnaheParameters).windowYears);
  if (source.date < window.from || source.date > window.until) return notApplicable('OUTSIDE_WINDOW');
  return { treatmentRule: { ruleCode: rule.ruleCode, version: rule.version } };
}

/** `WEG_SPENDING` is the line of the WEG sources only (§58B): on a split or a deposit it is `TREATMENT_NOT_ALLOWED`. */
export function wegSpendingRefusal(sourceType: SourceType, taxCategory: TaxCategory): CreateRefusal | undefined {
  if (taxCategory !== 'WEG_SPENDING' || sourceType === 'WEG_RESERVE_WITHDRAWAL' || sourceType === 'WEG_ASSESSMENT_USE') return undefined;
  return { kind: 'TREATMENT_NOT_ALLOWED', categoryType: null, allowed: [], sourceType, reason: 'WEG_SPENDING_ONLY_FOR_WEG_SOURCES' };
}

/**
 * The checks of a create of a split after the split was found (§56, §58A, §58B, in order): the source counts, a rule
 * version applies on its booking date (then `DE_82B_DISTRIBUTION` for an election), the treatment is allowed, the
 * election and the net amount, the Acquisition named, `taxYear` is the booking year ± 1, `refundOfYear` is at most the
 * tax year (the given one, else `derivedTaxYear`, the rule's), `supersedes` names the current classification. Returns
 * the rules the classification records, or the refusal.
 */
export function planClassification(
  facts: SplitFacts,
  currentId: string | null,
  request: Pick<NewTaxClassification, 'treatment' | 'supersedes' | 'taxYear' | 'refundOfYear'> & Partial<TreatmentRequest>,
  registry: RuleRegistry,
  derivedTaxYear: number = yearOf(facts.bookingDate),
  acquisition?: AcquisitionFacts | null,
): { readonly kind: 'CLASSIFY'; readonly rule: RuleRef; readonly treatmentRule: RuleRef | null } | CreateRefusal {
  if (!splitCounts(facts)) return { kind: 'SOURCE_NOT_COUNTED', transactionStatus: facts.transactionStatus, correctionRole: facts.correctionRole };
  const rule = categoryDefaultsOn(registry, facts.bookingDate);
  if (rule === undefined) return { kind: 'NO_APPLICABLE_RULE', ruleCode: CATEGORY_DEFAULTS, date: facts.bookingDate };
  const source: TreatmentSource = {
    date: facts.bookingDate,
    direction: facts.direction,
    grossAmount: facts.amount,
    propertyReferenceId: facts.propertyReferenceId,
  };
  const distribution = distributionRuleCheck(source, request.treatment, registry);
  if (distribution !== undefined && 'kind' in distribution) return distribution;
  const spending = request.taxCategory === undefined ? undefined : wegSpendingRefusal('TRANSACTION_SPLIT', request.taxCategory);
  if (spending !== undefined) return spending;
  const refusal = treatmentRefusal(rule, { code: facts.financialCategoryCode, categoryType: facts.categoryType }, request.treatment);
  if (refusal !== undefined) return { kind: 'TREATMENT_NOT_ALLOWED', ...refusal };
  const fields = treatmentFieldsCheck(
    source,
    { taxCategory: request.taxCategory ?? 'UNCLASSIFIED', ...request },
    distribution?.rule ?? null,
    request.anschaffungsnaheAcquisitionId === undefined || request.anschaffungsnaheAcquisitionId === null ? undefined : (acquisition ?? null),
    registry,
  );
  if ('kind' in fields) return fields;
  const bookingYear = yearOf(facts.bookingDate);
  const taxYear = request.taxYear ?? null;
  // § 11 EStG moves cash across one year-end at most (§58A).
  if (taxYear !== null && Math.abs(taxYear - bookingYear) > 1) return { kind: 'TAX_YEAR_OUT_OF_RANGE', taxYear, bookingYear };
  const refundOfYear = request.refundOfYear ?? null;
  const effectiveYear = taxYear ?? derivedTaxYear;
  if (refundOfYear !== null && refundOfYear > effectiveYear) return { kind: 'REFUND_YEAR_OUT_OF_RANGE', refundOfYear, taxYear: effectiveYear };
  return (
    supersedesCheck(currentId, request.supersedes) ?? {
      kind: 'CLASSIFY',
      rule: { ruleCode: rule.ruleCode, version: rule.version },
      treatmentRule: fields.treatmentRule,
    }
  );
}

/** `supersedes` must name the current classification, and must be given when there is one (§56). */
export function supersedesCheck(currentId: string | null, supersedes: string | null): CreateRefusal | undefined {
  if (currentId !== null && supersedes === null) return { kind: 'CLASSIFICATION_EXISTS', currentClassificationId: currentId };
  if (supersedes !== null && supersedes !== currentId) return { kind: 'NOT_CURRENT_CLASSIFICATION', currentClassificationId: currentId };
  return undefined;
}

/** §57's three steps. */
export type ReviewStep =
  | { readonly kind: 'CONFIRM' }
  | { readonly kind: 'ADVISOR_CONFIRM'; readonly advisorPartyId: string | null; readonly note: string | null }
  | { readonly kind: 'MARK_NEEDS_REVIEW'; readonly reason: string };

export type ReviewRefusal =
  | { readonly kind: 'CLASSIFICATION_SUPERSEDED'; readonly supersededBy: string }
  | { readonly kind: 'ADVISOR_CONFIRMED' }
  | { readonly kind: 'SOURCE_NOT_COUNTED'; readonly transactionStatus: TransactionStatus; readonly correctionRole: string | null }
  | DepositNotCounted
  | WegSourceNotCounted
  | { readonly kind: 'RULE_NOT_REGISTERED'; readonly ruleCode: string; readonly version: number };

/** What a step writes: the target state and advisor; `changed: false` is a `200` no-op. */
export interface ReviewPlan {
  readonly reviewState: StoredReviewState;
  readonly advisorPartyId: string | null;
  readonly changed: boolean;
}

/**
 * §57's state checks, in order: only the current classification moves; confirm does not lower an advisor's
 * confirmation; for the two confirmations the source still counts and the rule version still resolves; then the
 * target, or the no-op.
 */
export function planReview(
  current: TaxClassification,
  step: ReviewStep,
  source:
    | Pick<SplitFacts, 'transactionStatus' | 'correctionRole'>
    | { readonly deposit: DepositNotCounted | null }
    | { readonly weg: WegSourceNotCounted | null },
  registry: RuleRegistry,
): ReviewPlan | ReviewRefusal {
  if (current.supersededBy !== null) return { kind: 'CLASSIFICATION_SUPERSEDED', supersededBy: current.supersededBy };
  if (step.kind === 'CONFIRM' && current.reviewState === 'ADVISOR_CONFIRMED') return { kind: 'ADVISOR_CONFIRMED' };
  // Only a confirmation validates the source and the rule (§57): marking for review is exactly what a classification
  // whose source stopped counting needs (review on #158).
  if (step.kind !== 'MARK_NEEDS_REVIEW') {
    if ('deposit' in source) {
      if (source.deposit !== null) return source.deposit;
    } else if ('weg' in source) {
      if (source.weg !== null) return source.weg;
    } else if (!splitCounts(source)) {
      return { kind: 'SOURCE_NOT_COUNTED', transactionStatus: source.transactionStatus, correctionRole: source.correctionRole };
    }
    // Both rule references resolve (§58B).
    for (const ref of [current.rule, current.treatmentRule]) {
      if (ref !== null && !registry.isRegistered(ref.ruleCode, ref.version))
        return { kind: 'RULE_NOT_REGISTERED', ruleCode: ref.ruleCode, version: ref.version };
    }
  }
  const target: { reviewState: StoredReviewState; advisorPartyId: string | null } =
    step.kind === 'CONFIRM'
      ? { reviewState: 'USER_CONFIRMED', advisorPartyId: null }
      : step.kind === 'ADVISOR_CONFIRM'
        ? { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: step.advisorPartyId }
        : { reviewState: 'NEEDS_REVIEW', advisorPartyId: null };
  const changed = target.reviewState !== current.reviewState || target.advisorPartyId !== current.advisorPartyId;
  return { ...target, changed };
}

/** Identity of a create for `Idempotency-Key` replays. */
export function classificationFingerprint(c: NewTaxClassification): string {
  const years = (c.taxYear ?? null) === null && (c.refundOfYear ?? null) === null ? [] : [c.taxYear ?? null, c.refundOfYear ?? null];
  const fields = [
    c.sourcePosition ?? null,
    c.netAmount?.amount ?? null,
    c.annuallyRecurring ?? false,
    c.distributionYears ?? null,
    c.mostlyResidentialConfirmed ?? null,
    c.anschaffungsnaheAcquisitionId ?? null,
  ];
  // VC-7-03's fields only when one is given (§58B): a body without them keeps the fingerprint of VC-7-02.
  const later = JSON.stringify(fields) === JSON.stringify([null, null, false, null, null, null]) ? [] : [{ vc703: fields }];
  // VC-7-01's fingerprint unchanged without the years, so a key stored before VC-7-02 still replays.
  return JSON.stringify([c.sourceType, c.sourceId, c.taxCategory, c.treatment, c.reviewState, c.supersedes, c.notes, c.sourceReferences, ...years, ...later]);
}

export type CreateClassificationOutcome =
  | { readonly kind: 'CREATED'; readonly classification: TaxClassification }
  | { readonly kind: 'REPLAYED'; readonly classification: TaxClassification }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'SOURCE_NOT_FOUND' }
  | CreateRefusal;

export type ReviewClassificationOutcome =
  | { readonly kind: 'REVIEWED'; readonly classification: TaxClassification; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | ReviewRefusal
  | VersionConflict;

/**
 * An item of the per-property list: a split, a retained deposit (§58A), a withdrawal or a use (§58B), with the amount
 * of the year listed: the part of the year for a `DISTRIBUTED_82B` source, else its amount.
 */
export type TaxListItem = (TaxMeaning | DepositTaxMeaning | WegTaxMeaning) & { readonly yearAmount: Money };

export interface TaxMeaningFilter {
  readonly reviewStates?: readonly ReviewState[];
  readonly origins?: readonly Origin[];
  readonly taxCategories?: readonly TaxCategory[];
  /** VC-7-03 (§58B): the four source types. */
  readonly sourceTypes?: readonly SourceType[];
}

export interface TaxPageRequest {
  readonly page: number;
  readonly pageSize: number;
}

export interface TaxPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface TaxClassificationRepository {
  /** Claims the key, writes the split's Transaction (no-op), locks the current classification, checks §56's order. */
  createClassification(
    classification: NewTaxClassification,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateClassificationOutcome>;
  /** One of §57's steps; the classification row `FOR UPDATE` only. */
  reviewClassification(
    id: string,
    mreRealmId: string,
    step: ReviewStep,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ReviewClassificationOutcome>;
  findClassification(id: string, mreRealmId: string): Promise<TaxClassification | undefined>;
  /** Every classification of a source (a WEG source by its `sourcePosition`), by creation; undefined for an unknown source. */
  listHistory(sourceType: SourceType, sourceId: string, mreRealmId: string, sourcePosition?: number | null): Promise<readonly TaxClassification[] | undefined>;
  /** One `REPEATABLE READ READ ONLY` snapshot; undefined for an unknown split. */
  findTaxMeaning(splitId: string, mreRealmId: string, today: BusinessDate): Promise<TaxMeaning | undefined>;
  /** The retained amount of a deposit at its closing (§58A); undefined for an unknown deposit. */
  findDepositTaxMeaning(depositId: string, mreRealmId: string, today: BusinessDate): Promise<DepositTaxMeaning | undefined>;
  /**
   * The counting splits of a PropertyReference whose tax year is `year` (§58A), and its retained deposits closed in
   * `year`, derived, filtered and paged; undefined for an unknown one.
   */
  listTaxMeanings(
    propertyReferenceId: string,
    mreRealmId: string,
    year: number,
    filter: TaxMeaningFilter,
    page: TaxPageRequest,
    today: BusinessDate,
  ): Promise<TaxPage<TaxListItem> | undefined>;
  /** A reserve withdrawal's meaning (§58B); undefined for an unknown statement or a position naming no reserve line. */
  findWithdrawalTaxMeaning(statementId: string, position: number, mreRealmId: string, today: BusinessDate): Promise<WegTaxMeaning | undefined>;
  /** A Sonderumlage use's meaning (§58B); undefined for an unknown assessment or a position naming no use. */
  findUseTaxMeaning(assessmentId: string, position: number, mreRealmId: string, today: BusinessDate): Promise<WegTaxMeaning | undefined>;
  /** The anschaffungsnahe check of an Acquisition (§58B), one snapshot; undefined for an unknown one. */
  anschaffungsnaheCheck(acquisitionId: string, mreRealmId: string, today: BusinessDate): Promise<AnschaffungsnaheCheck | undefined>;
  /**
   * What the tax-year view reads (§58C), in one `REPEATABLE READ READ ONLY` snapshot: §55's items of `year` and the
   * rest of its input; undefined for an unknown PropertyReference. With an `ownerPartyId` that names no Party of the
   * Realm, `ownerPartyFound` is false and nothing else is read.
   */
  readTaxYear(propertyReferenceId: string, mreRealmId: string, year: number, ownerPartyId: string | null, today: BusinessDate): Promise<TaxYearRead | undefined>;
  /** Every distinct stored `ruleCode@version`, both references (§58B), across Realms (the start check, §58). */
  storedRuleReferences(): Promise<readonly RuleRef[]>;
}

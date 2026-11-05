import type { BusinessDate, Money, RuleRef, RuleRegistry, RuleVersion } from '../../shared/index.js';
import type { Direction, TransactionStatus } from '../ledger/index.js';
import { anschaffungsnaheWindow } from './anschaffungsnahe.js';
import { ANSCHAFFUNGSNAHE, type AnschaffungsnaheParameters } from './rules/de-anschaffungsnahe.js';
import { CATEGORY_DEFAULTS, type CategoryDefaultsParameters } from './rules/de-category-defaults.js';
import { DISTRIBUTION_82B } from './rules/de-82b-distribution.js';
import { yearOf } from './cash-timing.js';
import { constructionPeriodCheck, type ConstructionPeriodRecordFacts, type ConstructionPeriodRefusal } from './construction-period-checks.js';
import { interestPolicyOn, isInterestSplit } from './construction-period-interest.js';
import { performanceCheck, performedOutside, type PerformanceRefusal } from './performance.js';
import type { AcquisitionFacts, NewTaxClassification } from './tax-classification.js';
import { partialTreatmentParts, type TreatmentPart } from './treatment-parts.js';
import { categoryDefaultsOn, splitCounts, type SplitFacts } from './tax-meaning.js';
import type { WegNotCounted } from './weg-sources.js';
import type { SourceType, TaxCategory, Treatment } from './vocabulary.js';

/**
 * The checks of a create (api-design.md §56, §58A, §58B), in their order: the source counts, a rule applies, the
 * treatment is allowed, the election, the net amount and the Acquisition, the years, and `supersedes`.
 */

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
  readonly sourceType: 'WEG_RESERVE_WITHDRAWAL' | 'WEG_ASSESSMENT_USE' | 'WEG_STATEMENT_COST_LINE';
} & WegNotCounted;

export type DistributionNotAllowedReason = 'NOT_MOSTLY_RESIDENTIAL' | 'NOT_AN_OUTFLOW';
export type AnschaffungsnaheNotApplicableReason =
  | 'OTHER_PROPERTY_REFERENCE'
  | 'ACQUISITION_NOT_CONFIRMED'
  | 'OUTSIDE_WINDOW'
  | 'NO_APPLICABLE_RULE'
  /** §58K (VC-X-34): the Acquisition has no `economicTransferDate`, so the check has no window. */
  | 'TRANSFER_DATE_MISSING'
  /**
   * §59F: no `performance` (`MISSING`), one straddling the window without a partial treatment (`STRADDLES_WINDOW`), or
   * (VC-X-38 Part 2) a partial treatment whose evidenced points leave the part in the window open (`SPLIT_NOT_EVIDENCED`)
   * or of a source begun before the transfer date (`STRADDLES_START`: the start or both edges, pending the owner/advisor).
   */
  | 'PERFORMANCE_REQUIRED'
  /** VC-X-38 Part 2: a partial treatment of a source performed wholly in the window (`NOT_STRADDLING`). */
  | 'PARTIAL_TREATMENT_NOT_APPLICABLE';

/** §59F, VC-X-38 Part 2: the `cause` of `PERFORMANCE_REQUIRED` and `PARTIAL_TREATMENT_NOT_APPLICABLE`. */
export type AnschaffungsnaheCause = 'MISSING' | 'STRADDLES_WINDOW' | 'STRADDLES_START' | 'SPLIT_NOT_EVIDENCED' | 'NOT_STRADDLING';

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
  | {
      readonly kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE';
      readonly reason: AnschaffungsnaheNotApplicableReason;
      readonly acquisitionId: string;
      readonly cause?: AnschaffungsnaheCause;
      /** `SPLIT_NOT_EVIDENCED`: the part in the window as the evidenced points bound it (amount used). */
      readonly inWindow?: { readonly lower: Money; readonly upper: Money };
    }
  | { readonly kind: 'TAX_YEAR_OUT_OF_RANGE'; readonly taxYear: number; readonly bookingYear: number }
  /** An undated withdrawal's `taxYear` outside the years its statement's period touches (§58B). */
  | { readonly kind: 'WITHDRAWAL_TAX_YEAR_OUT_OF_RANGE'; readonly taxYear: number; readonly allowedYears: readonly number[] }
  | { readonly kind: 'REFUND_YEAR_OUT_OF_RANGE'; readonly refundOfYear: number; readonly taxYear: number }
  | { readonly kind: 'CLASSIFICATION_EXISTS'; readonly currentClassificationId: string }
  | { readonly kind: 'NOT_CURRENT_CLASSIFICATION'; readonly currentClassificationId: string | null }
  /** §59E: Bauzeitzinsen. */
  | ConstructionPeriodRefusal
  /** §59F: the period of performance. */
  | PerformanceRefusal;

/** The fields of an election or a capitalisation following the check (§58B), as a create carries them. */
export type TreatmentRequest = Pick<
  NewTaxClassification,
  | 'taxCategory'
  | 'treatment'
  | 'netAmount'
  | 'mostlyResidentialConfirmed'
  | 'anschaffungsnaheAcquisitionId'
  | 'constructionPeriodInterestId'
  | 'performance'
  | 'partialTreatment'
> & { readonly sourceReferences?: readonly string[] };

/** §59E: what the create read of the split's Loan and the record it names (`undefined`: none named; `null`: not of the Realm). */
export interface InterestContext {
  readonly loanId: string | null;
  readonly record: ConstructionPeriodRecordFacts | null | undefined;
}

/** What the checks after the treatment read of a source (§58B). */
export interface TreatmentSource {
  readonly date: BusinessDate;
  readonly direction: Direction;
  /** The split's amount, the withdrawal's or use's unit share. */
  readonly grossAmount: Money;
  readonly propertyReferenceId: string | null;
  /** §59F: a split that is interest by §59E's list takes no `performance`; absent means not interest. */
  readonly interest?: boolean;
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
): { readonly treatmentRule: RuleRef | null; readonly treatmentParts?: readonly TreatmentPart[] } | CreateRefusal {
  if (request.treatment === 'DISTRIBUTED_82B') {
    if (request.mostlyResidentialConfirmed !== true) return { kind: 'DISTRIBUTION_NOT_ALLOWED', reason: 'NOT_MOSTLY_RESIDENTIAL' };
    if (source.direction !== 'OUTFLOW') return { kind: 'DISTRIBUTION_NOT_ALLOWED', reason: 'NOT_AN_OUTFLOW' };
  }
  const net = request.netAmount ?? null;
  // Equal is allowed: no VAT (a craftsman under § 19 UStG).
  if (net !== null && net.compare(source.grossAmount) > 0) return { kind: 'NET_AMOUNT_EXCEEDS_GROSS', netAmount: net, grossAmount: source.grossAmount };
  // §59F: the performance's checks that need the source, after the net amount and before the Acquisition.
  const performance = request.performance ?? null;
  if (performance !== null) {
    const refusal = performanceCheck(
      { date: source.date, grossAmount: source.grossAmount, interest: source.interest ?? false },
      { performance, netAmount: net, sourceReferences: request.sourceReferences ?? [] },
      registry,
    );
    if (refusal !== undefined) return refusal;
  }
  const acquisitionId = request.anschaffungsnaheAcquisitionId ?? null;
  if (acquisitionId === null) return { treatmentRule: distributionRule };
  if (acquisition === null || acquisition === undefined) return { kind: 'ACQUISITION_NOT_FOUND', acquisitionId };
  const notApplicable = (
    reason: AnschaffungsnaheNotApplicableReason,
    cause?: AnschaffungsnaheCause,
    inWindow?: { readonly lower: Money; readonly upper: Money },
  ): CreateRefusal => ({
    kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE',
    reason,
    acquisitionId,
    ...(cause === undefined ? {} : { cause }),
    ...(inWindow === undefined ? {} : { inWindow }),
  });
  if (acquisition.propertyReferenceId !== source.propertyReferenceId) return notApplicable('OTHER_PROPERTY_REFERENCE');
  if (acquisition.status !== 'CONFIRMED') return notApplicable('ACQUISITION_NOT_CONFIRMED');
  // §58K (VC-X-34): never a window from the contract date.
  const transfer = acquisition.transferDate;
  if (transfer === null) return notApplicable('TRANSFER_DATE_MISSING');
  const rule = registry.select(ANSCHAFFUNGSNAHE, transfer);
  if (rule === undefined) return notApplicable('NO_APPLICABLE_RULE');
  const window = anschaffungsnaheWindow(transfer, (rule.parameters as AnschaffungsnaheParameters).windowYears);
  // §59F (the owner's decision of 2026-11-02, open question 12): judged by the performance, never by the source's date;
  // only work performed wholly in the window is capitalised on the check (a straddling source needs an evidenced split).
  if (performance === null) return notApplicable('PERFORMANCE_REQUIRED', 'MISSING');
  if (performedOutside(performance, window)) return notApplicable('OUTSIDE_WINDOW');
  const treatmentRule = { ruleCode: rule.ruleCode, version: rule.version };
  const partial = (rule.parameters as AnschaffungsnaheParameters).performance.partialTreatment;
  // VC-X-38 Part 2 (Entscheidung des Projektinhabers, 2026-11-02, 239-2): a source straddling the window's end only by a
  // partial treatment whose parts the evidenced points determine exactly; never the whole source, never an estimate. A
  // source begun before the transfer date stays refused (`STRADDLES_START`; the start is not decided, beratungsfragen §4).
  const straddles = performance.from < window.from || performance.until > window.until;
  if (request.partialTreatment === true) {
    if (!straddles) return notApplicable('PARTIAL_TREATMENT_NOT_APPLICABLE', 'NOT_STRADDLING');
    // A rule without the parameter keeps the refusal of VC-X-38.
    if (partial === undefined) return notApplicable('PERFORMANCE_REQUIRED', 'STRADDLES_WINDOW');
    const parts = partialTreatmentParts(performance, source.grossAmount, net ?? source.grossAmount, window);
    if ('parts' in parts) return { treatmentRule, treatmentParts: parts.parts };
    if (parts.cause === 'NOT_STRADDLING') return notApplicable('PARTIAL_TREATMENT_NOT_APPLICABLE', 'NOT_STRADDLING');
    if (parts.cause === 'STRADDLES_START') return notApplicable('PERFORMANCE_REQUIRED', 'STRADDLES_START');
    return notApplicable('PERFORMANCE_REQUIRED', 'SPLIT_NOT_EVIDENCED', { lower: parts.lower, upper: parts.upper });
  }
  if (straddles) return notApplicable('PERFORMANCE_REQUIRED', 'STRADDLES_WINDOW');
  return { treatmentRule };
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
  request: Pick<NewTaxClassification, 'treatment' | 'supersedes' | 'taxYear' | 'refundOfYear' | 'interestPeriod'> & Partial<TreatmentRequest>,
  registry: RuleRegistry,
  derivedTaxYear: number = yearOf(facts.bookingDate),
  acquisition?: AcquisitionFacts | null,
  interest: InterestContext = { loanId: null, record: undefined },
):
  | { readonly kind: 'CLASSIFY'; readonly rule: RuleRef; readonly treatmentRule: RuleRef | null; readonly treatmentParts?: readonly TreatmentPart[] }
  | CreateRefusal {
  if (!splitCounts(facts)) return { kind: 'SOURCE_NOT_COUNTED', transactionStatus: facts.transactionStatus, correctionRole: facts.correctionRole };
  const rule = categoryDefaultsOn(registry, facts.bookingDate);
  if (rule === undefined) return { kind: 'NO_APPLICABLE_RULE', ruleCode: CATEGORY_DEFAULTS, date: facts.bookingDate };
  // §58L (VC-X-40, L4): an interest period only on a Loan's `LOAN_INTEREST` split (0069 guards it past the repository).
  if ((request.interestPeriod ?? null) !== null && (interest.loanId === null || facts.financialCategoryCode !== 'LOAN_INTEREST')) {
    return { kind: 'FIELD_NOT_SUPPORTED', field: 'interestPeriod' };
  }
  const source: TreatmentSource = {
    date: facts.bookingDate,
    direction: facts.direction,
    grossAmount: facts.amount,
    propertyReferenceId: facts.propertyReferenceId,
    // §59F: interest by §59E's list (its financial category or its line) takes no performance.
    interest: isInterestSplit(
      { loanId: interest.loanId, financialCategoryCode: facts.financialCategoryCode, taxCategory: request.taxCategory ?? null },
      interestPolicyOn(registry, facts.bookingDate).policy,
    ),
  };
  const distribution = distributionRuleCheck(source, request.treatment, registry);
  if (distribution !== undefined && 'kind' in distribution) return distribution;
  const spending = request.taxCategory === undefined ? undefined : wegSpendingRefusal('TRANSACTION_SPLIT', request.taxCategory);
  if (spending !== undefined) return spending;
  const refusal = treatmentRefusal(rule, { code: facts.financialCategoryCode, categoryType: facts.categoryType }, request.treatment);
  if (refusal !== undefined) return { kind: 'TREATMENT_NOT_ALLOWED', ...refusal };
  // §59E: Bauzeitzinsen, after TREATMENT_NOT_ALLOWED.
  const forbidden = rule.parameters.forbiddenTreatmentsByCode[facts.financialCategoryCode] ?? [];
  const construction = constructionPeriodCheck(
    { ...facts, loanId: interest.loanId },
    {
      taxCategory: request.taxCategory ?? 'UNCLASSIFIED',
      treatment: request.treatment,
      constructionPeriodInterestId: request.constructionPeriodInterestId ?? null,
    },
    interest.record,
    registry,
    rule.parameters.treatments.filter((t) => !forbidden.includes(t)),
  );
  if ('kind' in construction) return construction;
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
      // A record and an anschaffungsnahe link never come together (the API refuses both): one second reference.
      treatmentRule: construction.treatmentRule ?? fields.treatmentRule,
      ...(fields.treatmentParts === undefined ? {} : { treatmentParts: fields.treatmentParts }),
    }
  );
}

/** `supersedes` must name the current classification, and must be given when there is one (§56). */
export function supersedesCheck(currentId: string | null, supersedes: string | null): CreateRefusal | undefined {
  if (currentId !== null && supersedes === null) return { kind: 'CLASSIFICATION_EXISTS', currentClassificationId: currentId };
  if (supersedes !== null && supersedes !== currentId) return { kind: 'NOT_CURRENT_CLASSIFICATION', currentClassificationId: currentId };
  return undefined;
}

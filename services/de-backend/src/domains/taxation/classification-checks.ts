import type { BusinessDate, Money, RuleRef, RuleRegistry, RuleVersion } from '../../shared/index.js';
import type { Direction, TransactionStatus } from '../ledger/index.js';
import { anschaffungsnaheWindow } from './anschaffungsnahe.js';
import { ANSCHAFFUNGSNAHE, type AnschaffungsnaheParameters } from './rules/de-anschaffungsnahe.js';
import { CATEGORY_DEFAULTS, type CategoryDefaultsParameters } from './rules/de-category-defaults.js';
import { DISTRIBUTION_82B } from './rules/de-82b-distribution.js';
import { yearOf } from './cash-timing.js';
import type { AcquisitionFacts, NewTaxClassification } from './tax-classification.js';
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

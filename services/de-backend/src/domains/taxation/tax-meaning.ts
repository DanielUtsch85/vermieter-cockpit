import type { BusinessDate, Money, RuleRef, RuleRegistry, RuleVersion } from '../../shared/index.js';
import type { CategoryType, Direction, TransactionStatus } from '../ledger/index.js';
import type { CheckEntryFlag } from './anschaffungsnahe.js';
import { CATEGORY_DEFAULTS, type CategoryDefault, type CategoryDefaultsParameters } from './rules/de-category-defaults.js';
import { attributeTaxYear, refundOf, type RefundFlag, type RefundInfo, type TaxYearAttribution, type TaxYearFlag, type TimingInput } from './cash-timing.js';
import type { Distribution, DistributionFlag } from './distribution-82b.js';
import type { TaxClassification } from './tax-classification.js';
import type { Origin, ReviewState, TaxCategory, Treatment } from './vocabulary.js';

/**
 * The tax meaning of a split (api-design.md §55, §58A): its current classification, else its category's default, with
 * the year it counts in, its refund and its flags. Derived on read, never stored.
 */

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

import type { BusinessDate, RuleVersion } from '../../../shared/index.js';
import type { ReviewState, TaxCategory, Treatment } from '../vocabulary.js';

/** The default meaning of one category: derived on read, never stored (api-design.md §55, P7-D2). */
export interface CategoryDefault {
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: Extract<ReviewState, 'SUGGESTED' | 'NEEDS_REVIEW'>;
}

export interface CategoryDefaultsParameters {
  /** The lines this version knows (§55: the list is a rule parameter, extended by a new version). */
  readonly taxCategories: readonly TaxCategory[];
  /** The treatments this version knows. */
  readonly treatments: readonly Treatment[];
  /** By `financial_category.code`. */
  readonly defaults: Readonly<Record<string, CategoryDefault>>;
  /** A code the table does not list (one added later) reads as `OTHER`. */
  readonly unlisted: CategoryDefault;
  /**
   * The hard rules of §56 (`TREATMENT_NOT_ALLOWED`): these category types only `NOT_RELEVANT` (BFH IX R 19/24; A11,
   * E6); these codes never the treatments named: principal never `DEDUCTIBLE` (A1), the purchase payment never
   * `CAPITALIZED` (the AfA basis comes from the Acquisition aggregate; capitalising the cash would count it twice).
   */
  readonly notRelevantOnlyCategoryTypes: readonly string[];
  readonly forbiddenTreatmentsByCode: Readonly<Record<string, readonly Treatment[]>>;
  /**
   * The retained deposit (VC-7-02, §58A, A11): its default (never income), and the lines and treatments a
   * classification may give it; anything else is TREATMENT_NOT_ALLOWED.
   */
  readonly depositClosing: {
    readonly default: CategoryDefault;
    readonly taxCategories: readonly TaxCategory[];
    readonly treatments: readonly Treatment[];
  };
}

export const CATEGORY_DEFAULTS = 'DE_CATEGORY_DEFAULTS';

const suggested = (taxCategory: TaxCategory, treatment: Treatment | null): CategoryDefault => ({ taxCategory, treatment, reviewState: 'SUGGESTED' });
const toReview = (taxCategory: TaxCategory, treatment: Treatment | null): CategoryDefault => ({ taxCategory, treatment, reviewState: 'NEEDS_REVIEW' });
const notRelevant = suggested('NOT_RELEVANT', 'NOT_RELEVANT');

/**
 * Version 1 (§55's table, §58), with VC-7-02's additive lines and the `DEPOSIT_CLOSING` default (§58A): no existing
 * default changed. Frozen once VC-7-02 is merged (review on #159): every later change, an additive one too, is a new
 * version.
 */
export const DE_CATEGORY_DEFAULTS_V1: RuleVersion<CategoryDefaultsParameters> = {
  ruleCode: CATEGORY_DEFAULTS,
  version: 1,
  title: 'Steuerliche Bedeutung der Kategorien (Vorschlag)',
  legalBasis: '§ 8, § 9, § 11, § 21 EStG',
  effectiveFrom: '2000-01-01' as BusinessDate,
  effectiveTo: null,
  parameters: {
    taxCategories: [
      'RENT',
      'OPERATING_COST_ADVANCES',
      'OPERATING_COST_SETTLEMENT',
      'OTHER_INCOME',
      'REFUNDS_OF_EARLIER_YEARS',
      'RETAINED_DEPOSIT_RENT',
      'RETAINED_DEPOSIT_DAMAGES',
      'LOAN_INTEREST',
      'FINANCING_COSTS',
      'WEG_HAUSGELD',
      'MAINTENANCE',
      'ADMINISTRATION',
      'INSURANCE',
      'PROPERTY_TAX',
      'BANK_FEES',
      'TAX_ADVICE',
      'TRAVEL',
      'OTHER_EXPENSE',
      'NOT_RELEVANT',
      'UNCLASSIFIED',
    ],
    treatments: ['INCOME', 'DEDUCTIBLE', 'CAPITALIZED', 'NOT_RELEVANT'],
    defaults: {
      RENT_BASE: suggested('RENT', 'INCOME'),
      RENT_OPERATING_COST_ADVANCE: suggested('OPERATING_COST_ADVANCES', 'INCOME'),
      RENT_OPERATING_COST_SETTLEMENT: suggested('OPERATING_COST_SETTLEMENT', 'INCOME'),
      OTHER_INCOME: toReview('OTHER_INCOME', 'INCOME'),
      LOAN_INTEREST: suggested('LOAN_INTEREST', 'DEDUCTIBLE'),
      LOAN_PRINCIPAL: notRelevant,
      WEG_RECOVERABLE: suggested('WEG_HAUSGELD', 'DEDUCTIBLE'),
      WEG_NON_RECOVERABLE: suggested('WEG_HAUSGELD', 'DEDUCTIBLE'),
      WEG_RESERVE_CONTRIBUTION: notRelevant,
      WEG_SPECIAL_ASSESSMENT: notRelevant,
      MAINTENANCE: suggested('MAINTENANCE', 'DEDUCTIBLE'),
      ADMINISTRATION: suggested('ADMINISTRATION', 'DEDUCTIBLE'),
      INSURANCE: suggested('INSURANCE', 'DEDUCTIBLE'),
      PROPERTY_TAX: suggested('PROPERTY_TAX', 'DEDUCTIBLE'),
      BANK_FEES: suggested('BANK_FEES', 'DEDUCTIBLE'),
      OTHER_EXPENSE: toReview('UNCLASSIFIED', null),
      SECURITY_DEPOSIT: notRelevant,
      SECURITY_DEPOSIT_INTEREST: notRelevant,
      ACQUISITION: notRelevant,
      OWNER_CONTRIBUTION: notRelevant,
      OWNER_WITHDRAWAL: notRelevant,
      TRANSFER: notRelevant,
      OTHER: toReview('UNCLASSIFIED', null),
    },
    unlisted: toReview('UNCLASSIFIED', null),
    notRelevantOnlyCategoryTypes: ['WEG_FUNDS', 'SECURITY_DEPOSIT', 'TRANSFER'],
    forbiddenTreatmentsByCode: { LOAN_PRINCIPAL: ['DEDUCTIBLE'], ACQUISITION: ['CAPITALIZED'] },
    depositClosing: {
      default: toReview('UNCLASSIFIED', null),
      taxCategories: ['RETAINED_DEPOSIT_RENT', 'RETAINED_DEPOSIT_DAMAGES', 'NOT_RELEVANT'],
      treatments: ['INCOME', 'NOT_RELEVANT'],
    },
  },
  source:
    'docs/germany/taxation.md §4–§5 (v0.2); BFH IX R 19/24 vom 14.01.2025 (WEG_FUNDS); phase-7-plan P7-D2, P7-D4; api-design §55, §58A (reviews on #157, #159); verification-checklist A1, A10, A11, D8, E6',
};

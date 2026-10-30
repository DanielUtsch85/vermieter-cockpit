/**
 * The words of a tax meaning (api-design.md §55, phase-7-plan P7-D2, domain-model §45). Taxation interprets cash and
 * never writes it (ADR-006, AGENTS.md §16).
 */

/** The lines of the tax-year view (VC-7-04). Which ones a rule version knows is its parameter (§55). */
export const TAX_CATEGORIES = [
  'RENT',
  'OPERATING_COST_ADVANCES',
  'OPERATING_COST_SETTLEMENT',
  'OTHER_INCOME',
  /** VC-7-02 (§58A, P7-D4): a refund of an earlier year's expense, income of the year received (A10). */
  'REFUNDS_OF_EARLIER_YEARS',
  /** VC-7-02 (§58A, A11): a retained deposit as compensation for unpaid rent, or for damage. */
  'RETAINED_DEPOSIT_RENT',
  'RETAINED_DEPOSIT_DAMAGES',
  'LOAN_INTEREST',
  'FINANCING_COSTS',
  'WEG_HAUSGELD',
  'WEG_SPENDING',
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
] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

/** The income lines: only with the treatment `INCOME` (§56). */
export const INCOME_TAX_CATEGORIES = [
  'RENT',
  'OPERATING_COST_ADVANCES',
  'OPERATING_COST_SETTLEMENT',
  'OTHER_INCOME',
  'REFUNDS_OF_EARLIER_YEARS',
  'RETAINED_DEPOSIT_RENT',
  'RETAINED_DEPOSIT_DAMAGES',
] as const satisfies readonly TaxCategory[];

/** The lines of a retained deposit (§58A): compensation for rent or damage, or not relevant. */
export const DEPOSIT_TAX_CATEGORIES = ['RETAINED_DEPOSIT_RENT', 'RETAINED_DEPOSIT_DAMAGES', 'NOT_RELEVANT'] as const satisfies readonly TaxCategory[];

/** An income line (§56). */
export const isIncomeLine = (taxCategory: TaxCategory) => (INCOME_TAX_CATEGORIES as readonly TaxCategory[]).includes(taxCategory);

/** An expense line: neither income, nor `NOT_RELEVANT`, nor `UNCLASSIFIED` (§58A's refunds). */
export const isExpenseLine = (taxCategory: TaxCategory) => !isIncomeLine(taxCategory) && taxCategory !== 'NOT_RELEVANT' && taxCategory !== 'UNCLASSIFIED';

export const TREATMENTS = ['INCOME', 'DEDUCTIBLE', 'CAPITALIZED', 'DISTRIBUTED_82B', 'NOT_RELEVANT'] as const;
export type Treatment = (typeof TREATMENTS)[number];

/**
 * The lines of Erhaltungsaufwand (§58B, P7-D6): the only ones that take `netAmount`, `annuallyRecurring`,
 * `DISTRIBUTED_82B` and a capitalisation following the anschaffungsnahe check.
 */
export const ERHALTUNG_TAX_CATEGORIES = ['MAINTENANCE', 'WEG_SPENDING'] as const satisfies readonly TaxCategory[];
export const isErhaltungLine = (taxCategory: TaxCategory) => (ERHALTUNG_TAX_CATEGORIES as readonly TaxCategory[]).includes(taxCategory);

/** `SUGGESTED` is only derived; the other three are stored (§57). */
export const REVIEW_STATES = ['SUGGESTED', 'USER_CONFIRMED', 'ADVISOR_CONFIRMED', 'NEEDS_REVIEW'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export type StoredReviewState = Exclude<ReviewState, 'SUGGESTED'>;
/** What a create may store (§56): `ADVISOR_CONFIRMED` only through §57. */
export const CREATE_REVIEW_STATES = ['USER_CONFIRMED', 'NEEDS_REVIEW'] as const satisfies readonly StoredReviewState[];
export type CreateReviewState = (typeof CREATE_REVIEW_STATES)[number];

/** The sources of a classification; VC-7-01 classifies splits, VC-7-02 retained deposits, VC-7-03 the WEG ones (§55, §58B). */
export const SOURCE_TYPES = ['TRANSACTION_SPLIT', 'WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE', 'DEPOSIT_CLOSING'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
/** The two WEG sources (§58B): named by their row and a `sourcePosition`. */
export const WEG_SOURCE_TYPES = ['WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE'] as const satisfies readonly SourceType[];
export type WegSourceType = (typeof WEG_SOURCE_TYPES)[number];
export const isWegSource = (sourceType: SourceType): sourceType is WegSourceType => (WEG_SOURCE_TYPES as readonly SourceType[]).includes(sourceType);

export const ORIGINS = ['DEFAULT', 'CLASSIFICATION'] as const;
export type Origin = (typeof ORIGINS)[number];

/**
 * Whether `taxCategory` and `treatment` fit (§56, §58B): an income line only with `INCOME`, `NOT_RELEVANT` only with
 * `NOT_RELEVANT`, `UNCLASSIFIED` only without a treatment, every other line with a treatment other than `INCOME`;
 * `DISTRIBUTED_82B` only on a line of Erhaltungsaufwand (§ 82b EStDV distributes Erhaltungsaufwand only).
 */
export function treatmentFits(taxCategory: TaxCategory, treatment: Treatment | null): boolean {
  if (isIncomeLine(taxCategory)) return treatment === 'INCOME';
  if (taxCategory === 'NOT_RELEVANT') return treatment === 'NOT_RELEVANT';
  if (taxCategory === 'UNCLASSIFIED') return treatment === null;
  if (treatment === 'DISTRIBUTED_82B') return isErhaltungLine(taxCategory);
  return treatment !== null && treatment !== 'INCOME';
}

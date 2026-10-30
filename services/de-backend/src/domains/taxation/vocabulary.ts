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
export const INCOME_TAX_CATEGORIES = ['RENT', 'OPERATING_COST_ADVANCES', 'OPERATING_COST_SETTLEMENT', 'OTHER_INCOME'] as const satisfies readonly TaxCategory[];

export const TREATMENTS = ['INCOME', 'DEDUCTIBLE', 'CAPITALIZED', 'DISTRIBUTED_82B', 'NOT_RELEVANT'] as const;
export type Treatment = (typeof TREATMENTS)[number];

/** Of a later item (VC-7-03): `400 NOT_SUPPORTED` in VC-7-01. */
export const LATER_TAX_CATEGORIES = ['WEG_SPENDING'] as const satisfies readonly TaxCategory[];
export const LATER_TREATMENTS = ['DISTRIBUTED_82B'] as const satisfies readonly Treatment[];

/** `SUGGESTED` is only derived; the other three are stored (§57). */
export const REVIEW_STATES = ['SUGGESTED', 'USER_CONFIRMED', 'ADVISOR_CONFIRMED', 'NEEDS_REVIEW'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export type StoredReviewState = Exclude<ReviewState, 'SUGGESTED'>;
/** What a create may store (§56): `ADVISOR_CONFIRMED` only through §57. */
export const CREATE_REVIEW_STATES = ['USER_CONFIRMED', 'NEEDS_REVIEW'] as const satisfies readonly StoredReviewState[];
export type CreateReviewState = (typeof CREATE_REVIEW_STATES)[number];

/** The sources of a classification; VC-7-01 classifies splits, VC-7-02/03 add the others (§55). */
export const SOURCE_TYPES = ['TRANSACTION_SPLIT', 'WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE', 'DEPOSIT_CLOSING'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SUPPORTED_SOURCE_TYPES = ['TRANSACTION_SPLIT'] as const satisfies readonly SourceType[];

export const ORIGINS = ['DEFAULT', 'CLASSIFICATION'] as const;
export type Origin = (typeof ORIGINS)[number];

/**
 * Whether `taxCategory` and `treatment` fit (§56): an income line only with `INCOME`, `NOT_RELEVANT` only with
 * `NOT_RELEVANT`, `UNCLASSIFIED` only without a treatment, every other line with a treatment other than `INCOME`.
 */
export function treatmentFits(taxCategory: TaxCategory, treatment: Treatment | null): boolean {
  if ((INCOME_TAX_CATEGORIES as readonly TaxCategory[]).includes(taxCategory)) return treatment === 'INCOME';
  if (taxCategory === 'NOT_RELEVANT') return treatment === 'NOT_RELEVANT';
  if (taxCategory === 'UNCLASSIFIED') return treatment === null;
  return treatment !== null && treatment !== 'INCOME';
}

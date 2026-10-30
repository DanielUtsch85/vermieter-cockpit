/**
 * Taxation domain (phase-7-plan.md, api-design.md §55–§58A): the rule registry, the category defaults, the tax year of
 * cash (the 10-day rule), refunds, and the TaxClassification of a split or a retained deposit. Taxation interprets
 * cash; it never writes it. See docs/development/coding-guidelines.md §3.
 */
export {
  CREATE_REVIEW_STATES,
  DEPOSIT_TAX_CATEGORIES,
  INCOME_TAX_CATEGORIES,
  LATER_TAX_CATEGORIES,
  LATER_TREATMENTS,
  ORIGINS,
  REVIEW_STATES,
  SOURCE_TYPES,
  SUPPORTED_SOURCE_TYPES,
  TAX_CATEGORIES,
  TREATMENTS,
  isExpenseLine,
  isIncomeLine,
  treatmentFits,
} from './vocabulary.js';
export type { CreateReviewState, Origin, ReviewState, SourceType, StoredReviewState, SupportedSourceType, TaxCategory, Treatment } from './vocabulary.js';
export { RULE_STATUSES, ruleKey } from './rules/rule-version.js';
export type { RuleRef, RuleStatus, RuleVersion } from './rules/rule-version.js';
export { RuleRegistry, TAX_RULES } from './rules/registry.js';
export { CATEGORY_DEFAULTS, DE_CATEGORY_DEFAULTS_V1 } from './rules/de-category-defaults.js';
export type { CategoryDefault, CategoryDefaultsParameters } from './rules/de-category-defaults.js';
export { CASH_TIMING, DE_CASH_TIMING_V1 } from './rules/de-cash-timing.js';
export type { CashTimingParameters } from './rules/de-cash-timing.js';
export {
  DUE_DATE_SOURCES,
  TIMING_SOURCES,
  attributeTaxYear,
  cashTimingOn,
  dayIn,
  hausgeldTiming,
  interestTiming,
  needsTiming,
  refundOf,
  rentTiming,
  widestWindowDays,
  windowYearEnd,
  yearOf,
} from './cash-timing.js';
export type { DueDateSource, EconomicPeriod, NoPeriodReason, RefundFlag, RefundInfo, TaxYearAttribution, TaxYearFlag, TimingInput } from './cash-timing.js';
export {
  categoryDefaultsOn,
  classificationFingerprint,
  defaultOf,
  deriveTaxMeaning,
  planClassification,
  planReview,
  splitCounts,
  supersedesCheck,
  treatmentRefusal,
} from './classification.js';
export type {
  CorrectedOriginal,
  CreateClassificationOutcome,
  CreateRefusal,
  DepositNotCounted,
  DepositNotCountedReason,
  NewTaxClassification,
  ReviewClassificationOutcome,
  ReviewPlan,
  ReviewRefusal,
  ReviewStep,
  SplitFacts,
  TaxClassification,
  TaxClassificationId,
  TaxClassificationRepository,
  TaxListItem,
  TaxMeaning,
  TaxMeaningFilter,
  TaxMeaningFlag,
  TaxPage,
  TaxPageRequest,
  TaxYearInputs,
} from './classification.js';
export { depositNotCounted, deriveDepositTaxMeaning, planDepositClassification } from './deposit-closing.js';
export type { DepositFacts, DepositTaxMeaning, DepositTaxMeaningFlag } from './deposit-closing.js';

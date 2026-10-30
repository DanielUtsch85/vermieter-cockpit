/**
 * Taxation domain (phase-7-plan.md, api-design.md §55–§58): the rule registry, the category defaults and the
 * TaxClassification of a split. Taxation interprets cash; it never writes it. See docs/development/coding-guidelines.md §3.
 */
export {
  CREATE_REVIEW_STATES,
  INCOME_TAX_CATEGORIES,
  LATER_TAX_CATEGORIES,
  LATER_TREATMENTS,
  ORIGINS,
  REVIEW_STATES,
  SOURCE_TYPES,
  SUPPORTED_SOURCE_TYPES,
  TAX_CATEGORIES,
  TREATMENTS,
  treatmentFits,
} from './vocabulary.js';
export type { CreateReviewState, Origin, ReviewState, SourceType, StoredReviewState, TaxCategory, Treatment } from './vocabulary.js';
export { RULE_STATUSES, ruleKey } from './rules/rule-version.js';
export type { RuleRef, RuleStatus, RuleVersion } from './rules/rule-version.js';
export { RuleRegistry, TAX_RULES } from './rules/registry.js';
export { CATEGORY_DEFAULTS, DE_CATEGORY_DEFAULTS_V1 } from './rules/de-category-defaults.js';
export type { CategoryDefault, CategoryDefaultsParameters } from './rules/de-category-defaults.js';
export {
  categoryDefaultsOn,
  classificationFingerprint,
  defaultOf,
  deriveTaxMeaning,
  planClassification,
  planReview,
  splitCounts,
  treatmentRefusal,
} from './classification.js';
export type {
  CorrectedOriginal,
  CreateClassificationOutcome,
  CreateRefusal,
  NewTaxClassification,
  ReviewClassificationOutcome,
  ReviewPlan,
  ReviewRefusal,
  ReviewStep,
  SplitFacts,
  TaxClassification,
  TaxClassificationId,
  TaxClassificationRepository,
  TaxMeaning,
  TaxMeaningFilter,
  TaxMeaningFlag,
  TaxPage,
  TaxPageRequest,
} from './classification.js';

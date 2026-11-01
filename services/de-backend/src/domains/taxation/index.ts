/**
 * Taxation domain (phase-7-plan.md, api-design.md §55–§58A): its rule versions, the category defaults, the tax year of
 * cash (the 10-day rule), refunds, and the TaxClassification of a split or a retained deposit. Taxation interprets
 * cash; it never writes it. See docs/development/coding-guidelines.md §3.
 */
export {
  CREATE_REVIEW_STATES,
  DEPOSIT_TAX_CATEGORIES,
  ERHALTUNG_TAX_CATEGORIES,
  INCOME_TAX_CATEGORIES,
  ORIGINS,
  REVIEW_STATES,
  SOURCE_TYPES,
  TAX_CATEGORIES,
  TREATMENTS,
  WEG_SOURCE_TYPES,
  isErhaltungLine,
  isExpenseLine,
  isIncomeLine,
  isWegSource,
  treatmentFits,
} from './vocabulary.js';
export type { CreateReviewState, Origin, ReviewState, SourceType, StoredReviewState, TaxCategory, Treatment, WegSourceType } from './vocabulary.js';
// The registry kernel is shared (P8-D11, §59); re-exported for the Phase-7 importers. `TAX_RULES` is `domains/tax-rules/`'s.
export { RULE_STATUSES, RuleRegistry, ruleKey } from '../../shared/index.js';
export type { RuleRef, RuleStatus, RuleVersion } from '../../shared/index.js';
export { TAXATION_RULE_VERSIONS } from './rules/versions.js';
export { CATEGORY_DEFAULTS, DE_CATEGORY_DEFAULTS_V1 } from './rules/de-category-defaults.js';
export type { CategoryDefault, CategoryDefaultsParameters } from './rules/de-category-defaults.js';
export { CASH_TIMING, DE_CASH_TIMING_V1 } from './rules/de-cash-timing.js';
export { DE_WEG_SPENDING_V1, WEG_SPENDING } from './rules/de-weg-spending.js';
export type { WegSpendingParameters } from './rules/de-weg-spending.js';
export { DE_82B_DISTRIBUTION_V1, DISTRIBUTION_82B } from './rules/de-82b-distribution.js';
export type { Distribution82bParameters } from './rules/de-82b-distribution.js';
export { ANSCHAFFUNGSNAHE, DE_ANSCHAFFUNGSNAHE_V1 } from './rules/de-anschaffungsnahe.js';
export type { AnschaffungsnaheParameters } from './rules/de-anschaffungsnahe.js';
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
  distributionRuleCheck,
  planClassification,
  planReview,
  ruleSupersededFlags,
  splitCounts,
  supersedesCheck,
  treatmentFieldsCheck,
  treatmentRefusal,
  wegSpendingRefusal,
} from './classification.js';
export type {
  AcquisitionFacts,
  AnschaffungsnaheNotApplicableReason,
  CorrectedOriginal,
  DistributionNotAllowedReason,
  TreatmentSuggestion,
  WegSourceNotCounted,
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
export { distribute, distributionRuleOn, partOf } from './distribution-82b.js';
export type { Distribution, DistributionFlag, DistributionOwnership, DistributionPart } from './distribution-82b.js';
export {
  BOOKING_DATE_EDGE_DAYS,
  NOT_COMPUTABLE_REASONS,
  anschaffungsnaheRuleOn,
  anschaffungsnaheWindow,
  checkAnschaffungsnahe,
  checkFlagsOf,
} from './anschaffungsnahe.js';
export type {
  AnschaffungsnaheCheck,
  CheckAcquisition,
  CheckAllocation,
  CheckBasis,
  CheckEntry,
  CheckEntryFlag,
  CheckFlag,
  CheckSource,
  CheckStatus,
  NotComputableReason,
  NotFinalReason,
} from './anschaffungsnahe.js';
export {
  deriveWegTaxMeaning,
  financialYearOf,
  planWegClassification,
  possiblyTwice,
  useFacts,
  wegNotCounted,
  wegSourceKey,
  wegSpendingOn,
  withdrawalFacts,
  withdrawalUnitShare,
} from './weg-sources.js';
export type { DateSource, MeaFraction, OtherWegSource, WegNotCounted, WegSourceFacts, WegSourceFlag, WegTaxMeaning, WegTaxMeaningFlag } from './weg-sources.js';
export { distributionOf, withTreatmentEffects } from './treatment-effects.js';
export { amendmentLists, attributionChanges, listBefore } from './attribution-changes.js';
export type {
  AttributionCandidate,
  AttributionChange,
  AttributionChanges,
  AttributionInput,
  ReferenceAmendment,
  ReferenceHistory,
} from './attribution-changes.js';
export { capitalizedItemsOf } from './capitalized-items.js';
export type { CapitalizedSource, CapitalizedSourceInput } from './capitalized-items.js';
export {
  AFA_LINES,
  EINNAHMEN_LINES,
  NO_DEPRECIATION,
  OPEN_AFA_YEAR_FLAGS,
  afaOf,
  componentOfItem,
  LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY,
  LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS,
  NOT_OWNED,
  TAX_YEAR_ITEM_LIMIT,
  TAX_YEAR_PLACES,
  WERBUNGSKOSTEN_LINES,
  buildTaxYearView,
  flagIsOpen,
  foldPerOwner,
  loanInterestOf,
  participantsOn,
  placementOf,
  reviewOf,
  ruleVersionsOf,
  shareOut,
  signedCents,
  sourceKeyOf,
} from './tax-year-view.js';
export type {
  AfaItem,
  AfaLine,
  AfaLineCode,
  CapitalizedComponent,
  DepreciationFlag,
  DepreciationSourceRef,
  FoldedParts,
  Level,
  LoanInterestCase,
  LoanInterestSplit,
  NotAttributedReason,
  Participant,
  Placement,
  TaxYearAcquisition,
  TaxYearDepreciation,
  TaxYearDepreciationAsset,
  TaxYearDepreciationBlock,
  TaxYearDepreciationComponent,
  TaxYearDepreciationPart,
  TaxYearItem,
  TaxYearLine,
  TaxYearLoanAllocation,
  TaxYearOutcome,
  TaxYearRead,
  TaxYearResult,
  TaxYearReview,
  TaxYearRuleVersion,
  TaxYearSection,
  TaxYearTotals,
  TaxYearView,
  ViewFlag,
  ViewOwnership,
} from './tax-year-view.js';

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
  MEANING_SOURCE_TYPES,
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
export type {
  CreateReviewState,
  MeaningSourceType,
  Origin,
  ReviewState,
  SourceType,
  StoredReviewState,
  TaxCategory,
  Treatment,
  WegSourceType,
} from './vocabulary.js';
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
export type {
  AnschaffungsnaheParameters,
  HausgeldMaintenanceParameters,
  PartialTreatmentParameters,
  PerformanceParameters,
} from './rules/de-anschaffungsnahe.js';
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
export { PROPOSED_BY_10_DAY_RULE, proposalIsOpen, proposedSplits, yearProposalIsOpen } from './ten-day-proposal.js';
export type { ProposalCandidate, ProposedSplit } from './ten-day-proposal.js';
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
  InterestContext,
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
  NOT_COMPUTABLE_REASONS,
  anschaffungsnaheRuleOn,
  anschaffungsnaheWindow,
  checkAnschaffungsnahe,
  checkFlagsOf,
  searchRangesOf,
} from './anschaffungsnahe.js';
export { NO_HAUSGELD, readHausgeld, readRangeOf } from './anschaffungsnahe-hausgeld.js';
export type {
  CostLineGroup,
  HausgeldInput,
  HausgeldLine,
  HausgeldMembership,
  HausgeldStatement,
  MissingStatement,
  UnjudgedLine,
} from './anschaffungsnahe-hausgeld.js';
export { costLineNotCounted, costLineRuleOn, planCostLineClassification } from './cost-line-classification.js';
export type { CostLineFacts } from './cost-line-classification.js';
export { partInWindow, performanceCheck, performanceJson, performanceParametersOn, performedOutside } from './performance.js';
export type { Performance, PerformancePoint, PerformanceRefusal } from './performance.js';
export { partAmountOf, partialTreatmentParts, treatmentPartsJson } from './treatment-parts.js';
export type { PartialTreatmentRefusal, TreatmentPart } from './treatment-parts.js';
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
export { CHANGE_KINDS, amendmentLists, attributionChanges, changeEntry, changeFingerprint, listBefore } from './attribution-changes.js';
export type {
  AttributionCandidate,
  AttributionChange,
  AttributionChanges,
  AttributionInput,
  ChangeEntityType,
  ChangeItem,
  ChangeKind,
  InconsistentHistory,
  MarkedChange,
  ReferenceAmendment,
  ReferenceHistory,
} from './attribution-changes.js';
export type {
  HistoryRecord,
  LoanInterestCandidate,
  LoanTermsHistory,
  ReconciliationCandidate,
  ReconciliationHistory,
  ReconciliationInput,
  TermsHistory,
} from './attribution-history.js';
export { closingChanges } from './attribution-history.js';
export { depositPartOn, depositSteps } from './attribution-deposits.js';
export type { DepositPartHistory, DepositReconciliationHistory, DepositStep } from './attribution-deposits.js';
export { DEPOSIT_YEAR_KINDS, isDepositYearKind } from './attribution-rule.js';
export { closingYear, depositClosingChanges, replayClosing } from './attribution-reopen.js';
export type { ClosingStep, DepositClosingHistory, DepositClosingRecord, DepositClosingState } from './attribution-reopen.js';
export { correctionRecordOf, correctionSteps, splitPartOn } from './attribution-corrections.js';
export { planFactsOf, scheduleSteps } from './attribution-loan-schedule-parts.js';
export type { LoanScheduleHistory, ScheduleKind, ScheduleStep } from './attribution-loan-schedule-parts.js';
export type { CorrectionHistory, CorrectionRecord, CorrectionSplit, CorrectionStep } from './attribution-corrections.js';
export {
  PART_CHANGE_KINDS,
  PART_STATES,
  PROPERTY_PART_CHANGED,
  isPartKind,
  partChangeEntry,
  partChangeFingerprint,
  partChanges,
  partItemFlags,
  partItemJson,
  partMoved,
  partOn,
} from './attribution-parts.js';
export type {
  AllocationSetHistory,
  LoanSetsHistory,
  MarkedPartChange,
  Part,
  PartCandidate,
  PartChange,
  PartChangeEntityType,
  PartChangeInput,
  PartChangeKind,
  PartChanges,
  PartItem,
  PartState,
} from './attribution-parts.js';
export { TAX_STATEMENT_STATUSES, confirmationMark, matchAcknowledgement, nothingToConfirm, planAcknowledgement } from './tax-statements.js';
export { OWNERSHIP_START_FLAG, ownershipStartChanges, ownershipStartEntry, ownershipStartIsOpen } from './ownership-start-changes.js';
export type { OwnershipStartChange, OwnershipStartFact, OwnershipStartKind } from './ownership-start-changes.js';
export { OWNERSHIP_EXTENDED_FLAG, ownershipAlignmentChanges, ownershipAlignmentEntry } from './ownership-alignment-changes.js';
export type { OwnershipAlignmentChange, OwnershipAlignmentFact, OwnershipAlignmentKind } from './ownership-alignment-changes.js';
export type {
  AcknowledgeDecision,
  AcknowledgeOutcome,
  AcknowledgedKind,
  AnyChange,
  AcknowledgementMark,
  ConfirmOutcome,
  ConfirmationMark,
  LoanAllocationTaxConfirmation,
  NothingToConfirmCause,
  TaxStatementStatus,
  TaxStatementRepository,
  TaxYearAcknowledgement,
  WithdrawOutcome,
} from './tax-statements.js';
export { SEVERAL_ALLOCATION_SETS, capitalizedItemsOf, capitalizedSourcesOf } from './capitalized-items.js';
export type { CapitalizedSource, CapitalizedSourceInput, CapitalizedSourceLoan, NotASource } from './capitalized-items.js';
export { CONSTRUCTION_PERIOD_INTEREST, DE_CONSTRUCTION_PERIOD_INTEREST_V1 } from './rules/de-construction-period-interest.js';
export type { ConstructionPeriodInterestParameters } from './rules/de-construction-period-interest.js';
export {
  CONSTRUCTION_PERIOD_DATE_OUTSIDE,
  CONSTRUCTION_PERIOD_REVIEW_STATES,
  CONSTRUCTION_PERIOD_STATUSES,
  CONSTRUCTION_PERIOD_TREATMENT_MIXED,
  INTEREST_CAPITALIZED_CONDITIONS_MISSING,
  INTEREST_REASONS,
  MAX_CONSTRUCTION_PERIOD_PROPERTIES,
  MAX_FUNDS_SHARE_DENOMINATOR,
  STRICT_INTEREST_POLICY,
  canonicalFacts,
  constructionPeriodFlags,
  interestPolicyOn,
  interestReasonOf,
  isInterestSplit,
  pickFacts,
  planAmend,
} from './construction-period-interest.js';
export type {
  AmendPlan,
  ConstructionPeriodChanges,
  ConstructionPeriodFacts,
  ConstructionPeriodInterest,
  ConstructionPeriodReviewState,
  ConstructionPeriodStatus,
  ConstructionPeriodView,
  FundsShare,
  InterestFacts,
  InterestPolicy,
  InterestReason,
  NewConstructionPeriodInterest,
} from './construction-period-interest.js';
export type {
  ChangeRecordOutcome,
  ConfirmStep,
  ConstructionPeriodInterestRepository,
  CreateRecordOutcome,
  NamingClassification,
} from './construction-period-repository.js';
export { constructionPeriodCheck } from './construction-period-checks.js';
export type { ConstructionPeriodRecordFacts, ConstructionPeriodRefusal, InterestSplitFacts } from './construction-period-checks.js';
export { inBuildingBasis, withInterestFlags, withLoanInterestFlags } from './tax-year-interest.js';
export { daysIn, deviationOf, distributeOverPeriod, interestPeriodOf, schedulePeriodOf, setsOfSegments } from './loan-interest-periods.js';
export type {
  InterestPeriod,
  InterestPeriodSource,
  LoanPeriodFacts,
  PeriodDeviation,
  PeriodDistribution,
  PeriodSegment,
  PeriodWeight,
} from './loan-interest-periods.js';
export type { NotInBasisReason } from './tax-year-interest.js';
export {
  AFA_LINES,
  EINNAHMEN_LINES,
  NO_DEPRECIATION,
  OPEN_AFA_YEAR_FLAGS,
  afaOf,
  componentOfItem,
  INTEREST_PERIOD_UNKNOWN,
  LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY,
  LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS,
  LOAN_INTEREST_OUTSIDE_LETTING,
  NOT_OWNED,
  TAX_YEAR_ITEM_LIMIT,
  TAX_YEAR_PLACES,
  WERBUNGSKOSTEN_LINES,
  buildTaxYearView,
  flagIsOpen,
  notCountedIsOpen,
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

/**
 * Depreciation domain (phase-8-plan.md, api-design.md §59, §59A, §59B): the DepreciationAsset with its facts (a building
 * or a separate asset), the rules `DE_AFA_BUILDING_LINEAR` and `DE_AFA_MOVABLE_LINEAR`, the rate derived from them and
 * the schedule of the purchase and of the capitalised items. It imports `shared/`, and the Acquisition and Ownership
 * domains through their indexes (the basis and the tenure, §59A), never Taxation or `tax-rules/`: the capitalised items
 * arrive as its own input type (`CapitalizedItem`), filled in `infrastructure/`, and the registry as a parameter
 * (P8-D11, §59B). Depreciation writes no cash. See docs/development/coding-guidelines.md §3.
 */
export {
  AMEND_REVIEW_STATES,
  ASSET_REVIEW_STATES,
  ASSET_STATUSES,
  ASSET_TYPES,
  COMPLETION_YEAR_MAX,
  COMPLETION_YEAR_MIN,
  CONFIRM_REVIEW_STATES,
  DEPRECIATION_METHODS,
  MAX_ASSET_ITEMS,
  MAX_ASSET_SOURCE_REFERENCES,
  MAX_SHORTER_USEFUL_LIVES,
  METHOD_OF_TYPE,
  SUPPORTED_ASSET_TYPES,
  USEFUL_LIFE_MAX_YEARS,
  USEFUL_LIFE_MIN_YEARS,
  addedItems,
  advisorsOf,
  amendFieldsNotAllowed,
  assetFingerprint,
  entryAcquisitionRefusal,
  isConfirmed,
  itemLinkRefusal,
  planAssetAmend,
  planAssetConfirm,
  sortedEntries,
  sortedItems,
  writtenEntries,
  writtenPurchaseMethods,
} from './asset.js';
// The method status of a purchase (api-design.md §59C, VC-X-37).
export {
  CONSIDERATIONS,
  MAX_PURCHASE_METHODS,
  METHOD_CAUSES,
  METHOD_REASONS,
  PURCHASE_METHODS,
  SPECIAL_DEPRECIATIONS,
  canonicalSpecial,
  isMethodReason,
  methodReasonOf,
  methodStatusOf,
} from './purchase-method.js';
export type {
  ChangedPurchaseMethod,
  Consideration,
  MethodCause,
  MethodReason,
  MethodStatus,
  MethodStatusParameters,
  PurchaseMethod,
  PurchaseMethodAmendment,
  PurchaseMethodCode,
  PurchaseMethodFacts,
  SpecialDepreciation,
} from './purchase-method.js';
export type {
  AmendAssetOutcome,
  AmendReviewState,
  AmendedField,
  AssetAmendPlan,
  AssetAmendment,
  AssetRead,
  AssetReviewState,
  AssetStatus,
  AssetType,
  ChangedItem,
  ChangedUsefulLife,
  ConfirmAssetOutcome,
  ConfirmAssetPlan,
  ConfirmReviewState,
  CreateAssetOutcome,
  CreateAssetRefusal,
  DepreciationAsset,
  DepreciationAssetFacts,
  DepreciationAssetId,
  DepreciationAssetRepository,
  DepreciationMethod,
  EntryAcquisition,
  EntryChange,
  FoundItem,
  ItemRefusal,
  NewDepreciationAsset,
  ShorterUsefulLife,
  SupportedAssetType,
  UsefulLifeAmendment,
  UsefulLifeEvidence,
  VoidAssetOutcome,
} from './asset.js';
export {
  ASSET_RATE_REASONS,
  USEFUL_LIFE_REASONS,
  bandOf,
  buildingRuleOn,
  deriveRate,
  isShorter,
  movableRuleOn,
  purchaseMethodStatuses,
  rateFraction,
  reciprocalPercent,
} from './rate.js';
export type { AssetRate, AssetRateReason, PurchaseMethodStatus, UsefulLifeRate, UsefulLifeReason } from './rate.js';
export {
  AFA_BUILDING_LINEAR,
  BUILDING_BANDS,
  DE_AFA_BUILDING_LINEAR_V1,
  DE_AFA_BUILDING_LINEAR_V2,
  SUBSEQUENT_COST_END_METHODS,
  SUBSEQUENT_COST_START_METHODS,
} from './rules/de-afa-building-linear.js';
export type {
  BuildingBand,
  BuildingLinearParameters,
  BuildingRateBand,
  SubsequentCostEndMethod,
  SubsequentCostStartMethod,
} from './rules/de-afa-building-linear.js';
export { AFA_MOVABLE_LINEAR, DE_AFA_MOVABLE_LINEAR_V1 } from './rules/de-afa-movable-linear.js';
export type { MovableLinearParameters } from './rules/de-afa-movable-linear.js';
export { ITEM_SOURCE_TYPES, NOT_OWNED_PART, componentIdOf, isCapitalized, sameItem } from './capitalized-item.js';
export type { CapitalizedItem, CapitalizedItemLoan, CapitalizedItemPart, ItemRef, ItemSourceType } from './capitalized-item.js';
export type { ItemComponent, ItemComponentRate, ItemOwner, ItemSourceView } from './schedule-items.js';
export { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
export { INFORMATIVE_CODES, RANGE_MAX_YEAR, RANGE_MIN_YEAR, SCHEDULE_CALCULATION_VERSION, deriveSchedule, isOwnerOf } from './schedule.js';
export type {
  AssetLink,
  CalculationStatus,
  ComponentBasis,
  ComponentMethod,
  ComponentOwner,
  ComponentRate,
  ComponentYear,
  DepreciationSchedule,
  DepreciationScheduleSource,
  Flag,
  OwnerYear,
  ScheduleAcquisition,
  ScheduleAllocation,
  ScheduleComponent,
  ScheduleCost,
  ScheduleInput,
  ScheduleOwnership,
  ScheduleRead,
  ScheduleStatus,
  ScheduleYear,
  YearRule,
} from './schedule.js';
// Recorded schedule versions (api-design.md §60, VC-8-04).
export { FINGERPRINT, canonicalJson, centsText, ruleVersionHash } from './fingerprint.js';
export type { Fingerprinter } from './fingerprint.js';
export { SCHEDULE_VERSION_STATUSES } from './version-model.js';
export type {
  NewScheduleVersion,
  PartRateKind,
  RecordDecision,
  RecordOutcome,
  RecordRead,
  RecordRefusal,
  RecordRequest,
  ScheduleVersion,
  ScheduleVersionRepository,
  ScheduleVersionStatus,
  VersionAcquisitionInputs,
  VersionAssetFacts,
  VersionComponent,
  VersionEntry,
  VersionFlag,
  VersionFraction,
  VersionInputs,
  VersionItemInputs,
  VersionMethodInputs,
  VersionPart,
  VersionRule,
  VersionYear,
} from './version-model.js';
export { entriesOf, resolveScheduleInputs } from './version-inputs.js';
export { computeVersionEntries } from './version-compute.js';
export { inputFingerprint, outputFingerprint, truncateInputs } from './version-fingerprint.js';
export { compareYear, liveSchedule, reproduce } from './version-compare.js';
export type { LiveSchedule, RecordingState, Reproduction, YearComparison } from './version-compare.js';
export { planRecord, recordFingerprint } from './version-record.js';
export { RECORDING_FLAGS, changedDetails, withRecording } from './version-schedule.js';
export type { RecordedSchedule, RecordedScheduleYear } from './version-schedule.js';

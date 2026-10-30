/**
 * Depreciation domain (phase-8-plan.md, api-design.md §59): the DepreciationAsset with its facts, the rule
 * `DE_AFA_BUILDING_LINEAR` and the rate derived from it. It imports `shared/` only, never Taxation or `tax-rules/`: the
 * registry arrives as a parameter (P8-D11). Depreciation writes no cash. See docs/development/coding-guidelines.md §3.
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
  MAX_ASSET_SOURCE_REFERENCES,
  MAX_SHORTER_USEFUL_LIVES,
  SUPPORTED_ASSET_TYPES,
  advisorsOf,
  assetFingerprint,
  entryAcquisitionRefusal,
  isConfirmed,
  planAssetAmend,
  planAssetConfirm,
  sortedEntries,
  writtenEntries,
} from './asset.js';
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
  NewDepreciationAsset,
  ShorterUsefulLife,
  SupportedAssetType,
  UsefulLifeAmendment,
  UsefulLifeEvidence,
  VoidAssetOutcome,
} from './asset.js';
export { ASSET_RATE_REASONS, USEFUL_LIFE_REASONS, bandOf, buildingRuleOn, deriveRate, isShorter, reciprocalPercent } from './rate.js';
export type { AssetRate, AssetRateReason, UsefulLifeRate, UsefulLifeReason } from './rate.js';
export { AFA_BUILDING_LINEAR, BUILDING_BANDS, DE_AFA_BUILDING_LINEAR_V1 } from './rules/de-afa-building-linear.js';
export type { BuildingBand, BuildingLinearParameters, BuildingRateBand } from './rules/de-afa-building-linear.js';
export { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';

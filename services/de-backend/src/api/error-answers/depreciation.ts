import {
  AcquisitionNotOfPropertyError,
  AssetAdvisorConfirmedError,
  AssetFieldNotAllowedError,
  BuildingAssetExistsError,
  CapitalizedItemNotFoundError,
  ItemAnschaffungsnaheError,
  ItemInOtherAssetError,
  ItemNotCapitalizedError,
  ItemNotOfPropertyError,
  CompletionYearMissingError,
  DepreciationAssetNotActiveError,
  DepreciationAssetNotFoundError,
  NotAnOwnerError,
  RecordingNotEnabledError,
  ScheduleVersionNotFoundError,
  ScheduleVersionRefusedError,
  ThroughYearInFutureError,
  centsText,
} from '../../application/index.js';
import { answer, on, validation } from './answer.js';

/** The answers to the depreciation module's errors (part of the central table, `../error-answers.ts`). */
export const DEPRECIATION_ANSWERS = [
  // The DepreciationAsset (api-design §59, VC-8-01).
  on(DepreciationAssetNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Depreciation asset not found.', { assetId: error.assetId })),
  on(BuildingAssetExistsError, (error) =>
    answer(409, 'CONFLICT', 'The PropertyReference already has an active building asset.', { reason: 'BUILDING_ASSET_EXISTS', assetId: error.assetId }),
  ),
  on(DepreciationAssetNotActiveError, (error) =>
    answer(409, 'CONFLICT', `The depreciation asset is ${error.status}.`, { reason: 'ASSET_NOT_ACTIVE', assetId: error.assetId, status: error.status }),
  ),
  on(CompletionYearMissingError, (error) =>
    answer(409, 'CONFLICT', "The building's completion year is not recorded; nothing to confirm.", {
      reason: 'COMPLETION_YEAR_MISSING',
      assetId: error.assetId,
    }),
  ),
  on(AssetAdvisorConfirmedError, (error) =>
    answer(409, 'CONFLICT', 'A user cannot lower an advisor confirmation; amend the review state to NEEDS_REVIEW first.', {
      reason: 'ADVISOR_CONFIRMED',
      assetId: error.assetId,
    }),
  ),
  // The schedule of the purchase (api-design §59A, VC-8-02).
  on(NotAnOwnerError, (error) =>
    answer(422, 'NOT_AN_OWNER', "The Party holds no share of the asset's PropertyReference and bought none.", {
      ownerPartyId: error.ownerPartyId,
      propertyReferenceId: error.propertyReferenceId,
    }),
  ),
  on(AcquisitionNotOfPropertyError, (error) =>
    answer(422, 'ACQUISITION_NOT_OF_PROPERTY', 'The Acquisition belongs to another PropertyReference.', {
      acquisitionId: error.acquisitionId,
      propertyReferenceId: error.propertyReferenceId,
    }),
  ),
  // A separate asset's fields and capitalised items (api-design §59B, VC-8-03); `item` is `{ sourceType, sourceId, sourcePosition }`.
  on(AssetFieldNotAllowedError, (error) => validation(error.fields.map((field) => ({ field, code: 'NOT_ALLOWED' })))),
  on(CapitalizedItemNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', "The capitalised item's source does not exist.", {
      sourceType: error.item.sourceType,
      sourceId: error.item.sourceId,
      sourcePosition: error.item.sourcePosition,
    }),
  ),
  on(ItemNotOfPropertyError, (error) =>
    answer(422, 'ITEM_NOT_OF_PROPERTY', 'The item belongs to another PropertyReference.', {
      item: itemOf(error.item),
      propertyReferenceId: error.propertyReferenceId,
    }),
  ),
  on(ItemNotCapitalizedError, (error) =>
    answer(409, 'CONFLICT', 'The item is not classified CAPITALIZED, or does not count.', {
      reason: 'ITEM_NOT_CAPITALIZED',
      item: itemOf(error.item),
      counts: error.counts,
      treatment: error.treatment,
      reviewState: error.reviewState,
    }),
  ),
  on(ItemAnschaffungsnaheError, (error) =>
    answer(409, 'CONFLICT', 'The item is anschaffungsnahe Herstellungskosten of the building.', {
      reason: 'ITEM_ANSCHAFFUNGSNAHE',
      item: itemOf(error.item),
      acquisitionId: error.acquisitionId,
    }),
  ),
  on(ItemInOtherAssetError, (error) =>
    answer(409, 'CONFLICT', 'The item belongs to another active depreciation asset.', {
      reason: 'ITEM_IN_OTHER_ASSET',
      item: itemOf(error.item),
      assetId: error.assetId,
    }),
  ),
  // Recorded schedule versions (api-design §60 "Error answers", VC-8-04).
  on(RecordingNotEnabledError, () =>
    answer(409, 'CONFLICT', 'Recording depreciation schedule versions is not enabled in this installation.', { reason: 'RECORDING_NOT_ENABLED' }),
  ),
  on(ThroughYearInFutureError, (error) =>
    answer(400, 'VALIDATION_ERROR', 'Validation failed.', { fields: [{ field: 'throughYear', code: 'OUT_OF_RANGE' }], max: error.max }),
  ),
  on(ScheduleVersionNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Schedule version not found.', { versionId: error.versionId })),
  on(ScheduleVersionRefusedError, (error) => refusalAnswer(error)),
];

/** The refusals of the record command's steps 4–9 (§60 "Error answers"); amounts as Money, never a `bigint`. */
function refusalAnswer({ assetId, refusal }: ScheduleVersionRefusedError) {
  switch (refusal.kind) {
    case 'SCHEDULE_NOT_COMPLETE':
      return answer(409, 'CONFLICT', 'The schedule has years without a figure; they cannot be recorded.', {
        reason: refusal.kind,
        assetId,
        ...refusal.details,
      });
    case 'NOTHING_TO_RECORD':
      return answer(409, 'CONFLICT', 'The schedule has no year with AfA up to throughYear.', {
        reason: refusal.kind,
        assetId,
        throughYear: refusal.throughYear,
        firstYear: refusal.firstYear,
      });
    case 'THROUGH_YEAR_BEFORE_CURRENT':
      return answer(409, 'CONFLICT', 'The current version already covers a later year.', {
        reason: refusal.kind,
        assetId,
        currentVersionId: refusal.currentVersionId,
        currentThroughYear: refusal.currentThroughYear,
      });
    case 'RECORDED_YEARS_WOULD_CHANGE': {
      const money = (c: unknown) => (typeof c === 'bigint' ? { amount: centsText(c), currency: 'EUR' } : null);
      const changedYears = (refusal.changedYears as { year: number; recorded: bigint | null; derived: bigint | null; causes: readonly string[] }[]).map(
        (c) => ({
          year: c.year,
          recorded: money(c.recorded),
          derived: money(c.derived),
          causes: c.causes,
        }),
      );
      return answer(409, 'CONFLICT', 'Recording would change already recorded years; name them in acceptChangedYears.', {
        reason: refusal.kind,
        assetId,
        currentVersionId: refusal.currentVersionId === '' ? null : refusal.currentVersionId,
        changedYears,
        acceptChangedYears: refusal.acceptChangedYears,
      });
    }
    case 'SCHEDULE_CHANGED':
      return answer(412, 'SCHEDULE_CHANGED', 'The schedule changed since it was read.', {
        assetId,
        throughYear: refusal.throughYear,
        expectedInputFingerprint: refusal.expectedInputFingerprint,
        currentInputFingerprint: refusal.currentInputFingerprint,
      });
  }
}

/** An item as §59B's answers name it. */
function itemOf(item: { readonly sourceType: string; readonly sourceId: string; readonly sourcePosition: number | null }) {
  return { sourceType: item.sourceType, sourceId: item.sourceId, sourcePosition: item.sourcePosition };
}

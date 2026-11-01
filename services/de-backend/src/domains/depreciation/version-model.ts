import type { BusinessDate, RuleRef } from '../../shared/index.js';
import type { ScheduleRead } from './schedule-model.js';

/**
 * A recorded depreciation schedule version (api-design.md §60, data-model §39–§40, P8-D10): the derivation's inputs
 * (stage 1, `version-inputs.ts`) and its output (the entries per year, component and owner part), kept for good and
 * never changed but by the supersede step. Amounts are cents (`bigint`) in the version's `currency`, fractions `"n/d"`,
 * months `YYYY-MM`. Types only.
 */

export const SCHEDULE_VERSION_STATUSES = ['CURRENT', 'SUPERSEDED'] as const;
export type ScheduleVersionStatus = (typeof SCHEDULE_VERSION_STATUSES)[number];

/** The asset's facts at the time (§60 "What a version stores"); `reviewState` and `assetVersion` are not fingerprinted. */
export interface VersionAssetFacts {
  readonly assetType: string;
  readonly depreciationMethod: string;
  readonly buildingCompletionYear: number | null;
  readonly description: string | null;
  readonly usefulLifeYears: number | null;
  readonly acquiredOn: BusinessDate | null;
  readonly reviewState: string;
  readonly assetVersion: number;
}

export interface VersionRule {
  readonly ruleCode: string;
  readonly version: number;
  readonly ruleVersionHash: string;
  readonly firstYear: number;
  readonly lastYear: number;
}

/** The still-held fraction from `month` on (one row per month in which it changes; §59A: the running minimum). */
export interface VersionFraction {
  readonly month: string;
  readonly fraction: string;
}

export type PartRateKind = 'BAND' | 'SHORTER_USEFUL_LIFE' | 'USEFUL_LIFE';

export interface VersionPart {
  /** `OWNER:{partyId}` or `NOT_OWNED`. */
  readonly partKey: string;
  readonly ownerPartyId: string | null;
  readonly ownershipIds: readonly string[];
  readonly share: string;
  readonly weight: string;
  readonly basis: bigint;
  readonly firstMonth: string;
  readonly rateKind: PartRateKind | null;
  readonly usefulLifeYears: number | null;
  readonly tenureFrom: BusinessDate | null;
  readonly lastDay: BusinessDate | null;
  readonly lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' | 'VALID_UNTIL' | null;
  /**
   * The pool the part runs in (§59B "The rate in a pool"): an item part's owner tenure, shared by the purchase parts of
   * that tenure; `null` for a purchase part in no item's pool. Stored so the pooled end is recomputed from the rows.
   */
  readonly poolKey: string | null;
  readonly fractions: readonly VersionFraction[];
}

export interface VersionAcquisitionInputs {
  readonly acquisitionId: string;
  readonly purchasePrice: bigint;
  readonly countedCostIds: readonly string[];
  readonly countedCostsTotal: bigint;
  readonly excludedCostIds: readonly string[];
  readonly excludedCostsTotal: bigint;
  /**
   * §59D (VC-X-42): the current classifications that decided a counted or excluded cost, sorted. They are frozen rows, so
   * the ids name the parts and amounts; a superseding classification changes the ids and so the fingerprint.
   */
  readonly costClassificationIds: readonly string[];
  readonly allocationId: string;
  readonly allocationReviewState: string;
  readonly totalAllocableAmount: bigint;
  readonly buildingAmount: bigint;
  /** The shorter useful life's review state when one is used (its years are the component's `usefulLifeYears`). */
  readonly shorterLifeReviewState: string | null;
}

/**
 * §59C (VC-X-37): the purchase's method entry as it gates the component (its facts and review state, not the evidence
 * texts), so `computeSchedule(storedInputs)` re-derives the same computability and the fingerprint sees a change.
 */
export interface VersionMethodInputs {
  readonly consideration: string;
  readonly method: string;
  readonly specialDepreciation: readonly string[];
  readonly subsidiesReceived: boolean;
  readonly newBuildingByConversion: boolean;
  readonly otherSpecialCase: boolean;
  readonly reviewState: string;
}

export interface VersionItemInputs {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourcePosition: number | null;
  readonly classificationId: string | null;
  readonly classificationReviewState: string;
  readonly taxCategory: string;
  readonly itemDate: BusinessDate;
  readonly itemDateSource: string;
  readonly itemTaxYear: number;
  readonly anschaffungsnaheAcquisitionId: string | null;
}

export interface VersionComponent {
  readonly componentId: string;
  readonly kind: 'ACQUISITION' | 'CAPITALIZED_ITEM';
  readonly position: number;
  /** Whether the derivation computes it; a recorded version holds computable components only (§60 step 4). */
  readonly computable: boolean;
  readonly basis: bigint;
  readonly start: { readonly date: BusinessDate | null; readonly dateSource: string; readonly method: string; readonly month: string | null };
  readonly rate: { readonly kind: PartRateKind; readonly usefulLifeYears: number | null };
  readonly acquisition: VersionAcquisitionInputs | null;
  /** §59C: `ACQUISITION` only, `null` without an entry (and always on an item). */
  readonly method: VersionMethodInputs | null;
  readonly item: VersionItemInputs | null;
  readonly parts: readonly VersionPart[];
}

/** Stage 1's output (§60): what `computeVersionEntries` recomputes from. */
export interface VersionInputs {
  readonly currency: string;
  readonly asset: VersionAssetFacts;
  readonly calculationVersion: number;
  readonly rules: readonly VersionRule[];
  readonly components: readonly VersionComponent[];
}

export interface VersionEntry {
  readonly year: number;
  readonly componentId: string;
  readonly partKey: string;
  readonly months: number;
  readonly fraction: string | null;
  readonly amount: bigint;
  readonly cumulative: bigint;
  readonly residualValue: bigint;
}

export interface VersionYear {
  readonly year: number;
  readonly amount: bigint;
  readonly residualValue: bigint;
  readonly inputFingerprint: string;
  readonly outputFingerprint: string;
}

export interface VersionFlag {
  readonly year: number | null;
  readonly componentId: string | null;
  readonly partKey: string | null;
  readonly code: string;
  readonly level: 'OPEN' | 'INFORMATIVE';
}

/** A version as stored (header, inputs, output); `version` is the row's (1, then 2 once superseded). */
export interface ScheduleVersion {
  readonly versionId: string;
  readonly assetId: string;
  readonly propertyReferenceId: string;
  readonly versionNumber: number;
  readonly status: ScheduleVersionStatus;
  readonly supersedesVersionId: string | null;
  readonly supersededByVersionId: string | null;
  readonly supersededAt: Date | null;
  readonly fromYear: number;
  readonly throughYear: number;
  readonly reason: string;
  readonly recordedAt: Date;
  readonly recordedBy: string;
  readonly computedOn: BusinessDate;
  readonly calculationVersion: number;
  readonly inputFingerprint: string;
  readonly outputFingerprint: string;
  readonly inputs: VersionInputs;
  readonly years: readonly VersionYear[];
  readonly entries: readonly VersionEntry[];
  readonly flags: readonly VersionFlag[];
  readonly version: number;
}

/** A version to record: everything but what the database assigns. */
export type NewScheduleVersion = Omit<
  ScheduleVersion,
  'versionId' | 'versionNumber' | 'status' | 'supersedesVersionId' | 'supersededByVersionId' | 'supersededAt' | 'recordedAt' | 'version'
>;

/** The record command's request (§60 "Body"), normalised. */
export interface RecordRequest {
  readonly throughYear: number;
  readonly reason: string;
  readonly expectedInputFingerprint: string;
  readonly acceptChangedYears: readonly number[];
}

/** What the record command's transaction reads (§60 "Concurrency"): the schedule's snapshot and the `CURRENT` version. */
export interface RecordRead {
  readonly schedule: ScheduleRead;
  readonly current: ScheduleVersion | null;
}

/** What the use case decides from a `RecordRead`; the repository executes it in the same transaction. */
export type RecordDecision =
  | { readonly kind: 'REFUSED'; readonly refusal: RecordRefusal }
  | { readonly kind: 'NOOP'; readonly version: ScheduleVersion }
  | {
      readonly kind: 'RECORD';
      readonly version: NewScheduleVersion;
      /** The `SUPERSEDED` AuditRecord's `changedYears` and the `RECORDED` one's `acceptedChangedYears`. */
      readonly changedYears: readonly { readonly year: number; readonly recorded: bigint; readonly derived: bigint | null }[];
    };

export type RecordRefusal =
  | { readonly kind: 'ASSET_NOT_ACTIVE'; readonly status: string }
  | { readonly kind: 'SCHEDULE_NOT_COMPLETE'; readonly details: Readonly<Record<string, unknown>> }
  | { readonly kind: 'NOTHING_TO_RECORD'; readonly throughYear: number; readonly firstYear: number | null }
  | { readonly kind: 'THROUGH_YEAR_BEFORE_CURRENT'; readonly currentVersionId: string; readonly currentThroughYear: number }
  | { readonly kind: 'SCHEDULE_CHANGED'; readonly throughYear: number; readonly expectedInputFingerprint: string; readonly currentInputFingerprint: string }
  | {
      readonly kind: 'RECORDED_YEARS_WOULD_CHANGE';
      readonly currentVersionId: string;
      readonly changedYears: readonly unknown[];
      readonly acceptChangedYears: readonly number[];
    };

export type RecordOutcome =
  | { readonly kind: 'RECORDED'; readonly version: ScheduleVersion; readonly replayed: boolean }
  | { readonly kind: 'UNCHANGED'; readonly version: ScheduleVersion; readonly replayed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'SERIALIZATION_FAILURE' }
  | { readonly kind: 'REFUSED'; readonly refusal: RecordRefusal };

/** The port of the recorded versions (§60): one record transaction, and the reads. */
export interface ScheduleVersionRepository {
  record(input: {
    readonly assetId: string;
    readonly mreRealmId: string;
    readonly actor: { readonly actorType: 'USER'; readonly actorId: string };
    readonly idempotency?: { readonly key: string; readonly fingerprint: string };
    readonly decide: (read: RecordRead) => RecordDecision;
  }): Promise<RecordOutcome>;
  /** `undefined` for an unknown or foreign asset. */
  list(assetId: string, mreRealmId: string, statuses: readonly ScheduleVersionStatus[] | null): Promise<readonly ScheduleVersion[] | undefined>;
  /** The version with the asset's current schedule read for its comparison, in one snapshot; `undefined` when not found. */
  find(assetId: string, mreRealmId: string, versionId: string): Promise<{ readonly version: ScheduleVersion; readonly schedule: ScheduleRead } | undefined>;
  /** The distinct references with their hashes (the start check, §58, §60). */
  storedRuleVersionHashes(): Promise<readonly (RuleRef & { readonly ruleVersionHash: string })[]>;
}

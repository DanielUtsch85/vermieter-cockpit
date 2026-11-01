import {
  assetFingerprint,
  deriveRate,
  deriveSchedule,
  isOwnerOf,
  purchaseMethodStatuses,
  withRecording,
  type AssetAmendment,
  type AssetRate,
  type AssetRead,
  type AssetStatus,
  type ConfirmReviewState,
  type DepreciationAsset,
  type DepreciationAssetRepository,
  type DepreciationScheduleSource,
  type Fingerprinter,
  type RecordedSchedule,
  type ItemRef,
  type ItemRefusal,
  type NewDepreciationAsset,
  type PurchaseMethodStatus,
} from '../domains/depreciation/index.js';
import { businessDayOf } from '../domains/ledger/index.js';
import { TAX_RULES } from '../domains/tax-rules/index.js';
import type { RuleRegistry } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { AcquisitionCancelledError } from './acquisition-costs.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { AcquisitionNotFoundError } from './ownerships.js';
import { PartyNotFoundError } from './parties.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { OwnerPartyNotFoundError } from './tax-classifications.js';

/**
 * The DepreciationAsset (api-design.md §59, backlog VC-8-01), in the caller's verified Realm. Input arrives validated
 * from the API boundary. A command answers the asset without a rate; a read derives the `rate` of a year from the
 * registry. Nothing here writes cash or calls MRE (P8-D14).
 */

export class DepreciationAssetNotFoundError extends Error {
  override readonly name = 'DepreciationAssetNotFoundError';

  constructor(readonly assetId: string) {
    super(`Depreciation asset ${assetId} not found`);
  }
}

/** The PropertyReference has an `ACTIVE` building asset (→ 409 BUILDING_ASSET_EXISTS). */
export class BuildingAssetExistsError extends Error {
  override readonly name = 'BuildingAssetExistsError';

  constructor(readonly assetId: string) {
    super(`The PropertyReference already has the active building asset ${assetId}`);
  }
}

/** A `VOID` asset takes no amend or confirm (→ 409 ASSET_NOT_ACTIVE). */
export class DepreciationAssetNotActiveError extends Error {
  override readonly name = 'DepreciationAssetNotActiveError';

  constructor(
    readonly assetId: string,
    readonly status: AssetStatus,
  ) {
    super(`Depreciation asset ${assetId} is ${status}`);
  }
}

/** Nothing to confirm without a completion year (→ 409 COMPLETION_YEAR_MISSING). */
export class CompletionYearMissingError extends Error {
  override readonly name = 'CompletionYearMissingError';

  constructor(readonly assetId: string) {
    super(`Depreciation asset ${assetId} has no completion year`);
  }
}

/** A user's `CONFIRMED` over an advisor's confirmation (→ 409 ADVISOR_CONFIRMED). */
export class AssetAdvisorConfirmedError extends Error {
  override readonly name = 'AssetAdvisorConfirmedError';

  constructor(readonly assetId: string) {
    super(`Depreciation asset ${assetId} is ADVISOR_CONFIRMED`);
  }
}

/** An entry names an Acquisition of another PropertyReference (→ 422 ACQUISITION_NOT_OF_PROPERTY). */
export class AcquisitionNotOfPropertyError extends Error {
  override readonly name = 'AcquisitionNotOfPropertyError';

  constructor(
    readonly acquisitionId: string,
    readonly propertyReferenceId: string,
  ) {
    super(`Acquisition ${acquisitionId} belongs to PropertyReference ${propertyReferenceId}`);
  }
}

/** A separate asset's item names no source of the Realm (→ 404 NOT_FOUND, §59B). */
export class CapitalizedItemNotFoundError extends Error {
  override readonly name = 'CapitalizedItemNotFoundError';

  constructor(readonly item: ItemRef) {
    super(`The capitalised item's source ${item.sourceType} ${item.sourceId} does not exist`);
  }
}

/** The item belongs to another PropertyReference (→ 422 ITEM_NOT_OF_PROPERTY, §59B). */
export class ItemNotOfPropertyError extends Error {
  override readonly name = 'ItemNotOfPropertyError';

  constructor(
    readonly item: ItemRef,
    readonly propertyReferenceId: string | null,
  ) {
    super(`The item ${item.sourceType} ${item.sourceId} belongs to another PropertyReference`);
  }
}

/** The item does not count or is not classified `CAPITALIZED` now (→ 409 ITEM_NOT_CAPITALIZED, §59B). */
export class ItemNotCapitalizedError extends Error {
  override readonly name = 'ItemNotCapitalizedError';

  constructor(
    readonly item: ItemRef,
    readonly counts: boolean,
    readonly treatment: string | null,
    readonly reviewState: string,
  ) {
    super(`The item ${item.sourceType} ${item.sourceId} is not classified CAPITALIZED, or does not count`);
  }
}

/** The item is anschaffungsnahe Herstellungskosten of the building (→ 409 ITEM_ANSCHAFFUNGSNAHE, §59B). */
export class ItemAnschaffungsnaheError extends Error {
  override readonly name = 'ItemAnschaffungsnaheError';

  constructor(
    readonly item: ItemRef,
    readonly acquisitionId: string,
  ) {
    super(`The item ${item.sourceType} ${item.sourceId} is anschaffungsnahe Herstellungskosten of the building`);
  }
}

/** The item belongs to another `ACTIVE` depreciation asset (→ 409 ITEM_IN_OTHER_ASSET, §59B). */
export class ItemInOtherAssetError extends Error {
  override readonly name = 'ItemInOtherAssetError';

  constructor(
    readonly item: ItemRef,
    readonly assetId: string,
  ) {
    super(`The item ${item.sourceType} ${item.sourceId} belongs to the active depreciation asset ${assetId}`);
  }
}

/** An amend names a field of the other asset type (→ 400 NOT_ALLOWED, §59B). */
export class AssetFieldNotAllowedError extends Error {
  override readonly name = 'AssetFieldNotAllowedError';

  constructor(readonly fields: readonly string[]) {
    super(`Not a field of this asset type: ${fields.join(', ')}`);
  }
}

/** The refusals of a separate asset's items (§59B, steps 4–5). */
function refuseItem(outcome: ItemRefusal): never {
  switch (outcome.kind) {
    case 'ITEM_NOT_FOUND':
      throw new CapitalizedItemNotFoundError(outcome.item);
    case 'ITEM_NOT_OF_PROPERTY':
      throw new ItemNotOfPropertyError(outcome.item, outcome.propertyReferenceId);
    case 'ITEM_NOT_CAPITALIZED':
      throw new ItemNotCapitalizedError(outcome.item, outcome.counts, outcome.treatment, outcome.reviewState);
    case 'ITEM_ANSCHAFFUNGSNAHE':
      throw new ItemAnschaffungsnaheError(outcome.item, outcome.acquisitionId);
    case 'ITEM_IN_OTHER_ASSET':
      throw new ItemInOtherAssetError(outcome.item, outcome.assetId);
  }
}

const ITEM_REFUSALS: readonly string[] = ['ITEM_NOT_FOUND', 'ITEM_NOT_OF_PROPERTY', 'ITEM_NOT_CAPITALIZED', 'ITEM_ANSCHAFFUNGSNAHE', 'ITEM_IN_OTHER_ASSET'];

/** The Party holds no share of the asset's PropertyReference and bought none (→ 422 NOT_AN_OWNER, §59A). */
export class NotAnOwnerError extends Error {
  override readonly name = 'NotAnOwnerError';

  constructor(
    readonly ownerPartyId: string,
    readonly propertyReferenceId: string,
  ) {
    super(`Party ${ownerPartyId} holds no share of PropertyReference ${propertyReferenceId} and bought none`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

type Clock = { readonly now?: () => Date };
const nowOf = (deps: Clock) => (deps.now ?? (() => new Date()))();
/** `registry` judges the method entries' status in the answer (§59C); the tax rules by default. */
type Deps = { readonly repository: DepreciationAssetRepository; readonly registry?: RuleRegistry };

/** A command's answer: the asset, and its method entries' status by the latest rule version (§59C "Responses"). */
const statusesOf = (deps: Deps, asset: DepreciationAsset) => purchaseMethodStatuses(asset, deps.registry ?? TAX_RULES);
type ReadDeps = Deps & Clock & { readonly registry?: RuleRegistry };

/** The refusals create and amend share (§59, order 3–4; §59B, order 4–5). */
function refuseEntry(
  outcome:
    | ItemRefusal
    | {
        readonly kind: 'PARTY_NOT_FOUND' | 'ACQUISITION_NOT_FOUND' | 'ACQUISITION_NOT_OF_PROPERTY' | 'ACQUISITION_CANCELLED';
        readonly partyId?: string;
        readonly acquisitionId?: string;
        readonly propertyReferenceId?: string;
      },
): never {
  if (ITEM_REFUSALS.includes(outcome.kind)) return refuseItem(outcome as ItemRefusal);
  const entry = outcome as { kind: string; partyId?: string; acquisitionId?: string; propertyReferenceId?: string };
  switch (entry.kind) {
    case 'PARTY_NOT_FOUND':
      throw new PartyNotFoundError(entry.partyId as string);
    case 'ACQUISITION_NOT_FOUND':
      throw new AcquisitionNotFoundError(entry.acquisitionId as string);
    case 'ACQUISITION_NOT_OF_PROPERTY':
      throw new AcquisitionNotOfPropertyError(entry.acquisitionId as string, entry.propertyReferenceId as string);
    case 'ACQUISITION_CANCELLED':
      throw new AcquisitionCancelledError(entry.acquisitionId as string);
    default:
      throw new Error(`unexpected outcome ${entry.kind}`);
  }
}

export interface CreateDepreciationAssetInput extends Omit<NewDepreciationAsset, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  readonly idempotencyKey?: string;
}

export type CreateDepreciationAsset = (
  input: CreateDepreciationAssetInput,
) => Promise<{ readonly asset: DepreciationAsset; readonly replayed: boolean; readonly methods: readonly PurchaseMethodStatus[] }>;

export function createDepreciationAsset(deps: Deps): CreateDepreciationAsset {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const asset: NewDepreciationAsset = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.create(
      asset,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: assetFingerprint(asset) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { asset: outcome.asset, replayed: false, methods: statusesOf(deps, outcome.asset) };
      case 'REPLAYED':
        return { asset: outcome.asset, replayed: true, methods: statusesOf(deps, outcome.asset) };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'PROPERTY_REFERENCE_NOT_FOUND':
        throw new PropertyReferenceNotFoundError(asset.propertyReferenceId);
      case 'BUILDING_ASSET_EXISTS':
        throw new BuildingAssetExistsError(outcome.assetId);
      default:
        return refuseEntry(outcome);
    }
  };
}

/** A command's answer (§59, §59C). */
export interface AssetCommandResult {
  readonly asset: DepreciationAsset;
  readonly changed: boolean;
  readonly methods: readonly PurchaseMethodStatus[];
}

export type AmendDepreciationAsset = (
  input: AssetAmendment & { readonly principal: RealmPrincipal; readonly assetId: string; readonly expectedVersions?: readonly number[] },
) => Promise<AssetCommandResult>;

export function amendDepreciationAsset(deps: Deps): AmendDepreciationAsset {
  return async ({ principal, assetId, expectedVersions, ...amendment }) => {
    const outcome = await deps.repository.amend(assetId, principal.mreRealmId, amendment, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'AMENDED':
        return { asset: outcome.asset, changed: outcome.changed, methods: statusesOf(deps, outcome.asset) };
      case 'NOT_FOUND':
        throw new DepreciationAssetNotFoundError(assetId);
      case 'ASSET_NOT_ACTIVE':
        throw new DepreciationAssetNotActiveError(assetId, outcome.status);
      case 'FIELDS_NOT_ALLOWED':
        throw new AssetFieldNotAllowedError(outcome.fields);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
      default:
        return refuseEntry(outcome);
    }
  };
}

export type ConfirmDepreciationAsset = (input: {
  readonly principal: RealmPrincipal;
  readonly assetId: string;
  readonly reviewState: ConfirmReviewState;
  readonly advisorPartyId: string | null;
  readonly note: string | null;
  readonly expectedVersions?: readonly number[];
}) => Promise<AssetCommandResult>;

export function confirmDepreciationAsset(deps: Deps): ConfirmDepreciationAsset {
  return async ({ principal, assetId, expectedVersions, ...request }) => {
    const outcome = await deps.repository.confirm(assetId, principal.mreRealmId, request, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'CONFIRMED':
        return { asset: outcome.asset, changed: outcome.changed, methods: statusesOf(deps, outcome.asset) };
      case 'NOT_FOUND':
        throw new DepreciationAssetNotFoundError(assetId);
      case 'ASSET_NOT_ACTIVE':
        throw new DepreciationAssetNotActiveError(assetId, outcome.status);
      case 'COMPLETION_YEAR_MISSING':
        throw new CompletionYearMissingError(assetId);
      case 'ADVISOR_CONFIRMED':
        throw new AssetAdvisorConfirmedError(assetId);
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(outcome.partyId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type VoidDepreciationAsset = (input: {
  readonly principal: RealmPrincipal;
  readonly assetId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<AssetCommandResult>;

export function voidDepreciationAsset(deps: Deps & Clock): VoidDepreciationAsset {
  return async ({ principal, assetId, reason, expectedVersions }) => {
    const outcome = await deps.repository.void(assetId, principal.mreRealmId, reason, nowOf(deps), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { asset: outcome.asset, changed: outcome.changed, methods: statusesOf(deps, outcome.asset) };
      case 'NOT_FOUND':
        throw new DepreciationAssetNotFoundError(assetId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

/** An asset with the `rate` of a year and its method entries' status (§59C), derived on read. */
export interface DepreciationAssetView {
  readonly asset: DepreciationAsset;
  readonly rate: AssetRate;
  readonly methods: readonly PurchaseMethodStatus[];
}

/** `year` defaults to today's year in Europe/Berlin, from the clock (as §58C's `computedOn`). */
const yearOf = (deps: Clock, year: number | undefined) => year ?? Number(businessDayOf(nowOf(deps)).slice(0, 4));
const viewOf = (read: AssetRead, year: number, registry: RuleRegistry): DepreciationAssetView => ({
  asset: read.asset,
  rate: deriveRate(read, year, registry),
  methods: purchaseMethodStatuses(read.asset, registry, read.purchaseStartYears),
});

export type GetDepreciationAsset = (input: {
  readonly principal: RealmPrincipal;
  readonly assetId: string;
  readonly year?: number;
}) => Promise<DepreciationAssetView>;

export function getDepreciationAsset(deps: ReadDeps): GetDepreciationAsset {
  const registry = deps.registry ?? TAX_RULES;
  return async ({ principal, assetId, year }) => {
    const read = await deps.repository.find(assetId, principal.mreRealmId);
    if (read === undefined) throw new DepreciationAssetNotFoundError(assetId);
    return viewOf(read, yearOf(deps, year), registry);
  };
}

export type ListPropertyDepreciationAssets = (input: {
  readonly principal: RealmPrincipal;
  readonly propertyReferenceId: string;
  readonly statuses: readonly AssetStatus[] | null;
  readonly year?: number;
}) => Promise<readonly DepreciationAssetView[]>;

export function listPropertyDepreciationAssets(deps: ReadDeps): ListPropertyDepreciationAssets {
  const registry = deps.registry ?? TAX_RULES;
  return async ({ principal, propertyReferenceId, statuses, year }) => {
    const reads = await deps.repository.listForPropertyReference(propertyReferenceId, principal.mreRealmId, statuses);
    if (reads === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
    const at = yearOf(deps, year);
    return reads.map((read) => viewOf(read, at, registry));
  };
}

export type GetDepreciationSchedule = (input: {
  readonly principal: RealmPrincipal;
  readonly assetId: string;
  readonly from?: number;
  readonly to?: number;
  readonly ownerPartyId: string | null;
}) => Promise<RecordedSchedule>;

/**
 * The schedule of the purchase (api-design.md §59A, backlog VC-8-02) and of the capitalised items or a separate asset
 * (§59B, VC-8-03): derived on every read from one snapshot, never stored, with its recording state (§60, VC-8-04): the
 * input fingerprints, each year compared with the `CURRENT` version, and `recordingEnabled`, which only reports the
 * installation's switch (decided 2026-10-31, third set, open question 10). The checks in §59A's order after the `400`s:
 * the asset (`404`), the Party (`404`), an owner of the asset's PropertyReference (`422 NOT_AN_OWNER`). `computedOn` is
 * today in Europe/Berlin; only the default range depends on it.
 */
export function getDepreciationSchedule(
  deps: {
    readonly source: DepreciationScheduleSource;
    readonly registry?: RuleRegistry;
    /** The installation's recording switch, reported as `recordingEnabled`; no default (§60). */
    readonly recordingEnabled: boolean;
    readonly fingerprinter: Fingerprinter;
  } & Clock,
): GetDepreciationSchedule {
  const registry = deps.registry ?? TAX_RULES;
  return async ({ principal, assetId, from, to, ownerPartyId }) => {
    const read = await deps.source.read(assetId, principal.mreRealmId, ownerPartyId);
    if (read === undefined) throw new DepreciationAssetNotFoundError(assetId);
    if (ownerPartyId !== null && read.ownerPartyFound !== true) throw new OwnerPartyNotFoundError(ownerPartyId);
    if (ownerPartyId !== null && !isOwnerOf(read.ownerships, ownerPartyId)) throw new NotAnOwnerError(ownerPartyId, read.asset.propertyReferenceId);
    const today = businessDayOf(nowOf(deps));
    const schedule = deriveSchedule(
      {
        asset: read.asset,
        acquisitions: read.acquisitions,
        ownerships: read.ownerships,
        capitalizedItems: read.capitalizedItems,
        links: read.links,
        today,
        from,
        to,
        ownerPartyId,
      },
      registry,
    );
    return withRecording(schedule, read, {
      registry,
      fingerprinter: deps.fingerprinter,
      today,
      current: read.currentVersion ?? null,
      recordingEnabled: deps.recordingEnabled,
    });
  };
}

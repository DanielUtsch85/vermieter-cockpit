import type { AuditActor, BusinessDate, RuleRef, VersionConflict } from '../../shared/index.js';

/**
 * The DepreciationAsset (data-model.md §38, api-design.md §59, phase-8-plan P8-D1, P8-D4; VC-8-01): the facts of a
 * depreciable asset that no other record holds. For the building: its completion year and the sources, the method, an
 * optional shorter useful life per Acquisition, and who reviewed them. It never stores a basis, a rate, a start or an
 * amount; those are derived on read (the rate here, the schedule in §59A).
 */

export type DepreciationAssetId = string & { readonly __brand: 'DepreciationAssetId' };

/** `SEPARATE_ASSET` is VC-8-03's (§59B): accepted by the vocabulary, refused as `NOT_SUPPORTED` until then. */
export const ASSET_TYPES = ['BUILDING', 'SEPARATE_ASSET'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export const SUPPORTED_ASSET_TYPES = ['BUILDING'] as const;
export type SupportedAssetType = (typeof SUPPORTED_ASSET_TYPES)[number];

export const ASSET_STATUSES = ['ACTIVE', 'VOID'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** Linear building AfA by § 7 Abs. 4 EStG, the only method of Phase 8 (P8-D13). */
export const DEPRECIATION_METHODS = ['LINEAR_7_4'] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

/** data-model §6.7 without `SUGGESTED`, as the allocation's (§27.3). */
export const ASSET_REVIEW_STATES = ['UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'ADVISOR_CONFIRMED'] as const;
export type AssetReviewState = (typeof ASSET_REVIEW_STATES)[number];
/** The states an amend may set on the asset; raising it is `confirm`'s job. */
export const AMEND_REVIEW_STATES = ['UNREVIEWED', 'NEEDS_REVIEW'] as const;
export type AmendReviewState = (typeof AMEND_REVIEW_STATES)[number];
export const CONFIRM_REVIEW_STATES = ['CONFIRMED', 'ADVISOR_CONFIRMED'] as const;
export type ConfirmReviewState = (typeof CONFIRM_REVIEW_STATES)[number];

export const isConfirmed = (state: AssetReviewState) => state === 'CONFIRMED' || state === 'ADVISOR_CONFIRMED';

export const MAX_SHORTER_USEFUL_LIVES = 20;
export const MAX_ASSET_SOURCE_REFERENCES = 20;
export const COMPLETION_YEAR_MIN = 1000;
export const COMPLETION_YEAR_MAX = 2100;

/** Where a shorter useful life comes from (depreciation.md §9). DE records it and judges nothing (B7). */
export interface UsefulLifeEvidence {
  readonly source: string;
  readonly date: BusinessDate;
  readonly documentReference: string | null;
}

/** A shorter actual useful life (§ 7 Abs. 4 S. 2 EStG) evidenced for one Acquisition of the PropertyReference (P8-D4). */
export interface ShorterUsefulLife {
  readonly acquisitionId: string;
  readonly usefulLifeYears: number;
  readonly evidence: UsefulLifeEvidence;
  readonly reviewState: AssetReviewState;
  readonly advisorPartyId: string | null;
}

export interface DepreciationAssetFacts {
  readonly buildingCompletionYear: number | null;
  readonly sourceReferences: readonly string[];
  readonly reviewState: AssetReviewState;
  readonly advisorPartyId: string | null;
  /** In `acquisitionId` order. */
  readonly shorterUsefulLives: readonly ShorterUsefulLife[];
  readonly notes: string | null;
}

export interface NewDepreciationAsset extends DepreciationAssetFacts {
  readonly mreRealmId: string;
  readonly propertyReferenceId: string;
  readonly assetType: SupportedAssetType;
  readonly depreciationMethod: DepreciationMethod;
}

export interface DepreciationAsset extends NewDepreciationAsset {
  readonly id: DepreciationAssetId;
  readonly status: AssetStatus;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** An asset as a read sees it: with the entries whose Acquisition is `CANCELLED` now (the rate's `ACQUISITION_CANCELLED`). */
export interface AssetRead {
  readonly asset: DepreciationAsset;
  readonly cancelledAcquisitionIds: readonly string[];
}

const byAcquisition = (a: { acquisitionId: string }, b: { acquisitionId: string }) =>
  a.acquisitionId < b.acquisitionId ? -1 : a.acquisitionId > b.acquisitionId ? 1 : 0;

export const sortedEntries = <T extends { readonly acquisitionId: string }>(entries: readonly T[]): T[] => [...entries].sort(byAcquisition);

/** Identity of a create for `Idempotency-Key` replays: the normalized body (§59). */
export function assetFingerprint(asset: NewDepreciationAsset): string {
  return JSON.stringify([
    asset.propertyReferenceId,
    asset.assetType,
    asset.buildingCompletionYear,
    asset.sourceReferences,
    asset.depreciationMethod,
    asset.reviewState,
    asset.advisorPartyId,
    sortedEntries(asset.shorterUsefulLives).map((e) => [
      e.acquisitionId,
      e.usefulLifeYears,
      e.evidence.source,
      e.evidence.date,
      e.evidence.documentReference,
      e.reviewState,
      e.advisorPartyId,
    ]),
    asset.notes,
  ]);
}

/** The Parties a body names as advisors, each once, in the order named (the asset's first). */
export function advisorsOf(facts: Pick<DepreciationAssetFacts, 'advisorPartyId' | 'shorterUsefulLives'>): string[] {
  const named = [facts.advisorPartyId, ...facts.shorterUsefulLives.map((e) => e.advisorPartyId)].filter((id): id is string => id !== null);
  return [...new Set(named)];
}

/** An entry as an amend names it: its review state and advisor are optional (an unchanged entry keeps its own). */
export interface UsefulLifeAmendment {
  readonly acquisitionId: string;
  readonly usefulLifeYears: number;
  readonly evidence: UsefulLifeEvidence;
  readonly reviewState?: AssetReviewState;
  readonly advisorPartyId?: string | null;
}

/** The fields an amend names; an omitted one keeps its value. */
export interface AssetAmendment {
  readonly buildingCompletionYear?: number | null;
  readonly sourceReferences?: readonly string[];
  readonly notes?: string | null;
  readonly reviewState?: AmendReviewState;
  /** The whole list: an entry left out is removed. */
  readonly shorterUsefulLives?: readonly UsefulLifeAmendment[];
}

export type EntryChange = 'ADDED' | 'CHANGED' | 'REMOVED';

/** One entry an amend adds, changes or removes, matched by `acquisitionId` (the AuditRecord's `changedEntries`). */
export interface ChangedUsefulLife {
  readonly acquisitionId: string;
  readonly change: EntryChange;
  readonly from: ShorterUsefulLife | null;
  readonly to: ShorterUsefulLife | null;
}

export type AmendedField = 'buildingCompletionYear' | 'sourceReferences' | 'notes' | 'reviewState' | 'advisorPartyId';

/** What an amend changes; no field and no entry is a `200` no-op. */
export interface AssetAmendPlan {
  readonly next: DepreciationAssetFacts;
  readonly changes: Partial<Record<AmendedField, { readonly from: unknown; readonly to: unknown }>>;
  readonly changedEntries: readonly ChangedUsefulLife[];
  /** The reset a changed completion year caused, when the body named no state (§59). */
  readonly reviewStateReset: { readonly from: AssetReviewState; readonly to: AssetReviewState } | null;
  readonly changed: boolean;
}

const sameEvidence = (a: UsefulLifeEvidence, b: UsefulLifeEvidence) =>
  a.source === b.source && a.date === b.date && a.documentReference === b.documentReference;
const sameEntry = (a: ShorterUsefulLife, b: ShorterUsefulLife) =>
  a.usefulLifeYears === b.usefulLifeYears && sameEvidence(a.evidence, b.evidence) && a.reviewState === b.reviewState && a.advisorPartyId === b.advisorPartyId;

/** The entry an amend leaves: a changed fact takes the state the body gives (default `UNREVIEWED`); an unchanged one keeps its own. */
function nextEntry(current: ShorterUsefulLife | undefined, named: UsefulLifeAmendment): ShorterUsefulLife {
  const factsChanged = current === undefined || current.usefulLifeYears !== named.usefulLifeYears || !sameEvidence(current.evidence, named.evidence);
  const facts = { acquisitionId: named.acquisitionId, usefulLifeYears: named.usefulLifeYears, evidence: named.evidence };
  if (factsChanged || named.reviewState !== undefined) {
    return { ...facts, reviewState: named.reviewState ?? 'UNREVIEWED', advisorPartyId: named.advisorPartyId ?? null };
  }
  return { ...facts, reviewState: current.reviewState, advisorPartyId: current.advisorPartyId };
}

/**
 * The amend of §59: a changed fact is never carried under an old confirmation. A changed completion year resets the
 * asset to `UNREVIEWED` (unless the body names a state) and clears the advisor, as lowering the state does. Entries are
 * matched by `acquisitionId`: added, changed or removed, an unchanged one untouched.
 */
export function planAssetAmend(current: DepreciationAsset, amendment: AssetAmendment): AssetAmendPlan {
  const year = amendment.buildingCompletionYear === undefined ? current.buildingCompletionYear : amendment.buildingCompletionYear;
  const yearChanged = year !== current.buildingCompletionYear;
  let reviewState = current.reviewState;
  let advisorPartyId = current.advisorPartyId;
  let reviewStateReset: AssetAmendPlan['reviewStateReset'] = null;
  if (amendment.reviewState !== undefined) {
    if (amendment.reviewState !== current.reviewState) {
      reviewState = amendment.reviewState;
      advisorPartyId = null;
    }
  } else if (yearChanged && current.reviewState !== 'UNREVIEWED') {
    reviewState = 'UNREVIEWED';
    advisorPartyId = null;
    reviewStateReset = { from: current.reviewState, to: 'UNREVIEWED' };
  }

  const old = new Map(current.shorterUsefulLives.map((e) => [e.acquisitionId, e]));
  const entries =
    amendment.shorterUsefulLives === undefined
      ? current.shorterUsefulLives
      : sortedEntries(amendment.shorterUsefulLives.map((named) => nextEntry(old.get(named.acquisitionId), named)));
  const next = new Map(entries.map((e) => [e.acquisitionId, e]));
  const changedEntries: ChangedUsefulLife[] = [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((acquisitionId): ChangedUsefulLife[] => {
    const from = old.get(acquisitionId) ?? null;
    const to = next.get(acquisitionId) ?? null;
    if (from === null) return [{ acquisitionId, change: 'ADDED', from, to }];
    if (to === null) return [{ acquisitionId, change: 'REMOVED', from, to }];
    return sameEntry(from, to) ? [] : [{ acquisitionId, change: 'CHANGED', from, to }];
  });

  const facts: DepreciationAssetFacts = {
    buildingCompletionYear: year,
    sourceReferences: amendment.sourceReferences ?? current.sourceReferences,
    reviewState,
    advisorPartyId,
    shorterUsefulLives: entries,
    notes: amendment.notes === undefined ? current.notes : amendment.notes,
  };
  const changes: Partial<Record<AmendedField, { from: unknown; to: unknown }>> = {};
  if (yearChanged) changes.buildingCompletionYear = { from: current.buildingCompletionYear, to: year };
  if (JSON.stringify(facts.sourceReferences) !== JSON.stringify(current.sourceReferences)) {
    changes.sourceReferences = { from: current.sourceReferences, to: facts.sourceReferences };
  }
  if (facts.notes !== current.notes) changes.notes = { from: current.notes, to: facts.notes };
  if (reviewState !== current.reviewState) changes.reviewState = { from: current.reviewState, to: reviewState };
  if (advisorPartyId !== current.advisorPartyId) changes.advisorPartyId = { from: current.advisorPartyId, to: advisorPartyId };
  return { next: facts, changes, changedEntries, reviewStateReset, changed: Object.keys(changes).length > 0 || changedEntries.length > 0 };
}

/** The entries an amend adds or changes: only their Acquisitions and advisors are checked again (§59, order 4–5). */
export const writtenEntries = (plan: AssetAmendPlan): ShorterUsefulLife[] => plan.changedEntries.flatMap((c) => (c.to === null ? [] : [c.to]));

export type ConfirmAssetPlan =
  | { readonly kind: 'CONFIRM'; readonly changed: boolean }
  | { readonly kind: 'ASSET_NOT_ACTIVE'; readonly status: AssetStatus }
  | { readonly kind: 'COMPLETION_YEAR_MISSING' }
  | { readonly kind: 'ADVISOR_CONFIRMED' };

/**
 * §59's confirm, steps 3–5 and 7: `VOID`, no completion year, a user's `CONFIRMED` over an advisor's confirmation;
 * then the same state with the same advisor is a no-op. The advisor's Party (step 6) is the repository's.
 */
export function planAssetConfirm(current: DepreciationAsset, reviewState: ConfirmReviewState, advisorPartyId: string | null): ConfirmAssetPlan {
  if (current.status !== 'ACTIVE') return { kind: 'ASSET_NOT_ACTIVE', status: current.status };
  if (current.buildingCompletionYear === null) return { kind: 'COMPLETION_YEAR_MISSING' };
  if (reviewState === 'CONFIRMED' && current.reviewState === 'ADVISOR_CONFIRMED') return { kind: 'ADVISOR_CONFIRMED' };
  return { kind: 'CONFIRM', changed: reviewState !== current.reviewState || advisorPartyId !== current.advisorPartyId };
}

export type CreateAssetRefusal =
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND' }
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | { readonly kind: 'ACQUISITION_NOT_FOUND'; readonly acquisitionId: string }
  | { readonly kind: 'ACQUISITION_NOT_OF_PROPERTY'; readonly acquisitionId: string; readonly propertyReferenceId: string }
  | { readonly kind: 'ACQUISITION_CANCELLED'; readonly acquisitionId: string };

/** An Acquisition an entry names, as the repository read it in the Realm. */
export interface EntryAcquisition {
  readonly id: string;
  readonly propertyReferenceId: string;
  readonly status: string;
}

/**
 * Steps 4–5 of create and amend (§59) for the entries written: unknown or foreign (`404`), of another PropertyReference
 * (`422`), `CANCELLED` (`409`); each check over all entries, in the order named.
 */
export function entryAcquisitionRefusal(
  entries: readonly ShorterUsefulLife[],
  found: ReadonlyMap<string, EntryAcquisition>,
  propertyReferenceId: string,
): CreateAssetRefusal | undefined {
  const missing = entries.find((e) => !found.has(e.acquisitionId));
  if (missing !== undefined) return { kind: 'ACQUISITION_NOT_FOUND', acquisitionId: missing.acquisitionId };
  for (const e of entries) {
    const acquisition = found.get(e.acquisitionId) as EntryAcquisition;
    if (acquisition.propertyReferenceId !== propertyReferenceId) {
      return { kind: 'ACQUISITION_NOT_OF_PROPERTY', acquisitionId: e.acquisitionId, propertyReferenceId: acquisition.propertyReferenceId };
    }
  }
  const cancelled = entries.find((e) => found.get(e.acquisitionId)?.status === 'CANCELLED');
  return cancelled === undefined ? undefined : { kind: 'ACQUISITION_CANCELLED', acquisitionId: cancelled.acquisitionId };
}

export type CreateAssetOutcome =
  | { readonly kind: 'CREATED'; readonly asset: DepreciationAsset }
  | { readonly kind: 'REPLAYED'; readonly asset: DepreciationAsset }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'BUILDING_ASSET_EXISTS'; readonly assetId: string }
  | CreateAssetRefusal;

export type AmendAssetOutcome =
  | { readonly kind: 'AMENDED'; readonly asset: DepreciationAsset; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'ASSET_NOT_ACTIVE'; readonly status: AssetStatus }
  | Exclude<CreateAssetRefusal, { kind: 'PROPERTY_REFERENCE_NOT_FOUND' }>
  | VersionConflict;

export type ConfirmAssetOutcome =
  | { readonly kind: 'CONFIRMED'; readonly asset: DepreciationAsset; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<ConfirmAssetPlan, { kind: 'CONFIRM' }>
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | VersionConflict;

export type VoidAssetOutcome =
  | { readonly kind: 'VOIDED'; readonly asset: DepreciationAsset; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict;

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface DepreciationAssetRepository {
  /**
   * One READ COMMITTED transaction in §59's lock order: the key, the PropertyReference (no-op write), the advisors, the
   * entries' Acquisitions `FOR SHARE` in id order, the `ACTIVE` building of the PropertyReference; then the writes.
   */
  create(asset: NewDepreciationAsset, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateAssetOutcome>;
  /** The same order with the asset `FOR UPDATE`; the entries written as a difference; the same values are a no-op. */
  amend(id: string, mreRealmId: string, amendment: AssetAmendment, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendAssetOutcome>;
  confirm(
    id: string,
    mreRealmId: string,
    request: { readonly reviewState: ConfirmReviewState; readonly advisorPartyId: string | null; readonly note: string | null },
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ConfirmAssetOutcome>;
  void(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidAssetOutcome>;
  /** One `REPEATABLE READ READ ONLY` snapshot; undefined for an unknown or foreign asset. */
  find(id: string, mreRealmId: string): Promise<AssetRead | undefined>;
  /** The PropertyReference's assets in `assetType`, `createdAt`, `assetId` order; undefined for an unknown or foreign one. */
  listForPropertyReference(propertyReferenceId: string, mreRealmId: string, statuses: readonly AssetStatus[] | null): Promise<readonly AssetRead[] | undefined>;
  /** The rule references Depreciation stores (the start check, §58): none in VC-8-01, the recorded versions from VC-8-04. */
  storedRuleReferences(): Promise<readonly RuleRef[]>;
}

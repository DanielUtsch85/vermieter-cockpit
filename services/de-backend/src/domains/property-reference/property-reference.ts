import type { AuditActor, ExactDecimal } from '../../shared/index.js';

/**
 * PropertyReference (data-model.md §9): the DE-side reference to an MRE-owned
 * `Property`. DE domains use `propertyReferenceId`; the raw MRE identity lives
 * only here (`mreRealmId` + `mrePropertyId`, data-model.md §8A). Cached display
 * values are non-authoritative; MRE `price` is never cached (it is rental
 * pricing, not acquisition price or market value).
 */

/** Opaque DE identifier, never derived from MRE identity (data-model.md §4.1). */
export type PropertyReferenceId = string & { readonly __brand: 'PropertyReferenceId' };

/** MRE entity ids are MongoDB ObjectIds (mre-integration.md §21.1). */
export const MRE_OBJECT_ID = /^[0-9a-f]{24}$/;

export function isMreObjectId(value: string): boolean {
  return MRE_OBJECT_ID.test(value);
}

export const EXTERNAL_REFERENCE_STATES = ['ACTIVE', 'MISSING', 'DELETED_UPSTREAM', 'UNRESOLVED'] as const;
export type ExternalReferenceState = (typeof EXTERNAL_REFERENCE_STATES)[number];

/** Address as last seen in MRE; every part optional because MRE does not require them. */
export interface CachedAddress {
  readonly street1?: string;
  readonly street2?: string;
  readonly zipCode?: string;
  readonly city?: string;
  readonly state?: string;
  readonly country?: string;
}

/** Display values cached from MRE (non-authoritative). */
export interface CachedPropertyData {
  readonly displayName: string | null;
  readonly cachedAddress: CachedAddress | null;
  /** Living area as MRE reports it, kept exact (never a binary float). */
  readonly cachedSurface: ExactDecimal | null;
}

export interface PropertyReference extends CachedPropertyData {
  readonly id: PropertyReferenceId;
  readonly mreRealmId: string;
  readonly mrePropertyId: string;
  readonly externalReferenceState: ExternalReferenceState;
  /** When the cached values were last read from MRE. */
  readonly lastRefreshedAt: Date | null;
  /**
   * Start of the latest MRE lookup that was applied, FOUND or NOT_FOUND. Orders
   * observations: one that started no later than this is stale and discarded.
   */
  readonly lastObservedAt: Date | null;
  readonly createdAt: Date;
  /** Increases with every change of cached values or state. */
  readonly version: number;
}

/** A reference about to be linked; id and timestamps are assigned on persistence. */
export interface NewPropertyReference extends CachedPropertyData {
  readonly mreRealmId: string;
  readonly mrePropertyId: string;
  /** Start of the MRE lookup the cached display values come from. */
  readonly refreshedAt: Date;
}

export interface LinkOutcome {
  readonly reference: PropertyReference;
  /** false when the natural key `(mreRealmId, mrePropertyId)` was already linked. */
  readonly created: boolean;
}

/**
 * What a look into MRE found for a linked Property. `observedAt` is taken
 * before the request is sent: a slow response may show an older MRE state than
 * a lookup that started later, so the start time is the conservative order.
 */
export type MreObservation =
  | ({ readonly kind: 'FOUND'; readonly observedAt: Date } & CachedPropertyData)
  /**
   * Not in the Realm's property list. MRE does not say whether it was deleted
   * or is merely not visible, so this is MISSING, never DELETED_UPSTREAM.
   */
  | { readonly kind: 'NOT_FOUND'; readonly observedAt: Date };

export type RefreshAction = 'REFRESHED' | 'MARKED_MISSING';

export interface RefreshPlan {
  /** The reference after the refresh (the current one when stale). */
  readonly next: PropertyReference;
  /** The observation is not newer than the last applied one: nothing is written. */
  readonly stale: boolean;
  /** Present when cached values or the state changed: the audited action and changed fields. */
  readonly change?: { readonly action: RefreshAction; readonly fields: readonly string[] };
}

/**
 * Decides what a refresh does (VC-1-02, workflows.md "Property deleted upstream"):
 *
 * - FOUND: cached values are replaced, the state becomes ACTIVE (also from
 *   MISSING), `lastRefreshedAt` moves to the observation.
 * - NOT_FOUND: the state becomes MISSING; cached values and `lastRefreshedAt`
 *   stay as they were, since nothing new was read. Nothing is deleted.
 * - The version increases only when cached values or the state change, so a
 *   refresh without news is not an audited change (data-model.md §57).
 * - Stale: an observation that started no later than `lastObservedAt` lost the
 *   race against a newer one (MRE is read outside the row lock). It is
 *   discarded, so an old state never overwrites a newer one — neither old
 *   values nor ACTIVE over a newer MISSING.
 * - Every applied observation moves `lastObservedAt`, NOT_FOUND included.
 */
export function planRefresh(current: PropertyReference, observation: MreObservation): RefreshPlan {
  if (current.lastObservedAt !== null && observation.observedAt.getTime() <= current.lastObservedAt.getTime()) {
    return { next: current, stale: true };
  }
  const observed = { ...current, lastObservedAt: observation.observedAt };

  if (observation.kind === 'NOT_FOUND') {
    if (current.externalReferenceState === 'MISSING') return { next: observed, stale: false };
    return {
      next: { ...observed, externalReferenceState: 'MISSING', version: current.version + 1 },
      stale: false,
      change: { action: 'MARKED_MISSING', fields: ['externalReferenceState'] },
    };
  }

  const fields = [
    ...(current.externalReferenceState === 'ACTIVE' ? [] : ['externalReferenceState']),
    ...(current.displayName === observation.displayName ? [] : ['displayName']),
    ...(sameAddress(current.cachedAddress, observation.cachedAddress) ? [] : ['cachedAddress']),
    ...(sameDecimal(current.cachedSurface, observation.cachedSurface) ? [] : ['cachedSurface']),
  ];
  const refreshed: PropertyReference = {
    ...observed,
    externalReferenceState: 'ACTIVE',
    displayName: observation.displayName,
    cachedAddress: observation.cachedAddress,
    cachedSurface: observation.cachedSurface,
    lastRefreshedAt: observation.observedAt,
  };
  return fields.length === 0
    ? { next: refreshed, stale: false }
    : { next: { ...refreshed, version: current.version + 1 }, stale: false, change: { action: 'REFRESHED', fields } };
}

const ADDRESS_PARTS = ['street1', 'street2', 'zipCode', 'city', 'state', 'country'] as const;

function sameAddress(a: CachedAddress | null, b: CachedAddress | null): boolean {
  if (a === null || b === null) return a === b;
  return ADDRESS_PARTS.every((part) => a[part] === b[part]);
}

/** Numeric equality: 64.5 and 64.50 are the same surface. */
function sameDecimal(a: ExactDecimal | null, b: ExactDecimal | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

/** Persistence port, implemented in infrastructure/postgres. */
export interface PropertyReferenceRepository {
  findByMreIdentity(mreRealmId: string, mrePropertyId: string): Promise<PropertyReference | undefined>;
  /** Only within the given Realm: another Realm's reference is not found. */
  findById(id: string, mreRealmId: string): Promise<PropertyReference | undefined>;
  /**
   * Creates the reference unless its natural key already exists — atomically, so
   * concurrent links of the same MRE Property yield exactly one reference — and
   * writes the AuditRecord in the same transaction. Otherwise returns the existing
   * reference unchanged (`created: false`), without an AuditRecord.
   */
  linkOnce(reference: NewPropertyReference, actor: AuditActor): Promise<LinkOutcome>;
  /**
   * Applies `planRefresh` to the current row under a row lock, so concurrent
   * refreshes serialize, and writes an AuditRecord (with previous/new version)
   * in the same transaction when the plan has a change. A stale plan writes
   * nothing and resolves the current row. Resolves undefined if the reference
   * does not exist in the Realm.
   */
  refresh(
    id: PropertyReferenceId,
    mreRealmId: string,
    observation: MreObservation,
    actor: AuditActor,
  ): Promise<PropertyReference | undefined>;
}

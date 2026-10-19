import type { AuditActor } from '../../shared/index.js';

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

export interface PropertyReference {
  readonly id: PropertyReferenceId;
  readonly mreRealmId: string;
  readonly mrePropertyId: string;
  readonly externalReferenceState: ExternalReferenceState;
  readonly displayName: string | null;
  readonly cachedAddress: CachedAddress | null;
  readonly lastRefreshedAt: Date | null;
  readonly createdAt: Date;
}

/** A reference about to be linked; id and timestamps are assigned on persistence. */
export interface NewPropertyReference {
  readonly mreRealmId: string;
  readonly mrePropertyId: string;
  readonly displayName: string | null;
  readonly cachedAddress: CachedAddress | null;
  /** When the cached display values were read from MRE. */
  readonly refreshedAt: Date;
}

export interface LinkOutcome {
  readonly reference: PropertyReference;
  /** false when the natural key `(mreRealmId, mrePropertyId)` was already linked. */
  readonly created: boolean;
}

/** Persistence port, implemented in infrastructure/postgres. */
export interface PropertyReferenceRepository {
  findByMreIdentity(mreRealmId: string, mrePropertyId: string): Promise<PropertyReference | undefined>;
  /**
   * Creates the reference unless its natural key already exists — atomically, so
   * concurrent links of the same MRE Property yield exactly one reference — and
   * writes the AuditRecord in the same transaction. Otherwise returns the existing
   * reference unchanged (`created: false`), without an AuditRecord.
   */
  linkOnce(reference: NewPropertyReference, actor: AuditActor): Promise<LinkOutcome>;
}

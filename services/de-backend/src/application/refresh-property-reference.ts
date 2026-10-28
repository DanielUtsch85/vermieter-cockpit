import type { MreObservation, PropertyReference, PropertyReferenceRepository } from '../domains/property-reference/index.js';
import type { RealmPrincipal } from './access.js';
import type { MrePropertyLookup } from './link-property-reference.js';

/**
 * Refresh command (api-design.md §22, backlog VC-1-02): re-reads the linked MRE
 * Property and updates the cached, non-authoritative display data. MRE stays
 * the authority; a Property no longer listed in the Realm marks the reference
 * MISSING instead of deleting anything (workflows.md, data-model.md §9).
 *
 * MRE errors (unavailable, access refused) propagate and change nothing (§77).
 */

export class PropertyReferenceNotFoundError extends Error {
  override readonly name = 'PropertyReferenceNotFoundError';

  constructor(readonly propertyReferenceId: string) {
    super(`PropertyReference ${propertyReferenceId} not found`);
  }
}

export interface RefreshPropertyReferenceInput {
  readonly principal: RealmPrincipal;
  /** The caller's `Authorization` header, forwarded to MRE for the lookup. */
  readonly authorizationHeader: string;
  readonly propertyReferenceId: string;
}

export interface RefreshPropertyReferenceDeps {
  readonly repository: PropertyReferenceRepository;
  readonly lookupMreProperty: MrePropertyLookup;
  readonly now?: () => Date;
}

export type RefreshPropertyReference = (input: RefreshPropertyReferenceInput) => Promise<PropertyReference>;

export function refreshPropertyReference(deps: RefreshPropertyReferenceDeps): RefreshPropertyReference {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, authorizationHeader, propertyReferenceId }) => {
    // Scoped to the verified Realm: another Realm's reference is "not found", not "forbidden".
    const current = await deps.repository.findById(propertyReferenceId, principal.mreRealmId);
    if (current === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);

    // Taken before the request: the conservative order for a slow MRE response (planRefresh).
    const observedAt = now();
    const property = await deps.lookupMreProperty(authorizationHeader, current.mreRealmId, current.mrePropertyId);
    const observation: MreObservation =
      property === undefined
        ? { kind: 'NOT_FOUND', observedAt }
        : {
            kind: 'FOUND',
            observedAt,
            displayName: property.name,
            cachedAddress: property.address,
            cachedSurface: property.surface,
          };

    const refreshed = await deps.repository.refresh(current.id, current.mreRealmId, observation, { actorType: 'USER', actorId: principal.email });
    if (refreshed === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
    return refreshed;
  };
}

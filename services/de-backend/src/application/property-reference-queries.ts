import type { PropertyReference, PropertyReferenceFilter, PropertyReferencePage, PropertyReferenceRepository } from '../domains/property-reference/index.js';
import type { RealmPrincipal } from './access.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

/**
 * PropertyReference reads (api-design.md §23.3). Both answer from DE's cached display data and never call MRE;
 * current values come from `refresh` (§23.2).
 */

export type GetPropertyReference = (input: { readonly principal: RealmPrincipal; readonly propertyReferenceId: string }) => Promise<PropertyReference>;

export function getPropertyReference(deps: { readonly repository: PropertyReferenceRepository }): GetPropertyReference {
  return async ({ principal, propertyReferenceId }) => {
    const reference = await deps.repository.findById(propertyReferenceId, principal.mreRealmId);
    // Unknown and other-Realm references look the same, so existence does not leak.
    if (reference === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
    return reference;
  };
}

export type ListPropertyReferences = (input: {
  readonly principal: RealmPrincipal;
  readonly filter: PropertyReferenceFilter;
  readonly page: { readonly page: number; readonly pageSize: number };
}) => Promise<PropertyReferencePage>;

export function listPropertyReferences(deps: { readonly repository: PropertyReferenceRepository }): ListPropertyReferences {
  return ({ principal, filter, page }) => deps.repository.list(principal.mreRealmId, filter, page);
}

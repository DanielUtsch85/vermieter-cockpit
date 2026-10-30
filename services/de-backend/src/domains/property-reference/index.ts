/**
 * PropertyReference: DE reference to an MRE-owned Property (data-model.md §9,
 * api-design.md §22–23). Owned by the MRE integration domain; the MRE client
 * itself stays in integrations/mre.
 */
export { EXTERNAL_REFERENCE_STATES, MRE_OBJECT_ID, isMreObjectId, planRefresh } from './property-reference.js';
export type {
  CachedAddress,
  CachedPropertyData,
  ExternalReferenceState,
  LinkOutcome,
  MreObservation,
  NewPropertyReference,
  PropertyReference,
  PropertyReferenceFilter,
  PropertyReferenceId,
  PropertyReferencePage,
  PropertyReferenceRepository,
  RefreshAction,
  RefreshPlan,
} from './property-reference.js';

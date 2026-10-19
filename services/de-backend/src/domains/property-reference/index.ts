/**
 * PropertyReference: DE reference to an MRE-owned Property (data-model.md §9,
 * api-design.md §22–23). Owned by the MRE integration domain; the MRE client
 * itself stays in integrations/mre.
 */
export { EXTERNAL_REFERENCE_STATES, MRE_OBJECT_ID, isMreObjectId } from './property-reference.js';
export type {
  CachedAddress,
  ExternalReferenceState,
  LinkOutcome,
  NewPropertyReference,
  PropertyReference,
  PropertyReferenceId,
  PropertyReferenceRepository,
} from './property-reference.js';

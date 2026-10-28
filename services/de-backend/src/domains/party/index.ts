/**
 * Party domain: the canonical shared identity of persons and organizations (data-model.md §7, ADR-009).
 * See docs/development/coding-guidelines.md §3.
 */
export {
  ORGANIZATION_FIELDS,
  PARTY_FIELDS,
  PARTY_STATUSES,
  PARTY_TYPES,
  PERSON_FIELDS,
  createFingerprint,
  fieldsNotAllowed,
  planAmend,
  planDeactivate,
} from './party.js';
export type {
  AmendPartyOutcome,
  AmendPlan,
  CreatePartyOutcome,
  DeactivatePartyOutcome,
  DeactivatePlan,
  NewParty,
  Party,
  PartyChanges,
  PartyData,
  PartyField,
  PartyFilter,
  PartyId,
  PartyPage,
  PartyRepository,
  PartyStatus,
  PartyType,
  TypeSpecificField,
} from './party.js';
export { EXTERNAL_ENTITY_TYPES, EXTERNAL_REFERENCE_STATUSES, EXTERNAL_SYSTEMS, MRE_EXTERNAL_ID, planClaim, planEnd } from './external-reference.js';
export type {
  ClaimCheck,
  ClaimOutcome,
  ClaimPlan,
  EndOutcome,
  EndPlan,
  ExternalEntityType,
  ExternalReferenceId,
  ExternalReferenceKey,
  ExternalReferencePage,
  ExternalReferenceStatus,
  ExternalSystem,
  PartyExternalReference,
  PartyExternalReferenceRepository,
} from './external-reference.js';

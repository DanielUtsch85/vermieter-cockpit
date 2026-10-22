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

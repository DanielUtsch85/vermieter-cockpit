/**
 * RentalContractReference domain (data-model.md §11, api-design.md §58A): the DE-side reference to the concrete
 * rental relationship of an MRE Tenant, with the rent's due day over time. See docs/development/coding-guidelines.md §3.
 */
export { MAX_RENT_DUE_DAYS, changedEntries, dueDayOn, planReferenceAmend, referenceFingerprint, rentDueDaysError } from './reference.js';
export type {
  AmendableReferenceField,
  AmendReferenceOutcome,
  ChangedEntry,
  CreateReferenceOutcome,
  NewRentalContractReference,
  ReferenceAmendPlan,
  RentDueDay,
  RentalContractReference,
  RentalContractReferenceFields,
  RentalContractReferenceId,
  RentalContractReferenceRepository,
} from './reference.js';

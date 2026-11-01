import {
  ExternalReferenceInUseError,
  ExternalReferenceNotFoundError,
  MreTenantNotFoundError,
  PartyFieldNotAllowedError,
  PartyInactiveError,
  PartyNotFoundError,
} from '../../application/index.js';
import { answer, on, validation } from './answer.js';

/** The answers to the party module's errors (part of the central table, `../error-answers.ts`). */
export const PARTY_ANSWERS = [
  on(ExternalReferenceInUseError, (error) =>
    answer(409, 'CONFLICT', 'Another Party holds this external reference.', { reason: 'REFERENCE_IN_USE', partyId: error.partyId }),
  ),
  on(ExternalReferenceNotFoundError, (error) => answer(404, 'NOT_FOUND', 'External reference not found.', { externalReferenceId: error.externalReferenceId })),
  on(MreTenantNotFoundError, (error) => answer(404, 'NOT_FOUND', 'MRE Tenant not found in this Realm.', { externalId: error.externalId })),
  on(PartyFieldNotAllowedError, (error) => validation(error.fields.map((field) => ({ field, code: 'NOT_ALLOWED_FOR_TYPE' })))),
  on(PartyInactiveError, (error) =>
    answer(409, 'CONFLICT', 'An inactive Party gets no new external reference.', { reason: 'PARTY_INACTIVE', partyId: error.partyId }),
  ),
  on(PartyNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Party not found.', { partyId: error.partyId })),
];

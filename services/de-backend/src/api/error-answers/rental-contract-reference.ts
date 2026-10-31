import { RentalContractReferenceExistsError, RentalContractReferenceNotFoundError, RentalContractTenantNotFoundError } from '../../application/index.js';
import { answer, on } from './answer.js';

/** The answers to the rental contract reference module's errors (part of the central table, `../error-answers.ts`). */
export const RENTAL_CONTRACT_REFERENCE_ANSWERS = [
  on(RentalContractReferenceNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'Rental contract reference not found.', { rentalContractReferenceId: error.rentalContractReferenceId }),
  ),
  on(RentalContractReferenceExistsError, (error) =>
    answer(409, 'CONFLICT', 'The MRE Tenant has a rental contract reference already.', {
      reason: 'RENTAL_CONTRACT_REFERENCE_EXISTS',
      rentalContractReferenceId: error.rentalContractReferenceId,
    }),
  ),
  on(RentalContractTenantNotFoundError, (error) =>
    answer(422, 'MRE_TENANT_NOT_FOUND', 'MRE has no such Tenant in this Realm.', { mreTenantId: error.mreTenantId }),
  ),
];

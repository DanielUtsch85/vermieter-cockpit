import { MrePropertyNotFoundError, PropertyReferenceNotFoundError } from '../../application/index.js';
import { answer, on } from './answer.js';

/** The answers to the property reference module's errors (part of the central table, `../error-answers.ts`). */
export const PROPERTY_REFERENCE_ANSWERS = [
  on(MrePropertyNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'MRE Property not found in this Realm.', {
      mreRealmId: error.mreRealmId,
      mrePropertyId: error.mrePropertyId,
    }),
  ),
  on(PropertyReferenceNotFoundError, (error) => answer(404, 'NOT_FOUND', 'PropertyReference not found.', { propertyReferenceId: error.propertyReferenceId })),
];

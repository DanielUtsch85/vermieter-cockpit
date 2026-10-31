import {
  AcquisitionNotDraftError,
  AcquisitionNotFoundError,
  InvalidOwnershipError,
  OverlappingOwnershipError,
  OwnerInactiveError,
  OwnershipIncompleteError,
  OwnershipNotFoundError,
  OwnershipOfConfirmedAcquisitionError,
  OwnershipTotalExceedsOneError,
  PredecessorOfConfirmedAcquisitionError,
  formatShare,
} from '../../application/index.js';
import { answer, on } from './answer.js';

/** The answers to the ownership module's errors (part of the central table, `../error-answers.ts`). */
export const OWNERSHIP_ANSWERS = [
  on(AcquisitionNotDraftError, (error) =>
    answer(422, 'ACQUISITION_NOT_DRAFT', 'Only a DRAFT Acquisition takes new Ownerships.', {
      acquisitionId: error.acquisitionId,
      status: error.status,
    }),
  ),
  on(AcquisitionNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Acquisition not found.', { acquisitionId: error.acquisitionId })),
  on(InvalidOwnershipError, (error) =>
    answer(422, 'INVALID_OWNERSHIP', 'The Ownership cannot be closed so.', { ownershipId: error.ownershipId, reason: error.reason }),
  ),
  on(OverlappingOwnershipError, (error) =>
    answer(422, 'OVERLAPPING_OWNERSHIP', 'The owner already holds an overlapping Ownership of this PropertyReference.', {
      ownershipId: error.ownershipId,
    }),
  ),
  on(OwnerInactiveError, (error) => answer(422, 'PARTY_INACTIVE', 'A Party named here must be active.', { partyId: error.partyId })),
  on(OwnershipIncompleteError, (error) =>
    answer(422, 'OWNERSHIP_INCOMPLETE', 'The ownership was complete and would no longer be.', {
      date: error.date,
      shareSum: formatShare(error.shareSum),
    }),
  ),
  on(OwnershipNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Ownership not found.', { ownershipId: error.ownershipId })),
  on(OwnershipOfConfirmedAcquisitionError, (error) =>
    answer(409, 'CONFLICT', 'The Ownership carries a confirmed Acquisition; close it instead of voiding it.', {
      reason: 'ACQUISITION_CONFIRMED',
      acquisitionId: error.acquisitionId,
    }),
  ),
  on(OwnershipTotalExceedsOneError, (error) =>
    answer(422, 'OWNERSHIP_TOTAL_EXCEEDS_ONE', 'The shares would sum above 1.', { date: error.date, shareSum: formatShare(error.shareSum) }),
  ),
  on(PredecessorOfConfirmedAcquisitionError, (error) =>
    answer(409, 'CONFLICT', "The owner's next Ownership carries a confirmed Acquisition; its acquired share cannot change.", {
      reason: 'ACQUISITION_CONFIRMED',
      acquisitionId: error.acquisitionId,
      ownershipId: error.successorOwnershipId,
    }),
  ),
];

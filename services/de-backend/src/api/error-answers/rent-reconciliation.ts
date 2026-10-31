import {
  AboveSuggestionError,
  AlreadyMatchedError,
  MreRentTermNotFoundError,
  NoRentCashError,
  NotConfirmableError,
  NotRejectableError,
  NotReleasableError,
  NotRemovableError,
  NotWritableError,
  ReconciliationNotFoundError,
  RemovalTooEarlyError,
  RentCashExceededError,
  RentNotProposableError,
  SuggestionStaleError,
  TransactionNotCountedError,
  TransactionNotInflowError,
  WriteBackFailedError,
  WriteBackInProgressError,
} from '../../application/index.js';
import { answer, on, type ErrorAnswer } from './answer.js';

/** The answers to the rent reconciliation module's errors (part of the central table, `../error-answers.ts`). */
export const RENT_RECONCILIATION_ANSWERS = [
  on(AboveSuggestionError, (error) =>
    answer(422, 'ABOVE_SUGGESTION', 'A confirmation may lower the suggested amount, never raise it.', { suggested: error.suggested.toJSON() }),
  ),
  on(AlreadyMatchedError, (error) =>
    answer(409, 'CONFLICT', 'This Transaction already matches this rent term.', {
      reason: 'ALREADY_MATCHED',
      reconciliationId: error.reconciliationId,
    }),
  ),
  on(MreRentTermNotFoundError, (error) =>
    answer(422, 'MRE_RENT_TERM_NOT_FOUND', 'MRE did not return this rent term.', { mreTenantId: error.mreTenantId, mreRentTerm: error.mreRentTerm }),
  ),
  on(NoRentCashError, () => answer(422, 'NO_RENT_CASH', 'The Transaction has no split in a rent category.')),
  on(NotConfirmableError, (error) =>
    answer(409, 'CONFLICT', `A ${error.status} reconciliation cannot be confirmed.`, { reason: 'NOT_CONFIRMABLE', status: error.status }),
  ),
  on(NotRejectableError, (error) =>
    answer(409, 'CONFLICT', `A ${error.status} reconciliation cannot be rejected.`, { reason: 'NOT_REJECTABLE', status: error.status }),
  ),
  on(NotReleasableError, (error) =>
    answer(409, 'CONFLICT', `A ${error.status} reconciliation cannot be released.`, { reason: 'NOT_RELEASABLE', status: error.status }),
  ),
  on(NotRemovableError, (error) =>
    answer(409, 'CONFLICT', `A ${error.status} reconciliation in ${error.mreWriteBackState} has nothing to remove from MRE.`, {
      reason: 'NOT_REMOVABLE',
      status: error.status,
      mreWriteBackState: error.mreWriteBackState,
    }),
  ),
  on(NotWritableError, (error) =>
    answer(409, 'CONFLICT', `A ${error.status} reconciliation cannot be written back to MRE.`, { reason: 'NOT_WRITABLE', status: error.status }),
  ),
  on(ReconciliationNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Rent reconciliation not found.', { reconciliationId: error.reconciliationId })),
  on(RemovalTooEarlyError, (error) =>
    answer(409, 'CONFLICT', 'A late write-back to MRE could still land; the removal may start later.', {
      reason: 'REMOVAL_TOO_EARLY',
      notBefore: error.notBefore.toISOString(),
    }),
  ),
  on(RentCashExceededError, (error) =>
    answer(409, 'CONFLICT', 'The matched amount exceeds the available rent cash.', {
      reason: 'RENT_CASH_EXCEEDED',
      rentCash: error.rentCash.toJSON(),
      available: error.available.toJSON(),
    }),
  ),
  on(RentNotProposableError, (error) =>
    answer(409, 'CONFLICT', 'Only an unconfirmed INFLOW gets a rent split proposal.', {
      reason: 'NOT_PROPOSABLE',
      direction: error.direction,
      status: error.status,
    }),
  ),
  on(SuggestionStaleError, (error) =>
    answer(409, 'CONFLICT', 'The term was matched in between; the amount is above its open amount now.', {
      reason: 'SUGGESTION_STALE',
      openAmount: error.openAmount.toJSON(),
    }),
  ),
  on(TransactionNotCountedError, (error) =>
    answer(409, 'CONFLICT', 'Only a confirmed, current Transaction is cash that can be matched.', {
      reason: 'TRANSACTION_NOT_COUNTED',
      status: error.status,
      correctionRole: error.correctionRole,
    }),
  ),
  on(TransactionNotInflowError, () => answer(422, 'TRANSACTION_NOT_INFLOW', 'Rent is matched only to an INFLOW.')),
  on(WriteBackFailedError, (error) => writeBackFailureAnswer(error)),
  on(WriteBackInProgressError, (error) =>
    answer(409, 'CONFLICT', 'A write-back to MRE is running for this MRE Tenant.', {
      reason: 'WRITE_BACK_IN_PROGRESS',
      reconciliationId: error.reconciliationId,
    }),
  ),
];

/** A write-back or removal MRE did not take (§37.4–§37.5); the reconciliation's state rides along. */
function writeBackFailureAnswer(error: WriteBackFailedError): ErrorAnswer {
  const details = { reason: error.code, mreWriteBackState: error.reconciliation.mreWriteBackState };
  switch (error.code) {
    case 'MRE_RENT_TERM_NOT_FOUND':
      // MRE also answers 404 when its own database read fails (review on #76), so the message stays neutral.
      return answer(422, 'MRE_RENT_TERM_NOT_FOUND', 'MRE did not return this rent term.', {
        ...details,
        mreTenantId: error.reconciliation.mreTenantId,
        mreRentTerm: error.reconciliation.mreRentTerm,
      });
    case 'MRE_UNAVAILABLE':
    case 'MRE_WRITE_REFUSED':
      return answer(503, 'EXTERNAL_SYSTEM_ERROR', 'MRE did not take the payment; the write-back can be retried.', details);
    case 'MRE_TERM_NOT_ROUND_TRIPPABLE':
      return answer(409, 'CONFLICT', 'Under a VAT ratio MRE would change the discount or extra charge; record this payment in MRE by hand.', details);
    default:
      return answer(409, 'CONFLICT', 'The term changed in MRE; nothing of it was repaired.', details);
  }
}

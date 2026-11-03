import {
  AttributionChangeAmbiguousError,
  AttributionChangeDiffersError,
  AttributionChangeNotFlaggedError,
  LoanAllocationTaxConfirmationNotFoundError,
  NothingToConfirmError,
  TaxYearAcknowledgementNotFoundError,
} from '../../application/index.js';
import { answer, on } from './answer.js';

/** The answers to the errors of §58E's statements (VC-X-28, VC-X-48; part of the central table, `../error-answers.ts`). */
export const TAX_STATEMENT_ANSWERS = [
  on(TaxYearAcknowledgementNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Acknowledgement not found.', { acknowledgementId: error.acknowledgementId })),
  on(AttributionChangeNotFlaggedError, (error) =>
    answer(409, 'CONFLICT', 'The year shows no such attribution change.', {
      reason: 'CHANGE_NOT_FLAGGED',
      auditRecordId: error.auditRecordId,
      year: error.year,
      // §58G: the kind named when the request gave one.
      ...(error.kind === undefined ? {} : { kind: error.kind }),
    }),
  ),
  on(AttributionChangeAmbiguousError, (error) =>
    answer(409, 'CONFLICT', 'The record is more than one change of this year; name its kind.', {
      reason: 'CHANGE_AMBIGUOUS',
      auditRecordId: error.auditRecordId,
      year: error.year,
      kinds: error.kinds,
    }),
  ),
  on(AttributionChangeDiffersError, (error) =>
    answer(412, 'ATTRIBUTION_CHANGE_DIFFERS', 'The change moves other items than when it was read.', {
      auditRecordId: error.auditRecordId,
      expectedFingerprint: error.expectedFingerprint,
      currentFingerprint: error.currentFingerprint,
    }),
  ),
  on(LoanAllocationTaxConfirmationNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Confirmation not found.', { confirmationId: error.confirmationId })),
  on(NothingToConfirmError, (error) =>
    answer(409, 'CONFLICT', 'This allocation set needs no tax confirmation.', {
      reason: 'NOTHING_TO_CONFIRM',
      allocationSetId: error.allocationSetId,
      cause: error.nothingCause,
    }),
  ),
];

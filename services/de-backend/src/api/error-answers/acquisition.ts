import {
  AcquisitionCancelledError,
  AcquisitionConfirmedError,
  AcquisitionCostNotFoundError,
  AcquisitionCostVoidError,
  ClassificationPartsSumMismatchError,
  ClassificationPurposeNotAllowedError,
  CurrentClassificationChangedError,
  AcquisitionHasValidOwnershipsError,
  AcquisitionPaymentNotFoundError,
  ConfirmationBlockedError,
  type ConfirmationViolation,
  CostHasPaymentsError,
  CurrentAllocationChangedError,
  type LinkRefusal,
  OwnershipBasisIncompleteError,
  PaymentRefusedError,
  formatShare,
} from '../../application/index.js';
import { answer, on, type ErrorAnswer } from './answer.js';

/** The answers to the acquisition module's errors (part of the central table, `../error-answers.ts`). */
export const ACQUISITION_ANSWERS = [
  on(AcquisitionCancelledError, (error) =>
    answer(409, 'CONFLICT', 'A cancelled Acquisition is final.', {
      reason: 'ACQUISITION_CANCELLED',
      acquisitionId: error.acquisitionId,
    }),
  ),
  on(AcquisitionConfirmedError, (error) =>
    answer(409, 'CONFLICT', 'A confirmed Acquisition is final.', { reason: 'ACQUISITION_CONFIRMED', acquisitionId: error.acquisitionId }),
  ),
  on(AcquisitionCostNotFoundError, (error) => answer(404, 'NOT_FOUND', 'AcquisitionCost not found.', { acquisitionCostId: error.acquisitionCostId })),
  on(AcquisitionHasValidOwnershipsError, (error) =>
    answer(409, 'CONFLICT', 'VALID Ownerships carry this Acquisition; void them first.', {
      reason: 'ACQUISITION_HAS_VALID_OWNERSHIPS',
      ownershipIds: error.ownershipIds,
    }),
  ),
  on(AcquisitionPaymentNotFoundError, (error) => answer(404, 'NOT_FOUND', 'AcquisitionPayment not found.', { paymentId: error.paymentId })),
  on(ConfirmationBlockedError, (error) =>
    answer(422, 'CONFIRMATION_BLOCKED', 'The Acquisition does not meet the requirements of confirmation.', {
      violations: error.violations.map(violationDto),
    }),
  ),
  on(CostHasPaymentsError, (error) =>
    answer(409, 'CONFLICT', 'Payments are linked to this cost; unlink them first.', {
      reason: 'COST_HAS_PAYMENTS',
      paymentIds: error.paymentIds,
    }),
  ),
  on(CurrentAllocationChangedError, (error) =>
    answer(409, 'CONFLICT', 'supersedes does not name the current allocation.', {
      reason: 'CURRENT_ALLOCATION_CHANGED',
      currentAllocationId: error.currentAllocationId,
    }),
  ),
  // §59D: the classification of a cost.
  on(AcquisitionCostVoidError, () => answer(409, 'CONFLICT', 'The cost is void.', { reason: 'COST_VOID' })),
  on(CurrentClassificationChangedError, (error) =>
    answer(409, 'CONFLICT', 'supersedes does not name the current classification.', {
      reason: 'CURRENT_CLASSIFICATION_CHANGED',
      currentClassificationId: error.currentClassificationId,
    }),
  ),
  on(ClassificationPartsSumMismatchError, (error) =>
    answer(422, 'PARTS_SUM_MISMATCH', "The parts do not sum to the cost's amount.", {
      costAmount: error.costAmount.toJSON(),
      partsSum: error.partsSum.toJSON(),
    }),
  ),
  on(ClassificationPurposeNotAllowedError, (error) =>
    answer(422, 'PURPOSE_NOT_ALLOWED', 'A FINANCING_RELATED cost takes FINANCING parts only.', { category: error.category, purpose: error.purpose }),
  ),
  on(OwnershipBasisIncompleteError, (error) =>
    answer(409, 'CONFLICT', "The Acquisition's Ownerships do not form a complete basis.", {
      reason: 'OWNERSHIP_BASIS_INCOMPLETE',
      violations: error.violations.map(violationDto),
    }),
  ),
  on(PaymentRefusedError, (error) => refusalAnswer(error.refusal)),
];

/** A confirmation violation as the API shows it (§27.3). */
export function violationDto(v: ConfirmationViolation) {
  switch (v.code) {
    case 'BUYER_SHARE_NOT_INCREASED':
      return { code: v.code, partyId: v.partyId, shareBefore: formatShare(v.shareBefore), share: formatShare(v.share) };
    case 'SHARE_SUM_MISMATCH':
      return {
        code: v.code,
        expected: formatShare(v.expected),
        actual: formatShare(v.actual),
        byBuyer: v.byBuyer.map((b) => ({
          partyId: b.partyId,
          shareBefore: formatShare(b.shareBefore),
          share: formatShare(b.share),
          acquired: formatShare(b.acquired),
        })),
      };
    case 'OWNERSHIP_INCOMPLETE':
      return { code: v.code, date: v.date, shareSum: formatShare(v.shareSum) };
    default:
      return v;
  }
}

/** A refused payment link (§26.4). */
function refusalAnswer(refusal: LinkRefusal): ErrorAnswer {
  switch (refusal.kind) {
    case 'ACQUISITION_CANCELLED':
      return answer(409, 'CONFLICT', 'A cancelled Acquisition takes no cost or payment writes.', { reason: refusal.kind });
    case 'COST_VOID':
      return answer(409, 'CONFLICT', 'The cost is void.', { reason: refusal.kind });
    case 'TRANSACTION_NOT_CURRENT':
      return answer(422, refusal.kind, 'Only a current Transaction (CONFIRMED or RECONCILED, not a reversal) can be linked.', {
        status: refusal.status,
        correctionRole: refusal.correctionRole,
      });
    case 'NOT_OUTFLOW':
      return answer(422, refusal.kind, 'Only an OUTFLOW Transaction pays an acquisition.');
    case 'CURRENCY_MISMATCH':
      return answer(422, refusal.kind, "The Transaction is not in the Acquisition's currency.");
    case 'PAYMENT_EXCEEDS_TRANSACTION':
      return answer(409, 'INVARIANT_VIOLATION', 'The payments would exceed the Transaction amount.', {
        reason: refusal.kind,
        transactionAmount: refusal.transactionAmount.toJSON(),
        linkedAmount: refusal.linkedAmount.toJSON(),
        available: refusal.available.toJSON(),
      });
    case 'PAYMENT_EXCEEDS_COST':
    case 'PAYMENT_EXCEEDS_PRICE':
      return answer(409, 'INVARIANT_VIOLATION', 'The payments would exceed the expected amount.', {
        reason: refusal.kind,
        expected: refusal.expected.toJSON(),
        paid: refusal.paid.toJSON(),
        remaining: refusal.remaining.toJSON(),
      });
  }
}

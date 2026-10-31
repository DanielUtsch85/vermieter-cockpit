import {
  AllocationNotLastError,
  AllocationRefusedError,
  ClosingBeforeDebtError,
  LoanAllocationSetNotFoundError,
  LoanBalanceStatementNotFoundError,
  LoanClosedError,
  LoanClosedOnError,
  LoanFieldsInvalidError,
  LoanHasSplitsError,
  LoanNotActiveError,
  LoanNotAllocatedError,
  LoanNotFoundError,
  LoanRefinancesError,
  LoanTermsNotFoundError,
  NoScheduleError,
  PaymentNotProposableError,
  ProposalTransactionNotFoundError,
  RefinancingLoanNotActiveError,
  RefinancingLoanNotFoundError,
  RemainingDebtNotZeroError,
  SplitsAfterClosingError,
  StatementAfterClosingError,
  StatementBeforeDebtError,
  TermsNotLastError,
  TermsRefusedError,
} from '../../application/index.js';
import { eurCents, signedEurCents } from '../cents.js';
import { answer, on, validation } from './answer.js';

/** The answers to the financing module's errors (part of the central table, `../error-answers.ts`). */
export const FINANCING_ANSWERS = [
  on(AllocationNotLastError, (error) =>
    answer(409, 'CONFLICT', 'Only the last set is voided.', { reason: 'ALLOCATION_NOT_LAST', laterAllocationSetId: error.laterAllocationSetId }),
  ),
  on(AllocationRefusedError, (error) => {
    const r = error.refusal;
    const details =
      r.kind === 'ALLOCATION_BEFORE_DEBT'
        ? { debtFrom: r.debtFrom }
        : r.kind === 'ALLOCATION_NOT_APPENDED'
          ? { lastValidFrom: r.lastValidFrom }
          : { acquisitionId: r.acquisitionId };
    return answer(422, r.kind, 'The set cannot be appended.', details);
  }),
  on(ClosingBeforeDebtError, (error) => answer(422, 'CLOSING_BEFORE_DEBT', 'The closing date is before the debt starts.', { debtFrom: error.debtFrom })),
  on(LoanAllocationSetNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Allocation set not found.', { allocationSetId: error.allocationSetId })),
  on(LoanBalanceStatementNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Balance statement not found.', { statementId: error.statementId })),
  on(LoanClosedError, (error) => answer(409, 'CONFLICT', 'A closed Loan is final.', { reason: 'LOAN_CLOSED', loanId: error.loanId })),
  on(LoanClosedOnError, (error) =>
    answer(409, 'CONFLICT', `The Loan was closed on ${error.closingDate}.`, { reason: 'LOAN_CLOSED', closingDate: error.closingDate }),
  ),
  on(LoanFieldsInvalidError, (error) => validation(error.errors)),
  on(LoanHasSplitsError, (error) => answer(409, 'CONFLICT', 'Splits reference the Loan.', { reason: 'LOAN_HAS_SPLITS', transactionIds: error.transactionIds })),
  on(LoanNotActiveError, (error) => answer(409, 'CONFLICT', `The Loan is ${error.status}.`, { reason: 'LOAN_NOT_ACTIVE', status: error.status })),
  on(LoanNotAllocatedError, (error) => answer(409, 'CONFLICT', 'No allocation set covers the day.', { reason: 'LOAN_NOT_ALLOCATED', ...error.details })),
  on(LoanNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Loan not found.', { loanId: error.loanId })),
  on(LoanRefinancesError, (error) =>
    answer(409, 'CONFLICT', 'A closed Loan names this one as its refinancing.', { reason: 'LOAN_REFINANCES', loanIds: error.loanIds }),
  ),
  on(LoanTermsNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Loan terms not found.', { termsId: error.termsId })),
  on(NoScheduleError, (error) => answer(409, 'CONFLICT', 'The Loan has no planned payment.', { reason: 'NO_SCHEDULE', endReason: error.endReason })),
  on(PaymentNotProposableError, (error) =>
    answer(409, 'CONFLICT', 'Only an unconfirmed OUTFLOW gets a payment proposal.', {
      reason: 'NOT_PROPOSABLE',
      direction: error.direction,
      status: error.status,
    }),
  ),
  on(ProposalTransactionNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId })),
  on(RefinancingLoanNotActiveError, (error) => answer(422, 'REFINANCING_LOAN_NOT_ACTIVE', 'The refinancing Loan must be ACTIVE.', { status: error.status })),
  on(RefinancingLoanNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Refinancing Loan not found.', { refinancedByLoanId: error.refinancedByLoanId })),
  on(RemainingDebtNotZeroError, (error) =>
    answer(409, 'CONFLICT', 'The remaining debt on the closing date is not 0.', {
      reason: 'REMAINING_DEBT_NOT_ZERO',
      actual: signedEurCents(error.actual),
    }),
  ),
  on(SplitsAfterClosingError, (error) =>
    answer(409, 'CONFLICT', 'Splits name the Loan after the closing date.', { reason: 'SPLITS_AFTER_CLOSING', transactionIds: error.transactionIds }),
  ),
  on(StatementAfterClosingError, (error) =>
    answer(422, 'STATEMENT_AFTER_CLOSING', 'The statement is after the Loan was closed.', { closingDate: error.closingDate }),
  ),
  on(StatementBeforeDebtError, (error) => answer(422, 'STATEMENT_BEFORE_DEBT', 'The statement is before the debt starts.', { debtFrom: error.debtFrom })),
  on(TermsNotLastError, (error) => answer(409, 'CONFLICT', 'Only the last period is voided.', { reason: 'TERMS_NOT_LAST', laterTermsId: error.laterTermsId })),
  on(TermsRefusedError, (error) => {
    const r = error.refusal;
    const details =
      r.kind === 'TERMS_BEFORE_DEBT'
        ? { debtFrom: r.debtFrom }
        : r.kind === 'TERMS_NOT_APPENDED'
          ? { lastValidFrom: r.lastValidFrom }
          : r.kind === 'PREVIOUS_TERMS_WITHOUT_PAYMENT'
            ? { termsId: r.termsId, firstPaymentDate: r.firstPaymentDate }
            : r.kind === 'PRINCIPAL_AT_START_EXCEEDS_ORIGINAL'
              ? { principalOriginal: r.principalOriginal.toJSON() }
              : r.kind === 'PAYMENT_DOES_NOT_COVER_INTEREST'
                ? { firstInterest: eurCents(r.firstInterest), balance: eurCents(r.balance) }
                : undefined;
    return answer(422, r.kind, 'The period cannot be appended.', details);
  }),
];

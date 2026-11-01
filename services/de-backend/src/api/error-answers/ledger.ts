import {
  AssessmentNotActiveError,
  CorrectionNoChangeError,
  FinancialAccountClosedError,
  FinancialAccountNotFoundError,
  ImportAccountMismatchError,
  ImportBatchNotFoundError,
  ImportFileError,
  ImportedFieldsFixedError,
  InactiveCategoryError,
  InvalidLoanSplitError,
  InvalidSecurityDepositSplitError,
  InvalidWegAssessmentSplitError,
  InvalidWegStatementSplitError,
  NoWegMembershipError,
  ReviewItemNotFoundError,
  ReviewResolutionConflictError,
  SplitSumMismatchError,
  SplitsMissingError,
  StatementNotCurrentError,
  TransactionAlreadyCorrectedError,
  TransactionFrozenError,
  TransactionNotAmendableError,
  TransactionNotConfirmableError,
  TransactionNotCorrectableError,
  TransactionNotFoundError,
  TransactionNotIgnorableError,
  TransactionNotIgnoredError,
  TransactionRentReconciledError,
  UnsupportedAdapterError,
  WegAssessmentNotFoundError,
  WegStatementNotFoundError,
} from '../../application/index.js';
import { answer, on, validation } from './answer.js';

/** The answers to the ledger module's errors (part of the central table, `../error-answers.ts`). */
export const LEDGER_ANSWERS = [
  on(AssessmentNotActiveError, (error) =>
    answer(409, 'CONFLICT', `The Sonderumlage is ${error.status}.`, {
      reason: 'ASSESSMENT_NOT_ACTIVE',
      wegSpecialAssessmentId: error.wegSpecialAssessmentId,
      status: error.status,
    }),
  ),
  on(CorrectionNoChangeError, () => answer(409, 'CONFLICT', 'The replacement equals the original; nothing to correct.', { reason: 'NO_CHANGE' })),
  on(FinancialAccountClosedError, (error) =>
    answer(409, 'CONFLICT', 'The FinancialAccount is closed.', {
      reason: 'ACCOUNT_CLOSED',
      financialAccountId: error.financialAccountId,
    }),
  ),
  on(FinancialAccountNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'FinancialAccount not found.', {
      financialAccountId: error.financialAccountId,
    }),
  ),
  on(ImportBatchNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'ImportBatch not found.', {
      importBatchId: error.importBatchId,
    }),
  ),
  on(ImportedFieldsFixedError, (error) =>
    answer(409, 'CONFLICT', 'An imported Transaction keeps the values of its bank row.', {
      reason: 'IMPORTED_FIELDS_FIXED',
      fields: error.fields,
    }),
  ),
  on(ImportAccountMismatchError, (error) =>
    answer(422, 'ACCOUNT_IBAN_MISMATCH', "The file's own account does not match the FinancialAccount; nothing was imported.", {
      reason: error.reason,
      accountIban: error.accountIban,
      fileIbans: error.fileIbans,
    }),
  ),
  on(ImportFileError, (error) =>
    answer(400, 'IMPORT_ERROR', error.error.message, {
      reason: error.error.code,
    }),
  ),
  on(InactiveCategoryError, (error) =>
    answer(422, 'REVIEW_REQUIRED', 'A split uses an inactive financial category.', {
      reason: 'INACTIVE_CATEGORY',
      financialCategoryCodes: error.codes,
    }),
  ),
  on(InvalidLoanSplitError, (error) =>
    answer(422, 'INVALID_LOAN_SPLIT', 'A split with a Loan is LOAN_INTEREST or LOAN_PRINCIPAL of an OUTFLOW.', {
      position: error.position,
      reason: error.reason,
    }),
  ),
  on(InvalidSecurityDepositSplitError, (error) =>
    answer(422, 'INVALID_SECURITY_DEPOSIT_SPLIT', 'A split with a security deposit is SECURITY_DEPOSIT, or SECURITY_DEPOSIT_INTEREST of an INFLOW.', {
      position: error.position,
      reason: error.reason,
    }),
  ),
  on(InvalidWegAssessmentSplitError, (error) =>
    answer(422, 'INVALID_WEG_ASSESSMENT_SPLIT', 'A split naming a Sonderumlage is WEG_SPECIAL_ASSESSMENT of its unit.', {
      position: error.position,
      reason: error.reason,
    }),
  ),
  on(InvalidWegStatementSplitError, (error) =>
    answer(422, 'INVALID_WEG_STATEMENT_SPLIT', "A split naming a statement is a WEG split of the statement's unit.", {
      position: error.position,
      reason: error.reason,
    }),
  ),
  on(NoWegMembershipError, (error) =>
    answer(422, 'NO_WEG_MEMBERSHIP', error.reason === 'NO_UNIT' ? 'A WEG split names its unit.' : 'The unit has no WEG membership on the booking date.', {
      ...(error.position === null ? {} : { position: error.position }),
      reason: error.reason,
      ...(error.propertyReferenceId === null ? {} : { propertyReferenceId: error.propertyReferenceId, bookingDate: error.bookingDate }),
    }),
  ),
  on(ReviewItemNotFoundError, (error) => answer(404, 'NOT_FOUND', 'ImportReviewItem not found in this ImportBatch.', { reviewItemId: error.reviewItemId })),
  on(ReviewResolutionConflictError, (error) =>
    answer(409, 'CONFLICT', 'The review item is already resolved differently.', {
      reason: 'ALREADY_RESOLVED',
      resolution: error.item.resolution,
    }),
  ),
  on(SplitsMissingError, () =>
    answer(409, 'INVARIANT_VIOLATION', 'Transaction has no splits; split it before confirming.', {
      reason: 'SPLITS_MISSING',
    }),
  ),
  on(SplitSumMismatchError, (error) =>
    answer(409, 'INVARIANT_VIOLATION', 'Splits do not add up to the Transaction amount.', {
      reason: 'SPLIT_SUM_MISMATCH',
      expected: error.expected.toJSON(),
      actual: error.actual.toJSON(),
      difference: error.expected.subtract(error.actual).toJSON(),
    }),
  ),
  on(StatementNotCurrentError, (error) =>
    answer(409, 'CONFLICT', `The annual statement is ${error.status}; a settlement names the statement in force.`, {
      reason: 'STATEMENT_NOT_CURRENT',
      wegAnnualStatementId: error.wegAnnualStatementId,
      status: error.status,
      ...(error.supersededBy === null ? {} : { supersededBy: error.supersededBy }),
    }),
  ),
  on(TransactionAlreadyCorrectedError, (error) =>
    answer(409, 'CONFLICT', 'Transaction is already corrected or reversed.', {
      reason: 'ALREADY_CORRECTED',
      reversalTransactionId: error.reversalTransactionId,
      replacementTransactionId: error.replacementTransactionId,
    }),
  ),
  on(TransactionFrozenError, (error) =>
    answer(409, 'CONFLICT', `Transaction is ${error.status}; its splits cannot change.`, {
      reason: 'TRANSACTION_FROZEN',
      status: error.status,
    }),
  ),
  on(TransactionNotAmendableError, (error) =>
    answer(409, 'CONFLICT', `Transaction is ${error.status} and cannot be amended.`, {
      reason: 'NOT_AMENDABLE',
      status: error.status,
    }),
  ),
  on(TransactionNotConfirmableError, (error) =>
    answer(409, 'CONFLICT', `Transaction is ${error.status} and cannot be confirmed.`, {
      reason: 'NOT_CONFIRMABLE',
      status: error.status,
    }),
  ),
  on(TransactionNotCorrectableError, (error) => {
    const message =
      error.correctionRole === 'REVERSAL'
        ? 'A reversal cannot be corrected or reversed; correct or reverse its original’s replacement.'
        : `Transaction is ${error.status} and cannot be corrected or reversed.`;
    return answer(409, 'CONFLICT', message, {
      reason: 'NOT_CORRECTABLE',
      status: error.status,
      ...(error.correctionRole === undefined ? {} : { correctionRole: error.correctionRole }),
    });
  }),
  on(TransactionNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId })),
  on(TransactionNotIgnorableError, (error) =>
    answer(409, 'CONFLICT', `Transaction is ${error.status} and cannot be ignored; correct it instead.`, {
      reason: 'NOT_IGNORABLE',
      status: error.status,
    }),
  ),
  on(TransactionNotIgnoredError, (error) =>
    answer(409, 'CONFLICT', `Transaction is ${error.status}, not IGNORED.`, { reason: 'NOT_IGNORED', status: error.status }),
  ),
  on(TransactionRentReconciledError, (error) =>
    answer(409, 'CONFLICT', 'Confirmed rent reconciliations match this Transaction; release them first.', {
      reason: 'TRANSACTION_RENT_RECONCILED',
      reconciliationIds: error.reconciliationIds,
    }),
  ),
  on(UnsupportedAdapterError, () => validation([{ field: 'adapterId', code: 'NOT_SUPPORTED' }])),
  on(WegAssessmentNotFoundError, (error) =>
    answer(404, 'NOT_FOUND', 'WEG special assessment not found.', { wegSpecialAssessmentId: error.wegSpecialAssessmentId }),
  ),
  on(WegStatementNotFoundError, (error) => answer(404, 'NOT_FOUND', 'WEG annual statement not found.', { wegAnnualStatementId: error.wegAnnualStatementId })),
];

import {
  DepositCashAfterClosingDateError,
  DepositClosedError,
  DepositExistsError,
  DepositHasSplitsError,
  DepositNotActiveError,
  DepositNotClosedError,
  DepositStillHeldError,
  ExpectedAmountRequiredError,
  HoldingAccountNotFoundError,
  NotASecurityDepositAccountError,
  NothingRetainedError,
  SecurityDepositNotFoundError,
  UnconfirmedDepositCashError,
} from '../../application/index.js';
import { answer, on } from './answer.js';

/** The answers to the security deposit module's errors (part of the central table, `../error-answers.ts`). */
export const SECURITY_DEPOSIT_ANSWERS = [
  on(DepositCashAfterClosingDateError, (error) =>
    answer(409, 'CONFLICT', 'Cash of the security deposit lies after the closing date.', {
      reason: 'CASH_AFTER_CLOSING_DATE',
      transactionIds: error.transactionIds,
    }),
  ),
  on(DepositClosedError, (error) =>
    answer(409, 'CONFLICT', 'The security deposit is closed.', { reason: 'DEPOSIT_CLOSED', securityDepositId: error.securityDepositId }),
  ),
  on(DepositExistsError, (error) =>
    answer(409, 'CONFLICT', 'The Tenant already has a security deposit.', { reason: 'DEPOSIT_EXISTS', securityDepositId: error.securityDepositId }),
  ),
  on(DepositHasSplitsError, (error) =>
    answer(409, 'CONFLICT', 'Splits reference the security deposit.', { reason: 'DEPOSIT_HAS_SPLITS', transactionIds: error.transactionIds }),
  ),
  on(DepositNotActiveError, (error) =>
    answer(409, 'CONFLICT', `The security deposit is ${error.status}.`, {
      reason: 'DEPOSIT_NOT_ACTIVE',
      securityDepositId: error.securityDepositId,
      status: error.status,
    }),
  ),
  on(DepositNotClosedError, (error) =>
    answer(409, 'CONFLICT', `The security deposit is ${error.status}, not CLOSED.`, {
      reason: 'DEPOSIT_NOT_CLOSED',
      securityDepositId: error.securityDepositId,
      status: error.status,
    }),
  ),
  on(DepositStillHeldError, (error) =>
    answer(409, 'CONFLICT', 'The security deposit still holds cash; RETURNED needs held = 0.', { reason: 'DEPOSIT_STILL_HELD', held: error.held.toJSON() }),
  ),
  on(ExpectedAmountRequiredError, () =>
    answer(422, 'EXPECTED_AMOUNT_REQUIRED', 'No expectedAmount was given, and MRE has no guaranty for the Tenant; nothing was written.'),
  ),
  on(HoldingAccountNotFoundError, (error) => answer(404, 'NOT_FOUND', 'FinancialAccount not found.', { financialAccountId: error.financialAccountId })),
  on(NotASecurityDepositAccountError, (error) =>
    answer(422, 'NOT_A_SECURITY_DEPOSIT_ACCOUNT', 'The holding account is not a SECURITY_DEPOSIT account.', {
      financialAccountId: error.financialAccountId,
      accountType: error.accountType,
    }),
  ),
  on(NothingRetainedError, (error) =>
    answer(409, 'CONFLICT', 'Nothing is retained; RETAINED needs held > 0.', { reason: 'NOTHING_RETAINED', held: error.held.toJSON() }),
  ),
  on(SecurityDepositNotFoundError, (error) => answer(404, 'NOT_FOUND', 'Security deposit not found.', { securityDepositId: error.securityDepositId })),
  on(UnconfirmedDepositCashError, (error) =>
    answer(409, 'CONFLICT', 'Unconfirmed Transactions name the security deposit; confirm or unlink them first.', {
      reason: 'UNCONFIRMED_CASH',
      transactionIds: error.transactionIds,
    }),
  ),
];

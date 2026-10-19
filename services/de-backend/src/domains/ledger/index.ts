/**
 * Financial Ledger domain: FinancialAccount, cash-only Transaction, TransactionSplit.
 * See docs/development/coding-guidelines.md §3.
 */
export { ACCOUNT_STATUSES, ACCOUNT_TYPES, createFingerprint, planClose } from './financial-account.js';
export type {
  AccountStatus,
  AccountType,
  ClosePlan,
  CreateOutcome,
  FinancialAccount,
  FinancialAccountId,
  FinancialAccountRepository,
  NewFinancialAccount,
} from './financial-account.js';

/**
 * Financing domain: loans, planned vs actual, LoanAllocation (phase-3-plan.md, api-design.md §41).
 * See docs/development/coding-guidelines.md §3.
 */
export { AMENDABLE_FIELDS, LOAN_STATUSES, createFingerprint, debtFrom, fieldErrors, planAmend, planVoid } from './loan.js';
export type {
  AmendableField,
  AmendLoanOutcome,
  AmendPlan,
  CreateLoanOutcome,
  Loan,
  LoanAmendable,
  LoanChanges,
  LoanData,
  LoanFieldError,
  LoanFilter,
  LoanId,
  LoanPage,
  LoanRepository,
  LoanStatus,
  NewLoan,
  VoidLoanOutcome,
  VoidPlan,
} from './loan.js';

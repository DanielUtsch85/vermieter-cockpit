/**
 * Security Deposit domain (phase-5-plan.md, api-design.md §47): the landlord's record of a rental deposit, never rent.
 * See docs/development/coding-guidelines.md §3.
 */
export {
  AMENDABLE_FIELDS,
  DEPOSIT_CLOSING_REASONS,
  DEPOSIT_STATUSES,
  EXPECTED_AMOUNT_SOURCES,
  createFingerprint,
  planAmend,
  planClose,
  planReopen,
  planVoid,
  resolveNew,
  retainedAmountOf,
} from './deposit.js';
export type {
  AmendableField,
  AmendDepositOutcome,
  AmendPlan,
  CloseCash,
  CloseDepositOutcome,
  ClosePlan,
  CloseRequest,
  DepositClosingReason,
  CreateDepositOutcome,
  CreatePrecheck,
  DepositAmendable,
  DepositChanges,
  DepositClosing,
  DepositFilter,
  DepositPage,
  DepositRefusal,
  DepositRequest,
  DepositStatus,
  ExpectedAmountSource,
  NewDeposit,
  ReopenDepositOutcome,
  ReopenPlan,
  SecurityDeposit,
  SecurityDepositId,
  SecurityDepositRepository,
  VoidDepositOutcome,
  VoidPlan,
} from './deposit.js';
export { CASH_KINDS, DEPOSIT_STATES, cashKindOf, compareWithMre, deriveFigures } from './figures.js';
export type { CashKind, CountedCash, DepositFigures, DepositFlag, DepositState, DepositView, MreComparison, MreDepositValues } from './figures.js';

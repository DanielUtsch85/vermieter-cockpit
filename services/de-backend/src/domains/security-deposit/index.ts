/**
 * Security Deposit domain (phase-5-plan.md, api-design.md §47): the landlord's record of a rental deposit, never rent.
 * See docs/development/coding-guidelines.md §3.
 */
export { AMENDABLE_FIELDS, DEPOSIT_STATUSES, EXPECTED_AMOUNT_SOURCES, createFingerprint, planAmend, planVoid, resolveNew } from './deposit.js';
export type {
  AmendableField,
  AmendDepositOutcome,
  AmendPlan,
  CreateDepositOutcome,
  CreatePrecheck,
  DepositAmendable,
  DepositChanges,
  DepositFilter,
  DepositPage,
  DepositRefusal,
  DepositRequest,
  DepositStatus,
  ExpectedAmountSource,
  NewDeposit,
  SecurityDeposit,
  SecurityDepositId,
  SecurityDepositRepository,
  VoidDepositOutcome,
  VoidPlan,
} from './deposit.js';
export { CASH_KINDS, DEPOSIT_STATES, cashKindOf, deriveFigures } from './figures.js';
export type { CashKind, CountedCash, DepositFigures, DepositFlag, DepositState, DepositView } from './figures.js';

/**
 * Rent reconciliation: DE cash matched to MRE rent terms (phase-4-plan.md, api-design.md §37).
 * See docs/development/coding-guidelines.md §3.
 */
export { RECONCILIATION_STATUSES, RENT_CATEGORIES, availableOf, checkMatch, isTermKey, matchFingerprint, planRelease } from './reconciliation.js';
export type {
  CreateMatchOutcome,
  MatchCash,
  MatchRefusal,
  MreWriteBackState,
  NewMatch,
  PrecheckOutcome,
  ReconciliationFilter,
  ReconciliationPage,
  ReconciliationStatus,
  ReleaseOutcome,
  ReleasePlan,
  RentPaymentReconciliation,
  RentPaymentReconciliationId,
  RentReconciliationRepository,
} from './reconciliation.js';

/**
 * Rent reconciliation: DE cash matched to MRE rent terms (phase-4-plan.md, api-design.md §37).
 * See docs/development/coding-guidelines.md §3.
 */
export { COVERAGES, RECONCILIATION_STATUSES, RENT_CATEGORIES, availableOf, checkMatch, coverageOf, isTermKey, matchFingerprint, matchedTotalOf, planRelease } from './reconciliation.js';
export type {
  Coverage,
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
  TransactionRentSide,
} from './reconciliation.js';

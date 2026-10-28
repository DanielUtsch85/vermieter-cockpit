/**
 * Rent reconciliation: DE cash matched to MRE rent terms (phase-4-plan.md, api-design.md §37).
 * See docs/development/coding-guidelines.md §3.
 */
export {
  COVERAGES,
  RECONCILIATION_STATUSES,
  RENT_CATEGORIES,
  WRITE_BACK_STATES,
  availableOf,
  checkMatch,
  coverageOf,
  holdsLease,
  isTermKey,
  matchFingerprint,
  matchedTotalOf,
  planConfirm,
  planReject,
  planRelease,
  planWriteBack,
  staleBy,
} from './reconciliation.js';
export { WRITE_BACK_ERRORS, dePayment, isRoundTrippable, markerIn, markerOf, storedPayments, verifyWritten, writeBody } from './write-back.js';
export type { MrePaymentSnapshot, StoredPayment, TermPayment, TermWrite, WriteBackError, WriteBackTerm } from './write-back.js';
export { SUGGESTION_REASONS, bookingWindow, suggestPairs } from './suggestion.js';
export type { Confidence, Suggestion, SuggestionCandidate, SuggestionInput, SuggestionPair, SuggestionReason, SuggestionTerm } from './suggestion.js';
export type {
  ClaimOutcome,
  RecordOutcome,
  WriteBackPlan,
  WriteBackResult,
  ConfirmOutcome,
  ConfirmPlan,
  ConfirmPrecheck,
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
  RejectOutcome,
  RejectPlan,
  ReleasePlan,
  RentPaymentReconciliation,
  RentPaymentReconciliationId,
  RentReconciliationRepository,
  SuggestionSnapshot,
  TransactionRentSide,
} from './reconciliation.js';

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
  planRemoval,
  planWriteBack,
  staleBy,
} from './reconciliation.js';
export {
  WRITE_BACK_ERRORS,
  dePayment,
  isRoundTrippable,
  markerIn,
  markerOf,
  removalBody,
  storedPayments,
  verifyRemoved,
  verifyWritten,
  writeBody,
} from './write-back.js';
export type { MrePaymentSnapshot, StoredPayment, TermPayment, TermWrite, WriteBackError, WriteBackTerm } from './write-back.js';
export { SUGGESTION_REASONS, bookingWindow, countDecidedBefore, suggestPairs } from './suggestion.js';
export type { Confidence, Suggestion, SuggestionCandidate, SuggestionInput, SuggestionPair, SuggestionReason, SuggestionTerm } from './suggestion.js';
export type {
  ClaimOutcome,
  RemovalClaimOutcome,
  RemovalPlan,
  RemovalResult,
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
  SkippedInflows,
  SuggestSkipped,
  SuggestionSnapshot,
  TransactionRentSide,
} from './reconciliation.js';
export { proposeRentSplit, soleTermProperty } from './split-proposal.js';
export type { NoPropertyReason, ProposalProperty, RentSplitProposal, RentTermBreakdown, RentTermTotals, SplitProposalFlag } from './split-proposal.js';
export type { RentTenantPage, RentTenantSummary, RentTenantTermQueries, TenantTermReconciliation } from './tenant-terms.js';

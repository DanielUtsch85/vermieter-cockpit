import type { RuleRegistry } from '../../shared/index.js';
import type { TransactionStatus } from '../ledger/index.js';
import type { DepositNotCounted, WegSourceNotCounted } from './classification-checks.js';
import type { TaxClassification } from './tax-classification.js';
import { splitCounts, type SplitFacts } from './tax-meaning.js';
import type { StoredReviewState } from './vocabulary.js';

/** The review of a classification (api-design.md §57): its three steps and their state checks. */

/** §57's three steps. */
export type ReviewStep =
  | { readonly kind: 'CONFIRM' }
  | { readonly kind: 'ADVISOR_CONFIRM'; readonly advisorPartyId: string | null; readonly note: string | null }
  | { readonly kind: 'MARK_NEEDS_REVIEW'; readonly reason: string };

export type ReviewRefusal =
  | { readonly kind: 'CLASSIFICATION_SUPERSEDED'; readonly supersededBy: string }
  | { readonly kind: 'ADVISOR_CONFIRMED' }
  | { readonly kind: 'SOURCE_NOT_COUNTED'; readonly transactionStatus: TransactionStatus; readonly correctionRole: string | null }
  | DepositNotCounted
  | WegSourceNotCounted
  | { readonly kind: 'RULE_NOT_REGISTERED'; readonly ruleCode: string; readonly version: number };

/** What a step writes: the target state and advisor; `changed: false` is a `200` no-op. */
export interface ReviewPlan {
  readonly reviewState: StoredReviewState;
  readonly advisorPartyId: string | null;
  readonly changed: boolean;
}

/**
 * §57's state checks, in order: only the current classification moves; confirm does not lower an advisor's
 * confirmation; for the two confirmations the source still counts and the rule version still resolves; then the
 * target, or the no-op.
 */
export function planReview(
  current: TaxClassification,
  step: ReviewStep,
  source:
    | Pick<SplitFacts, 'transactionStatus' | 'correctionRole'>
    | { readonly deposit: DepositNotCounted | null }
    | { readonly weg: WegSourceNotCounted | null },
  registry: RuleRegistry,
): ReviewPlan | ReviewRefusal {
  if (current.supersededBy !== null) return { kind: 'CLASSIFICATION_SUPERSEDED', supersededBy: current.supersededBy };
  if (step.kind === 'CONFIRM' && current.reviewState === 'ADVISOR_CONFIRMED') return { kind: 'ADVISOR_CONFIRMED' };
  // Only a confirmation validates the source and the rule (§57): marking for review is exactly what a classification
  // whose source stopped counting needs (review on #158).
  if (step.kind !== 'MARK_NEEDS_REVIEW') {
    if ('deposit' in source) {
      if (source.deposit !== null) return source.deposit;
    } else if ('weg' in source) {
      if (source.weg !== null) return source.weg;
    } else if (!splitCounts(source)) {
      return { kind: 'SOURCE_NOT_COUNTED', transactionStatus: source.transactionStatus, correctionRole: source.correctionRole };
    }
    // Both rule references resolve (§58B).
    for (const ref of [current.rule, current.treatmentRule]) {
      if (ref !== null && !registry.isRegistered(ref.ruleCode, ref.version))
        return { kind: 'RULE_NOT_REGISTERED', ruleCode: ref.ruleCode, version: ref.version };
    }
  }
  const target: { reviewState: StoredReviewState; advisorPartyId: string | null } =
    step.kind === 'CONFIRM'
      ? { reviewState: 'USER_CONFIRMED', advisorPartyId: null }
      : step.kind === 'ADVISOR_CONFIRM'
        ? { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: step.advisorPartyId }
        : { reviewState: 'NEEDS_REVIEW', advisorPartyId: null };
  const changed = target.reviewState !== current.reviewState || target.advisorPartyId !== current.advisorPartyId;
  return { ...target, changed };
}

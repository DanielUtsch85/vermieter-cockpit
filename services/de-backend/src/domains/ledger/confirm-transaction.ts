import { Money } from '../../shared/index.js';
import type { Transaction, TransactionStatus } from './transaction.js';

/**
 * Confirming a Transaction (api-design.md §34, domain-model.md §21, §24):
 * the step that makes it authoritative cash truth. Only a CLASSIFIED
 * Transaction whose splits cover its amount exactly, with every category still
 * active, can be confirmed. Afterwards it is immutable (ADR-037).
 */

/** States in which a Transaction counts as confirmed (RECONCILED and CORRECTED follow CONFIRMED). */
export const CONFIRMED_STATUSES = ['CONFIRMED', 'RECONCILED', 'CORRECTED'] as const satisfies readonly TransactionStatus[];

/** A stored split as far as confirmation needs it. */
export interface SplitForConfirm {
  readonly amount: Money;
  readonly financialCategoryCode: string;
  readonly categoryActive: boolean;
}

export type ConfirmPlan =
  | { readonly kind: 'CONFIRM' }
  /** CONFIRMED or RECONCILED: a repeated confirm is a no-op (§34.1). */
  | { readonly kind: 'ALREADY_CONFIRMED' }
  /** CORRECTED or IGNORED: never (again) confirmable. */
  | { readonly kind: 'NOT_CONFIRMABLE'; readonly status: TransactionStatus }
  /** No split set yet (IMPORTED / UNREVIEWED): coverage is incomplete. */
  | { readonly kind: 'SPLITS_MISSING' }
  | { readonly kind: 'SUM_MISMATCH'; readonly expected: Money; readonly actual: Money }
  /** A split's category was deactivated since: the classification must be reviewed (→ 422). */
  | { readonly kind: 'INACTIVE_CATEGORY'; readonly codes: readonly string[] };

/**
 * The checks of §34.1 in order: state, split coverage, exact sum (re-checked
 * here: the split set was valid when stored, the confirmation must not rely on
 * that alone), resolvable references.
 */
export function planConfirm(transaction: Pick<Transaction, 'amount' | 'status'>, splits: readonly SplitForConfirm[]): ConfirmPlan {
  switch (transaction.status) {
    case 'CONFIRMED':
    case 'RECONCILED':
      return { kind: 'ALREADY_CONFIRMED' };
    case 'CORRECTED':
    case 'IGNORED':
      return { kind: 'NOT_CONFIRMABLE', status: transaction.status };
    case 'IMPORTED':
    case 'UNREVIEWED':
    case 'CLASSIFIED':
      break;
  }
  if (splits.length === 0) return { kind: 'SPLITS_MISSING' };
  const actual = Money.sum(
    splits.map((s) => s.amount),
    transaction.amount.currency,
  );
  if (!actual.equals(transaction.amount)) return { kind: 'SUM_MISMATCH', expected: transaction.amount, actual };
  const inactive = [...new Set(splits.filter((s) => !s.categoryActive).map((s) => s.financialCategoryCode))];
  if (inactive.length > 0) return { kind: 'INACTIVE_CATEGORY', codes: inactive };
  return { kind: 'CONFIRM' };
}

export type ConfirmOutcome =
  | { readonly kind: 'CONFIRMED'; readonly transaction: Transaction; readonly replayed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<ConfirmPlan, { kind: 'CONFIRM' } | { kind: 'ALREADY_CONFIRMED' }>;

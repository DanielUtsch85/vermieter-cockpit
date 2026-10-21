import { Money, type AuditActor } from '../../shared/index.js';
import type { Direction, TransactionId, TransactionStatus, VersionConflict } from './transaction.js';

/**
 * TransactionSplit (data-model.md §18, api-design.md §33): the economically
 * distinct components of one Transaction, e.g. a loan payment split into
 * interest and principal. Splits are non-negative and inherit the
 * Transaction's direction; their sum equals the Transaction amount exactly —
 * no rounding tolerance.
 */

/** One split as requested: validated Money, a category code and optional references. */
export interface SplitInput {
  readonly amount: Money;
  readonly financialCategoryCode: string;
  readonly propertyReferenceId: string | null;
  readonly description: string | null;
}

export interface TransactionSplit extends SplitInput {
  readonly id: string;
  /** 1-based, in request order. */
  readonly position: number;
}

/** States whose split proposal may still change (domain-model.md §21); later ones are frozen. */
export const SPLITTABLE_STATUSES = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'] as const satisfies readonly TransactionStatus[];

export type SplitPlan =
  /** A valid, complete split set: the Transaction becomes CLASSIFIED. */
  | { readonly kind: 'APPLY'; readonly nextStatus: 'CLASSIFIED' }
  /** CONFIRMED and later are frozen (correct via reversal, ADR-037); IGNORED is out of the ledger. */
  | { readonly kind: 'FROZEN'; readonly status: TransactionStatus }
  | { readonly kind: 'CURRENCY_MISMATCH'; readonly positions: readonly number[] }
  | { readonly kind: 'SUM_MISMATCH'; readonly expected: Money; readonly actual: Money };

/**
 * Checks a full replacement split set against its Transaction, in this order:
 * frozen status, currency (no FX, §17.7), exact sum (§18).
 */
export function planSplits(
  transaction: { readonly amount: Money; readonly status: TransactionStatus },
  splits: readonly SplitInput[],
): SplitPlan {
  if (!(SPLITTABLE_STATUSES as readonly TransactionStatus[]).includes(transaction.status)) {
    return { kind: 'FROZEN', status: transaction.status };
  }
  const currency = transaction.amount.currency;
  const foreign = splits.flatMap((split, i) => (split.amount.currency === currency ? [] : [i + 1]));
  if (foreign.length > 0) return { kind: 'CURRENCY_MISMATCH', positions: foreign };
  const actual = Money.sum(
    splits.map((s) => s.amount),
    currency,
  );
  if (!actual.equals(transaction.amount)) return { kind: 'SUM_MISMATCH', expected: transaction.amount, actual };
  return { kind: 'APPLY', nextStatus: 'CLASSIFIED' };
}

/** Whether a replacement would change nothing (same splits in the same order): then no new version, no AuditRecord. */
export function sameSplits(current: readonly SplitInput[], next: readonly SplitInput[]): boolean {
  return (
    current.length === next.length &&
    current.every((c, i) => {
      const n = next[i];
      return (
        n !== undefined &&
        c.amount.equals(n.amount) &&
        c.financialCategoryCode === n.financialCategoryCode &&
        c.propertyReferenceId === n.propertyReferenceId &&
        c.description === n.description
      );
    })
  );
}

/** The Transaction as far as a split response needs it. */
export interface SplitTransaction {
  readonly id: TransactionId;
  readonly amount: Money;
  readonly direction: Direction;
  readonly status: TransactionStatus;
  readonly version: number;
}

export type ReplaceSplitsOutcome =
  | {
      readonly kind: 'REPLACED';
      readonly transaction: SplitTransaction;
      readonly splits: readonly TransactionSplit[];
      /** false when the request repeated the current split set (naturally idempotent, §33.1). */
      readonly changed: boolean;
    }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict
  | Exclude<SplitPlan, { kind: 'APPLY' }>
  /** Unknown or inactive category codes. */
  | { readonly kind: 'UNKNOWN_CATEGORY'; readonly codes: readonly string[] }
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND'; readonly propertyReferenceIds: readonly string[] };

/** Persistence port, implemented in infrastructure/postgres. */
export interface TransactionSplitRepository {
  /**
   * In one transaction, under the Transaction's row lock: applies `planSplits`,
   * resolves categories and PropertyReferences in the Realm, replaces the split
   * set atomically, sets the status and version and writes the AuditRecord.
   */
  replaceSplits(
    transactionId: string,
    mreRealmId: string,
    splits: readonly SplitInput[],
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ReplaceSplitsOutcome>;
}

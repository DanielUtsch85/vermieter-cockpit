import { businessDayOf } from '../ledger/index.js';

/**
 * The kinds of `ATTRIBUTION_INPUT_CHANGED` and the one rule that judges them (api-design.md §58E Part 1; §58H Part 1:
 * `LOAN_CLOSED`; §58I Part 1: `DEPOSIT_REOPENED`, `DEPOSIT_CLOSED`, whose items may name no year).
 */

export const CHANGE_KINDS = [
  'RENT_DUE_DAYS_AMENDED',
  'RENT_DUE_DAYS_CREATED',
  'RECONCILIATION_CONFIRMED',
  'RECONCILIATION_RELEASED',
  'LOAN_TERMS_ADDED',
  'LOAN_TERMS_VOIDED',
  'LOAN_CLOSED',
  'DEPOSIT_REOPENED',
  'DEPOSIT_CLOSED',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export type ChangeEntityType = 'RentalContractReference' | 'RentPaymentReconciliation' | 'LoanTerms' | 'Loan' | 'SecurityDeposit';

/** §58I Part 1: a deposit kind's items are deposit closings, every other year kind's are splits (Frage 3: the kind tells). */
export const DEPOSIT_YEAR_KINDS: readonly ChangeKind[] = ['DEPOSIT_REOPENED', 'DEPOSIT_CLOSED'];
export const isDepositYearKind = (kind: string) => (DEPOSIT_YEAR_KINDS as readonly string[]).includes(kind);

export interface ChangeItem {
  readonly sourceId: string;
  /** `null`: in no year (§58I Part 1, a deposit kind only; Entscheidung des Projektinhabers, 2026-11-03, Frage 1). */
  readonly yearBefore: number | null;
  readonly yearAfter: number | null;
}

/** A change before its fingerprint: the kind, the entity, the record and the items it moves into or out of the year. */
export interface RawChange {
  readonly kind: ChangeKind;
  readonly entityType: ChangeEntityType;
  readonly entityId: string;
  readonly auditRecordId: string;
  /** The record's `occurred_at`, for every kind (§58E: the key does not change). */
  readonly amendedAt: Date;
  /** The kind's own keys (§58E Part 1, "The flag, additively"). */
  readonly keys: Readonly<Record<string, unknown>>;
  readonly items: readonly ChangeItem[];
}

export interface InconsistentHistory {
  readonly entityType: ChangeEntityType;
  readonly entityId: string;
}

/** The 31-December rule (review on #168): only a record made after the year's end can have changed a filed return. */
export const recordedAfter = (occurredAt: Date, year: number) => businessDayOf(occurredAt) > `${String(year).padStart(4, '0')}-12-31`;

/** The items a change moves into or out of `year`: the two years differ (`null` a value of its own) and one of them is `year`. */
export function movedItems<C extends { readonly sourceId: string }>(
  candidates: readonly C[],
  year: number,
  yearUnder: (candidate: C, side: 'BEFORE' | 'AFTER') => number | null,
): ChangeItem[] {
  return candidates.flatMap((c) => {
    const [yearBefore, yearAfter] = [yearUnder(c, 'BEFORE'), yearUnder(c, 'AFTER')];
    return yearBefore !== yearAfter && (yearBefore === year || yearAfter === year) ? [{ sourceId: c.sourceId, yearBefore, yearAfter }] : [];
  });
}

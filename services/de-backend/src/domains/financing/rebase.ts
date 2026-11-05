import type { BusinessDate } from '../../shared/index.js';
import type { CountedSplit } from './debt.js';
import type { Loan } from './loan.js';
import { nearestEntry } from './payment-proposal.js';
import { loanPlan, planOf, toCents, type AppliedRestart, type PlanRestart, type SchedulePeriod, type WalkedPlan } from './terms.js';

/**
 * The plan reconciled with the real bookings (api-design.md §58O open question 12 (b) and (c); Entscheidung des
 * Projektinhabers, 2026-11-05, question 12): the simple rule stays (a full interval on every entry), and every booked
 * payment re-anchors the plan on the actual remaining debt (§41.6's `actual`) on its booking date. A regular debit (one
 * with a `LOAN_INTEREST` split) is matched to its nearest entry of the contract plan (§41.5's `nearestEntry`) and counts
 * as that entry paid, so the plan restarts with the entry after it; a principal-only payment (a special repayment)
 * matches no entry and restarts the plan with the first entry after its booking date. Entries before the first restart
 * are the contract's; each later one follows the restart before it, so a payment booked as the rebased plan says is no
 * deviation. Financing's reads (schedule, remaining debt, `fixedRateEnd`, the proposal) read this plan; Taxation keeps
 * reading the contract plan (`loanSchedule`), so no due date, no §58L period and no tax figure moves by it.
 */

/** Informative (§58O (c)): a booked payment whose split differs from its matched entry's, on that entry only. */
export interface BookedSplitDeviation {
  readonly code: 'BOOKED_SPLIT_DIFFERS_FROM_PLAN';
  readonly transactionId: string;
  /** Cents. */
  readonly booked: { readonly interest: bigint; readonly principal: bigint };
  readonly planned: { readonly interest: bigint; readonly principal: bigint };
}

/** Where the plan was last re-anchored (`rebasedOn`): the entries after `entryNumber` start from `actualBalance`. */
export interface RebasedOn {
  readonly bookingDate: BusinessDate;
  /** The number of the last entry before the rebased ones (the matched entry of a regular debit); 0 before the first. */
  readonly entryNumber: number;
  /** Cents. */
  readonly actualBalance: bigint;
  readonly transactionId: string;
  /** `BOOKED_SPLIT_DIFFERS_FROM_PLAN` of the payment that re-anchored the plan, if any. */
  readonly flags: readonly BookedSplitDeviation[];
}

export interface ReconciledPlan {
  /** The rebased plan, cut at a `CLOSED` Loan's closing (§41.7). */
  readonly plan: WalkedPlan;
  /** The same plan uncut (its `endReason` decides `MATURITY` for `planned`, as the contract's does today). */
  readonly uncut: WalkedPlan;
  /** The plan as contracted, cut and uncut. */
  readonly contract: WalkedPlan;
  readonly contractUncut: WalkedPlan;
  /** Every restart the walk applied, by booking date. */
  readonly rebases: readonly RebasedOn[];
  /** `BOOKED_SPLIT_DIFFERS_FROM_PLAN` by entry number. */
  readonly deviations: ReadonlyMap<number, readonly BookedSplitDeviation[]>;
}

interface BookedPayment {
  readonly transactionId: string;
  readonly bookingDate: BusinessDate;
  readonly interest: bigint;
  readonly principal: bigint;
  readonly regular: boolean;
}

/** The counted splits per Transaction, by booking date, then Transaction. */
function bookedPayments(splits: readonly CountedSplit[]): BookedPayment[] {
  const byTransaction = new Map<string, { bookingDate: BusinessDate; interest: bigint; principal: bigint; regular: boolean }>();
  for (const s of splits) {
    const seen = byTransaction.get(s.transactionId) ?? { bookingDate: s.bookingDate, interest: 0n, principal: 0n, regular: false };
    if (s.category === 'LOAN_INTEREST') {
      seen.interest += s.amount;
      seen.regular = true;
    } else seen.principal += s.amount;
    byTransaction.set(s.transactionId, seen);
  }
  return [...byTransaction.entries()]
    .map(([transactionId, p]) => ({ transactionId, ...p }))
    .sort((x, y) => (x.bookingDate !== y.bookingDate ? (x.bookingDate < y.bookingDate ? -1 : 1) : x.transactionId < y.transactionId ? -1 : 1));
}

/** The actual remaining debt after `day`'s bookings, never below 0 for the plan. */
function actualAfter(loan: Pick<Loan, 'principalOriginal'>, splits: readonly CountedSplit[], day: BusinessDate): bigint {
  const paid = splits.reduce((sum, s) => (s.category === 'LOAN_PRINCIPAL' && s.bookingDate <= day ? sum + s.amount : sum), 0n);
  const actual = toCents(loan.principalOriginal) - paid;
  return actual > 0n ? actual : 0n;
}

/** §58O question 12 (b), (c): the plan re-anchored by the Loan's counted splits (§41.5), from one snapshot. */
export function reconciledPlan(
  loan: Pick<Loan, 'principalOriginal' | 'maturityDate' | 'status' | 'closingDate'>,
  periods: readonly SchedulePeriod[],
  splits: readonly CountedSplit[],
): ReconciledPlan {
  const contract = loanPlan(loan, periods);
  const contractUncut = planOf(loan.principalOriginal, loan.maturityDate, periods);
  const entries = contract.schedule.entries;
  const restarts: (PlanRestart & { readonly payment: BookedPayment; readonly matched: number | null })[] = [];
  if (entries.length > 0) {
    for (const payment of bookedPayments(splits)) {
      const matched = payment.regular ? (nearestEntry(entries, payment.bookingDate)?.number ?? null) : null;
      // A regular debit counts as its matched entry paid; a special repayment as every entry up to its booking date.
      const index = matched ?? entries.filter((e) => e.paymentDate <= payment.bookingDate).length;
      // A later booking re-anchors from its own entry on: restarts at or after it are superseded.
      while (restarts.length > 0 && (restarts.at(-1) as PlanRestart).index >= index) restarts.pop();
      restarts.push({ index, balance: actualAfter(loan, splits, payment.bookingDate), bookingDate: payment.bookingDate, payment, matched });
    }
  }
  if (restarts.length === 0) return { plan: contract, uncut: contractUncut, contract, contractUncut, rebases: [], deviations: new Map() };
  const plan = loanPlan(loan, periods, restarts);
  const uncut = planOf(loan.principalOriginal, loan.maturityDate, periods, restarts);
  const deviations = new Map<number, BookedSplitDeviation[]>();
  const flagsOf = new Map<string, BookedSplitDeviation[]>();
  for (const payment of bookedPayments(splits)) {
    if (!payment.regular) continue;
    const number = nearestEntry(entries, payment.bookingDate)?.number;
    const entry = number === undefined ? undefined : plan.schedule.entries[number - 1];
    if (entry === undefined || (entry.interest === payment.interest && entry.principal === payment.principal)) continue;
    const flag: BookedSplitDeviation = {
      code: 'BOOKED_SPLIT_DIFFERS_FROM_PLAN',
      transactionId: payment.transactionId,
      booked: { interest: payment.interest, principal: payment.principal },
      planned: { interest: entry.interest, principal: entry.principal },
    };
    deviations.set(entry.number, [...(deviations.get(entry.number) ?? []), flag]);
    flagsOf.set(payment.transactionId, [flag]);
  }
  const rebases = uncut.applied.map((a: AppliedRestart, i) => {
    const restart = restarts[i] as (typeof restarts)[number];
    return {
      bookingDate: a.bookingDate,
      entryNumber: a.index,
      actualBalance: a.balance,
      transactionId: restart.payment.transactionId,
      flags: flagsOf.get(restart.payment.transactionId) ?? [],
    };
  });
  return { plan, uncut, contract, contractUncut, rebases, deviations };
}

/** The last re-anchoring booked on or before `day` (`null` before the first booked payment). */
export function rebasedOnDay(reconciled: ReconciledPlan, day: BusinessDate): RebasedOn | null {
  return reconciled.rebases.filter((r) => r.bookingDate <= day).at(-1) ?? null;
}

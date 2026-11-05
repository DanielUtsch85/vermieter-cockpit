import { addDays, addMonths, type AuditActor, type BusinessDate, type Money, type VersionConflict } from '../../shared/index.js';
import { debtFrom, type Loan, type LoanStatus } from './loan.js';
import type { CountedSplit } from './debt.js';
import type { ProposalTransaction } from './payment-proposal.js';

/**
 * Loan terms (data-model.md §22, api-design.md §41.2, backlog VC-3-02): the Loan's conditions as periods, appended
 * after the last one, never edited, only the last one voidable (phase-3-plan P3-D2). The schedule is derived from them
 * on read, never stored (P3-D5): a payment every `paymentIntervalMonths` months from `firstPaymentDate` (§58O, VC-X-53:
 * 1, 3, 6 or 12; 1 is monthly, as before), interest `round_half_up(balance × rate × months / 100 / 12)` to the cent
 * (30/360), exact in cents and thousandths of a percent.
 */

export type LoanTermsId = string & { readonly __brand: 'LoanTermsId' };

export const REPAYMENT_MODELS = ['ANNUITY', 'INTEREST_ONLY'] as const;
export type RepaymentModel = (typeof REPAYMENT_MODELS)[number];

export const TERMS_STATUSES = ['VALID', 'VOID'] as const;
export type TermsStatus = (typeof TERMS_STATUSES)[number];

/** §58O rule 1 (Entscheidung des Projektinhabers, 2026-11-05, question 1): monthly, quarterly, half-yearly, yearly. */
export const PAYMENT_INTERVALS = [1, 3, 6, 12] as const;
export type PaymentIntervalMonths = (typeof PAYMENT_INTERVALS)[number];

/** A rate in percent p.a. with at most three decimals, as thousandths of a percent ("3.450" → 3450n). */
export type RateMilli = bigint;

export interface LoanTermsData {
  readonly validFrom: BusinessDate;
  /** Percent p.a., `0 ≤ r < 100`, three decimals. */
  readonly interestRate: RateMilli;
  readonly repaymentModel: RepaymentModel;
  /** As on the contract; exactly for `ANNUITY`. */
  readonly scheduledPayment: Money | null;
  readonly firstPaymentDate: BusinessDate;
  /** Restarts the plan's balance; not on the first period, never above `principalOriginal`. */
  readonly principalAtStart: Money | null;
  readonly fixedRateUntil: BusinessDate | null;
  readonly initialRepaymentRate: RateMilli | null;
  readonly specialRepaymentLimit: Money | null;
  readonly notes: string | null;
  /** §58O: the months between two planned payments of the period; 1 for every period stored before VC-X-53. */
  readonly paymentIntervalMonths: PaymentIntervalMonths;
}

export interface LoanTerms extends LoanTermsData {
  readonly id: LoanTermsId;
  readonly loanId: string;
  readonly mreRealmId: string;
  readonly status: TermsStatus;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A period with its derived end: the day before the next `VALID` period's `validFrom`, `null` for the last. */
export interface LoanTermsView extends LoanTerms {
  readonly validUntil: BusinessDate | null;
}

const RATE = /^(\d{1,2})(?:\.(\d{1,3}))?$/;

/** `"3.45"` → 3450n; undefined when not a decimal with at most three decimals in `[0, 100)`. */
export function parseRate(value: string): RateMilli | undefined {
  const match = RATE.exec(value);
  if (match === null) return undefined;
  return BigInt(match[1] as string) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0'));
}

/** 3450n → `"3.450"`. */
export function formatRate(rate: RateMilli): string {
  return `${rate / 1000n}.${(rate % 1000n).toString().padStart(3, '0')}`;
}

/** Cents of a two-decimal EUR amount. */
export function toCents(money: Money): bigint {
  const [whole = '0', fraction = ''] = money.amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

/**
 * The interest of `months` months on `balance` cents (§58O rule 4): `round_half_up(balance × rate × months / 100 / 12)`
 * in one rounding, rate in thousandths of a percent.
 */
export function periodInterest(balance: bigint, rate: RateMilli, months: number): bigint {
  const numerator = balance * rate * BigInt(months);
  const denominator = 1_200_000n; // 100 (percent) × 1000 (thousandths) × 12 (months)
  return (2n * numerator + denominator) / (2n * denominator);
}

/** One month's interest on `balance` cents: `periodInterest` with one month. */
export function monthlyInterest(balance: bigint, rate: RateMilli): bigint {
  return periodInterest(balance, rate, 1);
}

export interface ScheduleEntry {
  readonly termsId: string;
  readonly paymentDate: BusinessDate;
  /** Cents. */
  readonly balanceBefore: bigint;
  readonly interest: bigint;
  readonly principal: bigint;
  readonly payment: bigint;
  readonly balanceAfter: bigint;
}

/** The 50-year cap of P3-D5: 600 months of intervals (§58O rule 3; 600 monthly, 200 quarterly, 50 yearly payments). */
export const MAX_PAYMENTS = 600;

/** A `VALID` period as the schedule reads it. */
export type SchedulePeriod = Pick<
  LoanTerms,
  | 'id'
  | 'validFrom'
  | 'interestRate'
  | 'repaymentModel'
  | 'scheduledPayment'
  | 'firstPaymentDate'
  | 'principalAtStart'
  | 'fixedRateUntil'
  | 'paymentIntervalMonths'
>;

/**
 * A re-anchoring of the plan on the actual remaining debt (§58O question 12 (b)): the entry at `index` (from 0) and every
 * later one start from `balance`. Applied in `index` order; one whose entry the plan does not reach (it ended at 0
 * before) applies where the plan ended.
 */
export interface PlanRestart {
  readonly index: number;
  /** Cents, ≥ 0. */
  readonly balance: bigint;
  /** The last booked payment's date the balance is the actual remaining debt on. */
  readonly bookingDate: BusinessDate;
}

/** A restart as the walk applied it: `index` is where it took effect (earlier than asked where the plan had ended). */
export interface AppliedRestart extends PlanRestart {
  readonly requestedIndex: number;
}

/**
 * The planned payments (P3-D5), periods in `validFrom` order. A period's k-th payment falls on `addMonths(firstPaymentDate,
 * k × paymentIntervalMonths)` (always from `firstPaymentDate`, clamped to the month's end; §58O rule 2) while before the
 * next period's `validFrom`, not after `maturityDate`, and while the balance is above zero; at most 600 months of
 * intervals in all (rule 3). A period's balance is its `principalAtStart`, else the balance carried over, the first one
 * `principalOriginal`.
 */
export function deriveSchedule(principalOriginal: Money, maturityDate: BusinessDate | null, periods: readonly SchedulePeriod[]): ScheduleEntry[] {
  return walkSchedule(principalOriginal, maturityDate, periods).entries;
}

/**
 * The derivation itself, with what `scheduleOf` needs besides the entries: the balance at the end, and the date the
 * last period's next payment would have fallen on (null without periods).
 */
function walkSchedule(
  principalOriginal: Money,
  maturityDate: BusinessDate | null,
  periods: readonly SchedulePeriod[],
  restarts: readonly PlanRestart[] = [],
): {
  readonly entries: ScheduleEntry[];
  readonly balance: bigint;
  readonly nextPaymentDate: BusinessDate | null;
  readonly applied: readonly AppliedRestart[];
} {
  const entries: ScheduleEntry[] = [];
  let balance = toCents(principalOriginal);
  let nextPaymentDate: BusinessDate | null = null;
  let months = 0;
  const applied: AppliedRestart[] = [];
  // §58O (b): a restart reached by the entries, or one the plan ended before (it resumes from the actual debt).
  const restart = () => {
    for (let r = restarts[applied.length]; r !== undefined && (entries.length >= r.index || balance <= 0n); r = restarts[applied.length]) {
      balance = r.balance;
      applied.push({ ...r, index: entries.length, requestedIndex: r.index });
    }
  };
  periods.forEach((period, i) => {
    if (period.principalAtStart !== null) balance = toCents(period.principalAtStart);
    const next = periods[i + 1]?.validFrom ?? null;
    const n = period.paymentIntervalMonths;
    let k = 0;
    for (; ; k++) {
      restart();
      if (balance <= 0n || months + n > MAX_PAYMENTS) break;
      const paymentDate = addMonths(period.firstPaymentDate, k * n);
      if ((next !== null && paymentDate >= next) || (maturityDate !== null && paymentDate > maturityDate)) break;
      const interest = periodInterest(balance, period.interestRate, n);
      const principal =
        period.repaymentModel === 'ANNUITY' && period.scheduledPayment !== null ? minBig(maxBig(toCents(period.scheduledPayment) - interest, 0n), balance) : 0n;
      entries.push({
        termsId: period.id,
        paymentDate,
        balanceBefore: balance,
        interest,
        principal,
        payment: interest + principal,
        balanceAfter: balance - principal,
      });
      balance -= principal;
      months += n;
      // An interest-only period never repays: one payment per interval until the next period or maturity.
    }
    nextPaymentDate = addMonths(period.firstPaymentDate, k * n);
  });
  restart();
  return { entries, balance, nextPaymentDate, applied };
}

/**
 * How a plan ends (api-design §41.4); on a tie `PAID_OFF` before `MATURITY` before `PAYMENT_CAP` (review on #65).
 * `CLOSED`: a `CLOSED` Loan's plan cut at its closing date (§41.7).
 */
export const SCHEDULE_END_REASONS = ['PAID_OFF', 'MATURITY', 'PAYMENT_CAP', 'CLOSED', 'NO_TERMS'] as const;
export type ScheduleEndReason = (typeof SCHEDULE_END_REASONS)[number];

/** An entry with its position in the whole plan, from 1, kept in a window. */
export interface NumberedScheduleEntry extends ScheduleEntry {
  readonly number: number;
}

export interface ScheduleSummary {
  readonly payments: number;
  readonly firstPaymentDate: BusinessDate | null;
  readonly lastPaymentDate: BusinessDate | null;
  /** Cents. */
  readonly totalInterest: bigint;
  readonly totalPrincipal: bigint;
  /** The balance after the last payment, due on `maturityDate` for `MATURITY`. */
  readonly balanceDue: bigint;
  readonly endReason: ScheduleEndReason;
  /** The end of the fixed-rate period of the last period (#119); null when it states none. */
  readonly fixedRateEnd: FixedRateEnd | null;
}

/**
 * The balance at the end of the fixed-rate period (Restschuld nach Zinsbindung, #119): the planned remaining debt of
 * §41.6 on `fixedRateUntil`, i.e. after every payment on or before it. The plan itself does not change at that date.
 */
export interface FixedRateEnd {
  readonly date: BusinessDate;
  /** Cents. */
  readonly balance: bigint;
}

export interface Schedule {
  readonly entries: readonly NumberedScheduleEntry[];
  readonly summary: ScheduleSummary;
}

/** A plan with the restarts the walk applied, and its planned balance before a date (§41.6). */
export interface WalkedPlan {
  readonly schedule: Schedule;
  readonly applied: readonly AppliedRestart[];
  /**
   * The balance a period starting on `date` would start from: after every payment before `date`, a period's
   * `principalAtStart` restarting it; from the last restart booked before `date` on, its actual balance and the entries
   * from its index (a follow-up period's `principalAtStart` still restarts entries at or after it, as in the walk).
   */
  readonly plannedBefore: (date: BusinessDate) => bigint;
}

/**
 * The whole plan of §41.4 with its summary. A follow-up period that starts after the plan reached 0 and states no
 * `principalAtStart` has no payments, and the plan stays `PAID_OFF` (review on #65).
 */
export function scheduleOf(principalOriginal: Money, maturityDate: BusinessDate | null, periods: readonly SchedulePeriod[]): Schedule {
  return planOf(principalOriginal, maturityDate, periods).schedule;
}

/** `scheduleOf` re-anchored by `restarts` (§58O question 12 (b)); without restarts the contract plan. */
export function planOf(
  principalOriginal: Money,
  maturityDate: BusinessDate | null,
  periods: readonly SchedulePeriod[],
  restarts: readonly PlanRestart[] = [],
): WalkedPlan {
  const { entries, balance, nextPaymentDate, applied } = walkSchedule(principalOriginal, maturityDate, periods, restarts);
  const plannedBefore = (date: BusinessDate) => plannedFromWalk(principalOriginal, periods, entries, applied, date);
  const endReason: ScheduleEndReason =
    periods.length === 0
      ? 'NO_TERMS'
      : balance === 0n
        ? 'PAID_OFF'
        : maturityDate !== null && nextPaymentDate !== null && nextPaymentDate > maturityDate
          ? 'MATURITY'
          : 'PAYMENT_CAP';
  const schedule: Schedule = {
    entries: entries.map((entry, i) => ({ ...entry, number: i + 1 })),
    summary: {
      payments: entries.length,
      firstPaymentDate: entries[0]?.paymentDate ?? null,
      lastPaymentDate: entries.at(-1)?.paymentDate ?? null,
      totalInterest: entries.reduce((sum, e) => sum + e.interest, 0n),
      totalPrincipal: entries.reduce((sum, e) => sum + e.principal, 0n),
      balanceDue: balance,
      endReason,
      fixedRateEnd: fixedRateEndOf(maturityDate, periods, endReason, plannedBefore),
    },
  };
  return { schedule, applied, plannedBefore };
}

/** As `debtOn`'s `planned` (§41.6): with `MATURITY` 0 from `maturityDate` on, else the balance after the day's payments. */
function fixedRateEndOf(
  maturityDate: BusinessDate | null,
  periods: readonly SchedulePeriod[],
  endReason: ScheduleEndReason,
  plannedBefore: (date: BusinessDate) => bigint,
): FixedRateEnd | null {
  const date = periods.at(-1)?.fixedRateUntil ?? null;
  if (date === null) return null;
  const matured = endReason === 'MATURITY' && maturityDate !== null && date >= maturityDate;
  return { date, balance: matured ? 0n : plannedBefore(addDays(date, 1)) };
}

/** `WalkedPlan.plannedBefore`; without an applied restart before `date` exactly the contract's `plannedBalanceOn`. */
function plannedFromWalk(
  principalOriginal: Money,
  periods: readonly SchedulePeriod[],
  entries: readonly ScheduleEntry[],
  applied: readonly AppliedRestart[],
  date: BusinessDate,
): bigint {
  const restart = applied.filter((r) => r.bookingDate < date).at(-1);
  let balance = restart?.balance ?? toCents(principalOriginal);
  const from = restart?.index ?? 0;
  let first = 0;
  for (const period of periods) {
    if (period.validFrom >= date) break;
    if (period.principalAtStart !== null && (restart === undefined || first >= restart.index)) balance = toCents(period.principalAtStart);
    entries.forEach((entry, i) => {
      if (entry.termsId === period.id && i >= from && entry.paymentDate < date) balance = entry.balanceAfter;
    });
    first += entries.filter((e) => e.termsId === period.id).length;
  }
  return balance;
}

/**
 * A `CLOSED` Loan's plan (§41.7): the entries after `closingDate` omitted, the summary over the rest, `endReason =
 * CLOSED` when an entry was omitted; a plan that ended on or before the closing keeps its reason.
 */
export function closedSchedule(schedule: Schedule, closingDate: BusinessDate): Schedule {
  const kept = schedule.entries.filter((e) => e.paymentDate <= closingDate);
  const omitted = schedule.entries[kept.length];
  if (omitted === undefined) return schedule;
  const { fixedRateEnd } = schedule.summary;
  return {
    entries: kept,
    summary: {
      payments: kept.length,
      firstPaymentDate: kept[0]?.paymentDate ?? null,
      lastPaymentDate: kept.at(-1)?.paymentDate ?? null,
      totalInterest: kept.reduce((sum, e) => sum + e.interest, 0n),
      totalPrincipal: kept.reduce((sum, e) => sum + e.principal, 0n),
      balanceDue: omitted.balanceBefore,
      endReason: 'CLOSED',
      // §41.7: nothing is owed after the closing date.
      fixedRateEnd: fixedRateEnd === null || fixedRateEnd.date <= closingDate ? fixedRateEnd : { date: fixedRateEnd.date, balance: 0n },
    },
  };
}

/**
 * The Loan's plan as contracted (§41.4): `scheduleOf`, cut at the closing date of a `CLOSED` Loan (§41.7). Taxation's
 * due dates and §58L's periods read this one, never the rebased plan (§58O question 12 (b)).
 */
export function loanSchedule(loan: Pick<Loan, 'principalOriginal' | 'maturityDate' | 'status' | 'closingDate'>, periods: readonly SchedulePeriod[]): Schedule {
  return loanPlan(loan, periods).schedule;
}

/** `planOf` with the restarts, the schedule cut at the closing date of a `CLOSED` Loan (§41.7). */
export function loanPlan(
  loan: Pick<Loan, 'principalOriginal' | 'maturityDate' | 'status' | 'closingDate'>,
  periods: readonly SchedulePeriod[],
  restarts: readonly PlanRestart[] = [],
): WalkedPlan {
  const plan = planOf(loan.principalOriginal, loan.maturityDate, periods, restarts);
  return loan.status === 'CLOSED' && loan.closingDate !== null ? { ...plan, schedule: closedSchedule(plan.schedule, loan.closingDate) } : plan;
}

/** The interval of the plan's first entry's period (§58O rule 8: the first entry's interest period); 1 without one. */
export function firstIntervalOf(schedule: Schedule, periods: readonly SchedulePeriod[]): number {
  const first = schedule.entries[0];
  return first === undefined ? 1 : (periods.find((p) => p.id === first.termsId)?.paymentIntervalMonths ?? 1);
}

/** The entries with `paymentDate` in `[from, to]`, both optional and inclusive; numbers and summary unchanged. */
export function scheduleWindow(schedule: Schedule, from?: BusinessDate, to?: BusinessDate): Schedule {
  return { ...schedule, entries: schedule.entries.filter((e) => (from === undefined || e.paymentDate >= from) && (to === undefined || e.paymentDate <= to)) };
}

/**
 * The planned balance on `date`: the balance a period starting that day would start from. Walks the periods that
 * began before `date`: a period's `principalAtStart` restarts the balance, its payments before `date` lower it.
 */
export function plannedBalanceOn(principalOriginal: Money, maturityDate: BusinessDate | null, periods: readonly SchedulePeriod[], date: BusinessDate): bigint {
  return planOf(principalOriginal, maturityDate, periods).plannedBefore(date);
}

const minBig = (x: bigint, y: bigint) => (x < y ? x : y);
const maxBig = (x: bigint, y: bigint) => (x > y ? x : y);

/**
 * The derived `validUntil` of each period (or allocation set, §41.3), over the `VALID` ones only; `VOID` ones get the
 * end they would have.
 */
export function withValidUntil<T extends { readonly status: TermsStatus; readonly validFrom: BusinessDate }>(
  items: readonly T[],
): (T & { readonly validUntil: BusinessDate | null })[] {
  const valid = items
    .filter((t) => t.status === 'VALID')
    .map((t) => t.validFrom)
    .sort();
  return items.map((t) => {
    const next = valid.find((from) => from > t.validFrom);
    return { ...t, validUntil: next === undefined ? null : addDays(next, -1) };
  });
}

/** Identity of a create request for `Idempotency-Key` replays: the Loan and the normalized payload. */
export function termsFingerprint(loanId: string, terms: LoanTermsData): string {
  return JSON.stringify([
    loanId,
    terms.validFrom,
    terms.interestRate.toString(),
    terms.repaymentModel,
    terms.scheduledPayment?.amount ?? null,
    terms.firstPaymentDate,
    terms.principalAtStart?.amount ?? null,
    terms.fixedRateUntil,
    terms.initialRepaymentRate?.toString() ?? null,
    terms.specialRepaymentLimit?.amount ?? null,
    terms.notes,
    // §58O: only when not 1, so a key stored before VC-X-53 replays (an omitted key and an explicit 1 are one request).
    ...(terms.paymentIntervalMonths === 1 ? [] : [terms.paymentIntervalMonths]),
  ]);
}

export type AppendRefusal =
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  | { readonly kind: 'TERMS_BEFORE_DEBT'; readonly debtFrom: BusinessDate }
  | { readonly kind: 'TERMS_NOT_APPENDED'; readonly lastValidFrom: BusinessDate }
  | { readonly kind: 'PREVIOUS_TERMS_WITHOUT_PAYMENT'; readonly termsId: string; readonly firstPaymentDate: BusinessDate }
  | { readonly kind: 'PRINCIPAL_AT_START_ON_FIRST_TERMS' }
  | { readonly kind: 'PRINCIPAL_AT_START_EXCEEDS_ORIGINAL'; readonly principalOriginal: Money }
  | { readonly kind: 'PAYMENT_DOES_NOT_COVER_INTEREST'; readonly firstInterest: bigint; readonly balance: bigint };

/** Checks 3–7 of §41.2 against the Loan and its `VALID` periods (in `validFrom` order); undefined when the period may be appended. */
export function checkAppend(loan: Loan, valid: readonly LoanTerms[], terms: LoanTermsData): AppendRefusal | undefined {
  if (loan.status !== 'ACTIVE') return { kind: 'LOAN_NOT_ACTIVE', status: loan.status };
  const from = debtFrom(loan);
  if (terms.validFrom < from) return { kind: 'TERMS_BEFORE_DEBT', debtFrom: from };
  const last = valid.at(-1);
  if (last !== undefined && terms.validFrom <= last.validFrom) return { kind: 'TERMS_NOT_APPENDED', lastValidFrom: last.validFrom };
  if (last !== undefined && terms.validFrom <= last.firstPaymentDate) {
    return { kind: 'PREVIOUS_TERMS_WITHOUT_PAYMENT', termsId: last.id, firstPaymentDate: last.firstPaymentDate };
  }
  if (terms.principalAtStart !== null) {
    if (last === undefined) return { kind: 'PRINCIPAL_AT_START_ON_FIRST_TERMS' };
    if (toCents(terms.principalAtStart) > toCents(loan.principalOriginal))
      return { kind: 'PRINCIPAL_AT_START_EXCEEDS_ORIGINAL', principalOriginal: loan.principalOriginal };
  }
  if (terms.repaymentModel === 'ANNUITY' && terms.scheduledPayment !== null) {
    const balance =
      terms.principalAtStart !== null ? toCents(terms.principalAtStart) : plannedBalanceOn(loan.principalOriginal, loan.maturityDate, valid, terms.validFrom);
    // §58O rule 6: the first entry's interest over the period's interval.
    const firstInterest = periodInterest(balance, terms.interestRate, terms.paymentIntervalMonths);
    if (toCents(terms.scheduledPayment) <= firstInterest) return { kind: 'PAYMENT_DOES_NOT_COVER_INTEREST', firstInterest, balance };
  }
  return undefined;
}

export type VoidTermsPlan =
  | { readonly kind: 'VOID'; readonly next: LoanTerms }
  /** Already void: a 200 no-op whatever the reason or version; the first reason and time stay. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  /** Only the last `VALID` period is voidable (→ 409 TERMS_NOT_LAST). */
  | { readonly kind: 'TERMS_NOT_LAST'; readonly laterTermsId: string };

export function planVoidTerms(loan: Loan, current: LoanTerms, valid: readonly LoanTerms[], reason: string, at: Date): VoidTermsPlan {
  if (current.status === 'VOID') return { kind: 'UNCHANGED' };
  if (loan.status !== 'ACTIVE') return { kind: 'LOAN_NOT_ACTIVE', status: loan.status };
  const later = valid.find((t) => t.validFrom > current.validFrom);
  if (later !== undefined) return { kind: 'TERMS_NOT_LAST', laterTermsId: later.id };
  return { kind: 'VOID', next: { ...current, status: 'VOID', voidedAt: at, voidReason: reason, version: current.version + 1 } };
}

export type CreateTermsOutcome =
  | { readonly kind: 'CREATED'; readonly terms: LoanTermsView }
  | { readonly kind: 'REPLAYED'; readonly terms: LoanTermsView }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'LOAN_NOT_FOUND' }
  | AppendRefusal;

export type VoidTermsOutcome =
  | { readonly kind: 'VOIDED'; readonly terms: LoanTermsView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<VoidTermsPlan, { kind: 'VOID' | 'UNCHANGED' }>
  | VersionConflict;

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface LoanTermsRepository {
  /** The Loan `FOR UPDATE`, then its `VALID` periods, then `checkAppend`; claims the key in the same transaction. */
  create(
    loanId: string,
    mreRealmId: string,
    terms: LoanTermsData,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateTermsOutcome>;
  /** The Loan `FOR UPDATE`, then the period and the `VALID` periods, then `planVoidTerms`. */
  void(
    loanId: string,
    termsId: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidTermsOutcome>;
  /** The Loan's periods in `validFrom`, then `createdAt` order, with `validUntil`; undefined for an unknown or foreign Loan. */
  list(loanId: string, mreRealmId: string, status?: TermsStatus): Promise<readonly LoanTermsView[] | undefined>;
  /**
   * The Loan, its `VALID` periods in `validFrom` order and its counted splits (§41.5, for §58O's rebase), in one snapshot
   * (§41.4); undefined for an unknown or foreign Loan.
   */
  scheduleInputs(
    loanId: string,
    mreRealmId: string,
  ): Promise<{ readonly loan: Loan; readonly periods: readonly LoanTerms[]; readonly splits: readonly CountedSplit[] } | undefined>;
  /** As `scheduleInputs`, with the Transaction of the Realm, in one snapshot (§41.5's proposal). */
  proposalInputs(
    loanId: string,
    transactionId: string,
    mreRealmId: string,
  ): Promise<
    | {
        readonly kind: 'FOUND';
        readonly loan: Loan;
        readonly periods: readonly LoanTerms[];
        readonly transaction: ProposalTransaction;
      }
    | { readonly kind: 'LOAN_NOT_FOUND' }
    | { readonly kind: 'TRANSACTION_NOT_FOUND' }
  >;
}

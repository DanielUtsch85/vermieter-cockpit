import { addDays, type BusinessDate } from '../../shared/index.js';
import { distributeSet, setOn, setShares, sumsToOne, type LoanAllocationSetView } from '../financing/index.js';
import { gcd, type Fraction } from '../ownership/index.js';
import { interestTiming } from './cash-timing.js';

/**
 * Loan interest by periods of use, not by the booking date (api-design.md §58L, VC-X-40; Entscheidung des
 * Projektinhabers, 2026-11-04, L1–L12; Prüfbericht 2026-11-01, Frage 22, mündlich bestätigt durch den Steuerberater,
 * laut Projektinhaber am 2026-11-01). Each interest split is distributed over its **interest period** by the allocation
 * sets valid on each calendar day of it (both ends inclusive, L5), in **one** `distribute` over the exact weights (L7);
 * a period with a day without a usable set leaves the whole split not attributed (L3). The payment still decides the
 * year (§58A): nothing here moves a split between years. One function for the view (`loanInterestOf`), the part change
 * (`partOn`, §58G, §58I Part 2) and §59E's capitalised sources, so they cannot drift.
 */

/** Where a split's interest period comes from: the Loan's schedule (§41.4) or the classification's recorded period (L4). */
export type InterestPeriodSource = 'LOAN_SCHEDULE' | 'CLASSIFICATION';

/** The days a split's interest pays for, both inclusive. */
export interface InterestPeriod {
  readonly from: BusinessDate;
  readonly until: BusinessDate;
  readonly source: InterestPeriodSource;
}

/**
 * What the period reads of the Loan: the day the debt starts (§41.1) and the contract schedule's payment dates (§41.4).
 * §58O (VC-X-53): the interval of the first entry's period (its period is that many months; 1 when absent), each
 * entry's terms period and interval (the deviation flag's details), and a `CLOSED` Loan's closing date (question 5).
 */
export interface LoanPeriodFacts {
  readonly debtFrom: BusinessDate;
  readonly paymentDates: readonly BusinessDate[];
  readonly firstIntervalMonths?: number;
  readonly entryTerms?: readonly { readonly termsId: string; readonly paymentIntervalMonths: number }[];
  readonly closingDate?: BusinessDate | null;
}

const dayNumber = (date: BusinessDate) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;

/** The calendar days from `from` to `until`, both inclusive (L5: taggenau, never 30/360). */
export const daysIn = (from: BusinessDate, until: BusinessDate): number => Math.round(dayNumber(until) - dayNumber(from)) + 1;

/**
 * The interest period of a split (rule 1): the recorded `interestPeriod` of its classification where one is given (L4,
 * for the allocation only; the 10-day rule keeps its own timing), else the schedule's `economicPeriod` of
 * `interestTiming` (§58A: the nearest entry, from the day after the previous one to its payment date), clipped at the
 * Loan's `debtFrom` (no interest accrues before the debt; §41.2 keeps every payment date on or after it, so the clip
 * never empties a period, and is clamped defensively). `null` without a schedule (rule 8, `NO_SCHEDULE`).
 */
export function interestPeriodOf(
  bookingDate: BusinessDate,
  recorded: { readonly from: BusinessDate; readonly until: BusinessDate } | null,
  loan: LoanPeriodFacts | undefined,
): InterestPeriod | null {
  const schedule = schedulePeriodOf(bookingDate, loan);
  if (recorded === null) return schedule;
  // §58O precedence case 3 (Entscheidung des Projektinhabers, 2026-11-05, question 11): a recorded period equal to the plan's is redundant.
  if (schedule !== null && recorded.from === schedule.from && recorded.until === schedule.until) return schedule;
  // §58P question 10 (Entscheidung des Projektinhabers, 2026-11-05): every other recorded period is used, also a closing
  // stub that `deviationOf` counts as matching the plan (§58O question 5: not flagged, but used).
  return { from: recorded.from, until: recorded.until, source: 'CLASSIFICATION' };
}

/** The schedule's period of a split (rule 1 without a recorded one); `null` without a schedule. */
export function schedulePeriodOf(bookingDate: BusinessDate, loan: LoanPeriodFacts | undefined): InterestPeriod | null {
  if (loan === undefined) return null;
  const timing = interestTiming(bookingDate, loan.paymentDates, loan.firstIntervalMonths ?? 1);
  if (timing.kind !== 'PERIOD') return null;
  const until = timing.economicPeriod.to;
  const clipped = timing.economicPeriod.from < loan.debtFrom ? loan.debtFrom : timing.economicPeriod.from;
  return { from: clipped > until ? until : clipped, until, source: 'LOAN_SCHEDULE' };
}

/**
 * §58O "The deviation flag": a recorded period (VC-X-40) that differs from the schedule's in either end, on a Loan with a
 * schedule; `null` when they are equal, without a recorded period or without a schedule (no plan to deviate from).
 * A recorded period from the day after a `CLOSED` Loan's last kept entry to its closing date matches (question 5).
 */
export interface PeriodDeviation {
  readonly recorded: { readonly from: BusinessDate; readonly until: BusinessDate };
  readonly schedule: InterestPeriod;
  readonly termsId: string | null;
  readonly paymentIntervalMonths: number;
}

export function deviationOf(
  bookingDate: BusinessDate,
  recorded: { readonly from: BusinessDate; readonly until: BusinessDate } | null,
  loan: LoanPeriodFacts | undefined,
): PeriodDeviation | null {
  const schedule = schedulePeriodOf(bookingDate, loan);
  if (recorded === null || schedule === null || loan === undefined) return null;
  if (recorded.from === schedule.from && recorded.until === schedule.until) return null;
  const last = [...loan.paymentDates].sort().at(-1);
  if (loan.closingDate != null && last !== undefined && recorded.from === addDays(last, 1) && recorded.until === loan.closingDate) return null;
  const nearest = nearestIndex(bookingDate, loan.paymentDates);
  const terms = nearest === undefined ? undefined : loan.entryTerms?.[nearest];
  return { recorded, schedule, termsId: terms?.termsId ?? null, paymentIntervalMonths: terms?.paymentIntervalMonths ?? 1 };
}

/** The index of the entry `interestTiming` takes (nearest, ties towards the later one), in the given order. */
function nearestIndex(bookingDate: BusinessDate, paymentDates: readonly BusinessDate[]): number | undefined {
  let best: number | undefined;
  const distance = (d: BusinessDate) => Math.abs(dayNumber(d) - dayNumber(bookingDate));
  paymentDates.forEach((d, i) => {
    if (best === undefined || distance(d) <= distance(paymentDates[best] as BusinessDate)) best = i;
  });
  return best;
}

/** Consecutive days of the period with the same set (rule 2). */
export interface PeriodSegment {
  readonly from: BusinessDate;
  readonly until: BusinessDate;
  readonly days: number;
  readonly set: LoanAllocationSetView;
}

/** A PropertyReference's exact weight in a split (rule 4) and its part of the split's cents (rule 5). */
export interface PeriodWeight {
  readonly propertyReferenceId: string;
  readonly share: Fraction;
  readonly cents: bigint;
}

export type PeriodDistribution =
  | {
      readonly kind: 'COVERED';
      /** `null`: no period (rule 8), distributed by the set on the booking date. */
      readonly period: InterestPeriod | null;
      /** By `from`; under rule 8 the booking date's set alone, as one segment of that day. */
      readonly segments: readonly PeriodSegment[];
      /**
       * Every PropertyReference named by a segment's set, by id; with `outsideLetting` the shares sum to `1/1`, the cents
       * to the split's.
       */
      readonly weights: readonly PeriodWeight[];
      /** §58V rule 5: `w_O = Σ (days_k / D) × outside_k` and its part; `null` when no segment's set has a part outside letting. */
      readonly outsideLetting: { readonly share: Fraction; readonly cents: bigint } | null;
    }
  | {
      readonly kind: 'UNCOVERED';
      readonly reason: 'NO_LOAN_ALLOCATION' | 'ALLOCATION_SUM_NOT_ONE';
      readonly period: InterestPeriod | null;
      /** The covered days' segments (with an unusable set where `ALLOCATION_SUM_NOT_ONE`). */
      readonly segments: readonly PeriodSegment[];
      /** The days without a set, by `from` (rule 3). */
      readonly uncovered: readonly { readonly from: BusinessDate; readonly until: BusinessDate }[];
    };

/** The `VALID` sets' segments over [from, until] and the days no set covers (`validUntil` derived over the `VALID` sets). */
function segmentsOver(sets: readonly LoanAllocationSetView[], from: BusinessDate, until: BusinessDate) {
  const segments: PeriodSegment[] = [];
  const uncovered: { from: BusinessDate; until: BusinessDate }[] = [];
  let day = from;
  const valid = sets.filter((s) => s.status === 'VALID').sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
  for (const set of valid) {
    if (day > until) break;
    const end = set.validUntil === null || set.validUntil > until ? until : set.validUntil;
    if (end < day) continue;
    const start = set.validFrom > day ? set.validFrom : day;
    if (start > end) continue;
    if (start > day) uncovered.push({ from: day, until: addDays(start, -1) });
    segments.push({ from: start, until: end, days: daysIn(start, end), set });
    day = addDays(end, 1);
  }
  if (day <= until) uncovered.push({ from: day, until });
  return { segments, uncovered };
}

const reduced = (numerator: bigint, denominator: bigint): Fraction => {
  const g = gcd(numerator, denominator);
  return { numerator: numerator / g, denominator: denominator / g };
};

/**
 * The split's distribution (rules 2–8): its segments, and when every day is covered by a usable set, every named
 * PropertyReference's weight `w_P = Σ (days_k / D) × share_k(P)` and its part, by **one** `distribute` over the weights
 * (§41.6: largest remainder, ties by `propertyReferenceId`). A period in one set gives that set's shares, so the parts
 * are exactly `distribute` over the set (rule 7). Without a period, the set on the booking date (rule 8).
 */
export function distributeOverPeriod(
  sets: readonly LoanAllocationSetView[],
  totalCents: bigint,
  period: InterestPeriod | null,
  bookingDate: BusinessDate,
): PeriodDistribution {
  let segments: PeriodSegment[];
  let uncovered: { from: BusinessDate; until: BusinessDate }[] = [];
  if (period === null) {
    const set = setOn(sets, bookingDate);
    segments = set === null ? [] : [{ from: bookingDate, until: bookingDate, days: 1, set }];
    if (set === null) uncovered = [{ from: bookingDate, until: bookingDate }];
  } else {
    ({ segments, uncovered } = segmentsOver(sets, period.from, period.until));
  }
  if (uncovered.length > 0) return { kind: 'UNCOVERED', reason: 'NO_LOAN_ALLOCATION', period, segments, uncovered };
  // §58V: usable with the part outside letting (a set whose entries alone sum to 1/1 plus such a part is not).
  if (segments.some((s) => !sumsToOne(setShares(s.set)))) {
    return { kind: 'UNCOVERED', reason: 'ALLOCATION_SUM_NOT_ONE', period, segments, uncovered };
  }
  const total = BigInt(segments.reduce((sum, s) => sum + s.days, 0));
  const sums = new Map<string, Fraction>();
  let outside: Fraction | null = null;
  // (days_k / D) × n / d, added exactly to `seen`.
  const plus = (seen: Fraction | null | undefined, days: number, share: Fraction): Fraction => {
    const term = { numerator: BigInt(days) * share.numerator, denominator: total * share.denominator };
    return seen == null
      ? reduced(term.numerator, term.denominator)
      : reduced(seen.numerator * term.denominator + term.numerator * seen.denominator, seen.denominator * term.denominator);
  };
  for (const s of segments) {
    for (const a of s.set.allocations) sums.set(a.propertyReferenceId, plus(sums.get(a.propertyReferenceId), s.days, a.share));
    // §58V rule 5: the part outside letting per day, as the PropertyReferences' (never the booking date's set alone).
    if (s.set.outsideLetting != null) outside = plus(outside, s.days, s.set.outsideLetting.share);
  }
  const keys = [...sums.keys()].sort();
  const allocations = keys.map((propertyReferenceId) => ({ propertyReferenceId, share: sums.get(propertyReferenceId) as Fraction }));
  // Once per split (L7), over the PropertyReferences and the part outside letting (§58V): every view computes the same parts.
  const cents = distributeSet(totalCents, allocations, outside);
  return {
    kind: 'COVERED',
    period,
    segments,
    weights: allocations.map((a, i) => ({ ...a, cents: cents.parts[i] as bigint })),
    outsideLetting: outside === null ? null : { share: outside, cents: cents.outsideLetting as bigint },
  };
}

/** The distinct sets of the segments, in order (a set covers one run of days, so each appears once). */
export const setsOfSegments = (segments: readonly PeriodSegment[]): LoanAllocationSetView[] => [
  ...new Map(segments.map((s) => [s.set.id, s.set] as const)).values(),
];

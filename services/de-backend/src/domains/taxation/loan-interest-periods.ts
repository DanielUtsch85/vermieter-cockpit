import { addDays, type BusinessDate } from '../../shared/index.js';
import { distribute, setOn, sumsToOne, type LoanAllocationSetView } from '../financing/index.js';
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

/** What the period reads of the Loan: the day the debt starts (§41.1) and the schedule's payment dates (§41.4). */
export interface LoanPeriodFacts {
  readonly debtFrom: BusinessDate;
  readonly paymentDates: readonly BusinessDate[];
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
  if (recorded !== null) return { from: recorded.from, until: recorded.until, source: 'CLASSIFICATION' };
  if (loan === undefined) return null;
  const timing = interestTiming(bookingDate, loan.paymentDates);
  if (timing.kind !== 'PERIOD') return null;
  const until = timing.economicPeriod.to;
  const clipped = timing.economicPeriod.from < loan.debtFrom ? loan.debtFrom : timing.economicPeriod.from;
  return { from: clipped > until ? until : clipped, until, source: 'LOAN_SCHEDULE' };
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
      /** Every PropertyReference named by a segment's set, by id; the shares sum to `1/1`, the cents to the split's. */
      readonly weights: readonly PeriodWeight[];
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
  if (segments.some((s) => !sumsToOne(s.set.allocations.map((a) => a.share)))) {
    return { kind: 'UNCOVERED', reason: 'ALLOCATION_SUM_NOT_ONE', period, segments, uncovered };
  }
  const total = BigInt(segments.reduce((sum, s) => sum + s.days, 0));
  const sums = new Map<string, Fraction>();
  for (const s of segments) {
    for (const a of s.set.allocations) {
      // (days_k / D) × n / d, added exactly.
      const term = { numerator: BigInt(s.days) * a.share.numerator, denominator: total * a.share.denominator };
      const seen = sums.get(a.propertyReferenceId);
      sums.set(
        a.propertyReferenceId,
        seen === undefined
          ? reduced(term.numerator, term.denominator)
          : reduced(seen.numerator * term.denominator + term.numerator * seen.denominator, seen.denominator * term.denominator),
      );
    }
  }
  const keys = [...sums.keys()].sort();
  const allocations = keys.map((propertyReferenceId) => ({ propertyReferenceId, share: sums.get(propertyReferenceId) as Fraction }));
  // Once per split (L7): every view distributes over the whole union, so all compute the same parts.
  const cents = distribute(totalCents, allocations);
  return {
    kind: 'COVERED',
    period,
    segments,
    weights: allocations.map((a, i) => ({ ...a, cents: cents[i] as bigint })),
  };
}

/** The distinct sets of the segments, in order (a set covers one run of days, so each appears once). */
export const setsOfSegments = (segments: readonly PeriodSegment[]): LoanAllocationSetView[] => [
  ...new Map(segments.map((s) => [s.set.id, s.set] as const)).values(),
];

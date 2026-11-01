import { addDays, addMonths, type BusinessDate, type RuleRef, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import type { Direction } from '../ledger/index.js';
import { dueDayOn, type RentDueDay } from '../rental-contract-reference/index.js';
import { CASH_TIMING, type CashTimingParameters } from './rules/de-cash-timing.js';
import { isExpenseLine, isIncomeLine, type TaxCategory } from './vocabulary.js';

/**
 * The tax year of a split (api-design.md §58A, phase-7-plan P7-D3) and the year a refund refunds (P7-D4, A10). The
 * booking year, except where the 10-day rule of § 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG moves a regularly recurring amount
 * to its economic year. Derived on read, never stored: a classification may only override it (`taxYear`).
 */

export const yearOf = (date: BusinessDate) => Number(date.slice(0, 4));

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** Day `day` of the month, clamped to the month's last day (31 → 28/29 February, 30 April). */
export function dayIn(year: number, month: number, day: number): BusinessDate {
  const last = new Date(Date.UTC(2000, 0, 1));
  last.setUTCFullYear(year, month, 0);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(Math.min(day, last.getUTCDate()), 2)}` as BusinessDate;
}

const monthOf = (date: BusinessDate) => ({ year: yearOf(date), month: Number(date.slice(5, 7)) });
const shiftMonth = (year: number, month: number, by: number) => {
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};
const dayNumber = (date: BusinessDate) => {
  const d = new Date(0);
  d.setUTCFullYear(yearOf(date), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.round(d.getTime() / 86_400_000);
};
const distance = (a: BusinessDate, b: BusinessDate) => Math.abs(dayNumber(a) - dayNumber(b));

/** The period an amount pays for, both days inclusive. */
export interface EconomicPeriod {
  readonly from: BusinessDate;
  readonly to: BusinessDate;
}

const monthPeriod = (year: number, month: number): EconomicPeriod => ({ from: dayIn(year, month, 1), to: dayIn(year, month, 31) });

/** Where a due date comes from; `PERIOD_START` is the assumption of P7-D3, flagged `DUE_DATE_ASSUMED`. */
export const DUE_DATE_SOURCES = ['RENTAL_CONTRACT_REFERENCE', 'ECONOMIC_PLAN', 'LOAN_SCHEDULE', 'PERIOD_START'] as const;
export type DueDateSource = (typeof DUE_DATE_SOURCES)[number];

/** Why a recurring split in the window has no economic period (it takes the booking year). */
export type NoPeriodReason = 'NO_RECONCILIATION' | 'SEVERAL_TERMS' | 'NO_ECONOMIC_PLAN' | 'NO_LOAN' | 'NO_SCHEDULE';

/** What a split's source says about the period it pays for and when it fell due (§58A's table). */
export type TimingInput =
  | { readonly kind: 'NO_ECONOMIC_PERIOD'; readonly reason: NoPeriodReason }
  | {
      readonly kind: 'PERIOD';
      readonly economicPeriod: EconomicPeriod;
      readonly economicYear: number;
      readonly dueDate: BusinessDate;
      readonly dueDateSource: DueDateSource;
      /** Hausgeld: a debit names no month, so the period is only the nearest month's guess (review on #159). */
      readonly periodGuessed: boolean;
    };

/**
 * The due date of a rent term, `term` as MRE keys it (`YYYYMMDDHH`): the day of `rentDueDays` that applies to the
 * term, in the term's month, else the term's first day.
 */
export function rentTiming(term: string, rentDueDays: readonly RentDueDay[] | null): TimingInput {
  const year = Number(term.slice(0, 4));
  const month = Number(term.slice(4, 6));
  const termStart = dayIn(year, month, Number(term.slice(6, 8)));
  const day = rentDueDays === null ? undefined : dueDayOn(rentDueDays, termStart);
  // DUE_DATE_ASSUMED is decided here. Without a recorded due day the term's first day serves as the due date (P7-D3).
  // Rationale (§ 556b Abs. 1 BGB): unless the lease says otherwise, rent is due in advance, at the latest by the
  // 3rd working day of the period. For a January term that is at the latest 5 or 6 January, inside the window of
  // 10 January, as the 1st is; for a December term both lie before 22 December. So the assumption gives the
  // statutory outcome of the 10-day rule; it is still flagged, since a lease may agree another day (e.g. the 15th).
  return day === undefined
    ? { kind: 'PERIOD', economicPeriod: monthPeriod(year, month), economicYear: year, dueDate: termStart, dueDateSource: 'PERIOD_START', periodGuessed: false }
    : {
        kind: 'PERIOD',
        economicPeriod: monthPeriod(year, month),
        economicYear: year,
        dueDate: dayIn(year, month, day),
        dueDateSource: 'RENTAL_CONTRACT_REFERENCE',
        periodGuessed: false,
      };
}

/**
 * A Hausgeld debit (§58A): the month whose due date (`advanceDueDay`, else day 1 assumed) is nearest to the booking
 * date, ties towards the later month. Only a guess: the debit names no month.
 */
export function hausgeldTiming(bookingDate: BusinessDate, advanceDueDay: number | null): TimingInput {
  const { year, month } = monthOf(bookingDate);
  const day = advanceDueDay ?? 1;
  let best: { year: number; month: number; due: BusinessDate } | undefined;
  for (const by of [-1, 0, 1]) {
    const m = shiftMonth(year, month, by);
    const due = dayIn(m.year, m.month, day);
    // Ascending months: `<=` lets the later one win a tie.
    if (best === undefined || distance(due, bookingDate) <= distance(best.due, bookingDate)) best = { ...m, due };
  }
  const chosen = best as { year: number; month: number; due: BusinessDate };
  return {
    kind: 'PERIOD',
    economicPeriod: monthPeriod(chosen.year, chosen.month),
    economicYear: chosen.year,
    dueDate: chosen.due,
    dueDateSource: advanceDueDay === null ? 'PERIOD_START' : 'ECONOMIC_PLAN',
    periodGuessed: true,
  };
}

/**
 * Loan interest (§58A): the schedule entry (§41.4) whose payment date is nearest to the booking date, ties towards the
 * later one. Its interest period runs from the day after the previous payment (or one month before) to its payment
 * date, in arrears as §41.4 computes it; the economic year is the year holding most of the period's days (ties
 * towards the later year), so December's interest due on 2 January belongs to December's year.
 */
export function interestTiming(bookingDate: BusinessDate, paymentDates: readonly BusinessDate[]): TimingInput {
  if (paymentDates.length === 0) return { kind: 'NO_ECONOMIC_PERIOD', reason: 'NO_SCHEDULE' };
  const sorted = [...paymentDates].sort();
  let index = 0;
  sorted.forEach((date, i) => {
    if (distance(date, bookingDate) <= distance(sorted[index] as BusinessDate, bookingDate)) index = i;
  });
  const due = sorted[index] as BusinessDate;
  const previous = sorted[index - 1] ?? addMonths(due, -1);
  const from = addDays(previous, 1);
  const fromYear = yearOf(from);
  let economicYear = yearOf(due);
  if (fromYear !== economicYear) {
    const daysInFirst = dayNumber(`${pad(fromYear, 4)}-12-31` as BusinessDate) - dayNumber(from) + 1;
    const daysInSecond = dayNumber(due) - dayNumber(`${pad(economicYear, 4)}-01-01` as BusinessDate) + 1;
    if (daysInFirst > daysInSecond) economicYear = fromYear;
  }
  return { kind: 'PERIOD', economicPeriod: { from, to: due }, economicYear, dueDate: due, dueDateSource: 'LOAN_SCHEDULE', periodGuessed: false };
}

/** Where each recurring category's economic period and due date come from (§58A's table). */
export const TIMING_SOURCES: Readonly<Record<string, 'RENT' | 'HAUSGELD' | 'LOAN_SCHEDULE'>> = {
  RENT_BASE: 'RENT',
  RENT_OPERATING_COST_ADVANCE: 'RENT',
  WEG_RECOVERABLE: 'HAUSGELD',
  WEG_NON_RECOVERABLE: 'HAUSGELD',
  LOAN_INTEREST: 'LOAN_SCHEDULE',
};

/** The cash timing rule applicable on `date`, typed. */
export function cashTimingOn(registry: RuleRegistry, date: BusinessDate): RuleVersion<CashTimingParameters> | undefined {
  return registry.select(CASH_TIMING, date) as RuleVersion<CashTimingParameters> | undefined;
}

/** The year-end Y (of Y/Y+1) whose window holds `date`: 22 December of Y to 10 January of Y+1 for 10 days; else undefined. */
export function windowYearEnd(date: BusinessDate, windowDays: number): number | undefined {
  const { year, month } = monthOf(date);
  const day = Number(date.slice(8, 10));
  if (month === 12 && day >= 32 - windowDays) return year;
  if (month === 1 && day <= windowDays) return year - 1;
  return undefined;
}

/** Whether the 10-day rule may apply: a recurring category booked inside a window. Only then a source is read. */
export function needsTiming(registry: RuleRegistry, split: { readonly bookingDate: BusinessDate; readonly financialCategoryCode: string }): boolean {
  const rule = cashTimingOn(registry, split.bookingDate);
  return (
    rule !== undefined &&
    rule.parameters.recurringCategories.includes(split.financialCategoryCode) &&
    windowYearEnd(split.bookingDate, rule.parameters.windowDays) !== undefined
  );
}

/** The widest window of every registered version: the per-year list reads splits booked this far around the year. */
export function widestWindowDays(registry: RuleRegistry): number {
  return Math.max(0, ...registry.versions(CASH_TIMING).map((v) => (v.parameters as CashTimingParameters).windowDays));
}

export type TaxYearFlag =
  | {
      readonly code: 'ATTRIBUTED_BY_10_DAY_RULE';
      readonly details: {
        readonly bookingDate: BusinessDate;
        readonly dueDate: BusinessDate;
        readonly economicPeriod: EconomicPeriod;
        readonly dueDateSource: DueDateSource;
      };
    }
  | { readonly code: 'DUE_DATE_ASSUMED'; readonly details: { readonly dueDate: BusinessDate; readonly economicPeriod: EconomicPeriod } }
  | { readonly code: 'NO_ECONOMIC_PERIOD'; readonly details: { readonly reason: NoPeriodReason } }
  | {
      readonly code: 'ECONOMIC_PERIOD_ASSUMED';
      readonly details: {
        readonly bookingDate: BusinessDate;
        readonly dueDate: BusinessDate;
        readonly economicPeriod: EconomicPeriod;
        readonly proposedYear: number;
      };
    };

/** How the tax year came about (§58A): the rule's proposal, and whether a classification overrode it. */
export interface TaxYearAttribution {
  /** `null` only before 2000, where no version of the rule applies. */
  readonly rule: RuleRef | null;
  readonly bookingYear: number;
  readonly proposedYear: number;
  readonly overridden: boolean;
}

/**
 * The tax year of a split (§58A): the booking year, unless (1) the booking date and (2) the due date lie in the same
 * window and (3) the economic year differs from the booking year; then the economic year, flagged
 * `ATTRIBUTED_BY_10_DAY_RULE`. Hausgeld is never moved on a guess: it keeps its booking year, flagged
 * `ECONOMIC_PERIOD_ASSUMED` with the guessed year as `proposedYear`. A classification's `taxYear` wins over both.
 * The flags of the source (`DUE_DATE_ASSUMED`, `NO_ECONOMIC_PERIOD`) are raised only where the rule could apply.
 */
export function attributeTaxYear(
  split: { readonly bookingDate: BusinessDate; readonly financialCategoryCode: string },
  timing: TimingInput | undefined,
  override: number | null,
  registry: RuleRegistry,
): { readonly taxYear: number; readonly attribution: TaxYearAttribution; readonly flags: readonly TaxYearFlag[] } {
  const bookingYear = yearOf(split.bookingDate);
  const rule = cashTimingOn(registry, split.bookingDate);
  const flags: TaxYearFlag[] = [];
  let proposedYear = bookingYear;
  let moves = false;
  if (rule !== undefined && needsTiming(registry, split)) {
    const yearEnd = windowYearEnd(split.bookingDate, rule.parameters.windowDays) as number;
    if (timing === undefined || timing.kind === 'NO_ECONOMIC_PERIOD') {
      flags.push({ code: 'NO_ECONOMIC_PERIOD', details: { reason: timing?.reason ?? 'NO_RECONCILIATION' } });
    } else {
      if (timing.dueDateSource === 'PERIOD_START')
        flags.push({ code: 'DUE_DATE_ASSUMED', details: { dueDate: timing.dueDate, economicPeriod: timing.economicPeriod } });
      const across = timing.economicYear !== bookingYear && (timing.economicYear === yearEnd || timing.economicYear === yearEnd + 1);
      if (across && windowYearEnd(timing.dueDate, rule.parameters.windowDays) === yearEnd) {
        proposedYear = timing.economicYear;
        if (timing.periodGuessed) {
          flags.push({
            code: 'ECONOMIC_PERIOD_ASSUMED',
            details: { bookingDate: split.bookingDate, dueDate: timing.dueDate, economicPeriod: timing.economicPeriod, proposedYear },
          });
        } else {
          moves = true;
          flags.push({
            code: 'ATTRIBUTED_BY_10_DAY_RULE',
            details: { bookingDate: split.bookingDate, dueDate: timing.dueDate, economicPeriod: timing.economicPeriod, dueDateSource: timing.dueDateSource },
          });
        }
      }
    }
  }
  return {
    taxYear: override ?? (moves ? proposedYear : bookingYear),
    attribution: {
      rule: rule === undefined ? null : { ruleCode: rule.ruleCode, version: rule.version },
      bookingYear,
      proposedYear,
      overridden: override !== null,
    },
    flags,
  };
}

/** A refund (an `INFLOW` on an expense line) or a repayment (an `OUTFLOW` on an income line), §58A. */
export interface RefundInfo {
  readonly kind: 'REFUND' | 'REPAYMENT';
  readonly ofYear: number | null;
  readonly ofYearSource: 'WEG_ANNUAL_STATEMENT' | 'CLASSIFICATION' | null;
  readonly presentation: 'REDUCES_LINE' | 'INCOME';
  /** The line it is shown on: its own, or `REFUNDS_OF_EARLIER_YEARS`. */
  readonly line: TaxCategory;
}

export type RefundFlag = { readonly code: 'REFUND_YEAR_UNKNOWN'; readonly details: Record<string, never> };

/**
 * §58A, P7-D4: a refund refunds the year of the WEG statement its split names, else the classification's
 * `refundOfYear`, else an unknown year (flagged); it reduces its line for the same or an unknown year, and is income on
 * `REFUNDS_OF_EARLIER_YEARS` for an earlier one (A10). A repayment of income always reduces its line in the year paid
 * (§ 11 Abs. 2 EStG); `refundOfYear` is then informational. Anything else is neither.
 */
export function refundOf(
  direction: Direction,
  taxCategory: TaxCategory,
  taxYear: number,
  statementYear: number | null,
  refundOfYear: number | null,
): { readonly refund: RefundInfo | null; readonly flags: readonly RefundFlag[] } {
  if (direction === 'OUTFLOW' && isIncomeLine(taxCategory)) {
    return {
      refund: {
        kind: 'REPAYMENT',
        ofYear: refundOfYear,
        ofYearSource: refundOfYear === null ? null : 'CLASSIFICATION',
        presentation: 'REDUCES_LINE',
        line: taxCategory,
      },
      flags: [],
    };
  }
  if (direction !== 'INFLOW' || !isExpenseLine(taxCategory)) return { refund: null, flags: [] };
  const ofYear = statementYear ?? refundOfYear;
  const ofYearSource = statementYear !== null ? 'WEG_ANNUAL_STATEMENT' : refundOfYear !== null ? 'CLASSIFICATION' : null;
  const earlier = ofYear !== null && ofYear < taxYear;
  return {
    refund: {
      kind: 'REFUND',
      ofYear,
      ofYearSource,
      presentation: earlier ? 'INCOME' : 'REDUCES_LINE',
      line: earlier ? 'REFUNDS_OF_EARLIER_YEARS' : taxCategory,
    },
    flags: ofYear === null ? [{ code: 'REFUND_YEAR_UNKNOWN', details: {} }] : [],
  };
}

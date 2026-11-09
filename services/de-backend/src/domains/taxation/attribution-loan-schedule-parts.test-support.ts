import { Money, type BusinessDate } from '../../shared/index.js';
import type { LoanAllocationSet, LoanTermsId, SchedulePeriod } from '../financing/index.js';
import type { HistoryRecord, TermsHistory } from './attribution-history.js';
import { planFactsOf, type LoanScheduleHistory } from './attribution-loan-schedule-parts.js';
import type { PartCandidate, PartChangeInput } from './attribution-parts.js';
import { attributeTaxYear, interestTiming } from './cash-timing.js';
import { interestPeriodOf } from './loan-interest-periods.js';
import type { LoanInterestSplit } from './tax-year-view.js';
import { L, TAX_RULES, day, split } from './tax-year-loan-periods.test-support.js';

/**
 * Fixtures of §58P's examples (api-design.md §58P "Example (synthetic)", VC-X-54): a Loan with its terms periods and
 * their records, its closing record and its sets with their records; its debits as the view's read builds them (the
 * period now, `interestPeriodOf` over the current contract plan) and as §58P's candidates. Synthetic ids and figures only.
 */

export const rec = (auditRecordId: string, action: string, iso: string): HistoryRecord => ({ auditRecordId, action, occurredAt: new Date(iso) });

/** A terms period as the schedule reads it: Loan Q's (`ANNUITY` 3 %, 1 800.00, from 2027-01-01, due 2027-03-31) unless overridden. */
export const terms = (id: string, o: Partial<SchedulePeriod> = {}): SchedulePeriod => ({
  id: id as LoanTermsId,
  validFrom: day('2027-01-01'),
  interestRate: 3000n,
  repaymentModel: 'ANNUITY',
  scheduledPayment: Money.of('1800.00', 'EUR'),
  firstPaymentDate: day('2027-03-31'),
  principalAtStart: null,
  fixedRateUntil: null,
  paymentIntervalMonths: 1,
  ...o,
});

export type LoanFacts = LoanScheduleHistory['loan'];
export const ACTIVE_LOAN: LoanFacts = { principalOriginal: Money.of('120000.00', 'EUR'), maturityDate: null, status: 'ACTIVE', closingDate: null };

export interface Debit {
  readonly amount: string;
  readonly bookingDate: string;
  readonly recorded?: { readonly from: BusinessDate; readonly until: BusinessDate } | null;
  readonly override?: number;
}

export interface LoanCase {
  readonly loanId?: string;
  readonly loan?: LoanFacts;
  readonly debtFrom?: string;
  readonly terms: readonly TermsHistory[];
  readonly closing?: readonly HistoryRecord[];
  readonly sets: readonly { readonly set: LoanAllocationSet; readonly records: readonly HistoryRecord[] }[];
  readonly debits: readonly Debit[];
  /** Leaves out the terms and closing histories (the read before VC-X-54). */
  readonly withoutSchedule?: boolean;
}

/** The debits as the view's splits (period and year now) and the part change input of the Loan. */
export function loanCase(c: LoanCase): { readonly splits: LoanInterestSplit[]; readonly input: PartChangeInput; readonly candidates: PartCandidate[] } {
  const loanId = c.loanId ?? L;
  const loan = c.loan ?? ACTIVE_LOAN;
  const debtFrom = day(c.debtFrom ?? '2027-01-01');
  const now = planFactsOf(
    loan,
    debtFrom,
    c.terms.filter((t) => t.validNow).map((t) => t.period),
  );
  const splits = c.debits.map((d) => {
    const bookingDate = day(d.bookingDate);
    const recorded = d.recorded ?? null;
    const taxYear = attributeTaxYear(
      { bookingDate, financialCategoryCode: 'LOAN_INTEREST' },
      interestTiming(bookingDate, now.paymentDates, now.firstIntervalMonths ?? 1),
      d.override ?? null,
      TAX_RULES,
    ).taxYear;
    const s = split(d.amount, d.bookingDate, interestPeriodOf(bookingDate, recorded, now), { taxYear, loanId });
    const overridden = d.override !== undefined;
    return {
      ...s,
      item: { ...s.item, attribution: { ...(s.item as { attribution: object }).attribution, overridden } } as LoanInterestSplit['item'],
      recordedPeriod: recorded,
    };
  });
  const candidates = splits.map((s): PartCandidate => ({
    sourceId: s.item.sourceId,
    bookingDate: (s.item as { bookingDate: BusinessDate }).bookingDate,
    amount: s.item.amount,
    period: s.period,
    recordedPeriod: s.recordedPeriod,
    financialCategoryCode: 'LOAN_INTEREST',
    taxYearOverride: c.debits[splits.indexOf(s)]?.override ?? null,
  }));
  const schedule: LoanScheduleHistory = { loan, debtFrom, terms: c.terms, closing: c.closing ?? [] };
  return {
    splits,
    candidates,
    input: { loans: [{ loanId, candidates, sets: c.sets, ...(c.withoutSchedule === true ? {} : { schedule }) }] },
  };
}

/** The candidates of `year` only (§58G: the read keeps the splits whose tax year is the view's). */
export function ofYear(c: ReturnType<typeof loanCase>, year: number): ReturnType<typeof loanCase> {
  const keep = new Set(c.splits.filter((s) => (s.item as { taxYear: number }).taxYear === year).map((s) => s.item.sourceId));
  return {
    splits: c.splits.filter((s) => keep.has(s.item.sourceId)),
    candidates: c.candidates.filter((x) => keep.has(x.sourceId)),
    input: { loans: c.input.loans.map((l) => ({ ...l, candidates: l.candidates.filter((x) => keep.has(x.sourceId)) })) },
  };
}

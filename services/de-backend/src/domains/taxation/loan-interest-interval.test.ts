import { describe, expect, it } from 'vitest';
import { addMonths, type BusinessDate } from '../../shared/index.js';
import { attributeTaxYear, interestTiming } from './cash-timing.js';
import { deviationOf, interestPeriodOf, schedulePeriodOf, type LoanPeriodFacts } from './loan-interest-periods.js';
import { flagIsOpen } from './tax-year-review.js';
import { A, B, C, P1, P2, TAX_RULES, day, interestLine, parts, readOf, set, split, viewOf, views } from './tax-year-loan-periods.test-support.js';

/**
 * VC-X-53 in Taxation (api-design.md §58O; Entscheidung des Projektinhabers, 2026-11-05, questions 3, 5–8, 11): the
 * first entry's interest period over its interval (rule 8), §58O's example distribution (745.00 / 155.00), §58L
 * Example 2 with interval 12, the 10-day case, the precedence of the plan and the recorded period, and
 * `INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE` open, informative and absent. Synthetic figures only.
 */
const S1 = set('2027-01-01', [[P1, '1/1']]);
const S2 = set('2027-03-01', [
  [P1, '1/2'],
  [P2, '1/2'],
]);
const sets = views([S1, S2]);
const every = (first: string, n: number, count: number) => Array.from({ length: count }, (_, k) => addMonths(day(first), k * n));
/** Loan Q of §58O's example: debtFrom 2027-01-01, quarterly from 2027-03-31, or entered without the interval (monthly). */
const quarterly: LoanPeriodFacts = {
  debtFrom: day('2027-01-01'),
  paymentDates: every('2027-03-31', 3, 12),
  firstIntervalMonths: 3,
  entryTerms: Array(12).fill({ termsId: 'tq', paymentIntervalMonths: 3 }),
};
const monthlyQ: LoanPeriodFacts = {
  debtFrom: day('2027-01-01'),
  paymentDates: every('2027-03-31', 1, 36),
  firstIntervalMonths: 1,
  entryTerms: Array(36).fill({ termsId: 'tm', paymentIntervalMonths: 1 }),
};
const range = (from: string, until: string) => ({ from: day(from), until: day(until) });
/** A split as the view's read builds it: its period by §58L rule 1 and §58O's precedence, its deviation. */
const debit = (amount: string, bookingDate: string, facts: LoanPeriodFacts | undefined, rec: { from: BusinessDate; until: BusinessDate } | null = null) => ({
  ...split(amount, bookingDate, interestPeriodOf(day(bookingDate), rec, facts)),
  deviation: deviationOf(day(bookingDate), rec, facts),
});
const flag = (v: ReturnType<typeof viewOf>) => interestLine(v)?.items[0]?.flags.find((f) => f.code === 'INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE');

describe('§58O rule 8: the first entry runs over its interval', () => {
  it('quarterly from 2027-03-31: 2027-01-01 – 2027-03-31; monthly 2027-03-01 – 2027-03-31; clipped at a later debtFrom', () => {
    expect(schedulePeriodOf(day('2027-03-31'), quarterly)).toEqual({ from: '2027-01-01', until: '2027-03-31', source: 'LOAN_SCHEDULE' });
    expect(schedulePeriodOf(day('2027-06-30'), quarterly)).toEqual({ from: '2027-04-01', until: '2027-06-30', source: 'LOAN_SCHEDULE' });
    expect(schedulePeriodOf(day('2027-03-31'), monthlyQ)).toEqual({ from: '2027-03-01', until: '2027-03-31', source: 'LOAN_SCHEDULE' });
    expect(schedulePeriodOf(day('2027-03-31'), { ...quarterly, debtFrom: day('2027-01-15') })).toMatchObject({ from: '2027-01-15' });
    // Without the field (facts read before VC-X-53): one month, as today.
    expect(interestTiming(day('2027-03-31'), quarterly.paymentDates)).toMatchObject({ economicPeriod: { from: '2027-03-01', to: '2027-03-31' } });
  });

  it('the example: the March debit 900.00 over the quarter, P1 745.00, P2 155.00, the owners; monthly 450.00 each', () => {
    const q = debit('900.00', '2027-03-31', quarterly);
    expect(parts(viewOf(readOf(P1, [q], sets)))).toEqual([[q.item.sourceId, '745.00']]);
    expect(parts(viewOf(readOf(P2, [q], sets)))).toEqual([[q.item.sourceId, '155.00']]);
    expect(parts(viewOf(readOf(P1, [q], sets), 2027, A))).toEqual([[q.item.sourceId, '372.50']]);
    expect(parts(viewOf(readOf(P1, [q], sets), 2027, B))).toEqual([[q.item.sourceId, '372.50']]);
    expect(parts(viewOf(readOf(P2, [q], sets), 2027, C))).toEqual([[q.item.sourceId, '155.00']]);
    expect(interestLine(viewOf(readOf(P1, [q], sets)))?.items[0]?.loanAllocation).toMatchObject({ share: '149/180' });
    const m = debit('900.00', '2027-03-31', monthlyQ);
    expect([parts(viewOf(readOf(P1, [m], sets))), parts(viewOf(readOf(P2, [m], sets)))]).toEqual([
      [[m.item.sourceId, '450.00']],
      [[m.item.sourceId, '450.00']],
    ]);
  });

  it('Loan Q 2027 by PropertyReference: the interval moves 295.00 from P2 to P1, the sum 3 559.30 unchanged', () => {
    const year = (facts: LoanPeriodFacts) => [
      debit('900.00', '2027-03-31', facts),
      debit('893.25', '2027-06-30', facts),
      debit('886.45', '2027-09-30', facts),
      debit('879.60', '2027-12-31', facts),
    ];
    const total = (pr: string, facts: LoanPeriodFacts) => interestLine(viewOf(readOf(pr, year(facts), sets)))?.total.amount;
    expect([total(P1, quarterly), total(P2, quarterly)]).toEqual(['2074.66', '1484.64']);
    expect([total(P1, monthlyQ), total(P2, monthlyQ)]).toEqual(['1779.66', '1779.64']);
    expect(parts(viewOf(readOf(P1, [debit('893.25', '2027-06-30', quarterly)], sets)))[0]?.[1]).toBe('446.63');
  });

  it('§58L Example 2 with interval 12: the debit of 2027-12-30 over 2027-01-01 – 2027-12-31 without a recorded period, P1 2 730.00, P2 920.00', () => {
    const yearly: LoanPeriodFacts = { debtFrom: day('2026-01-01'), paymentDates: every('2026-12-31', 12, 5), firstIntervalMonths: 12 };
    const ex2 = views([set('2026-01-01', [[P1, '1/1']]), set('2027-10-01', [[P2, '1/1']])]);
    const d = debit('3650.00', '2027-12-30', yearly);
    expect(d.period).toEqual({ from: '2027-01-01', until: '2027-12-31', source: 'LOAN_SCHEDULE' });
    expect([parts(viewOf(readOf(P1, [d], ex2)))[0]?.[1], parts(viewOf(readOf(P2, [d], ex2)))[0]?.[1]]).toEqual(['2730.00', '920.00']);
    // The first yearly entry 2026-12-31 runs over 2026 (clipped at debtFrom 2026-01-01).
    expect(schedulePeriodOf(day('2026-12-31'), yearly)).toMatchObject({ from: '2026-01-01', until: '2026-12-31' });
  });

  it('the 10-day case: a quarterly Loan due on the 5th, debit 2028-01-03: 2027 by the monthly plan, 2028 by the quarterly', () => {
    const facts = { bookingDate: day('2028-01-03'), financialCategoryCode: 'LOAN_INTEREST' };
    const year = (dates: BusinessDate[], n: number) => attributeTaxYear(facts, interestTiming(facts.bookingDate, dates, n), null, TAX_RULES).taxYear;
    expect(year(every('2027-02-05', 1, 24), 1)).toBe(2027);
    expect(year(every('2027-02-05', 3, 8), 3)).toBe(2028);
  });
});

describe('§58O precedence and INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE (questions 6, 7, 11)', () => {
  const quarter = range('2027-01-01', '2027-03-31');

  it('Loan Q entered without the interval, the March debit recorded as the quarter: the recorded period used, the flag open, the year not final', () => {
    const d = debit('900.00', '2027-03-31', monthlyQ, quarter);
    const v = viewOf(readOf(P1, [d], sets));
    expect(parts(v)).toEqual([[d.item.sourceId, '745.00']]);
    expect(interestLine(v)?.items[0]?.loanAllocation?.interestPeriod).toMatchObject({ source: 'CLASSIFICATION' });
    expect(flag(v)).toEqual({
      code: 'INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE',
      details: {
        loanId: d.loanId,
        recorded: { from: '2027-01-01', until: '2027-03-31' },
        schedule: { from: '2027-03-01', until: '2027-03-31' },
        termsId: 'tm',
        paymentIntervalMonths: 1,
        partsDiffer: true,
      },
    });
    expect(v.review.open).toContainEqual({ code: 'INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE', count: 1 });
    expect(v.review.final).toBe(false);
    // The same in every view: P2's and the owners'.
    for (const other of [viewOf(readOf(P2, [d], sets)), viewOf(readOf(P1, [d], sets), 2027, A), viewOf(readOf(P2, [d], sets), 2027, C)]) {
      expect(flag(other)).toEqual(flag(v));
      expect(other.review.open).toContainEqual({ code: 'INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE', count: 1 });
    }
  });

  it('the level compares the whole distribution: open in a view whose own part is the same (P1 half in both periods)', () => {
    const P3 = '0000aaaa-0000-4000-8000-000000000003';
    const halves = views([
      set('2027-01-01', [
        [P1, '1/2'],
        [P3, '1/2'],
      ]),
      set('2027-03-01', [
        [P1, '1/2'],
        [P2, '1/2'],
      ]),
    ]);
    const d = debit('900.00', '2027-03-31', monthlyQ, quarter);
    const v = viewOf(readOf(P1, [d], halves));
    // P1's part is 450.00 by the recorded quarter and by the schedule's March; P2's and P3's differ.
    expect(parts(v)).toEqual([[d.item.sourceId, '450.00']]);
    expect(flag(v)?.details).toMatchObject({ partsDiffer: true });
    expect(v.review.open).toContainEqual({ code: 'INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE', count: 1 });
  });

  it('the same with interval 3 on the terms: equal to the plan, source LOAN_SCHEDULE, no flag', () => {
    const d = debit('900.00', '2027-03-31', quarterly, quarter);
    const v = viewOf(readOf(P1, [d], sets));
    expect([d.deviation, d.period?.source, flag(v), parts(v)[0]?.[1]]).toEqual([null, 'LOAN_SCHEDULE', undefined, '745.00']);
  });

  it('interval 3, the June debit recorded off by a day, both wholly in S2: informative (parts equal)', () => {
    const d = debit('893.25', '2027-06-30', quarterly, range('2027-04-02', '2027-07-01'));
    const v = viewOf(readOf(P1, [d], sets));
    expect(flag(v)?.details).toMatchObject({ partsDiffer: false, termsId: 'tq', paymentIntervalMonths: 3 });
    expect(v.review.info).toContainEqual({ code: 'INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE', count: 1 });
    expect(v.review.open.map((o) => o.code)).not.toContain('INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE');
    // Counter-check against comparing only one end: the until alone differs here too, the from alone as well.
    expect(deviationOf(day('2027-06-30'), range('2027-04-02', '2027-06-30'), quarterly)).not.toBeNull();
    expect(deviationOf(day('2027-06-30'), range('2027-04-01', '2027-07-01'), quarterly)).not.toBeNull();
  });

  it('a Loan without terms: the recorded period is the only source, no flag; INTEREST_PERIOD_UNKNOWN without one', () => {
    const d = debit('900.00', '2027-03-31', undefined, quarter);
    expect([d.deviation, d.period]).toEqual([null, { ...quarter, source: 'CLASSIFICATION' }]);
    expect(flag(viewOf(readOf(P1, [d], sets)))).toBeUndefined();
    const none = debit('900.00', '2027-03-31', undefined);
    expect(interestLine(viewOf(readOf(P1, [none], sets)))?.items[0]?.flags.map((f) => f.code)).toContain('INTEREST_PERIOD_UNKNOWN');
  });

  it('a not attributed entry: listed informative (the year open by LOAN_INTEREST_NOT_ATTRIBUTED anyway)', () => {
    const gap = views([set('2027-02-01', [[P1, '1/1']])]);
    const d = debit('900.00', '2027-03-31', monthlyQ, quarter);
    const v = viewOf(readOf(P1, [d], gap));
    const entry = v.notAttributed.items.find((n) => n.sourceId === d.item.sourceId);
    const f = entry?.flags.find((x) => x.code === 'INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE');
    expect(f?.details).toMatchObject({ partsDiffer: true, notAttributed: true });
    expect(flagIsOpen('INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE', { treatment: 'DEDUCTIBLE', origin: 'DEFAULT', reviewState: 'SUGGESTED' }, f?.details)).toBe(
      false,
    );
    expect(v.review.open.map((o) => o.code)).toContain('LOAN_INTEREST_NOT_ATTRIBUTED');
  });

  it('a CLOSED Loan: a recorded period from the day after the last kept entry to the closing date matches the plan (question 5)', () => {
    const closed: LoanPeriodFacts = { ...quarterly, paymentDates: every('2027-03-31', 3, 1), closingDate: day('2027-05-15') };
    expect(deviationOf(day('2027-05-15'), range('2027-04-01', '2027-05-15'), closed)).toBeNull();
    expect(deviationOf(day('2027-05-15'), range('2027-04-01', '2027-05-14'), closed)).not.toBeNull();
    expect(deviationOf(day('2027-05-15'), range('2027-04-01', '2027-05-15'), { ...closed, closingDate: null })).not.toBeNull();
  });

  it('every split parts sum to its amount; per Loan and year attributed in P1 plus P2 is the Loan interest', () => {
    const splits = [debit('900.00', '2027-03-31', monthlyQ, quarter), debit('893.25', '2027-06-30', quarterly, range('2027-04-02', '2027-07-01'))];
    const sum = (pr: string) => BigInt((interestLine(viewOf(readOf(pr, splits, sets)))?.total.amount ?? '0').replace('.', ''));
    expect(sum(P1) + sum(P2)).toBe(179_325n);
  });
});

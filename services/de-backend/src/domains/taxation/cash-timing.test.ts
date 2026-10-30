import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import type { RentDueDay } from '../rental-contract-reference/index.js';
import { attributeTaxYear, dayIn, hausgeldTiming, interestTiming, needsTiming, refundOf, rentTiming, windowYearEnd, type TimingInput } from './cash-timing.js';
import { planClassification, type SplitFacts } from './classification.js';
import { deriveDepositTaxMeaning, depositNotCounted, planDepositClassification, type DepositFacts } from './deposit-closing.js';
import { TAX_RULES } from './rules/registry.js';

/**
 * VC-7-02 domain (api-design.md §58A, P7-D3, P7-D4): the window, each source's economic period and due date, the
 * 10-day rule and its flags, the override, refunds and repayments, and the retained deposit. Figures are invented.
 */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const at = (bookingDate: string, financialCategoryCode: string) => ({ bookingDate: day(bookingDate), financialCategoryCode });
const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);
const due = (entries: [string, number][]): RentDueDay[] => entries.map(([validFrom, d]) => ({ validFrom: day(validFrom), day: d }));

describe('the window (§58A: 22 December to 10 January, both inclusive)', () => {
  it('its edges, on both sides of the year-end', () => {
    expect(windowYearEnd(day('2026-12-21'), 10)).toBeUndefined();
    expect(windowYearEnd(day('2026-12-22'), 10)).toBe(2026);
    expect(windowYearEnd(day('2026-12-31'), 10)).toBe(2026);
    expect(windowYearEnd(day('2027-01-01'), 10)).toBe(2026);
    expect(windowYearEnd(day('2027-01-10'), 10)).toBe(2026);
    expect(windowYearEnd(day('2027-01-11'), 10)).toBeUndefined();
    expect(windowYearEnd(day('2027-06-15'), 10)).toBeUndefined();
  });

  it('only recurring categories in the window need a source; others take the booking year without a flag', () => {
    expect(needsTiming(TAX_RULES, at('2026-12-29', 'RENT_BASE'))).toBe(true);
    expect(needsTiming(TAX_RULES, at('2026-12-29', 'MAINTENANCE'))).toBe(false);
    expect(needsTiming(TAX_RULES, at('2026-12-21', 'RENT_BASE'))).toBe(false);
    const repair = attributeTaxYear(at('2026-12-29', 'MAINTENANCE'), undefined, null, TAX_RULES);
    expect(repair).toEqual({
      taxYear: 2026,
      attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2026, proposedYear: 2026, overridden: false },
      flags: [],
    });
  });

  it('a booking date before 2000 has no rule version: the booking year, rule null', () => {
    expect(attributeTaxYear(at('1999-12-30', 'RENT_BASE'), undefined, null, TAX_RULES).attribution.rule).toBeNull();
  });
});

describe('rent (§58A): the term of the reconciliation, the due day of the RentalContractReference', () => {
  it('a January rent paid on 29 December: without a reference January’s year with DUE_DATE_ASSUMED; day 3 the same without; day 15 December’s', () => {
    const rent = at('2026-12-29', 'RENT_BASE');
    const assumed = attributeTaxYear(rent, rentTiming('2027010100', null), null, TAX_RULES);
    expect(assumed.taxYear).toBe(2027);
    expect(assumed.flags).toEqual([
      { code: 'DUE_DATE_ASSUMED', details: { dueDate: '2027-01-01', economicPeriod: { from: '2027-01-01', to: '2027-01-31' } } },
      {
        code: 'ATTRIBUTED_BY_10_DAY_RULE',
        details: { bookingDate: '2026-12-29', dueDate: '2027-01-01', economicPeriod: { from: '2027-01-01', to: '2027-01-31' }, dueDateSource: 'PERIOD_START' },
      },
    ]);
    const third = attributeTaxYear(rent, rentTiming('2027010100', due([['2025-01-01', 3]])), null, TAX_RULES);
    expect([third.taxYear, codes(third.flags)]).toEqual([2027, ['ATTRIBUTED_BY_10_DAY_RULE']]);
    expect(third.flags[0]?.details).toMatchObject({ dueDate: '2027-01-03', dueDateSource: 'RENTAL_CONTRACT_REFERENCE' });
    expect(third.attribution).toEqual({ rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2026, proposedYear: 2027, overridden: false });
    const fifteenth = attributeTaxYear(rent, rentTiming('2027010100', due([['2025-01-01', 15]])), null, TAX_RULES);
    expect([fifteenth.taxYear, fifteenth.flags]).toEqual([2026, []]);
  });

  it('the reviewer’s example of #156: due on 15 January, paid on 28 December → the due date is outside the window: the year of payment', () => {
    const result = attributeTaxYear(at('2026-12-28', 'RENT_BASE'), rentTiming('2027010100', due([['2026-01-01', 15]])), null, TAX_RULES);
    expect([result.taxYear, result.attribution.proposedYear, result.flags]).toEqual([2026, 2026, []]);
  });

  it('rentDueDays over time: day 3 from 2025, day 15 from 2028; January 2027 takes 3, January 2029 takes 15; before the first entry assumed', () => {
    const days = due([
      ['2025-01-01', 3],
      ['2028-01-01', 15],
    ]);
    expect(rentTiming('2027010100', days)).toMatchObject({ dueDate: '2027-01-03', dueDateSource: 'RENTAL_CONTRACT_REFERENCE' });
    expect(rentTiming('2029010100', days)).toMatchObject({ dueDate: '2029-01-15', dueDateSource: 'RENTAL_CONTRACT_REFERENCE' });
    expect(rentTiming('2024120100', days)).toMatchObject({ dueDate: '2024-12-01', dueDateSource: 'PERIOD_START' });
    expect(rentTiming('2027010100', [])).toMatchObject({ dueDateSource: 'PERIOD_START' });
    // In a shorter month the day means the month's last day.
    expect(rentTiming('2027020100', due([['2025-01-01', 31]]))).toMatchObject({ dueDate: '2027-02-28' });
    expect(dayIn(2028, 2, 31)).toBe('2028-02-29');
  });

  it('a December rent paid on 2 January moves back; a rent paid late outside the window does not; no economic period is flagged', () => {
    const late = attributeTaxYear(at('2027-01-02', 'RENT_BASE'), rentTiming('2026120100', due([['2025-01-01', 28]])), null, TAX_RULES);
    expect([late.taxYear, codes(late.flags)]).toEqual([2026, ['ATTRIBUTED_BY_10_DAY_RULE']]);
    const due27 = attributeTaxYear(at('2027-01-11', 'RENT_BASE'), rentTiming('2026120100', due([['2025-01-01', 28]])), null, TAX_RULES);
    expect([due27.taxYear, due27.flags]).toEqual([2027, []]);
    // Due on 21 December: outside the window, so not moved although paid on 2 January.
    const early = attributeTaxYear(at('2027-01-02', 'RENT_BASE'), rentTiming('2026120100', due([['2025-01-01', 21]])), null, TAX_RULES);
    expect([early.taxYear, early.flags]).toEqual([2027, []]);
    const none: TimingInput = { kind: 'NO_ECONOMIC_PERIOD', reason: 'SEVERAL_TERMS' };
    const several = attributeTaxYear(at('2026-12-30', 'RENT_BASE'), none, null, TAX_RULES);
    expect([several.taxYear, several.flags]).toEqual([2026, [{ code: 'NO_ECONOMIC_PERIOD', details: { reason: 'SEVERAL_TERMS' } }]]);
    // The same rent mid-year needs no source and raises nothing.
    expect(attributeTaxYear(at('2026-06-01', 'RENT_BASE'), undefined, null, TAX_RULES).flags).toEqual([]);
  });
});

describe('Hausgeld (§58A): never moved on a guess', () => {
  it('a debit on 30 December with advanceDueDay 1: its booking year, ECONOMIC_PERIOD_ASSUMED with proposedYear Y+1', () => {
    const timing = hausgeldTiming(day('2026-12-30'), 1);
    expect(timing).toEqual({
      kind: 'PERIOD',
      economicPeriod: { from: '2027-01-01', to: '2027-01-31' },
      economicYear: 2027,
      dueDate: '2027-01-01',
      dueDateSource: 'ECONOMIC_PLAN',
      periodGuessed: true,
    });
    const result = attributeTaxYear(at('2026-12-30', 'WEG_RECOVERABLE'), timing, null, TAX_RULES);
    expect(result.taxYear).toBe(2026);
    expect(result.attribution).toMatchObject({ bookingYear: 2026, proposedYear: 2027, overridden: false });
    expect(result.flags).toEqual([
      {
        code: 'ECONOMIC_PERIOD_ASSUMED',
        details: { bookingDate: '2026-12-30', dueDate: '2027-01-01', economicPeriod: { from: '2027-01-01', to: '2027-01-31' }, proposedYear: 2027 },
      },
    ]);
    // Without advanceDueDay, day 1 is assumed and flagged too.
    const assumed = attributeTaxYear(at('2026-12-30', 'WEG_NON_RECOVERABLE'), hausgeldTiming(day('2026-12-30'), null), null, TAX_RULES);
    expect(codes(assumed.flags)).toEqual(['DUE_DATE_ASSUMED', 'ECONOMIC_PERIOD_ASSUMED']);
    // The user decides with taxYear: the override wins, the proposal stays visible.
    const decided = attributeTaxYear(at('2026-12-30', 'WEG_RECOVERABLE'), timing, 2027, TAX_RULES);
    expect([decided.taxYear, decided.attribution.overridden, codes(decided.flags)]).toEqual([2027, true, ['ECONOMIC_PERIOD_ASSUMED']]);
  });

  it('"nearest" and its tie towards the later month; a guess within the same year moves nothing', () => {
    expect(hausgeldTiming(day('2026-01-16'), 1)).toMatchObject({ dueDate: '2026-01-01' });
    // 15 February: 1 February and 1 March are 14 days away; the later month wins.
    expect(hausgeldTiming(day('2026-02-15'), 1)).toMatchObject({ dueDate: '2026-03-01' });
    expect(hausgeldTiming(day('2026-12-24'), 31)).toMatchObject({ dueDate: '2026-12-31', economicYear: 2026 });
    const same = attributeTaxYear(at('2026-12-24', 'WEG_RECOVERABLE'), hausgeldTiming(day('2026-12-24'), 31), null, TAX_RULES);
    expect([same.taxYear, same.flags]).toEqual([2026, []]);
  });
});

describe('loan interest (§58A): the nearest schedule entry', () => {
  const monthly = (dates: string[]) => dates.map(day);

  it('interest due on 2 January and debited on 30 December belongs to December’s period: the booking year, nothing moved', () => {
    const timing = interestTiming(day('2026-12-30'), monthly(['2026-11-02', '2026-12-02', '2027-01-02', '2027-02-02']));
    expect(timing).toMatchObject({ dueDate: '2027-01-02', economicPeriod: { from: '2026-12-03', to: '2027-01-02' }, economicYear: 2026 });
    expect(attributeTaxYear(at('2026-12-30', 'LOAN_INTEREST'), timing, null, TAX_RULES)).toMatchObject({ taxYear: 2026, flags: [] });
  });

  it('interest due on 30 December and debited on 4 January moves back to December’s year', () => {
    const timing = interestTiming(day('2027-01-04'), monthly(['2026-11-30', '2026-12-30', '2027-01-30']));
    expect(timing).toMatchObject({ dueDate: '2026-12-30', economicPeriod: { from: '2026-12-01', to: '2026-12-30' }, economicYear: 2026 });
    const result = attributeTaxYear(at('2027-01-04', 'LOAN_INTEREST'), timing, null, TAX_RULES);
    expect([result.taxYear, codes(result.flags)]).toEqual([2026, ['ATTRIBUTED_BY_10_DAY_RULE']]);
    expect(result.flags[0]?.details).toMatchObject({ dueDateSource: 'LOAN_SCHEDULE' });
  });

  it('a quarterly schedule: the period runs from the previous payment, not one month back', () => {
    const timing = interestTiming(day('2027-01-03'), monthly(['2026-06-30', '2026-09-30', '2026-12-31', '2027-03-31']));
    expect(timing).toMatchObject({ dueDate: '2026-12-31', economicPeriod: { from: '2026-10-01', to: '2026-12-31' }, economicYear: 2026 });
    // Paid on 3 January for the quarter ending 31 December: moved back.
    expect(attributeTaxYear(at('2027-01-03', 'LOAN_INTEREST'), timing, null, TAX_RULES).taxYear).toBe(2026);
    // A quarter spanning the year-end (due 15 January) belongs mostly to the old year.
    expect(interestTiming(day('2027-01-14'), monthly(['2026-10-15', '2027-01-15']))).toMatchObject({
      economicPeriod: { from: '2026-10-16', to: '2027-01-15' },
      economicYear: 2026,
    });
  });

  it('"nearest" ties towards the later entry; the first entry’s period is the month before; no schedule is NO_ECONOMIC_PERIOD', () => {
    expect(interestTiming(day('2026-12-16'), monthly(['2026-12-01', '2026-12-31']))).toMatchObject({ dueDate: '2026-12-31' });
    expect(interestTiming(day('2027-01-01'), monthly(['2027-01-01']))).toMatchObject({
      economicPeriod: { from: '2026-12-02', to: '2027-01-01' },
      economicYear: 2026,
    });
    expect(interestTiming(day('2026-12-30'), [])).toEqual({ kind: 'NO_ECONOMIC_PERIOD', reason: 'NO_SCHEDULE' });
  });
});

describe('refunds and repayments (§58A, P7-D4, A10)', () => {
  it('a refund of the same, an earlier and an unknown year', () => {
    expect(refundOf('INFLOW', 'MAINTENANCE', 2027, null, 2027)).toEqual({
      refund: { kind: 'REFUND', ofYear: 2027, ofYearSource: 'CLASSIFICATION', presentation: 'REDUCES_LINE', line: 'MAINTENANCE' },
      flags: [],
    });
    expect(refundOf('INFLOW', 'WEG_HAUSGELD', 2027, 2026, null)).toEqual({
      refund: { kind: 'REFUND', ofYear: 2026, ofYearSource: 'WEG_ANNUAL_STATEMENT', presentation: 'INCOME', line: 'REFUNDS_OF_EARLIER_YEARS' },
      flags: [],
    });
    // The statement wins over the classification.
    expect(refundOf('INFLOW', 'WEG_HAUSGELD', 2027, 2027, 2025).refund).toMatchObject({ ofYear: 2027, presentation: 'REDUCES_LINE' });
    expect(refundOf('INFLOW', 'INSURANCE', 2027, null, null)).toEqual({
      refund: { kind: 'REFUND', ofYear: null, ofYearSource: null, presentation: 'REDUCES_LINE', line: 'INSURANCE' },
      flags: [{ code: 'REFUND_YEAR_UNKNOWN', details: {} }],
    });
  });

  it('an operating-cost credit paid back in Y+1 for Y reduces Y+1’s line, never REFUNDS_OF_EARLIER_YEARS', () => {
    expect(refundOf('OUTFLOW', 'OPERATING_COST_SETTLEMENT', 2027, null, 2026)).toEqual({
      refund: { kind: 'REPAYMENT', ofYear: 2026, ofYearSource: 'CLASSIFICATION', presentation: 'REDUCES_LINE', line: 'OPERATING_COST_SETTLEMENT' },
      flags: [],
    });
  });

  it('neither: an expense paid, income received, a line not relevant or unclassified', () => {
    expect(refundOf('OUTFLOW', 'MAINTENANCE', 2027, null, null).refund).toBeNull();
    expect(refundOf('INFLOW', 'RENT', 2027, null, null).refund).toBeNull();
    expect(refundOf('INFLOW', 'NOT_RELEVANT', 2027, null, null).refund).toBeNull();
    expect(refundOf('INFLOW', 'UNCLASSIFIED', 2027, null, null).refund).toBeNull();
  });
});

describe('a create’s years (§58A)', () => {
  const facts = (overrides: Partial<SplitFacts> = {}): SplitFacts => ({
    splitId: 's-1',
    transactionId: 't-1',
    position: 1,
    bookingDate: day('2026-12-29'),
    direction: 'INFLOW',
    amount: eur('900.00'),
    financialCategoryCode: 'RENT_BASE',
    categoryType: 'INCOME',
    propertyReferenceId: 'p-1',
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    ...overrides,
  });
  const request = { treatment: 'INCOME' as const, supersedes: null };

  it('taxYear the booking year ± 1, else TAX_YEAR_OUT_OF_RANGE; refundOfYear at most the tax year, else REFUND_YEAR_OUT_OF_RANGE', () => {
    for (const taxYear of [2025, 2026, 2027]) expect(planClassification(facts(), null, { ...request, taxYear }, TAX_RULES).kind).toBe('CLASSIFY');
    expect(planClassification(facts(), null, { ...request, taxYear: 2028 }, TAX_RULES)).toEqual({
      kind: 'TAX_YEAR_OUT_OF_RANGE',
      taxYear: 2028,
      bookingYear: 2026,
    });
    expect(planClassification(facts(), null, { ...request, taxYear: 2024 }, TAX_RULES).kind).toBe('TAX_YEAR_OUT_OF_RANGE');
    // Without taxYear, the rule's year (here 2027 by the 10-day rule) bounds refundOfYear.
    expect(planClassification(facts(), null, { ...request, refundOfYear: 2027 }, TAX_RULES, 2027).kind).toBe('CLASSIFY');
    expect(planClassification(facts(), null, { ...request, refundOfYear: 2027 }, TAX_RULES)).toEqual({
      kind: 'REFUND_YEAR_OUT_OF_RANGE',
      refundOfYear: 2027,
      taxYear: 2026,
    });
    expect(planClassification(facts(), null, { ...request, taxYear: 2025, refundOfYear: 2026 }, TAX_RULES).kind).toBe('REFUND_YEAR_OUT_OF_RANGE');
    // TREATMENT_NOT_ALLOWED comes first, the supersedes checks after.
    expect(
      planClassification(facts({ financialCategoryCode: 'TRANSFER', categoryType: 'TRANSFER' }), null, { ...request, taxYear: 2030 }, TAX_RULES).kind,
    ).toBe('TREATMENT_NOT_ALLOWED');
    expect(planClassification(facts(), 'c-1', { ...request, taxYear: 2030 }, TAX_RULES).kind).toBe('TAX_YEAR_OUT_OF_RANGE');
  });
});

describe('the retained deposit (§58A, A11)', () => {
  const closed = (overrides: Partial<DepositFacts> = {}): DepositFacts => ({
    securityDepositId: 'd-1',
    status: 'CLOSED',
    closingDate: day('2027-06-30'),
    retainedAmount: eur('400.00'),
    propertyReferenceId: 'p-1',
    propertyCandidates: ['p-1'],
    ...overrides,
  });

  it('the default: UNCLASSIFIED, no treatment, NEEDS_REVIEW, in the closing year; never income', () => {
    expect(deriveDepositTaxMeaning(closed(), null, TAX_RULES, day('2027-10-30'))).toMatchObject({
      sourceType: 'DEPOSIT_CLOSING',
      sourceId: 'd-1',
      counts: true,
      taxYear: 2027,
      amount: eur('400.00'),
      taxCategory: 'UNCLASSIFIED',
      treatment: null,
      reviewState: 'NEEDS_REVIEW',
      origin: 'DEFAULT',
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      flags: [],
    });
  });

  it('no PropertyReference is flagged, never silent: no reconciled rent, or several (review on #166)', () => {
    const today = day('2027-10-30');
    expect(deriveDepositTaxMeaning(closed({ propertyReferenceId: null, propertyCandidates: [] }), null, TAX_RULES, today).flags).toEqual([
      { code: 'NO_PROPERTY_REFERENCE', details: { reason: 'NO_RECONCILED_RENT' } },
    ]);
    expect(deriveDepositTaxMeaning(closed({ propertyReferenceId: null, propertyCandidates: ['p-2', 'p-1'] }), null, TAX_RULES, today).flags).toEqual([
      { code: 'NO_PROPERTY_REFERENCE', details: { reason: 'SEVERAL_PROPERTY_REFERENCES', candidates: ['p-1', 'p-2'] } },
    ]);
  });

  it('its lines and treatments only; not counted when not CLOSED, nothing retained, or closed again', () => {
    const plan = (taxCategory: string, treatment: string | null) =>
      planDepositClassification(closed(), null, { taxCategory: taxCategory as never, treatment: treatment as never, supersedes: null }, TAX_RULES);
    expect(plan('RETAINED_DEPOSIT_RENT', 'INCOME')).toEqual({
      kind: 'CLASSIFY',
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      closingDate: '2027-06-30',
    });
    expect(plan('RETAINED_DEPOSIT_DAMAGES', 'INCOME').kind).toBe('CLASSIFY');
    expect(plan('NOT_RELEVANT', 'NOT_RELEVANT').kind).toBe('CLASSIFY');
    for (const [category, treatment] of [
      ['RENT', 'INCOME'],
      ['MAINTENANCE', 'DEDUCTIBLE'],
      ['UNCLASSIFIED', null],
      ['RETAINED_DEPOSIT_RENT', 'DEDUCTIBLE'],
    ] as const) {
      expect(plan(category, treatment)).toEqual({
        kind: 'TREATMENT_NOT_ALLOWED',
        categoryType: null,
        allowed: ['INCOME', 'NOT_RELEVANT'],
        taxCategories: ['RETAINED_DEPOSIT_RENT', 'RETAINED_DEPOSIT_DAMAGES', 'NOT_RELEVANT'],
      });
    }
    expect(depositNotCounted(closed({ status: 'ACTIVE', closingDate: null, retainedAmount: eur('0.00') }), null)?.reason).toBe('NOT_CLOSED');
    expect(depositNotCounted(closed({ retainedAmount: eur('0.00') }), null)?.reason).toBe('NOTHING_RETAINED');
    const of = { depositClosing: { closingDate: day('2027-06-30'), retainedAmount: eur('400.00') } };
    expect(depositNotCounted(closed(), of)).toBeNull();
    expect(depositNotCounted(closed({ closingDate: day('2027-07-31') }), of)?.reason).toBe('CLOSING_CHANGED');
    expect(depositNotCounted(closed({ retainedAmount: eur('300.00') }), of)?.reason).toBe('CLOSING_CHANGED');
    expect(
      planDepositClassification(closed({ status: 'ACTIVE' }), null, { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', supersedes: null }, TAX_RULES),
    ).toMatchObject({
      kind: 'DEPOSIT_NOT_COUNTED',
      reason: 'NOT_CLOSED',
    });
  });
});

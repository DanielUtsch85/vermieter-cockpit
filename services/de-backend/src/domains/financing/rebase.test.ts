import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { debtOn, remainingDebt, type CountedSplit } from './debt.js';
import type { Loan } from './loan.js';
import { reconciledPlan } from './rebase.js';
import { loanSchedule, type LoanTermsId, type SchedulePeriod } from './terms.js';

/**
 * VC-X-53: the plan reconciled with the real bookings (api-design.md §58O open question 12 (b), (c); Entscheidung des
 * Projektinhabers, 2026-11-05, question 12): Loan F's stub, Loan M's special repayment, a debit a day early and late, a
 * missed payment, interval 3, no booked payment, `fixedRateEnd`, the flag once, and the contract plan beside it.
 * Synthetic figures only.
 */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const loanOf = (overrides: Partial<Loan> = {}) =>
  ({
    id: 'loan-f',
    mreRealmId: 'realm',
    status: 'ACTIVE',
    principalOriginal: eur('120000.00'),
    startDate: day('2027-01-01'),
    disbursementDate: null,
    maturityDate: null,
    closingDate: null,
    closingReason: null,
    refinancedByLoanId: null,
    ...overrides,
  }) as unknown as Loan;
const period = (overrides: Partial<SchedulePeriod> = {}): SchedulePeriod => ({
  id: 't1' as LoanTermsId,
  validFrom: day('2027-01-01'),
  interestRate: 3000n,
  repaymentModel: 'ANNUITY',
  scheduledPayment: eur('600.00'),
  firstPaymentDate: day('2027-01-31'),
  principalAtStart: null,
  fixedRateUntil: null,
  paymentIntervalMonths: 1,
  ...overrides,
});
const debit = (transactionId: string, bookingDate: string, interest: bigint, principal: bigint): CountedSplit[] => [
  { transactionId, bookingDate: day(bookingDate), category: 'LOAN_INTEREST', amount: interest },
  { transactionId, bookingDate: day(bookingDate), category: 'LOAN_PRINCIPAL', amount: principal },
];
const special = (transactionId: string, bookingDate: string, principal: bigint): CountedSplit[] => [
  { transactionId, bookingDate: day(bookingDate), category: 'LOAN_PRINCIPAL', amount: principal },
];
const rows = (entries: readonly { paymentDate: string; interest: bigint; principal: bigint; balanceAfter: bigint }[]) =>
  entries.map((e) => [e.paymentDate, e.interest, e.principal, e.balanceAfter]);

/** Loan F: paid out 2027-04-25, monthly from 2027-05-31; the bank charged 36 days in the first debit (case A of #121). */
const loanF = loanOf({ disbursementDate: day('2027-04-25') });
const termsF = [period({ validFrom: day('2027-04-25'), firstPaymentDate: day('2027-05-31') })];
const stubF = debit('f-1', '2027-05-31', 36_000n, 24_000n);

describe('the rebase (§58O question 12 (b))', () => {
  it('without a booked payment: rebasedOn null, the plan byte for byte the contract plan', () => {
    const r = reconciledPlan(loanF, termsF, []);
    expect(r.rebases).toEqual([]);
    expect(r.plan.schedule).toEqual(loanSchedule(loanF, termsF));
    expect(debtOn(loanF, termsF, [], day('2027-06-15'))).toMatchObject({ planned: 11_970_000n, plannedAsContracted: 11_970_000n, rebasedOn: null });
  });

  it('Loan F after the stub: the next entries from the actual 119 760.00; difference 0.00, differenceAsContracted +60.00', () => {
    const r = reconciledPlan(loanF, termsF, stubF);
    expect(r.rebases).toEqual([{ bookingDate: '2027-05-31', entryNumber: 1, actualBalance: 11_976_000n, transactionId: 'f-1', flags: expect.any(Array) }]);
    expect(rows(r.plan.schedule.entries.slice(0, 3))).toEqual([
      // Entry 1 stays the contract's; it is the booked one.
      ['2027-05-31', 30_000n, 30_000n, 11_970_000n],
      ['2027-06-30', 29_940n, 30_060n, 11_945_940n],
      ['2027-07-31', 29_865n, 30_135n, 11_915_805n],
    ]);
    expect(rows(r.contract.schedule.entries.slice(1, 3))).toEqual([
      ['2027-06-30', 29_925n, 30_075n, 11_939_925n],
      ['2027-07-31', 29_850n, 30_150n, 11_909_775n],
    ]);
    expect(debtOn(loanF, termsF, stubF, day('2027-06-15'))).toMatchObject({
      actual: 11_976_000n,
      planned: 11_976_000n,
      difference: 0n,
      plannedAsContracted: 11_970_000n,
      differenceAsContracted: 6_000n,
      rebasedOn: { bookingDate: '2027-05-31', entryNumber: 1, actualBalance: 11_976_000n },
    });
    // Before the booking, the contract plan: nothing rebased yet.
    expect(debtOn(loanF, termsF, stubF, day('2027-05-30'))).toMatchObject({ planned: 12_000_000n, plannedAsContracted: 12_000_000n, rebasedOn: null });
  });

  it('BOOKED_SPLIT_DIFFERS_FROM_PLAN once: on entry 1, not on entry 2 booked as rebased', () => {
    const both = [...stubF, ...debit('f-2', '2027-06-30', 29_940n, 30_060n)];
    const r = reconciledPlan(loanF, termsF, both);
    expect([...r.deviations.entries()]).toEqual([
      [
        1,
        [
          {
            code: 'BOOKED_SPLIT_DIFFERS_FROM_PLAN',
            transactionId: 'f-1',
            booked: { interest: 36_000n, principal: 24_000n },
            planned: { interest: 30_000n, principal: 30_000n },
          },
        ],
      ],
    ]);
    expect(r.rebases.map((x) => [x.entryNumber, x.flags.length])).toEqual([
      [1, 1],
      [2, 0],
    ]);
    expect(rows(r.plan.schedule.entries.slice(2, 3))).toEqual([['2027-07-31', 29_865n, 30_135n, 11_915_805n]]);
    // Booked exactly as the contract plan: no flag at all.
    expect(reconciledPlan(loanF, termsF, debit('f-1', '2027-05-31', 30_000n, 30_000n)).deviations.size).toBe(0);
  });

  it('Loan M after a special repayment: it matches no entry, the rebase starts with entry 2 (286.75 / 313.25 / 114 386.75)', () => {
    const loanM = loanOf();
    const terms = [period()];
    const splits = [...debit('m-1', '2027-01-31', 30_000n, 30_000n), ...special('m-s', '2027-02-15', 500_000n)];
    const r = reconciledPlan(loanM, terms, splits);
    expect(r.rebases.at(-1)).toMatchObject({ bookingDate: '2027-02-15', entryNumber: 1, actualBalance: 11_470_000n, transactionId: 'm-s', flags: [] });
    expect(rows(r.plan.schedule.entries.slice(0, 3))).toEqual([
      ['2027-01-31', 30_000n, 30_000n, 11_970_000n],
      ['2027-02-28', 28_675n, 31_325n, 11_438_675n],
      ['2027-03-31', 28_597n, 31_403n, 11_407_272n],
    ]);
    expect(r.contract.schedule.entries[1]).toMatchObject({ interest: 29_925n, principal: 30_075n, balanceAfter: 11_939_925n });
    expect(debtOn(loanM, terms, splits, day('2027-02-20'))).toMatchObject({
      actual: 11_470_000n,
      planned: 11_470_000n,
      difference: 0n,
      differenceAsContracted: -500_000n,
    });
    expect(r.deviations.size).toBe(0);
  });

  it('a debit a day early and a day late: matched to its entry, which is not planned twice', () => {
    const terms = [period()];
    const one = debit('m-1', '2027-01-31', 30_000n, 30_000n);
    for (const booked of ['2027-02-27', '2027-03-01']) {
      const splits = [...one, ...debit('m-2', booked, 29_925n, 30_075n)];
      const r = reconciledPlan(loanOf(), terms, splits);
      expect(r.rebases.at(-1)).toMatchObject({ bookingDate: booked, entryNumber: 2, actualBalance: 11_939_925n });
      expect(r.plan.schedule).toEqual(r.contract.schedule);
      expect(r.deviations.size).toBe(0);
      expect(debtOn(loanOf(), terms, splits, day(booked))).toMatchObject({ planned: 11_939_925n, difference: 0n });
    }
    // Booked early, the day itself already shows the debit; the contract plan still shows the entry before it.
    expect(debtOn(loanOf(), terms, [...one, ...debit('m-2', '2027-02-27', 29_925n, 30_075n)], day('2027-02-27'))).toMatchObject({
      plannedAsContracted: 11_970_000n,
      differenceAsContracted: -30_075n,
    });
  });

  it('a missed payment: the next booked one re-anchors from the actual debt, nothing propagates', () => {
    const terms = [period()];
    const splits = [...debit('m-1', '2027-01-31', 30_000n, 30_000n), ...debit('m-3', '2027-03-31', 29_850n, 30_150n)];
    const r = reconciledPlan(loanOf(), terms, splits);
    expect(r.rebases.at(-1)).toMatchObject({ entryNumber: 3, actualBalance: 11_939_850n });
    expect(rows(r.plan.schedule.entries.slice(3, 4))).toEqual([['2027-04-30', 29_850n, 30_150n, 11_909_700n]]);
    expect(debtOn(loanOf(), terms, splits, day('2027-03-31'))).toMatchObject({ planned: 11_939_850n, difference: 0n, differenceAsContracted: 30_075n });
    // Between the two, before the third is booked: the plan rebased after entry 1 still shows entry 2 due.
    expect(debtOn(loanOf(), terms, splits, day('2027-03-15'))).toMatchObject({ actual: 11_970_000n, planned: 11_939_925n, difference: 30_075n });
  });

  it('interval 3: a stub on the first quarterly debit, the next entry from 119 160.00', () => {
    const terms = [period({ scheduledPayment: eur('1800.00'), firstPaymentDate: day('2027-03-31'), paymentIntervalMonths: 3 })];
    const r = reconciledPlan(loanOf(), terms, debit('q-1', '2027-03-31', 96_000n, 84_000n));
    expect(rows(r.plan.schedule.entries.slice(1, 2))).toEqual([['2027-06-30', 89_370n, 90_630n, 11_825_370n]]);
    expect(r.deviations.get(1)?.[0]?.planned).toEqual({ interest: 90_000n, principal: 90_000n });
  });

  it('fixedRateEnd from the rebased plan, in the schedule and the remaining debt alike', () => {
    const terms = [{ ...(termsF[0] as SchedulePeriod), fixedRateUntil: day('2027-07-31') }];
    const r = reconciledPlan(loanF, terms, stubF);
    expect(r.plan.schedule.summary.fixedRateEnd).toEqual({ date: '2027-07-31', balance: 11_915_805n });
    expect(r.contract.schedule.summary.fixedRateEnd).toEqual({ date: '2027-07-31', balance: 11_909_775n });
    const debt = remainingDebt({ loan: loanF, periods: terms, sets: [], splits: stubF, statements: [] }, day('2027-06-15'), false);
    expect(debt.kind === 'LOAN_LEVEL' && debt.debt.fixedRateEnd).toEqual({ date: '2027-07-31', balance: 11_915_805n });
  });

  it('a large special repayment ends the rebased plan earlier; the contract plan (Taxation dates) keeps every entry', () => {
    const terms = [period()];
    const splits = [...debit('m-1', '2027-01-31', 30_000n, 30_000n), ...special('m-s', '2027-02-10', 11_940_000n)];
    const r = reconciledPlan(loanOf(), terms, splits);
    expect(rows(r.plan.schedule.entries.slice(1))).toEqual([['2027-02-28', 75n, 30_000n, 0n]]);
    expect(r.plan.schedule.summary.endReason).toBe('PAID_OFF');
    expect(loanSchedule(loanOf(), terms).entries.length).toBe(r.contract.schedule.entries.length);
    expect(r.contract.schedule.entries.length).toBeGreaterThan(200);
  });

  it('a CLOSED Loan: the rebased plan cut at its closing as the contract plan', () => {
    const closed = loanOf({ status: 'CLOSED', closingDate: day('2027-07-15') });
    const r = reconciledPlan(closed, termsF, stubF);
    expect([r.plan.schedule.entries.length, r.plan.schedule.summary.endReason, r.plan.schedule.summary.balanceDue]).toEqual([2, 'CLOSED', 11_945_940n]);
  });
});

describe('the actual remaining debt a restart starts from (§41.6, never below 0)', () => {
  /** A small Loan of 1 000.00; a special repayment of 1 200.00 overpays it by 200.00. Synthetic figures only. */
  const small = loanOf({ principalOriginal: eur('1000.00') });
  const terms = [period({ scheduledPayment: eur('100.00') })];

  it('an overpayment anchors the plan at 0.00, not at the negative remainder', () => {
    const r = reconciledPlan(small, terms, special('s-over', '2027-02-15', 120_000n));
    expect(r.rebases.map((x) => [x.bookingDate, x.actualBalance])).toEqual([['2027-02-15', 0n]]);
  });

  it('counter-check: a special repayment below the debt anchors at the actual remainder', () => {
    const r = reconciledPlan(small, terms, special('s-part', '2027-02-15', 40_000n));
    expect(r.rebases.map((x) => [x.bookingDate, x.actualBalance])).toEqual([['2027-02-15', 60_000n]]);
  });
});

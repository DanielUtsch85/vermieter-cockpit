import { describe, expect, it } from 'vitest';
import { addDays, addMonths, Money, type BusinessDate } from '../../shared/index.js';
import type { Loan } from './loan.js';
import { nearestEntry } from './payment-proposal.js';
import {
  MAX_PAYMENTS,
  checkAppend,
  closedSchedule,
  loanSchedule,
  monthlyInterest,
  periodInterest,
  plannedBalanceOn,
  scheduleOf,
  termsFingerprint,
  toCents,
  type LoanTerms,
  type LoanTermsData,
  type LoanTermsId,
  type PaymentIntervalMonths,
  type Schedule,
  type ScheduleEndReason,
  type ScheduleEntry,
  type SchedulePeriod,
} from './terms.js';

/**
 * VC-X-53: the payment interval of api-design.md §58O (Entscheidung des Projektinhabers, 2026-11-05, questions 1–5, 9):
 * Loan M's and Loan Q's tables, the day of month 29–31, the first period, an interval change, a closing mid-interval,
 * the cap in months, the annuity check, and the monthly plan byte for byte against today's derivation kept as an
 * oracle. Synthetic figures only.
 */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
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
const loanM = period();
const loanQ = period({ scheduledPayment: eur('1800.00'), firstPaymentDate: day('2027-03-31'), paymentIntervalMonths: 3 });
const io = (overrides: Partial<SchedulePeriod> = {}) => period({ repaymentModel: 'INTEREST_ONLY', scheduledPayment: null, ...overrides });
const rows = (schedule: Schedule) => schedule.entries.map((e) => [e.number, e.paymentDate, e.balanceBefore, e.interest, e.principal, e.balanceAfter]);
const dates = (schedule: Schedule) => schedule.entries.map((e) => e.paymentDate);
const of = (...periods: SchedulePeriod[]) => scheduleOf(eur('120000.00'), null, periods);

describe('the payment interval (§58O rules 2–5)', () => {
  it('Loan M monthly: unchanged, entry 12 and the year 2027 as before', () => {
    const plan = of(loanM);
    expect(rows(plan).slice(0, 4)).toEqual([
      [1, '2027-01-31', 12_000_000n, 30_000n, 30_000n, 11_970_000n],
      [2, '2027-02-28', 11_970_000n, 29_925n, 30_075n, 11_939_925n],
      [3, '2027-03-31', 11_939_925n, 29_850n, 30_150n, 11_909_775n],
      [4, '2027-04-30', 11_909_775n, 29_774n, 30_226n, 11_879_549n],
    ]);
    expect(rows(plan)[11]).toEqual([12, '2027-12-31', 11_665_844n, 29_165n, 30_835n, 11_635_009n]);
    const year = plan.entries.filter((e) => e.paymentDate.startsWith('2027-'));
    expect([year.length, year.reduce((s, e) => s + e.interest, 0n), year.reduce((s, e) => s + e.principal, 0n)]).toEqual([12, 355_009n, 364_991n]);
  });

  it('Loan Q quarterly: row for row, the year 2027, and the plan without the interval for comparison', () => {
    const plan = of(loanQ);
    expect(rows(plan).slice(0, 4)).toEqual([
      [1, '2027-03-31', 12_000_000n, 90_000n, 90_000n, 11_910_000n],
      [2, '2027-06-30', 11_910_000n, 89_325n, 90_675n, 11_819_325n],
      [3, '2027-09-30', 11_819_325n, 88_645n, 91_355n, 11_727_970n],
      [4, '2027-12-31', 11_727_970n, 87_960n, 92_040n, 11_635_930n],
    ]);
    const year = plan.entries.filter((e) => e.paymentDate.startsWith('2027-'));
    expect([year.length, year.reduce((s, e) => s + e.interest, 0n), year.reduce((s, e) => s + e.principal, 0n)]).toEqual([4, 355_930n, 364_070n]);
    // The same contract entered without the interval: monthly from 2027-03-31 with 1 800.00.
    const today = of({ ...loanQ, paymentIntervalMonths: 1 });
    expect(rows(today).slice(0, 2)).toEqual([
      [1, '2027-03-31', 12_000_000n, 30_000n, 150_000n, 11_850_000n],
      [2, '2027-04-30', 11_850_000n, 29_625n, 150_375n, 11_699_625n],
    ]);
    expect(today.entries.filter((e) => e.paymentDate.startsWith('2027-')).at(-1)?.balanceAfter).toBe(10_483_012n);
  });

  it('the interest of a period: one rounding over the months; with 1 the monthly interest', () => {
    expect(periodInterest(11_819_325n, 3000n, 3)).toBe(88_645n); // 886.449375
    expect(periodInterest(11_727_970n, 3000n, 3)).toBe(87_960n); // 879.59775
    expect(periodInterest(12_000_000n, 3000n, 12)).toBe(360_000n);
    expect(periodInterest(12_000_000n, 3000n, 6)).toBe(180_000n);
    for (const balance of [1n, 333n, 11_939_925n, 98_765_432n]) expect(periodInterest(balance, 3450n, 1)).toBe(monthlyInterest(balance, 3450n));
  });

  it('half-yearly and yearly plans: every 6 and 12 months with that interval interest', () => {
    const half = of(period({ scheduledPayment: eur('3600.00'), firstPaymentDate: day('2027-06-30'), paymentIntervalMonths: 6 }));
    expect(rows(half).slice(0, 2)).toEqual([
      [1, '2027-06-30', 12_000_000n, 180_000n, 180_000n, 11_820_000n],
      [2, '2027-12-30', 11_820_000n, 177_300n, 182_700n, 11_637_300n],
    ]);
    const yearly = of(period({ scheduledPayment: eur('7200.00'), firstPaymentDate: day('2027-12-31'), paymentIntervalMonths: 12 }));
    expect(rows(yearly).slice(0, 2)).toEqual([
      [1, '2027-12-31', 12_000_000n, 360_000n, 360_000n, 11_640_000n],
      [2, '2028-12-31', 11_640_000n, 349_200n, 370_800n, 11_269_200n],
    ]);
  });

  it('the day of month 29–31: always counted from firstPaymentDate and clamped (a counter-check counting from the previous date drifts)', () => {
    const plan = (first: string, n: PaymentIntervalMonths, count: number) =>
      dates(scheduleOf(eur('1000.00'), null, [io({ validFrom: day(first), firstPaymentDate: day(first), paymentIntervalMonths: n })])).slice(0, count);
    expect(plan('2027-01-31', 3, 5)).toEqual(['2027-01-31', '2027-04-30', '2027-07-31', '2027-10-31', '2028-01-31']);
    expect(plan('2027-11-30', 3, 4)).toEqual(['2027-11-30', '2028-02-29', '2028-05-30', '2028-08-30']);
    expect(plan('2027-08-31', 6, 3)).toEqual(['2027-08-31', '2028-02-29', '2028-08-31']);
    expect(plan('2028-02-29', 12, 5)).toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
    // Counter-check: from the previous, clamped date the quarterly plan from the 31st would drift to the 30th.
    const drift = [day('2027-01-31')];
    for (let k = 1; k < 4; k++) drift.push(addMonths(drift[k - 1] as BusinessDate, 3));
    expect(drift).toEqual(['2027-01-31', '2027-04-30', '2027-07-30', '2027-10-30']);
    expect(plan('2027-01-31', 3, 4)).not.toEqual(drift);
  });

  it('the first entry charges its full interval, also after a later debtFrom (rule 4, question 3)', () => {
    const plan = of({ ...loanQ, validFrom: day('2027-01-15') });
    expect(plan.entries[0]).toMatchObject({ paymentDate: '2027-03-31', interest: 90_000n, principal: 90_000n });
  });

  it('an interval change by new terms: monthly to quarterly and quarterly to yearly, the balance carried, each period its own rhythm', () => {
    const quarterly = period({
      id: 't2' as LoanTermsId,
      validFrom: day('2027-04-01'),
      scheduledPayment: eur('1800.00'),
      firstPaymentDate: day('2027-06-30'),
      paymentIntervalMonths: 3,
    });
    const plan = of(loanM, quarterly);
    expect(plan.entries.slice(0, 5).map((e) => [e.termsId, e.paymentDate, e.balanceBefore, e.interest])).toEqual([
      ['t1', '2027-01-31', 12_000_000n, 30_000n],
      ['t1', '2027-02-28', 11_970_000n, 29_925n],
      ['t1', '2027-03-31', 11_939_925n, 29_850n],
      // The carried balance, one quarter's interest.
      ['t2', '2027-06-30', 11_909_775n, 89_323n],
      ['t2', '2027-09-30', 11_909_775n - 90_677n, periodInterest(11_909_775n - 90_677n, 3000n, 3)],
    ]);
    const yearly = period({
      id: 't2' as LoanTermsId,
      validFrom: day('2028-01-01'),
      scheduledPayment: eur('7200.00'),
      firstPaymentDate: day('2028-12-31'),
      paymentIntervalMonths: 12,
    });
    const qy = of(loanQ, yearly);
    expect(qy.entries.slice(2, 6).map((e) => [e.termsId, e.paymentDate])).toEqual([
      ['t1', '2027-09-30'],
      ['t1', '2027-12-31'],
      ['t2', '2028-12-31'],
      ['t2', '2029-12-31'],
    ]);
    expect(qy.entries[4]).toMatchObject({ balanceBefore: 11_635_930n, interest: periodInterest(11_635_930n, 3000n, 12) });
  });

  it('a closing mid-interval: the entries after it omitted, CLOSED, balanceDue the omitted entry balanceBefore; on a payment date that entry kept', () => {
    const loan = (closingDate: string) =>
      ({ principalOriginal: eur('120000.00'), maturityDate: null, status: 'CLOSED', closingDate: day(closingDate) }) as unknown as Loan;
    const mid = loanSchedule(loan('2027-05-15'), [loanQ]);
    expect([dates(mid), mid.summary.endReason, mid.summary.balanceDue]).toEqual([['2027-03-31'], 'CLOSED', 11_910_000n]);
    const onDate = loanSchedule(loan('2027-06-30'), [loanQ]);
    expect([dates(onDate), onDate.summary.endReason, onDate.summary.balanceDue]).toEqual([['2027-03-31', '2027-06-30'], 'CLOSED', 11_819_325n]);
    // A plan that ended before the closing keeps its reason.
    const short = scheduleOf(eur('1000.00'), null, [period({ scheduledPayment: eur('600.00'), paymentIntervalMonths: 3 })]);
    expect(closedSchedule(short, day('2030-01-01')).summary.endReason).toBe('PAID_OFF');
  });

  it('the cap is 600 months of intervals: 200 quarterly, 100 half-yearly, 50 yearly payments PAYMENT_CAP; 600 monthly unchanged', () => {
    const capped = (n: PaymentIntervalMonths) => scheduleOf(eur('1000.00'), null, [io({ paymentIntervalMonths: n })]).summary;
    expect(capped(1)).toMatchObject({ payments: MAX_PAYMENTS, endReason: 'PAYMENT_CAP', lastPaymentDate: '2076-12-31' });
    expect(capped(3)).toMatchObject({ payments: 200, endReason: 'PAYMENT_CAP', lastPaymentDate: '2076-10-31' });
    expect(capped(6)).toMatchObject({ payments: 100, endReason: 'PAYMENT_CAP', lastPaymentDate: '2076-07-31' });
    expect(capped(12)).toMatchObject({ payments: 50, endReason: 'PAYMENT_CAP', lastPaymentDate: '2076-01-31' });
  });

  it('MATURITY between two quarterly entries; the planned balance steps once a quarter', () => {
    const cut = scheduleOf(eur('120000.00'), day('2027-08-15'), [loanQ]);
    expect([dates(cut), cut.summary.endReason, cut.summary.balanceDue]).toEqual([['2027-03-31', '2027-06-30'], 'MATURITY', 11_819_325n]);
    const planned = (d: string) => plannedBalanceOn(eur('120000.00'), null, [loanQ], addDays(day(d), 1));
    expect([planned('2027-02-15'), planned('2027-05-15'), planned('2027-12-31')]).toEqual([12_000_000n, 11_910_000n, 11_635_930n]);
  });

  it('the proposal entry: the nearest of the quarterly plan (a tie towards the earlier)', () => {
    const plan = of(loanQ);
    expect(nearestEntry(plan.entries, day('2027-05-15'))?.paymentDate).toBe('2027-03-31');
    expect(nearestEntry(plan.entries, day('2027-05-16'))?.paymentDate).toBe('2027-06-30');
  });
});

describe('the terms with an interval (§58O rule 6, API idempotency)', () => {
  const loan = {
    id: 'l',
    status: 'ACTIVE',
    principalOriginal: eur('120000.00'),
    startDate: day('2027-01-01'),
    disbursementDate: null,
    maturityDate: null,
  } as unknown as Loan;
  const data = (overrides: Partial<LoanTermsData> = {}): LoanTermsData => ({
    validFrom: day('2027-01-01'),
    interestRate: 3000n,
    repaymentModel: 'ANNUITY',
    scheduledPayment: eur('900.00'),
    firstPaymentDate: day('2027-03-31'),
    principalAtStart: null,
    fixedRateUntil: null,
    initialRepaymentRate: null,
    specialRepaymentLimit: null,
    notes: null,
    paymentIntervalMonths: 3,
    ...overrides,
  });

  it.each([
    [3, '900.00', '900.01'],
    [6, '1800.00', '1800.01'],
    [12, '3600.00', '3600.01'],
  ] as const)('interval %i: the payment must exceed the first interest over the interval (%s refused, %s accepted)', (n, equal, above) => {
    const interest = periodInterest(12_000_000n, 3000n, n);
    expect(checkAppend(loan, [], data({ paymentIntervalMonths: n, scheduledPayment: eur(equal) }))).toEqual({
      kind: 'PAYMENT_DOES_NOT_COVER_INTEREST',
      firstInterest: interest,
      balance: 12_000_000n,
    });
    expect(checkAppend(loan, [], data({ paymentIntervalMonths: n, scheduledPayment: eur(above) }))).toBeUndefined();
    // Counter-check: monthly, the same payment covers a month.
    expect(checkAppend(loan, [], data({ paymentIntervalMonths: 1, scheduledPayment: eur(equal) }))).toBeUndefined();
  });

  it('the fingerprint gains the interval only when it is not 1', () => {
    const monthly = termsFingerprint('l', data({ paymentIntervalMonths: 1 }));
    expect(JSON.parse(monthly)).toHaveLength(11);
    expect(termsFingerprint('l', data({ paymentIntervalMonths: 3 }))).not.toBe(monthly);
    expect(JSON.parse(termsFingerprint('l', data({ paymentIntervalMonths: 3 }))).at(-1)).toBe(3);
  });

  it('a follow-up period may change the interval; PREVIOUS_TERMS_WITHOUT_PAYMENT unchanged', () => {
    const first = { ...data(), id: 't1', status: 'VALID' } as unknown as LoanTerms;
    expect(checkAppend(loan, [first], data({ validFrom: day('2027-04-01'), firstPaymentDate: day('2027-04-30'), paymentIntervalMonths: 1 }))).toBeUndefined();
    expect(checkAppend(loan, [first], data({ validFrom: day('2027-03-31'), firstPaymentDate: day('2027-04-30') }))).toMatchObject({
      kind: 'PREVIOUS_TERMS_WITHOUT_PAYMENT',
    });
  });
});

/** Today's derivation before VC-X-53 (main f574a96), kept as the oracle for monthly plans. */
const oracle = {
  walk(principalOriginal: Money, maturityDate: BusinessDate | null, periods: readonly SchedulePeriod[]) {
    const entries: ScheduleEntry[] = [];
    let balance = toCents(principalOriginal);
    let nextPaymentDate: BusinessDate | null = null;
    periods.forEach((p, i) => {
      if (p.principalAtStart !== null) balance = toCents(p.principalAtStart);
      const next = periods[i + 1]?.validFrom ?? null;
      let k = 0;
      for (; balance > 0n && entries.length < 600; k++) {
        const paymentDate = addMonths(p.firstPaymentDate, k);
        if ((next !== null && paymentDate >= next) || (maturityDate !== null && paymentDate > maturityDate)) break;
        const interest = monthlyInterest(balance, p.interestRate);
        const pay = p.scheduledPayment === null ? 0n : toCents(p.scheduledPayment) - interest;
        const principal = p.repaymentModel === 'ANNUITY' && p.scheduledPayment !== null ? (pay < 0n ? 0n : pay < balance ? pay : balance) : 0n;
        entries.push({
          termsId: p.id,
          paymentDate,
          balanceBefore: balance,
          interest,
          principal,
          payment: interest + principal,
          balanceAfter: balance - principal,
        });
        balance -= principal;
      }
      nextPaymentDate = addMonths(p.firstPaymentDate, k);
    });
    return { entries, balance, nextPaymentDate };
  },
  planned(principalOriginal: Money, maturityDate: BusinessDate | null, periods: readonly SchedulePeriod[], date: BusinessDate): bigint {
    const { entries } = oracle.walk(principalOriginal, maturityDate, periods);
    let balance = toCents(principalOriginal);
    for (const p of periods) {
      if (p.validFrom >= date) break;
      if (p.principalAtStart !== null) balance = toCents(p.principalAtStart);
      for (const e of entries) if (e.termsId === p.id && e.paymentDate < date) balance = e.balanceAfter;
    }
    return balance;
  },
  schedule(principalOriginal: Money, maturityDate: BusinessDate | null, periods: readonly SchedulePeriod[]): Schedule {
    const { entries, balance } = oracle.walk(principalOriginal, maturityDate, periods);
    const nextPaymentDate = oracle.walk(principalOriginal, maturityDate, periods).nextPaymentDate as BusinessDate | null;
    const endReason: ScheduleEndReason =
      periods.length === 0
        ? 'NO_TERMS'
        : balance === 0n
          ? 'PAID_OFF'
          : maturityDate !== null && nextPaymentDate !== null && nextPaymentDate > maturityDate
            ? 'MATURITY'
            : 'PAYMENT_CAP';
    const date = periods.at(-1)?.fixedRateUntil ?? null;
    const matured = endReason === 'MATURITY' && maturityDate !== null && date !== null && date >= maturityDate;
    return {
      entries: entries.map((e, i) => ({ ...e, number: i + 1 })),
      summary: {
        payments: entries.length,
        firstPaymentDate: entries[0]?.paymentDate ?? null,
        lastPaymentDate: entries.at(-1)?.paymentDate ?? null,
        totalInterest: entries.reduce((s, e) => s + e.interest, 0n),
        totalPrincipal: entries.reduce((s, e) => s + e.principal, 0n),
        balanceDue: balance,
        endReason,
        fixedRateEnd: date === null ? null : { date, balance: matured ? 0n : oracle.planned(principalOriginal, maturityDate, periods, addDays(date, 1)) },
      },
    };
  },
};

/** mulberry32: a small seeded generator, so the property tests are deterministic without a new dependency. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('property tests (§58O "Tests the implementation needs")', () => {
  it('monthly plans unchanged in every cent: 400 seeded plans against today derivation (entries, summary, planned balance, fixedRateEnd, closing)', () => {
    const random = seeded(20261105);
    const int = (max: number) => Math.floor(random() * max);
    for (let run = 0; run < 400; run++) {
      const principalOriginal = eur(`${1000 + int(300_000)}.${String(int(100)).padStart(2, '0')}`);
      const count = 1 + int(3);
      const periods: SchedulePeriod[] = [];
      let validFrom = day('2027-01-01');
      for (let i = 0; i < count; i++) {
        const annuity = random() < 0.7;
        const firstPaymentDate = addDays(validFrom, int(40));
        periods.push(
          period({
            id: `t${i}` as LoanTermsId,
            validFrom,
            interestRate: BigInt(int(9000)),
            repaymentModel: annuity ? 'ANNUITY' : 'INTEREST_ONLY',
            scheduledPayment: annuity ? eur(`${50 + int(5000)}.00`) : null,
            firstPaymentDate,
            principalAtStart: i > 0 && random() < 0.3 ? eur(`${500 + int(50_000)}.00`) : null,
            fixedRateUntil: random() < 0.5 ? addDays(firstPaymentDate, int(4000)) : null,
          }),
        );
        validFrom = addDays(firstPaymentDate, 1 + int(900));
      }
      const maturityDate = random() < 0.4 ? addDays(day('2027-01-01'), int(12_000)) : null;
      const expected = oracle.schedule(principalOriginal, maturityDate, periods);
      expect(scheduleOf(principalOriginal, maturityDate, periods), `run ${run}`).toEqual(expected);
      for (let probe = 0; probe < 4; probe++) {
        const d = addDays(day('2027-01-01'), int(9000));
        expect(plannedBalanceOn(principalOriginal, maturityDate, periods, d)).toBe(oracle.planned(principalOriginal, maturityDate, periods, d));
      }
      if (random() < 0.3) {
        const closingDate = addDays(day('2027-01-01'), int(4000));
        const closed = { principalOriginal, maturityDate, status: 'CLOSED', closingDate } as unknown as Loan;
        expect(loanSchedule(closed, periods)).toEqual(closedSchedule(expected, closingDate));
      }
    }
  });

  it.each([3, 6, 12] as const)('interval %i: sum of principal is the original, payment = interest + principal, only the last below the payment', (n) => {
    const random = seeded(4711 + n);
    const int = (max: number) => Math.floor(random() * max);
    for (let run = 0; run < 150; run++) {
      const cents = BigInt(100_000 + int(30_000_000));
      const rate = BigInt(int(9000));
      const payments = BigInt(Math.max(2, Math.floor(600 / n / 2) - int(10)));
      const payment = periodInterest(cents, rate, n) + cents / payments + 1n;
      const p = period({
        interestRate: rate,
        scheduledPayment: Money.of(`${payment / 100n}.${String(payment % 100n).padStart(2, '0')}`, 'EUR'),
        paymentIntervalMonths: n,
      });
      const plan = scheduleOf(Money.of(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`, 'EUR'), null, [p]);
      expect(plan.summary.endReason).toBe('PAID_OFF');
      expect(plan.summary.totalPrincipal).toBe(cents);
      for (const e of plan.entries) {
        expect(e.payment).toBe(e.interest + e.principal);
        expect(e.balanceAfter).toBe(e.balanceBefore - e.principal);
        expect(e.interest).toBe(periodInterest(e.balanceBefore, rate, n));
      }
      expect(plan.entries.slice(0, -1).every((e) => e.payment === payment)).toBe(true);
      expect((plan.entries.at(-1) as ScheduleEntry).payment <= payment).toBe(true);
    }
  });
});

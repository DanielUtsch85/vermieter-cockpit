import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { scheduleOf, scheduleWindow, type LoanTermsId, type SchedulePeriod } from './terms.js';

/** VC-3-04: the plan of api-design.md §41.4, hand-computed, and a seeded property test over full annuities. */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');

const period = (overrides: Partial<SchedulePeriod> = {}): SchedulePeriod => ({
  id: 't1' as LoanTermsId,
  validFrom: day('2027-01-01'),
  interestRate: 6000n,
  repaymentModel: 'ANNUITY',
  scheduledPayment: eur('300.00'),
  firstPaymentDate: day('2027-01-31'),
  principalAtStart: null,
  fixedRateUntil: null,
  ...overrides,
});
const rows = (principal: string, maturity: string | null, periods: SchedulePeriod[]) =>
  scheduleOf(eur(principal), maturity === null ? null : day(maturity), periods).entries.map((e) => [
    e.number,
    e.paymentDate,
    e.balanceBefore,
    e.interest,
    e.principal,
    e.payment,
    e.balanceAfter,
  ]);

describe('scheduleOf (§41.4)', () => {
  it('the hand-computed example, row for row, with its summary', () => {
    expect(rows('1000.00', null, [period()])).toEqual([
      [1, '2027-01-31', 100_000n, 500n, 29_500n, 30_000n, 70_500n],
      [2, '2027-02-28', 70_500n, 353n, 29_647n, 30_000n, 40_853n], // 3.525 rounds up
      [3, '2027-03-31', 40_853n, 204n, 29_796n, 30_000n, 11_057n],
      [4, '2027-04-30', 11_057n, 55n, 11_057n, 11_112n, 0n],
    ]);
    expect(scheduleOf(eur('1000.00'), null, [period()]).summary).toEqual({
      payments: 4,
      firstPaymentDate: '2027-01-31',
      lastPaymentDate: '2027-04-30',
      totalInterest: 1_112n,
      totalPrincipal: 100_000n,
      balanceDue: 0n,
      endReason: 'PAID_OFF',
      fixedRateEnd: null,
    });
  });

  it('carries the balance into a follow-up period; principalAtStart restarts it', () => {
    const second = period({
      id: 't2' as LoanTermsId,
      validFrom: day('2027-03-01'),
      interestRate: 0n,
      scheduledPayment: eur('100.00'),
      firstPaymentDate: day('2027-03-15'),
    });
    // Two payments of the first period leave 408.53; at 0 % the second repays 100.00 a month.
    expect(rows('1000.00', null, [period(), second]).map((r) => [r[1], r[2], r[4]])).toEqual([
      ['2027-01-31', 100_000n, 29_500n],
      ['2027-02-28', 70_500n, 29_647n],
      ['2027-03-15', 40_853n, 10_000n],
      ['2027-04-15', 30_853n, 10_000n],
      ['2027-05-15', 20_853n, 10_000n],
      ['2027-06-15', 10_853n, 10_000n],
      ['2027-07-15', 853n, 853n],
    ]);
    const restarted = rows('1000.00', null, [period(), { ...second, principalAtStart: eur('200.00') }]);
    expect(restarted.slice(2).map((r) => [r[2], r[4]])).toEqual([
      [20_000n, 10_000n],
      [10_000n, 10_000n],
    ]);
  });

  it('interest-only ends at maturity with the principal due; without maturity at 600 payments', () => {
    const io = period({ repaymentModel: 'INTEREST_ONLY', scheduledPayment: null });
    const atMaturity = scheduleOf(eur('1000.00'), day('2027-03-30'), [io]);
    expect(atMaturity.entries.map((e) => [e.paymentDate, e.interest, e.principal])).toEqual([
      ['2027-01-31', 500n, 0n],
      ['2027-02-28', 500n, 0n],
    ]);
    expect(atMaturity.summary).toMatchObject({ payments: 2, balanceDue: 100_000n, endReason: 'MATURITY', totalPrincipal: 0n });
    const capped = scheduleOf(eur('1000.00'), null, [io]);
    expect(capped.summary).toMatchObject({ payments: 600, lastPaymentDate: '2076-12-31', balanceDue: 100_000n, endReason: 'PAYMENT_CAP' });
  });

  it('an annuity cut by maturity has a balance due', () => {
    const cut = scheduleOf(eur('1000.00'), day('2027-02-28'), [period()]);
    expect(cut.entries.map((e) => e.paymentDate)).toEqual(['2027-01-31', '2027-02-28']);
    expect(cut.summary).toMatchObject({ balanceDue: 40_853n, endReason: 'MATURITY' });
  });

  it('ties (review on #65): PAID_OFF before MATURITY before PAYMENT_CAP', () => {
    // Paid off by the last payment, which falls on the maturity date.
    expect(scheduleOf(eur('1000.00'), day('2027-04-30'), [period()]).summary.endReason).toBe('PAID_OFF');
    // The 600th payment repays the rest exactly: 600 × 1.00 at 0 %.
    const exact = scheduleOf(eur('600.00'), null, [period({ interestRate: 0n, scheduledPayment: eur('1.00') })]);
    expect(exact.summary).toMatchObject({ payments: 600, balanceDue: 0n, endReason: 'PAID_OFF' });
    // The 600th payment falls on the maturity date.
    const io = period({ repaymentModel: 'INTEREST_ONLY', scheduledPayment: null });
    expect(scheduleOf(eur('1000.00'), day('2076-12-31'), [io]).summary).toMatchObject({ payments: 600, endReason: 'MATURITY' });
    // The next payment would be 2077-01-31: after a maturity of 2077-01-30 (MATURITY), not after 2077-01-31 (the cap stops it).
    expect(scheduleOf(eur('1000.00'), day('2077-01-30'), [io]).summary).toMatchObject({ payments: 600, endReason: 'MATURITY' });
    expect(scheduleOf(eur('1000.00'), day('2077-01-31'), [io]).summary).toMatchObject({ payments: 600, endReason: 'PAYMENT_CAP' });
  });

  it('a follow-up period after the plan reached 0, without principalAtStart, has no payments and the plan stays PAID_OFF', () => {
    const late = period({ id: 't2' as LoanTermsId, validFrom: day('2027-06-01'), firstPaymentDate: day('2027-06-30') });
    const plan = scheduleOf(eur('1000.00'), null, [period(), late]);
    expect(plan.entries.map((e) => e.termsId)).toEqual(['t1', 't1', 't1', 't1']);
    expect(plan.summary.endReason).toBe('PAID_OFF');
  });

  it('clamps to the month end, counted from firstPaymentDate', () => {
    const io = period({ repaymentModel: 'INTEREST_ONLY', scheduledPayment: null });
    expect(
      scheduleOf(eur('1000.00'), day('2028-03-31'), [io])
        .entries.slice(12, 15)
        .map((e) => e.paymentDate),
    ).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  });

  it('NO_TERMS: no payments, the original principal due', () => {
    expect(scheduleOf(eur('1000.00'), null, [])).toEqual({
      entries: [],
      summary: {
        payments: 0,
        firstPaymentDate: null,
        lastPaymentDate: null,
        totalInterest: 0n,
        totalPrincipal: 0n,
        balanceDue: 100_000n,
        endReason: 'NO_TERMS',
        fixedRateEnd: null,
      },
    });
  });

  it('fixedRateEnd (#119): the planned balance after every payment on or before fixedRateUntil, of the last period', () => {
    const end = (fixedRateUntil: string, maturity: string | null = null, periods = [period({ fixedRateUntil: day(fixedRateUntil) })]) =>
      scheduleOf(eur('1000.00'), maturity === null ? null : day(maturity), periods).summary.fixedRateEnd;
    // Before the first payment: the principal; on a due date: after it; between two: after the earlier one.
    expect(end('2027-01-15')).toEqual({ date: '2027-01-15', balance: 100_000n });
    expect(end('2027-01-31')).toEqual({ date: '2027-01-31', balance: 70_500n });
    expect(end('2027-02-28')).toEqual({ date: '2027-02-28', balance: 40_853n });
    expect(end('2027-03-30')).toEqual({ date: '2027-03-30', balance: 40_853n });
    // Paid off before it: 0.
    expect(end('2036-12-31')).toEqual({ date: '2036-12-31', balance: 0n });
    // MATURITY: 0 from maturityDate on, as the planned remaining debt (§41.6).
    const interestOnly = [period({ repaymentModel: 'INTEREST_ONLY', scheduledPayment: null, fixedRateUntil: day('2027-06-30') })];
    expect(end('', '2027-03-31', interestOnly)).toEqual({ date: '2027-06-30', balance: 0n });
    expect(end('', '2027-07-31', interestOnly)).toEqual({ date: '2027-06-30', balance: 100_000n });
    // The last period's date counts; an earlier period's is history. A follow-up's principalAtStart restarts the balance.
    const second = period({
      id: 't2' as LoanTermsId,
      validFrom: day('2027-03-01'),
      interestRate: 0n,
      scheduledPayment: eur('100.00'),
      firstPaymentDate: day('2027-03-15'),
      principalAtStart: eur('500.00'),
    });
    expect(end('', null, [period({ fixedRateUntil: day('2027-01-31') }), second])).toBeNull();
    expect(end('', null, [period({ fixedRateUntil: day('2027-01-31') }), { ...second, fixedRateUntil: day('2027-03-01') }])).toEqual({
      date: '2027-03-01',
      balance: 50_000n,
    });
    expect(end('', null, [period(), { ...second, fixedRateUntil: day('2027-04-15') }])).toEqual({ date: '2027-04-15', balance: 30_000n });
  });

  it('a window keeps the numbers and the summary', () => {
    const plan = scheduleOf(eur('1000.00'), null, [period()]);
    const window = scheduleWindow(plan, day('2027-02-01'), day('2027-03-31'));
    expect(window.entries.map((e) => [e.number, e.paymentDate])).toEqual([
      [2, '2027-02-28'],
      [3, '2027-03-31'],
    ]);
    expect(window.summary).toBe(plan.summary);
    expect(scheduleWindow(plan, day('2027-04-30')).entries.map((e) => e.number)).toEqual([4]);
    expect(scheduleWindow(plan, undefined, day('2027-01-31')).entries.map((e) => e.number)).toEqual([1]);
  });
});

/** mulberry32: a small seeded generator, so the property test is deterministic without a new dependency. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const cents = (c: bigint) => Money.of(`${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`, 'EUR');

/** The oracle's own payment date: the k-th month after `first`, its day clamped to that month's last day (not addMonths). */
function oracleDate(first: string, k: number): BusinessDate {
  const [y, m, d] = first.split('-').map(Number) as [number, number, number];
  const month = m - 1 + k;
  const year = y + Math.floor(month / 12);
  const inYear = ((month % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, inYear + 1, 0)).getUTCDate();
  return `${year}-${String(inYear + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}` as BusinessDate;
}
const plusDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10) as BusinessDate;

describe('property: the plan against an independent oracle (§41.4)', () => {
  /** §41.4's 50 years, written out: the constant itself is under test. */
  const CAP = 600;

  it('over 400 seeded random full annuities: Σ principal = principal, only the last payment smaller', () => {
    const random = seeded(20261027);
    const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    for (let run = 0; run < 400; run++) {
      const principal = BigInt(between(1, 200_000_000)); // up to 2 000 000.00
      const rate = BigInt(between(0, 99_999)); // [0, 100) percent in thousandths
      // Above the first interest, and at least 1/300 of the principal, so the plan ends within 600 payments.
      const payment = (2n * principal * rate + 1_200_000n) / 2_400_000n + principal / 300n + BigInt(between(1, 50_000));
      const { entries, summary } = scheduleOf(cents(principal), null, [period({ interestRate: rate, scheduledPayment: cents(payment) })]);
      const context = `run ${run}: ${principal} cents at ${rate}, payment ${payment}`;
      expect(summary.endReason, context).toBe('PAID_OFF');
      expect(
        entries.reduce((sum, e) => sum + e.principal, 0n),
        context,
      ).toBe(principal);
      expect(summary.totalPrincipal, context).toBe(principal);
      entries.forEach((e, i) => {
        // Every payment but the last is the scheduled one; the last may equal it (review on #65).
        if (i < entries.length - 1) expect(e.payment, context).toBe(payment);
        else expect(e.payment <= payment && e.balanceAfter === 0n, context).toBe(true);
      });
    }
  });

  it('over 400 seeded random plans with follow-up periods, principalAtStart, interest-only and maturity', () => {
    const random = seeded(4104);
    const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const chance = (p: number) => random() < p;
    for (let run = 0; run < 400; run++) {
      const principal = BigInt(between(100, 100_000_000));
      const month = between(1, 12);
      const lastDay = new Date(Date.UTC(2027, month, 0)).getUTCDate();
      // Month ends often, so the clamping is exercised.
      const firstPayment = `2027-${String(month).padStart(2, '0')}-${String(chance(0.5) ? lastDay : between(1, lastDay)).padStart(2, '0')}`;
      const annuity = (balance: bigint, rate: bigint) => cents((2n * balance * rate + 1_200_000n) / 2_400_000n + balance / 200n + BigInt(between(1, 5_000)));
      const rate1 = BigInt(between(0, 15_000));
      const periods: SchedulePeriod[] = [
        period({
          validFrom: day(plusDays(firstPayment, -between(0, 20))),
          firstPaymentDate: day(firstPayment),
          interestRate: rate1,
          scheduledPayment: annuity(principal, rate1),
        }),
      ];
      if (chance(0.7)) {
        const validFrom = plusDays(oracleDate(firstPayment, between(0, 30)), between(1, 20));
        const rate2 = BigInt(between(0, 15_000));
        const restart = chance(0.5) ? BigInt(between(1, Number(principal))) : null;
        const interestOnly = chance(0.25);
        periods.push(
          period({
            id: 't2' as LoanTermsId,
            validFrom,
            firstPaymentDate: plusDays(validFrom, between(0, 40)),
            interestRate: rate2,
            repaymentModel: interestOnly ? 'INTEREST_ONLY' : 'ANNUITY',
            scheduledPayment: interestOnly ? null : annuity(principal, rate2),
            principalAtStart: restart === null ? null : cents(restart),
          }),
        );
      }
      // A fixed-rate end on the last period half the time, on a payment date or between two.
      const lastPeriod = periods.at(-1) as SchedulePeriod;
      const fixedRateUntil = chance(0.5)
        ? null
        : chance(0.5)
          ? oracleDate(lastPeriod.firstPaymentDate, between(0, 60))
          : plusDays(lastPeriod.validFrom, between(0, 2000));
      periods[periods.length - 1] = { ...lastPeriod, fixedRateUntil };
      // A maturity on one of the payment dates half the time, so the boundary is exercised.
      const maturity = chance(0.5) ? null : chance(0.5) ? oracleDate(firstPayment, between(0, 40)) : plusDays(firstPayment, between(0, 1500));
      const { entries, summary } = scheduleOf(cents(principal), maturity, periods);
      const context = `run ${run}: ${JSON.stringify({ principal: String(principal), maturity, periods }, (_, v) => (typeof v === 'bigint' ? String(v) : v))}`;

      expect(entries.length <= CAP, context).toBe(true);
      let balance = principal;
      let index = 0;
      const stops: BusinessDate[] = [];
      periods.forEach((p, i) => {
        if (p.principalAtStart !== null) balance = BigInt(p.principalAtStart.amount.replace('.', ''));
        const following = periods[i + 1]?.validFrom ?? null;
        let k = 0;
        for (; index < entries.length && entries[index]?.termsId === p.id; k++, index++) {
          const e = entries[index] as (typeof entries)[number];
          expect(e.number, context).toBe(index + 1);
          expect(e.paymentDate, context).toBe(oracleDate(p.firstPaymentDate, k));
          expect(following === null || e.paymentDate < following, context).toBe(true);
          expect(maturity === null || e.paymentDate <= maturity, context).toBe(true);
          expect(e.balanceBefore, context).toBe(balance);
          const interest = (2n * balance * p.interestRate + 1_200_000n) / 2_400_000n;
          expect(e.interest, context).toBe(interest);
          const scheduled = p.scheduledPayment === null ? null : BigInt(p.scheduledPayment.amount.replace('.', ''));
          const repay = scheduled === null ? 0n : scheduled - interest < balance ? scheduled - interest : balance;
          expect(e.principal, context).toBe(repay);
          expect(e.payment, context).toBe(interest + repay);
          balance -= repay;
          expect(e.balanceAfter, context).toBe(balance);
        }
        // Where the period stopped: paid off, the cap, the next period or maturity, and nothing earlier.
        const next = oracleDate(p.firstPaymentDate, k);
        expect(balance === 0n || index === CAP || (following !== null && next >= following) || (maturity !== null && next > maturity), context).toBe(true);
        stops.push(next);
      });
      expect(index, context).toBe(entries.length);
      expect(summary.balanceDue, context).toBe(balance);
      expect(summary.totalPrincipal, context).toBe(entries.reduce((sum, e) => sum + e.principal, 0n));
      const reason = balance === 0n ? 'PAID_OFF' : maturity !== null && (stops.at(-1) ?? '') > maturity ? 'MATURITY' : 'PAYMENT_CAP';
      expect(summary.endReason, context).toBe(reason);
      if (reason === 'PAYMENT_CAP') expect(entries.length, context).toBe(CAP);
      if (fixedRateUntil === null) expect(summary.fixedRateEnd, context).toBeNull();
      else {
        // The balance after the last payment on or before the date, restarts of periods from it included; 0 once matured.
        let planned = principal;
        for (const p of periods) {
          if (p.validFrom > fixedRateUntil) break;
          if (p.principalAtStart !== null) planned = BigInt(p.principalAtStart.amount.replace('.', ''));
          for (const e of entries) if (e.termsId === p.id && e.paymentDate <= fixedRateUntil) planned = e.balanceAfter;
        }
        if (reason === 'MATURITY' && maturity !== null && fixedRateUntil >= maturity) planned = 0n;
        expect(summary.fixedRateEnd, context).toEqual({ date: fixedRateUntil, balance: planned });
      }
    }
  });
});

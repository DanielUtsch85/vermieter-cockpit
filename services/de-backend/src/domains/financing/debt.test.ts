import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import type { LoanAllocationSetId, LoanAllocationSetView } from './allocation.js';
import {
  actualOn,
  checkStatement,
  debtOn,
  debtPerProperty,
  distribute,
  latestStatementOn,
  paymentsInYear,
  planVoidStatement,
  remainingDebt,
  statementViews,
  type CountedSplit,
  type DebtInputs,
  type LoanBalanceStatement,
  type LoanBalanceStatementId,
} from './debt.js';
import type { Loan, LoanId } from './loan.js';
import type { LoanTermsId, SchedulePeriod } from './terms.js';

/** VC-3-06: remaining debt, payments and statements of api-design.md §41.6, on §41.4's example Loan. */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const f = (n: bigint, d: bigint) => ({ numerator: n, denominator: d });

const loanOf = (overrides: Partial<Loan> = {}): Loan =>
  ({
    id: 'l0000000-0000-4000-8000-000000000001' as LoanId,
    mreRealmId: 'realm',
    status: 'ACTIVE',
    lenderPartyId: 'bank',
    borrowerPartyIds: ['anna'],
    principalOriginal: eur('1000.00'),
    startDate: day('2027-01-01'),
    disbursementDate: null,
    maturityDate: null,
    contractNumber: null,
    acquisitionId: null,
    sourceReferences: [],
    notes: null,
    voidedAt: null,
    voidReason: null,
    createdAt: new Date('2027-01-01T00:00:00Z'),
    version: 1,
    ...overrides,
  }) as Loan;
const loan = loanOf();
const period = (overrides: Partial<SchedulePeriod> = {}): SchedulePeriod => ({
  id: 't1' as LoanTermsId,
  validFrom: day('2027-01-01'),
  interestRate: 6000n,
  repaymentModel: 'ANNUITY',
  scheduledPayment: eur('300.00'),
  firstPaymentDate: day('2027-01-31'),
  principalAtStart: null,
  ...overrides,
});
const annuity = [period()];
const interestOnly = [period({ repaymentModel: 'INTEREST_ONLY', scheduledPayment: null })];
const split = (bookingDate: string, category: CountedSplit['category'], amount: bigint, transactionId = `tx-${bookingDate}`): CountedSplit => ({
  transactionId,
  bookingDate: day(bookingDate),
  category,
  amount,
});
/** The plan's entries 1 and 2 paid as planned (§41.4: principal 295.00 and 296.47). */
const twoPayments = [
  split('2027-01-31', 'LOAN_INTEREST', 500n),
  split('2027-01-31', 'LOAN_PRINCIPAL', 29_500n),
  split('2027-02-28', 'LOAN_INTEREST', 353n),
  split('2027-02-28', 'LOAN_PRINCIPAL', 29_647n),
];
const setOf = (validFrom: string, validUntil: string | null, allocations: [string, bigint, bigint][], id = `set-${validFrom}`): LoanAllocationSetView => ({
  id: id as LoanAllocationSetId,
  loanId: loan.id,
  mreRealmId: 'realm',
  status: 'VALID',
  validFrom: day(validFrom),
  validUntil: validUntil === null ? null : day(validUntil),
  basis: 'MANUAL',
  allocations: allocations.map(([propertyReferenceId, n, d]) => ({ propertyReferenceId, share: f(n, d), acquisitionId: null })),
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2027-01-01T00:00:00Z'),
  version: 1,
});
const twoThirds = setOf('2027-01-01', null, [
  ['p-a', 2n, 3n],
  ['p-b', 1n, 3n],
]);
const statementOf = (statementDate: string, balance: string, overrides: Partial<LoanBalanceStatement> = {}): LoanBalanceStatement => ({
  id: `st-${statementDate}` as LoanBalanceStatementId,
  loanId: loan.id,
  mreRealmId: 'realm',
  status: 'VALID',
  statementDate: day(statementDate),
  balance: eur(balance),
  source: 'Jahreskontoauszug',
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2027-06-01T00:00:00Z'),
  version: 1,
  ...overrides,
});
const inputs = (overrides: Partial<DebtInputs> = {}): DebtInputs => ({
  loan,
  periods: annuity,
  sets: [twoThirds],
  splits: twoPayments,
  statements: [],
  ...overrides,
});

describe('debtOn (§41.6)', () => {
  it('the example: on 2027-03-15 principal paid 591.47, actual = planned = 408.53, difference 0', () => {
    expect(debtOn(loan, annuity, twoPayments, day('2027-03-15'))).toEqual({
      principalPaid: 59_147n,
      actual: 40_853n,
      planned: 40_853n,
      difference: 0n,
      planEndReason: 'PAID_OFF',
    });
  });

  it('before debtFrom everything is 0; before the first payment the starting balance; on and between payment dates', () => {
    const withDisbursement = loanOf({ disbursementDate: day('2027-01-10') });
    expect(debtOn(withDisbursement, annuity, twoPayments, day('2027-01-09'))).toMatchObject({ principalPaid: 0n, actual: 0n, planned: 0n, difference: 0n });
    expect(debtOn(withDisbursement, annuity, twoPayments, day('2027-01-10'))).toMatchObject({ actual: 100_000n, planned: 100_000n, difference: 0n });
    expect(debtOn(loan, annuity, twoPayments, day('2027-01-30'))).toMatchObject({ actual: 100_000n, planned: 100_000n });
    expect(debtOn(loan, annuity, twoPayments, day('2027-01-31'))).toMatchObject({ principalPaid: 29_500n, actual: 70_500n, planned: 70_500n, difference: 0n });
    expect(debtOn(loan, annuity, twoPayments, day('2027-02-27'))).toMatchObject({ actual: 70_500n, planned: 70_500n });
    expect(debtOn(loan, annuity, twoPayments, day('2027-02-28'))).toMatchObject({ actual: 40_853n, planned: 40_853n });
    // Entry 3 is due 2027-03-31 and not paid: missed, the actual stays above the plan.
    expect(debtOn(loan, annuity, twoPayments, day('2027-04-01'))).toMatchObject({ actual: 40_853n, planned: 11_057n, difference: 29_796n });
  });

  it('a special repayment shows as actual below planned (negative difference)', () => {
    const extra = [...twoPayments, split('2027-03-01', 'LOAN_PRINCIPAL', 10_000n, 'special')];
    expect(debtOn(loan, annuity, extra, day('2027-03-15'))).toMatchObject({ actual: 30_853n, planned: 40_853n, difference: -10_000n });
  });

  it('principal paid beyond the original makes the actual negative; only principal counts, interest never does', () => {
    const over = [split('2027-01-31', 'LOAN_PRINCIPAL', 110_000n), split('2027-01-31', 'LOAN_INTEREST', 999_999n)];
    expect(debtOn(loan, annuity, over, day('2027-03-15'))).toMatchObject({ principalPaid: 110_000n, actual: -10_000n });
  });

  it('a later period: its principalAtStart restarts the planned balance from its validFrom, before its first payment', () => {
    const periods = [
      period(),
      period({ id: 't2' as LoanTermsId, validFrom: day('2027-03-10'), firstPaymentDate: day('2027-04-10'), principalAtStart: eur('500.00') }),
    ];
    expect(debtOn(loan, periods, twoPayments, day('2027-03-09'))).toMatchObject({ planned: 40_853n });
    expect(debtOn(loan, periods, twoPayments, day('2027-03-10'))).toMatchObject({ planned: 50_000n });
  });

  it('NO_TERMS: planned and difference are null, the actual is still derived', () => {
    expect(debtOn(loan, [], twoPayments, day('2027-03-15'))).toEqual({
      principalPaid: 59_147n,
      actual: 40_853n,
      planned: null,
      difference: null,
      planEndReason: 'NO_TERMS',
    });
    expect(debtOn(loan, [], [], day('2026-12-31'))).toMatchObject({ actual: 0n, planned: null, difference: null });
  });

  describe('MATURITY (review on #69)', () => {
    const bullet = loanOf({ maturityDate: day('2027-06-30') });
    const bulletPaid = [split('2027-06-30', 'LOAN_PRINCIPAL', 100_000n)];

    it('planned is the balance due the day before maturityDate and 0 on it', () => {
      expect(debtOn(bullet, interestOnly, [], day('2027-06-29'))).toMatchObject({ planned: 100_000n, planEndReason: 'MATURITY' });
      expect(debtOn(bullet, interestOnly, [], day('2027-06-30'))).toMatchObject({ planned: 0n });
      expect(debtOn(bullet, interestOnly, [], day('2030-01-01'))).toMatchObject({ planned: 0n });
    });

    it('a bullet repayment paid on maturityDate: difference 0; not paid: the full balance, also per property', () => {
      const paid = debtOn(bullet, interestOnly, bulletPaid, day('2027-06-30'));
      expect(paid).toMatchObject({ actual: 0n, planned: 0n, difference: 0n });
      const overdue = debtOn(bullet, interestOnly, [], day('2027-07-15'));
      expect(overdue).toMatchObject({ actual: 100_000n, planned: 0n, difference: 100_000n });
      expect(debtPerProperty(overdue, twoThirds).map((i) => [i.actual, i.planned, i.difference])).toEqual([
        [66_667n, 0n, 66_667n],
        [33_333n, 0n, 33_333n],
      ]);
      expect(debtPerProperty(paid, twoThirds).map((i) => i.difference)).toEqual([0n, 0n]);
    });

    it('an annuity with a balance left at maturity: planned 0 from maturityDate, the open rest as difference', () => {
      const short = loanOf({ maturityDate: day('2027-02-28') });
      expect(debtOn(short, annuity, twoPayments, day('2027-02-27'))).toMatchObject({ planned: 70_500n, planEndReason: 'MATURITY' });
      expect(debtOn(short, annuity, twoPayments, day('2027-02-28'))).toMatchObject({ actual: 40_853n, planned: 0n, difference: 40_853n });
    });

    it('PAYMENT_CAP keeps balanceDue: no due date', () => {
      // Interest only without maturity: 600 payments, then the cap; the balance stays due.
      expect(debtOn(loan, interestOnly, [], day('2090-01-01'))).toMatchObject({ planned: 100_000n, difference: 0n, planEndReason: 'PAYMENT_CAP' });
    });

    it('PAID_OFF before maturity: planned 0 after the last payment anyway', () => {
      const late = loanOf({ maturityDate: day('2030-01-01') });
      expect(debtOn(late, annuity, [], day('2027-05-01'))).toMatchObject({ planned: 0n, planEndReason: 'PAID_OFF' });
    });
  });
});

describe('per property (§41.6)', () => {
  it('the example: actual 408.53 by 2/3 and 1/3 is 272.35 and 136.18; planned the same; each difference 0', () => {
    const items = debtPerProperty(debtOn(loan, annuity, twoPayments, day('2027-03-15')), twoThirds);
    expect(items.map((i) => [i.propertyReferenceId, i.actual, i.planned, i.difference])).toEqual([
      ['p-a', 27_235n, 27_235n, 0n],
      ['p-b', 13_618n, 13_618n, 0n],
    ]);
  });

  it('largest remainder, ties by propertyReferenceId whatever the set order', () => {
    const halves = [
      { propertyReferenceId: 'p-b', share: f(1n, 2n) },
      { propertyReferenceId: 'p-a', share: f(1n, 2n) },
    ];
    expect(distribute(1n, halves)).toEqual([0n, 1n]);
    expect(distribute(3n, halves)).toEqual([1n, 2n]);
  });

  it('a negative total is distributed by its absolute value, the sign restored', () => {
    expect(distribute(-10_000n, twoThirds.allocations)).toEqual([-6_667n, -3_333n]);
    expect(distribute(-1n, twoThirds.allocations)).toEqual([-1n, 0n]);
  });

  it('the difference is derived, never distributed (F4b): 3/7, 3/7, 1/7 with actual 408.53 and planned 408.50', () => {
    const sevenths = setOf('2027-01-01', null, [
      ['p1', 3n, 7n],
      ['p2', 3n, 7n],
      ['p3', 1n, 7n],
    ]);
    const items = debtPerProperty({ principalPaid: 0n, actual: 40_853n, planned: 40_850n, difference: 3n, planEndReason: 'PAID_OFF' }, sevenths);
    expect(items.map((i) => [i.actual, i.planned, i.difference])).toEqual([
      [17_509n, 17_507n, 2n],
      [17_508n, 17_507n, 1n],
      [5_836n, 5_836n, 0n],
    ]);
    // Distributing 3 cents directly would give 1, 1, 1 and break difference_i = actual_i − planned_i.
    expect(distribute(3n, sevenths.allocations)).toEqual([1n, 1n, 1n]);
  });

  it('property test: each column sums to its total, each part within a cent, difference_i = actual_i − planned_i', () => {
    const random = seeded(20271027);
    const int = (max: number) => Math.floor(random() * max);
    for (let run = 0; run < 500; run++) {
      const n = 1 + int(6);
      const weights = Array.from({ length: n }, () => BigInt(1 + int(997)));
      const sum = weights.reduce((x, y) => x + y, 0n);
      const set = setOf(
        '2027-01-01',
        null,
        weights.map((w, i) => [`p-${(n - i).toString().padStart(2, '0')}`, w, sum]),
      );
      const actual = BigInt(int(20_000_000)) - (run % 5 === 0 ? 30_000_000n : 0n); // every fifth negative
      const planned = run % 7 === 0 ? null : BigInt(int(20_000_000));
      const items = debtPerProperty(
        { principalPaid: 0n, actual, planned, difference: planned === null ? null : actual - planned, planEndReason: 'PAID_OFF' },
        set,
      );
      expect(items.reduce((s, i) => s + i.actual, 0n)).toBe(actual);
      items.forEach((item, i) => {
        // |part − total × w| < 1 cent, exactly: |part × sum − total × w| < sum.
        const w = weights[i] as bigint;
        const gap = item.actual * sum - actual * w;
        expect(gap < sum && gap > -sum).toBe(true);
        expect(actual < 0n ? item.actual <= 0n : item.actual >= 0n).toBe(true);
      });
      if (planned === null) {
        expect(items.every((i) => i.planned === null && i.difference === null)).toBe(true);
        continue;
      }
      expect(items.reduce((s, i) => s + (i.planned as bigint), 0n)).toBe(planned);
      expect(items.reduce((s, i) => s + (i.difference as bigint), 0n)).toBe(actual - planned);
      for (const i of items) expect(i.difference).toBe(i.actual - (i.planned as bigint));
    }
  });
});

describe('remainingDebt (§41.6)', () => {
  it('Loan level whatever the allocation; per property with the set covering asOf', () => {
    expect(remainingDebt(inputs({ sets: [] }), day('2027-03-15'), false)).toMatchObject({
      kind: 'LOAN_LEVEL',
      debt: { actual: 40_853n, debtFrom: '2027-01-01', latestStatement: null },
    });
    expect(remainingDebt(inputs(), day('2027-03-15'), true)).toMatchObject({
      kind: 'PER_PROPERTY',
      debt: { allocationSetId: twoThirds.id, items: [{ actual: 27_235n }, { actual: 13_618n }] },
    });
  });

  it('per property without a set covering asOf: LOAN_NOT_ALLOCATED with asOf', () => {
    const later = setOf('2027-04-01', null, [['p-a', 1n, 1n]]);
    expect(remainingDebt(inputs({ sets: [later] }), day('2027-03-15'), true)).toEqual({ kind: 'LOAN_NOT_ALLOCATED', asOf: '2027-03-15' });
  });

  it('a VOID Loan counts nowhere, before anything else', () => {
    expect(remainingDebt(inputs({ loan: loanOf({ status: 'VOID' }), sets: [] }), day('2027-03-15'), true)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
  });

  it('the latest VALID statement on or before asOf, with its comparison', () => {
    const statements = [
      statementOf('2027-01-31', '705.00'),
      statementOf('2027-02-28', '408.50', { id: 'st-a' as LoanBalanceStatementId, createdAt: new Date('2027-03-01T00:00:00Z') }),
      statementOf('2027-02-28', '408.53', { id: 'st-b' as LoanBalanceStatementId, createdAt: new Date('2027-03-02T00:00:00Z') }),
      statementOf('2027-03-10', '1.00', { status: 'VOID' }),
      statementOf('2027-03-31', '110.57'),
    ];
    const outcome = remainingDebt(inputs({ statements }), day('2027-03-15'), false);
    expect(outcome.kind === 'LOAN_LEVEL' && outcome.debt.latestStatement).toMatchObject({ id: 'st-b', comparison: { actualOnDate: 40_853n, difference: 0n } });
    expect(latestStatementOn(statements, day('2027-01-30'))).toBeNull();
  });
});

describe('paymentsInYear (§41.6)', () => {
  const yearSplits = [
    ...twoPayments,
    split('2026-12-31', 'LOAN_PRINCIPAL', 1n, 'last-year'),
    split('2027-07-31', 'LOAN_INTEREST', 101n, 'july'),
    split('2027-07-31', 'LOAN_PRINCIPAL', 1n, 'july'),
    split('2028-01-31', 'LOAN_PRINCIPAL', 7n, 'next-year'),
  ];
  const first = setOf('2026-01-01', '2027-06-30', [
    ['p-a', 2n, 3n],
    ['p-b', 1n, 3n],
  ]);
  const second = setOf('2027-07-01', null, [
    ['p-c', 1n, 2n],
    ['p-a', 1n, 2n],
  ]);

  it('sums the year by category and counts Transactions', () => {
    expect(paymentsInYear(inputs({ splits: yearSplits }), 2027, false)).toEqual({
      kind: 'LOAN_LEVEL',
      payments: { year: 2027, interest: 954n, principal: 59_148n, payments: 3 },
    });
  });

  it('per property: each split by the set of its booking date, by largest remainder, then summed; columns sum exactly', () => {
    const outcome = paymentsInYear(inputs({ splits: yearSplits, sets: [first, second] }), 2027, true);
    // January/February by 2/3 : 1/3, July by 1/2 : 1/2 (1 cent of principal to p-a, the smaller key).
    expect(outcome).toEqual({
      kind: 'PER_PROPERTY',
      payments: { year: 2027, interest: 954n, principal: 59_148n, payments: 3 },
      items: [
        { propertyReferenceId: 'p-a', interest: 333n + 235n + 51n, principal: 19_667n + 19_765n + 1n },
        { propertyReferenceId: 'p-b', interest: 167n + 118n, principal: 9_833n + 9_882n },
        { propertyReferenceId: 'p-c', interest: 50n, principal: 0n },
      ],
    });
    if (outcome.kind !== 'PER_PROPERTY') return;
    expect(outcome.items.reduce((s, i) => s + i.interest, 0n)).toBe(954n);
    expect(outcome.items.reduce((s, i) => s + i.principal, 0n)).toBe(59_148n);
  });

  it('a counted split of the year on a day without a set: LOAN_NOT_ALLOCATED with the first such booking date', () => {
    const late = setOf('2027-02-01', null, [['p-a', 1n, 1n]]);
    expect(paymentsInYear(inputs({ splits: yearSplits, sets: [late] }), 2027, true)).toEqual({ kind: 'LOAN_NOT_ALLOCATED', bookingDate: '2027-01-31' });
    expect(paymentsInYear(inputs({ splits: yearSplits, sets: [late] }), 2027, false).kind).toBe('LOAN_LEVEL');
  });

  it('a VOID Loan: LOAN_NOT_ACTIVE', () => {
    expect(paymentsInYear(inputs({ loan: loanOf({ status: 'VOID' }) }), 2027, false)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
  });
});

describe('statements (§41.6)', () => {
  it('the comparison: balance − actual on statementDate as derived now, signed', () => {
    const views = statementViews(inputs({ statements: [statementOf('2027-02-28', '400.00'), statementOf('2027-01-31', '710.00')] }));
    expect(views.map((v) => [v.statementDate, v.comparison.actualOnDate, v.comparison.difference])).toEqual([
      ['2027-01-31', 70_500n, 500n],
      ['2027-02-28', 40_853n, -853n],
    ]);
    expect(actualOn(loan, twoPayments, day('2026-12-31'))).toBe(0n);
  });

  it('list by statementDate, then createdAt; a status filter', () => {
    const statements = [
      statementOf('2027-02-28', '1.00', { id: 'late' as LoanBalanceStatementId, createdAt: new Date('2027-03-02T00:00:00Z') }),
      statementOf('2027-02-28', '2.00', { id: 'early' as LoanBalanceStatementId, createdAt: new Date('2027-03-01T00:00:00Z'), status: 'VOID' }),
    ];
    expect(statementViews(inputs({ statements })).map((s) => s.id)).toEqual(['early', 'late']);
    expect(statementViews(inputs({ statements }), 'VALID').map((s) => s.id)).toEqual(['late']);
  });

  it('create: a VOID Loan before the debt check; a date before debtFrom', () => {
    expect(checkStatement(loanOf({ status: 'VOID' }), day('2026-01-01'))).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
    expect(checkStatement(loanOf({ disbursementDate: day('2027-02-01') }), day('2027-01-31'))).toEqual({
      kind: 'STATEMENT_BEFORE_DEBT',
      debtFrom: '2027-02-01',
    });
    expect(checkStatement(loan, day('2027-01-01'))).toBeUndefined();
    expect(checkStatement(loanOf({ status: 'CLOSED' }), day('2027-01-01'))).toBeUndefined();
  });

  it('void: already VOID is a no-op before the Loan check; then a VOID Loan; else version + 1', () => {
    const at = new Date('2027-07-01T00:00:00Z');
    expect(planVoidStatement(loanOf({ status: 'VOID' }), statementOf('2027-02-28', '1.00', { status: 'VOID' }), 'x', at)).toEqual({ kind: 'UNCHANGED' });
    expect(planVoidStatement(loanOf({ status: 'VOID' }), statementOf('2027-02-28', '1.00'), 'x', at)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
    expect(planVoidStatement(loan, statementOf('2027-02-28', '1.00'), 'Tippfehler', at)).toMatchObject({
      kind: 'VOID',
      next: { status: 'VOID', voidedAt: at, voidReason: 'Tippfehler', version: 2 },
    });
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

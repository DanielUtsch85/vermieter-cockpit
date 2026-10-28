import { describe, expect, it } from 'vitest';
import { Money, addMonths, type BusinessDate } from '../../shared/index.js';
import type { Loan, LoanId } from './loan.js';
import {
  checkAppend,
  deriveSchedule,
  formatRate,
  monthlyInterest,
  parseRate,
  planVoidTerms,
  plannedBalanceOn,
  withValidUntil,
  type LoanTerms,
  type LoanTermsData,
  type LoanTermsId,
} from './terms.js';

/** VC-3-02 rules of api-design.md §41.2 and the derivation of P3-D5, hand-computed. */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');

const loan: Loan = {
  id: 'f0000000-0000-4000-8000-000000000000' as LoanId,
  mreRealmId: 'realm',
  status: 'ACTIVE',
  lenderPartyId: 'a',
  borrowerPartyIds: ['b'],
  principalOriginal: eur('100000.00'),
  startDate: day('2026-08-15'),
  disbursementDate: day('2026-09-01'),
  maturityDate: null,
  contractNumber: null,
  acquisitionId: null,
  sourceReferences: [],
  notes: null,
  voidedAt: null,
  voidReason: null,
  closingDate: null,
  closingReason: null,
  refinancedByLoanId: null,
  closingNote: null,
  createdAt: new Date('2026-08-15T10:00:00Z'),
  version: 1,
};

const data = (overrides: Partial<LoanTermsData> = {}): LoanTermsData => ({
  validFrom: day('2026-09-01'),
  interestRate: 3000n,
  repaymentModel: 'ANNUITY',
  scheduledPayment: eur('500.00'),
  firstPaymentDate: day('2026-10-01'),
  principalAtStart: null,
  fixedRateUntil: null,
  initialRepaymentRate: null,
  specialRepaymentLimit: null,
  notes: null,
  ...overrides,
});
let counter = 0;
const terms = (overrides: Partial<LoanTermsData> = {}, status: 'VALID' | 'VOID' = 'VALID'): LoanTerms => ({
  ...data(overrides),
  id: `t${++counter}` as LoanTermsId,
  loanId: loan.id,
  mreRealmId: 'realm',
  status,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date(),
  version: 1,
});

describe('rates', () => {
  it('parses at most three decimals in [0, 100) and formats with three', () => {
    expect(parseRate('3.45')).toBe(3450n);
    expect(parseRate('0')).toBe(0n);
    expect(parseRate('99.999')).toBe(99999n);
    for (const bad of ['100', '3.4567', '-1', '1e2', ' 3', '3.', '.5']) expect(parseRate(bad), bad).toBeUndefined();
    expect(formatRate(3450n)).toBe('3.450');
    expect(formatRate(5n)).toBe('0.005');
  });
});

describe('monthlyInterest', () => {
  it('is round_half_up(balance × rate / 100 / 12) in cents', () => {
    // 100 000.00 at 3 %: 250.00 a month.
    expect(monthlyInterest(10_000_000n, 3000n)).toBe(25_000n);
    // 99 750.00 at 3 %: 249.375 → 249.38.
    expect(monthlyInterest(9_975_000n, 3000n)).toBe(24_938n);
    // Exactly half a cent rounds up; just below it rounds down.
    expect(monthlyInterest(600n, 1000n)).toBe(1n);
    expect(monthlyInterest(599n, 1000n)).toBe(0n);
    expect(monthlyInterest(10_000_000n, 0n)).toBe(0n);
  });
});

describe('addMonths', () => {
  it('keeps the day, clamped to the month end, counted from the original date', () => {
    expect(addMonths(day('2026-01-31'), 1)).toBe('2026-02-28');
    expect(addMonths(day('2028-01-31'), 1)).toBe('2028-02-29');
    expect(addMonths(day('2026-01-31'), 2)).toBe('2026-03-31');
    expect(addMonths(day('2026-11-15'), 3)).toBe('2027-02-15');
  });
});

describe('deriveSchedule', () => {
  it('annuity: interest on the balance, the rest repays; the last payment is capped at the balance', () => {
    const entries = deriveSchedule(eur('1000.00'), null, [terms({ scheduledPayment: eur('400.00'), interestRate: 6000n })]);
    // 1000.00 at 6 %: 5.00 interest, 395.00 repaid; then 3.025 → 3.03 on 605.00; the third repays the last 208.03.
    expect(entries.map((e) => [e.paymentDate, e.interest, e.principal, e.balanceAfter])).toEqual([
      ['2026-10-01', 500n, 39_500n, 60_500n],
      ['2026-11-01', 303n, 39_697n, 20_803n],
      ['2026-12-01', 104n, 20_803n, 0n],
    ]);
  });

  it('interest-only: no principal, one payment a month until maturity', () => {
    const entries = deriveSchedule(eur('1000.00'), day('2027-01-01'), [terms({ repaymentModel: 'INTEREST_ONLY', scheduledPayment: null })]);
    expect(entries.map((e) => [e.paymentDate, e.interest, e.principal])).toEqual([
      ['2026-10-01', 250n, 0n],
      ['2026-11-01', 250n, 0n],
      ['2026-12-01', 250n, 0n],
      ['2027-01-01', 250n, 0n],
    ]);
  });

  it('a period stops at the next validFrom; principalAtStart restarts the balance', () => {
    const first = terms();
    const second = terms({ validFrom: day('2026-11-15'), firstPaymentDate: day('2026-12-01'), interestRate: 2000n, principalAtStart: eur('90000.00') });
    const entries = deriveSchedule(eur('100000.00'), null, [first, second]).slice(0, 3);
    expect(entries.map((e) => [e.termsId, e.paymentDate, e.balanceBefore])).toEqual([
      [first.id, '2026-10-01', 10_000_000n],
      [first.id, '2026-11-01', 9_975_000n],
      [second.id, '2026-12-01', 9_000_000n],
    ]);
  });
});

describe('plannedBalanceOn', () => {
  it('carries the balance over: 100 000.00 at 3 % with 500.00 a month, after October and November', () => {
    // Oct: 250.00 interest, 250.00 principal → 99 750.00; Nov: 249.38 interest, 250.62 principal → 99 499.38.
    expect(plannedBalanceOn(eur('100000.00'), null, [terms()], day('2026-12-01'))).toBe(9_949_938n);
    // A payment on the day itself belongs to the next period.
    expect(plannedBalanceOn(eur('100000.00'), null, [terms()], day('2026-11-01'))).toBe(9_975_000n);
    expect(plannedBalanceOn(eur('100000.00'), null, [], day('2026-12-01'))).toBe(10_000_000n);
  });

  it('a later period with principalAtStart and no payment yet starts from that figure', () => {
    const later = terms({ validFrom: day('2027-01-15'), firstPaymentDate: day('2027-03-01'), principalAtStart: eur('80000.00') });
    expect(plannedBalanceOn(eur('100000.00'), null, [terms(), later], day('2027-02-15'))).toBe(8_000_000n);
  });
});

describe('checkAppend (order of §41.2)', () => {
  it('LOAN_NOT_ACTIVE, then TERMS_BEFORE_DEBT, then TERMS_NOT_APPENDED, then PREVIOUS_TERMS_WITHOUT_PAYMENT', () => {
    expect(checkAppend({ ...loan, status: 'VOID' }, [], data({ validFrom: day('2020-01-01') }))).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
    expect(checkAppend(loan, [], data({ validFrom: day('2026-08-31') }))).toEqual({ kind: 'TERMS_BEFORE_DEBT', debtFrom: '2026-09-01' });
    const first = terms();
    expect(checkAppend(loan, [first], data())).toEqual({ kind: 'TERMS_NOT_APPENDED', lastValidFrom: '2026-09-01' });
    expect(checkAppend(loan, [first], data({ validFrom: day('2026-10-01'), firstPaymentDate: day('2026-11-01') }))).toEqual({
      kind: 'PREVIOUS_TERMS_WITHOUT_PAYMENT',
      termsId: first.id,
      firstPaymentDate: '2026-10-01',
    });
    expect(checkAppend(loan, [first], data({ validFrom: day('2026-10-02'), firstPaymentDate: day('2026-11-01') }))).toBeUndefined();
  });

  it('principalAtStart: not on the first period, never above the original', () => {
    expect(checkAppend(loan, [], data({ principalAtStart: eur('1.00') }))).toEqual({ kind: 'PRINCIPAL_AT_START_ON_FIRST_TERMS' });
    expect(
      checkAppend(loan, [terms()], data({ validFrom: day('2027-01-01'), firstPaymentDate: day('2027-02-01'), principalAtStart: eur('100000.01') })),
    ).toEqual({
      kind: 'PRINCIPAL_AT_START_EXCEEDS_ORIGINAL',
      principalOriginal: loan.principalOriginal,
    });
  });

  it('an annuity must exceed the first interest: equal is refused, one cent above passes; rate 0 always repays', () => {
    expect(checkAppend(loan, [], data({ scheduledPayment: eur('250.00') }))).toEqual({
      kind: 'PAYMENT_DOES_NOT_COVER_INTEREST',
      firstInterest: 25_000n,
      balance: 10_000_000n,
    });
    expect(checkAppend(loan, [], data({ scheduledPayment: eur('250.01') }))).toBeUndefined();
    expect(checkAppend(loan, [], data({ interestRate: 0n, scheduledPayment: eur('0.01') }))).toBeUndefined();
    // A follow-up on the carried-over balance 99 499.38 at 3 %: 248.748… → 248.75.
    const follow = data({ validFrom: day('2026-12-01'), firstPaymentDate: day('2027-01-01'), scheduledPayment: eur('248.75') });
    expect(checkAppend(loan, [terms()], follow)).toEqual({ kind: 'PAYMENT_DOES_NOT_COVER_INTEREST', firstInterest: 24_875n, balance: 9_949_938n });
    expect(checkAppend(loan, [terms()], { ...follow, scheduledPayment: eur('248.76') })).toBeUndefined();
    // principalAtStart is the balance the check uses.
    expect(checkAppend(loan, [terms()], { ...follow, principalAtStart: eur('1000.00'), scheduledPayment: eur('2.51') })).toBeUndefined();
    // Interest-only has no payment to check.
    expect(checkAppend(loan, [], data({ repaymentModel: 'INTEREST_ONLY', scheduledPayment: null }))).toBeUndefined();
  });
});

describe('planVoidTerms and withValidUntil', () => {
  it('a VOID period is a no-op; a VOID Loan refuses; only the last VALID period is voidable', () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const [first, second] = [terms(), terms({ validFrom: day('2027-01-01'), firstPaymentDate: day('2027-02-01') })];
    expect(planVoidTerms(loan, { ...first, status: 'VOID' }, [second], 'x', at)).toEqual({ kind: 'UNCHANGED' });
    expect(planVoidTerms({ ...loan, status: 'CLOSED' }, second, [first, second], 'x', at)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'CLOSED' });
    expect(planVoidTerms(loan, first, [first, second], 'x', at)).toEqual({ kind: 'TERMS_NOT_LAST', laterTermsId: second.id });
    expect(planVoidTerms(loan, second, [first, second], 'falsch', at)).toEqual({
      kind: 'VOID',
      next: { ...second, status: 'VOID', voidedAt: at, voidReason: 'falsch', version: 2 },
    });
  });

  it('validUntil is the day before the next VALID period; VOID ones do not count', () => {
    const first = terms();
    const voided = terms({ validFrom: day('2027-01-01') }, 'VOID');
    const third = terms({ validFrom: day('2027-03-01') });
    expect(withValidUntil([first, voided, third]).map((t) => t.validUntil)).toEqual(['2027-02-28', '2027-02-28', null]);
  });
});

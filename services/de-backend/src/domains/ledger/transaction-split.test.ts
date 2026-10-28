import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { checkLoanSplits, planSplits, sameSplits, type SplitInput } from './transaction-split.js';
import type { TransactionStatus } from './transaction.js';

const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, financialCategoryCode = 'LOAN_INTEREST', extra: Partial<SplitInput> = {}): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId: null,
  loanId: null,
  description: null,
  ...extra,
});
const loanPayment = (status: TransactionStatus = 'IMPORTED') => ({ amount: eur('1200.00'), status });

describe('planSplits (data-model.md §18, domain-model.md §21)', () => {
  it('a set that adds up exactly classifies the Transaction', () => {
    expect(planSplits(loanPayment(), [split('600.00'), split('600', 'LOAN_PRINCIPAL')])).toEqual({
      kind: 'APPLY',
      nextStatus: 'CLASSIFIED',
    });
    expect(planSplits(loanPayment('UNREVIEWED'), [split('1200')])).toMatchObject({ kind: 'APPLY' });
    expect(planSplits(loanPayment('CLASSIFIED'), [split('0.01'), split('1199.99')])).toMatchObject({ kind: 'APPLY' });
  });

  it('one cent off is a mismatch, in both directions — no rounding tolerance', () => {
    expect(planSplits(loanPayment(), [split('600.00'), split('599.99')])).toEqual({
      kind: 'SUM_MISMATCH',
      expected: eur('1200.00'),
      actual: eur('1199.99'),
    });
    expect(planSplits(loanPayment(), [split('600.00'), split('600.01')])).toMatchObject({ kind: 'SUM_MISMATCH' });
  });

  it('CONFIRMED and later, and IGNORED, are frozen — checked before anything else', () => {
    for (const status of ['CONFIRMED', 'RECONCILED', 'CORRECTED', 'IGNORED'] as const) {
      expect(planSplits(loanPayment(status), [split('1.00')])).toEqual({ kind: 'FROZEN', status });
    }
  });

  it('a zero Transaction is classified by zero splits summing to zero', () => {
    expect(planSplits({ amount: eur('0'), status: 'UNREVIEWED' }, [split('0.00')])).toMatchObject({ kind: 'APPLY' });
  });
});

describe('sameSplits', () => {
  it('compares amount by value, category, references and order', () => {
    const current = [split('600.00'), split('600.00', 'LOAN_PRINCIPAL')];
    expect(sameSplits(current, [split('600'), split('600.0', 'LOAN_PRINCIPAL')])).toBe(true);
    expect(sameSplits(current, [split('600', 'LOAN_PRINCIPAL'), split('600')])).toBe(false);
    expect(sameSplits(current, [split('600'), split('600', 'LOAN_PRINCIPAL', { description: 'Rate 10' })])).toBe(false);
    expect(sameSplits(current, [split('1200')])).toBe(false);
    // loanId is part of the set (§41.5): changing only it is a change.
    expect(sameSplits(current, [split('600', 'LOAN_INTEREST', { loanId: 'l1' }), split('600', 'LOAN_PRINCIPAL')])).toBe(false);
    expect(sameSplits([], [])).toBe(true);
  });
});

describe('checkLoanSplits (api-design §41.5)', () => {
  const bookingDate = '2027-03-01' as BusinessDate;
  const outflow = { direction: 'OUTFLOW' as const, reversal: false, bookingDate };
  const loans = new Map([
    ['l1', { status: 'ACTIVE', closingDate: null }],
    ['l2', { status: 'VOID', closingDate: null }],
    ['l3', { status: 'CLOSED', closingDate: '2027-02-28' as BusinessDate }],
    ['l4', { status: 'CLOSED', closingDate: '2027-03-01' as BusinessDate }],
  ]);
  const withLoan = (loanId: string, code = 'LOAN_INTEREST') => split('1.00', code, { loanId });

  it('passes LOAN_INTEREST and LOAN_PRINCIPAL of an OUTFLOW for an ACTIVE Loan, and splits without a Loan', () => {
    expect(checkLoanSplits(outflow, [withLoan('l1'), withLoan('l1', 'LOAN_PRINCIPAL'), split('1.00', 'OTHER')], loans)).toBeUndefined();
    expect(checkLoanSplits({ direction: 'INFLOW', reversal: false, bookingDate }, [split('1.00', 'LOAN_INTEREST')], loans)).toBeUndefined();
  });

  it('in the order of §41.5: an unknown Loan, then the category, then the direction, then a VOID Loan, each first by position', () => {
    const all = [withLoan('l2'), withLoan('l1', 'OTHER'), withLoan('nope'), withLoan('gone')];
    expect(checkLoanSplits({ direction: 'INFLOW', reversal: false, bookingDate }, all, loans)).toEqual({ kind: 'LOAN_NOT_FOUND', loanId: 'nope' });
    expect(checkLoanSplits({ direction: 'INFLOW', reversal: false, bookingDate }, all.slice(0, 2), loans)).toEqual({
      kind: 'INVALID_LOAN_SPLIT',
      position: 2,
      reason: 'CATEGORY',
    });
    expect(checkLoanSplits({ direction: 'INFLOW', reversal: false, bookingDate }, [split('1.00', 'OTHER'), withLoan('l2')], loans)).toEqual({
      kind: 'INVALID_LOAN_SPLIT',
      position: 2,
      reason: 'DIRECTION',
    });
    expect(checkLoanSplits(outflow, [withLoan('l1'), withLoan('l2')], loans)).toEqual({ kind: 'LOAN_NOT_ACTIVE', loanId: 'l2', status: 'VOID' });
  });

  it('a reversal is exempt from the direction (review on #58)', () => {
    expect(checkLoanSplits({ direction: 'INFLOW', reversal: true, bookingDate }, [withLoan('l1')], loans)).toBeUndefined();
  });

  it('a CLOSED Loan (§41.7): refused after its closing date, allowed on it; after the VOID check; a reversal exempt', () => {
    expect(checkLoanSplits(outflow, [withLoan('l4'), withLoan('l3')], loans)).toEqual({ kind: 'LOAN_CLOSED', loanId: 'l3', closingDate: '2027-02-28' });
    expect(checkLoanSplits(outflow, [withLoan('l4')], loans)).toBeUndefined();
    expect(checkLoanSplits(outflow, [withLoan('l3'), withLoan('l2')], loans)).toEqual({ kind: 'LOAN_NOT_ACTIVE', loanId: 'l2', status: 'VOID' });
    expect(checkLoanSplits({ direction: 'INFLOW', reversal: true, bookingDate }, [withLoan('l3')], loans)).toBeUndefined();
  });
});

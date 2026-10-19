import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { planSplits, sameSplits, type SplitInput } from './transaction-split.js';
import type { TransactionStatus } from './transaction.js';

const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, financialCategoryCode = 'LOAN_INTEREST', extra: Partial<SplitInput> = {}): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId: null,
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
    expect(sameSplits([], [])).toBe(true);
  });
});

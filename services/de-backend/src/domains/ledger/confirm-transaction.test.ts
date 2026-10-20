import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { planConfirm, type SplitForConfirm } from './confirm-transaction.js';
import type { TransactionStatus } from './transaction.js';

const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, code = 'LOAN_INTEREST', categoryActive = true): SplitForConfirm => ({
  amount: eur(amount),
  financialCategoryCode: code,
  categoryActive,
});
const tx = (status: TransactionStatus) => ({ amount: eur('1200.00'), status });

describe('planConfirm (api-design.md §34, domain-model.md §21/§24)', () => {
  it('confirms a CLASSIFIED Transaction whose active-category splits sum exactly', () => {
    expect(planConfirm(tx('CLASSIFIED'), [split('600'), split('600.00', 'LOAN_PRINCIPAL')])).toEqual({ kind: 'CONFIRM' });
  });

  it('is a no-op once confirmed; CORRECTED and IGNORED are never confirmable', () => {
    expect(planConfirm(tx('CONFIRMED'), [])).toEqual({ kind: 'ALREADY_CONFIRMED' });
    expect(planConfirm(tx('RECONCILED'), [])).toEqual({ kind: 'ALREADY_CONFIRMED' });
    expect(planConfirm(tx('CORRECTED'), [split('1200')])).toEqual({ kind: 'NOT_CONFIRMABLE', status: 'CORRECTED' });
    expect(planConfirm(tx('IGNORED'), [split('1200')])).toEqual({ kind: 'NOT_CONFIRMABLE', status: 'IGNORED' });
  });

  it('needs splits, an exact sum (re-checked) and active categories, in that order', () => {
    expect(planConfirm(tx('IMPORTED'), [])).toEqual({ kind: 'SPLITS_MISSING' });
    expect(planConfirm(tx('UNREVIEWED'), [])).toEqual({ kind: 'SPLITS_MISSING' });
    expect(planConfirm(tx('CLASSIFIED'), [split('600'), split('599.99', 'OLD', false)])).toEqual({
      kind: 'SUM_MISMATCH',
      expected: eur('1200.00'),
      actual: eur('1199.99'),
    });
    expect(planConfirm(tx('CLASSIFIED'), [split('600', 'OLD', false), split('600', 'OLD', false)])).toEqual({
      kind: 'INACTIVE_CATEGORY',
      codes: ['OLD'],
    });
  });
});

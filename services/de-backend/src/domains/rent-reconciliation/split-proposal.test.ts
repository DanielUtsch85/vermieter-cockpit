import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { proposeRentSplit, type RentTermTotals } from './split-proposal.js';

/** §37.6's split proposal (#126). */
const eur = (amount: string) => Money.of(amount, 'EUR');
const totals = (overrides: Partial<Record<keyof RentTermTotals, string>> = {}): RentTermTotals => {
  const v = { preTaxAmount: '650.00', charges: '150.00', debts: '0.00', discount: '0.00', vat: '0.00', balance: '0.00', grandTotal: '800.00', ...overrides };
  return Object.fromEntries(Object.entries(v).map(([k, a]) => [k, eur(a)])) as unknown as RentTermTotals;
};
const view = (p: ReturnType<typeof proposeRentSplit>) => ({
  splits: p.splits.map((s) => [s.financialCategoryCode, s.amount.amount]),
  unallocated: p.unallocated.amount,
  flags: p.flags.map((f) => ('details' in f ? [f.code, Object.values(f.details)[0]?.amount] : [f.code])),
});

describe('proposeRentSplit (§37.6)', () => {
  it('the exact amount: rent and advance, nothing unallocated, no flags; the term as read', () => {
    const p = proposeRentSplit(eur('800.00'), totals(), false);
    expect(view(p)).toEqual({
      splits: [
        ['RENT_BASE', '650.00'],
        ['RENT_OPERATING_COST_ADVANCE', '150.00'],
      ],
      unallocated: '0.00',
      flags: [],
    });
    expect([p.term.rent, p.term.charges, p.term.adjustments, p.term.due].map((m) => m.amount)).toEqual(['650.00', '150.00', '0.00', '800.00']);
  });

  it('less than due: the advance takes the shortfall; flagged with the signed difference', () => {
    expect(view(proposeRentSplit(eur('790.00'), totals(), false))).toEqual({
      splits: [
        ['RENT_BASE', '650.00'],
        ['RENT_OPERATING_COST_ADVANCE', '140.00'],
      ],
      unallocated: '0.00',
      flags: [['AMOUNT_DIFFERS_FROM_TERM', '-10.00']],
    });
  });

  it('below the rent: only RENT_BASE, the advance of 0 left out', () => {
    expect(view(proposeRentSplit(eur('600.00'), totals(), false)).splits).toEqual([['RENT_BASE', '600.00']]);
  });

  it('more than due: the rest stays unallocated', () => {
    expect(view(proposeRentSplit(eur('850.00'), totals(), false))).toMatchObject({ unallocated: '50.00', flags: [['AMOUNT_DIFFERS_FROM_TERM', '50.00']] });
  });

  it('a term with adjustments (VAT, debts, discount): flagged; due includes them; their part stays unallocated', () => {
    const p = proposeRentSplit(eur('820.00'), totals({ debts: '30.00', discount: '10.00', grandTotal: '820.00' }), false);
    expect(view(p)).toEqual({
      splits: [
        ['RENT_BASE', '650.00'],
        ['RENT_OPERATING_COST_ADVANCE', '150.00'],
      ],
      unallocated: '20.00',
      flags: [['TERM_HAS_ADJUSTMENTS', '20.00']],
    });
  });

  it('a balance carried from earlier months is not due for this term', () => {
    expect(proposeRentSplit(eur('800.00'), totals({ balance: '100.00', grandTotal: '900.00' }), false).term.due.amount).toBe('800.00');
  });

  it('ALREADY_SPLIT last; splits plus unallocated always equal the amount', () => {
    const p = proposeRentSplit(eur('123.45'), totals(), true);
    expect(view(p).flags.at(-1)).toEqual(['ALREADY_SPLIT']);
    const sum = p.splits.reduce((acc, s) => acc.add(s.amount), p.unallocated);
    expect(sum.amount).toBe('123.45');
  });
});

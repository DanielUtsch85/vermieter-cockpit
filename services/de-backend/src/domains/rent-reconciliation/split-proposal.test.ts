import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { proposeRentSplit, soleTermProperty, type ProposalProperty, type RentTermTotals } from './split-proposal.js';

/** §37.6's split proposal (#126). */
const eur = (amount: string) => Money.of(amount, 'EUR');
const totals = (overrides: Partial<Record<keyof RentTermTotals, string>> = {}): RentTermTotals => {
  const v = { rent: '650.00', charges: '150.00', due: '800.00', ...overrides };
  return Object.fromEntries(Object.entries(v).map(([k, a]) => [k, eur(a)])) as unknown as RentTermTotals;
};
const FLAT = '6a0000000000000000000001';
const GARAGE = '6a0000000000000000000002';
const linked: ProposalProperty = { mrePropertyIds: [FLAT], propertyReferenceId: 'p-1' };
const view = (p: ReturnType<typeof proposeRentSplit>) => ({
  splits: p.splits.map((s) => [s.financialCategoryCode, s.amount.amount]),
  unallocated: p.unallocated.amount,
  flags: p.flags.map((f) =>
    f.code === 'AMOUNT_DIFFERS_FROM_TERM' || f.code === 'TERM_HAS_ADJUSTMENTS' ? [f.code, Object.values(f.details)[0]?.amount] : [f.code],
  ),
});

describe('proposeRentSplit (§37.6)', () => {
  it('the exact amount: rent and advance, nothing unallocated, no flags; the term as read', () => {
    const p = proposeRentSplit(eur('800.00'), totals(), false, linked);
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
    expect(view(proposeRentSplit(eur('790.00'), totals(), false, linked))).toEqual({
      splits: [
        ['RENT_BASE', '650.00'],
        ['RENT_OPERATING_COST_ADVANCE', '140.00'],
      ],
      unallocated: '0.00',
      flags: [['AMOUNT_DIFFERS_FROM_TERM', '-10.00']],
    });
  });

  it('below the rent: only RENT_BASE, the advance of 0 left out', () => {
    expect(view(proposeRentSplit(eur('600.00'), totals(), false, linked)).splits).toEqual([['RENT_BASE', '600.00']]);
  });

  it('more than due: the rest stays unallocated', () => {
    expect(view(proposeRentSplit(eur('850.00'), totals(), false, linked))).toMatchObject({
      unallocated: '50.00',
      flags: [['AMOUNT_DIFFERS_FROM_TERM', '50.00']],
    });
  });

  it('a term with adjustments (VAT, debts, discount): flagged; due includes them; their part stays unallocated', () => {
    const p = proposeRentSplit(eur('820.00'), totals({ due: '820.00' }), false, linked);
    expect(view(p)).toEqual({
      splits: [
        ['RENT_BASE', '650.00'],
        ['RENT_OPERATING_COST_ADVANCE', '150.00'],
      ],
      unallocated: '20.00',
      flags: [['TERM_HAS_ADJUSTMENTS', '20.00']],
    });
  });

  it('ALREADY_SPLIT last; splits plus unallocated always equal the amount', () => {
    const p = proposeRentSplit(eur('123.45'), totals(), true, linked);
    expect(view(p).flags.at(-1)).toEqual(['ALREADY_SPLIT']);
    const sum = p.splits.reduce((acc, s) => acc.add(s.amount), p.unallocated);
    expect(sum.amount).toBe('123.45');
  });

  it('#368: the linked property on every split and in property, no flag', () => {
    const p = proposeRentSplit(eur('800.00'), totals(), false, linked);
    expect(p.property).toEqual({ mrePropertyIds: [FLAT], propertyReferenceId: 'p-1' });
    expect(p.splits.map((s) => s.propertyReferenceId)).toEqual(['p-1', 'p-1']);
    expect(p.flags).toEqual([]);
  });

  it.each([
    ['NO_PROPERTY_FOR_TERM', []],
    ['SEVERAL_PROPERTIES', [FLAT, GARAGE]],
    ['PROPERTY_NOT_LINKED', [FLAT]],
  ] as const)('#368: %s leaves every split without a property and raises NO_PROPERTY_REFERENCE last', (reason, mrePropertyIds) => {
    const p = proposeRentSplit(eur('790.00'), totals(), true, { mrePropertyIds, reason });
    expect(p.property).toEqual({ mrePropertyIds, propertyReferenceId: null });
    expect(p.splits.map((s) => s.propertyReferenceId)).toEqual([null, null]);
    expect(p.flags.map((f) => f.code)).toEqual(['AMOUNT_DIFFERS_FROM_TERM', 'ALREADY_SPLIT', 'NO_PROPERTY_REFERENCE']);
    expect(p.flags.at(-1)).toEqual({ code: 'NO_PROPERTY_REFERENCE', details: { reason, mrePropertyIds } });
  });

  it('#368: the property changes no amount', () => {
    const amounts = (property: ProposalProperty) => view(proposeRentSplit(eur('790.00'), totals(), false, property)).splits;
    expect(amounts({ mrePropertyIds: [], reason: 'NO_PROPERTY_FOR_TERM' })).toEqual(amounts(linked));
  });
});

describe('soleTermProperty (§37.6, #368)', () => {
  it('exactly one MRE property is looked up; none or several are the reason, never the first', () => {
    expect(soleTermProperty([FLAT])).toEqual({ mrePropertyId: FLAT });
    expect(soleTermProperty([])).toEqual({ reason: 'NO_PROPERTY_FOR_TERM' });
    expect(soleTermProperty([FLAT, GARAGE])).toEqual({ reason: 'SEVERAL_PROPERTIES' });
  });
});

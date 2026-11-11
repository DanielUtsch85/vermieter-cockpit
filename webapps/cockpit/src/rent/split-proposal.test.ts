import { describe, expect, it } from 'vitest';
import { checkDraft } from '../transactions/split-draft';
import { addCents, decimalToCents } from '../transactions/split-amount';
import { splitProposal, TENANT, TENANT_2, TERM, TERM_2 } from './fixtures.test-support';
import { checkMatchAmount, checkTenantId, checkTermKey, combineProposals, draftFromProposal, hasFreeCash, type CombinedProposal } from './split-proposal';

/**
 * Step 8's rules (Entscheidung des Projektinhabers, 2026-11-11; ui-guide.md §6.6 steps 2 and 3; api-design.md §37.1,
 * §37.6) on synthetic ids and amounts only. Money stays digit strings: the sums are checked on whole cents.
 */

const EUR = (amount: string) => ({ amount, currency: 'EUR' });
let n = 0;
const key = () => `k${(n += 1)}`;

/** Lines plus remainder, on whole cents: always the payment. */
function total(combined: CombinedProposal): string {
  return [...combined.lines.map((line) => line.amount), combined.remainder].reduce((sum, amount) => addCents(sum, decimalToCents(amount) ?? 'x'), '0');
}
const lines = (combined: CombinedProposal | undefined) =>
  combined?.lines.map((line) => [line.financialCategoryCode, line.amount, line.source.mreRentTerm, line.cut]);

describe('step 8: the MRE keys a user types (never a name, ui-guide.md §5.1)', () => {
  it('a Tenant id is 24 lowercase hex digits after trimming', () => {
    expect(checkTenantId(` ${TENANT} `)).toBeUndefined();
    expect(checkTenantId('')).toBe('TENANT_MISSING');
    expect(checkTenantId('   ')).toBe('TENANT_MISSING');
    expect(checkTenantId(TENANT.toUpperCase())).toBe('TENANT_INVALID');
    expect(checkTenantId(TENANT.slice(1))).toBe('TENANT_INVALID');
    expect(checkTenantId(`${TENANT}0`)).toBe('TENANT_INVALID');
    expect(checkTenantId('Erika Beispiel')).toBe('TENANT_INVALID');
  });

  it('a term is the key YYYYMMDDHH with a real date and hour', () => {
    expect(checkTermKey(TERM)).toBeUndefined();
    expect(checkTermKey('2028022900')).toBeUndefined();
    expect(checkTermKey('2026022900')).toBe('TERM_INVALID');
    expect(checkTermKey('2026130100')).toBe('TERM_INVALID');
    expect(checkTermKey('2026100124')).toBe('TERM_INVALID');
    expect(checkTermKey('2026-10')).toBe('TERM_INVALID');
    expect(checkTermKey('')).toBe('TERM_MISSING');
  });
});

describe('step 8: combining proposals (api-design.md §37.6, applied to what is left of the payment)', () => {
  it('one term, exact payment: the server proposal as it is, no remainder', () => {
    const combined = combineProposals(EUR('850.00'), [splitProposal()]);
    expect(lines(combined)).toEqual([
      ['RENT_BASE', '700.00', TERM, false],
      ['RENT_OPERATING_COST_ADVANCE', '150.00', TERM, false],
    ]);
    expect(combined?.remainder).toBe('0.00');
  });

  it('a partial payment below the target: the advance is cut, nothing remains, the sum is the payment', () => {
    const combined = combineProposals(EUR('800.00'), [splitProposal({ amount: '800.00' })]);
    expect(lines(combined)).toEqual([
      ['RENT_BASE', '700.00', TERM, false],
      ['RENT_OPERATING_COST_ADVANCE', '100.00', TERM, false],
    ]);
    expect(combined?.remainder).toBe('0.00');
    if (combined !== undefined) expect(total(combined)).toBe('80000');
  });

  it('an overpayment above the target: the term in full, the excess as remainder', () => {
    const combined = combineProposals(EUR('900.01'), [splitProposal({ amount: '900.01' })]);
    expect(lines(combined)?.map((line) => line[1])).toEqual(['700.00', '150.00']);
    expect(combined?.remainder).toBe('50.01');
    if (combined !== undefined) expect(total(combined)).toBe('90001');
  });

  it('two months in one payment: each term in full, in the order chosen, no remainder', () => {
    const october = splitProposal({ amount: '1700.00' });
    const november = splitProposal({ amount: '1700.00', term: TERM_2 });
    const combined = combineProposals(EUR('1700.00'), [october, november]);
    expect(lines(combined)).toEqual([
      ['RENT_BASE', '700.00', TERM, false],
      ['RENT_OPERATING_COST_ADVANCE', '150.00', TERM, false],
      ['RENT_BASE', '700.00', TERM_2, false],
      ['RENT_OPERATING_COST_ADVANCE', '150.00', TERM_2, false],
    ]);
    expect(combined?.remainder).toBe('0.00');
  });

  it('two months paid short: the second term takes only what is left, cut and marked', () => {
    const combined = combineProposals(EUR('1650.00'), [splitProposal({ amount: '1650.00' }), splitProposal({ amount: '1650.00', term: TERM_2 })]);
    expect(lines(combined)).toEqual([
      ['RENT_BASE', '700.00', TERM, false],
      ['RENT_OPERATING_COST_ADVANCE', '150.00', TERM, false],
      ['RENT_BASE', '700.00', TERM_2, false],
      ['RENT_OPERATING_COST_ADVANCE', '100.00', TERM_2, true],
    ]);
    if (combined !== undefined) expect(total(combined)).toBe('165000');
  });

  it('two Tenants in one payment, a term with rent only, and one the payment no longer reaches', () => {
    const a = splitProposal({ amount: '1000.00' });
    const b = splitProposal({ amount: '1000.00', tenant: TENANT_2, rent: '300.00', charges: '0.00' });
    const c = splitProposal({ amount: '1000.00', tenant: TENANT_2, term: TERM_2, rent: '300.00', charges: '0.00' });
    const combined = combineProposals(EUR('1000.00'), [a, b, c]);
    expect(combined?.lines.map((line) => [line.source.mreTenantId, line.amount, line.cut])).toEqual([
      [TENANT, '700.00', false],
      [TENANT, '150.00', false],
      [TENANT_2, '150.00', true],
    ]);
    expect(combined?.remainder).toBe('0.00');
  });

  it('zero: a split of 0,00 is left out; a payment of 0,00 gives no line and nothing to take over', () => {
    const combined = combineProposals(EUR('0.00'), [splitProposal({ amount: '0.00' })]);
    expect(combined).toEqual({ lines: [], remainder: '0.00' });
    if (combined !== undefined) expect(draftFromProposal(combined, key)).toBeUndefined();
    const withZero = splitProposal(
      {},
      {
        splits: [
          { financialCategoryCode: 'RENT_BASE', amount: EUR('0.00') },
          { financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', amount: EUR('850.00') },
        ],
      },
    );
    expect(lines(combineProposals(EUR('850.00'), [withZero]))).toEqual([['RENT_OPERATING_COST_ADVANCE', '850.00', TERM, false]]);
  });

  it('beyond 2^53 cents: digit strings, exact to the cent', () => {
    const big = '90071992547409.93';
    const combined = combineProposals(EUR(big), [splitProposal({ amount: big, rent: '90071992547409.00', charges: '0.50' })]);
    expect(lines(combined)?.map((line) => line[1])).toEqual(['90071992547409.00', '0.50']);
    expect(combined?.remainder).toBe('0.43');
    if (combined !== undefined) expect(total(combined)).toBe('9007199254740993');
  });

  it('an unreadable amount or another currency: no combination', () => {
    expect(combineProposals(EUR('8,50'), [splitProposal()])).toBeUndefined();
    expect(
      combineProposals(EUR('850.00'), [splitProposal({}, { splits: [{ financialCategoryCode: 'RENT_BASE', amount: { amount: '850.00', currency: 'CHF' } }] })]),
    ).toBeUndefined();
  });
});

describe('step 8: the draft taken over (ui-guide.md §6.4: an editable draft, nothing sent)', () => {
  it('one row per line without a reference; the draft covers the payment exactly', () => {
    const combined = combineProposals(EUR('1700.00'), [splitProposal({ amount: '1700.00' }), splitProposal({ amount: '1700.00', term: TERM_2 })]);
    const rows = combined === undefined ? undefined : draftFromProposal(combined, key);
    expect(rows?.map((row) => [row.financialCategoryCode, row.amount, row.reference.kind, row.description])).toEqual([
      ['RENT_BASE', '700,00', 'none', ''],
      ['RENT_OPERATING_COST_ADVANCE', '150,00', 'none', ''],
      ['RENT_BASE', '700,00', 'none', ''],
      ['RENT_OPERATING_COST_ADVANCE', '150,00', 'none', ''],
    ]);
    const check = checkDraft(rows ?? [], '1700.00');
    expect([check.sum, check.rest, check.exact, check.complete]).toEqual(['1700.00', '0.00', true, true]);
  });

  it('a remainder becomes its own row without a category: the sum is still the payment, saving waits for the category', () => {
    const combined = combineProposals(EUR('900.00'), [splitProposal({ amount: '900.00' })]);
    const rows = combined === undefined ? undefined : draftFromProposal(combined, key);
    expect(rows?.map((row) => [row.financialCategoryCode, row.amount])).toEqual([
      ['RENT_BASE', '700,00'],
      ['RENT_OPERATING_COST_ADVANCE', '150,00'],
      ['', '50,00'],
    ]);
    const check = checkDraft(rows ?? [], '900.00');
    expect([check.sum, check.exact, check.complete, check.problems[2]]).toEqual(['900.00', true, false, ['CATEGORY_MISSING']]);
  });

  it('more than 100 rows cannot be taken over', () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      splitProposal({ amount: '100000.00', term: `20${String(30 + Math.floor(i / 12))}${String((i % 12) + 1).padStart(2, '0')}0100` }),
    );
    const combined = combineProposals(EUR('100000.00'), many);
    expect(combined?.lines).toHaveLength(102);
    if (combined !== undefined) expect(draftFromProposal(combined, key)).toBeUndefined();
    const fifty = combineProposals(EUR('42500.00'), many.slice(0, 50));
    expect(fifty === undefined ? undefined : draftFromProposal(fifty, key)).toHaveLength(100);
  });
});

describe('step 8: the amount of a manual match (api-design.md §37.1)', () => {
  const free = EUR('850.00');
  it('more than zero and at most the free rent cash; less leaves the rest free', () => {
    expect(checkMatchAmount('850,00', free)).toEqual({ ok: true, amount: EUR('850.00') });
    expect(checkMatchAmount('800', free)).toEqual({ ok: true, amount: EUR('800.00') });
    expect(checkMatchAmount('0,01', free)).toEqual({ ok: true, amount: EUR('0.01') });
    expect(checkMatchAmount('850,01', free)).toEqual({ ok: false, problem: 'ABOVE_AVAILABLE' });
    expect(checkMatchAmount('0,00', free)).toEqual({ ok: false, problem: 'NOT_POSITIVE' });
    expect(checkMatchAmount('-5', free)).toEqual({ ok: false, problem: 'NEGATIVE' });
    expect(checkMatchAmount('850.5', free)).toEqual({ ok: false, problem: 'AMBIGUOUS' });
    expect(checkMatchAmount('', free)).toEqual({ ok: false, problem: 'EMPTY' });
  });

  it('free cash: only an amount above zero counts', () => {
    expect(hasFreeCash(EUR('0.01'))).toBe(true);
    expect(hasFreeCash(EUR('0.00'))).toBe(false);
    expect(hasFreeCash(null)).toBe(false);
    expect(hasFreeCash(EUR('x'))).toBe(false);
  });
});

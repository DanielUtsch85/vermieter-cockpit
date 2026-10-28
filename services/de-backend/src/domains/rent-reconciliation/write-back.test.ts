import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import {
  dePayment,
  isRoundTrippable,
  markerIn,
  markerOf,
  removalBody,
  storedPayments,
  verifyRemoved,
  verifyWritten,
  writeBody,
  type WriteBackTerm,
} from './write-back.js';

/** §37.4's round trip, against the shapes of MRE baseline 479d0ad (`toRentData`, `_updateByTerm`). */
const ID = '0B6F1F9E-2F2C-4A8E-9D55-1F0D8C1E2A3B';
const MARKER = 'DE-RPR-0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const eur = (amount: string) => Money.of(amount, 'EUR');
const mine = dePayment(ID, eur('800.10'), '2027-01-03' as BusinessDate);
const theirs = { date: '02/01/2027', amount: 50, type: 'cash', reference: '', description: 'Bar' };
const term = (overrides: Partial<WriteBackTerm> = {}): WriteBackTerm => ({
  mreTenantId: '6512f0c2a1b2c3d4e5f60a01',
  term: '2027010100',
  vatRatio: 0,
  payments: [theirs],
  promo: 20,
  notepromo: 'Rabatt\n',
  extracharge: 0,
  noteextracharge: '',
  description: 'Januar',
  ...overrides,
});

describe('the DE payment (§37.4)', () => {
  it('the marker is DE-RPR- and the lower-case id; the date DD/MM/YYYY; type transfer; empty description', () => {
    expect(markerOf(ID)).toBe(MARKER);
    expect(mine).toEqual({ date: '03/01/2027', amount: 800.1, type: 'transfer', reference: MARKER, description: '' });
  });

  it('the amount is written from its decimal text, never by float arithmetic on cents', () => {
    const amount = (text: string) => dePayment(ID, eur(text), '2027-01-03' as BusinessDate).amount;
    expect(amount('800.10')).toBe(800.1);
    expect(amount('0.01')).toBe(0.01);
    expect(amount('1234567.89')).toBe(1234567.89);
    // 0.29 is not 29 / 100 * … in float: written from its text it is exactly the double MRE stores for "0.29".
    expect(amount('0.29')).toBe(Number('0.29'));
  });
});

describe('storedPayments: as MRE stores them (review on #82)', () => {
  it('amount missing or ≤ 0 dropped; date, type, reference, description || ""; amount Number()', () => {
    expect(
      storedPayments([
        { date: undefined, amount: '12.5', type: undefined, reference: null, description: undefined },
        { date: '01/01/2027', amount: 0, type: 'cash', reference: '', description: '' },
        { date: '01/01/2027', amount: -3, type: 'cash', reference: '', description: '' },
        { date: '01/01/2027', amount: undefined, type: 'cash', reference: '', description: '' },
      ]),
    ).toEqual([{ date: '', amount: 12.5, type: '', reference: '', description: '' }]);
  });
});

describe('writeBody', () => {
  it('every payment read as MRE stores it, then DE’s; promo, extracharge, description as read; notes without the trailing \\n', () => {
    expect(writeBody(term({ payments: [{ ...theirs, type: undefined }], noteextracharge: 'Mahngebühr\n', extracharge: 5 }), mine)).toEqual({
      payments: [{ ...theirs, type: '' }, mine],
      promo: 20,
      notepromo: 'Rabatt',
      extracharge: 5,
      noteextracharge: 'Mahngebühr',
      description: 'Januar',
    });
  });
});

describe('isRoundTrippable', () => {
  it('VAT with a promo or an extra charge is not; VAT alone, or neither, is', () => {
    expect(isRoundTrippable(term({ vatRatio: 0.2, promo: 20 }))).toBe(false);
    expect(isRoundTrippable(term({ vatRatio: 0.2, promo: 0, extracharge: 5 }))).toBe(false);
    expect(isRoundTrippable(term({ vatRatio: 0.2, promo: 0, extracharge: 0 }))).toBe(true);
    expect(isRoundTrippable(term({ vatRatio: 0, promo: 20, extracharge: 5 }))).toBe(true);
  });
});

describe('markerIn', () => {
  it('ABSENT; PRESENT once with DE’s date and amount; CHANGED twice, or with another date or amount', () => {
    expect(markerIn(term(), mine)).toBe('ABSENT');
    expect(markerIn(term({ payments: [theirs, mine] }), mine)).toBe('PRESENT');
    expect(markerIn(term({ payments: [mine, theirs, mine] }), mine)).toBe('CHANGED');
    expect(markerIn(term({ payments: [{ ...mine, amount: 800 }] }), mine)).toBe('CHANGED');
    expect(markerIn(term({ payments: [{ ...mine, date: '04/01/2027' }] }), mine)).toBe('CHANGED');
  });
});

describe('verifyWritten', () => {
  const after = (overrides: Partial<WriteBackTerm> = {}) => term({ payments: [theirs, mine], ...overrides });

  it('OK: the marker once, every payment read in its order, the settlement as read', () => {
    expect(verifyWritten(term(), after(), mine)).toBe('OK');
  });

  it('a payment that never went through MRE’s save comes back normalised: no mismatch (review on #82)', () => {
    const read = term({ payments: [{ date: '02/01/2027', amount: '50', type: undefined, reference: undefined, description: undefined }] });
    expect(verifyWritten(read, after({ payments: [{ date: '02/01/2027', amount: 50, type: '', reference: '', description: '' }, mine] }), mine)).toBe('OK');
  });

  it('MARKER_ABSENT without DE’s payment; CHANGED for each other mismatch', () => {
    expect(verifyWritten(term(), term(), mine)).toBe('MARKER_ABSENT');
    expect(verifyWritten(term(), after({ payments: [mine] }), mine)).toBe('CHANGED');
    expect(verifyWritten(term(), after({ payments: [{ ...theirs, amount: 51 }, mine] }), mine)).toBe('CHANGED');
    expect(
      verifyWritten(term({ payments: [theirs, { ...theirs, reference: 'b' }] }), after({ payments: [{ ...theirs, reference: 'b' }, theirs, mine] }), mine),
    ).toBe('CHANGED');
    expect(verifyWritten(term(), after({ promo: 0 }), mine)).toBe('CHANGED');
    expect(verifyWritten(term(), after({ notepromo: '' }), mine)).toBe('CHANGED');
    expect(verifyWritten(term(), after({ extracharge: 1 }), mine)).toBe('CHANGED');
    expect(verifyWritten(term(), after({ description: '' }), mine)).toBe('CHANGED');
    expect(verifyWritten(term(), after({ payments: [theirs, mine, mine] }), mine)).toBe('CHANGED');
  });
});

describe('removal (§37.5)', () => {
  it('removalBody: every payment read but DE’s, as MRE stores them; the settlement as writeBody', () => {
    const read = term({
      payments: [theirs, mine, { ...theirs, reference: 'b', type: undefined }],
      notepromo: 'Rabatt\n',
      extracharge: 5,
      noteextracharge: 'Mahngebühr\n',
    });
    expect(removalBody(read, mine)).toEqual({
      payments: [theirs, { ...theirs, reference: 'b', type: '' }],
      promo: 20,
      notepromo: 'Rabatt',
      extracharge: 5,
      noteextracharge: 'Mahngebühr',
      description: 'Januar',
    });
  });

  it('verifyRemoved: OK without the marker and with the rest as read; MARKER_PRESENT; CHANGED for any other difference', () => {
    const read = term({ payments: [theirs, mine] });
    expect(verifyRemoved(read, term({ payments: [theirs] }), mine)).toBe('OK');
    expect(verifyRemoved(read, read, mine)).toBe('MARKER_PRESENT');
    expect(verifyRemoved(read, term({ payments: [] }), mine)).toBe('CHANGED');
    expect(verifyRemoved(read, term({ payments: [{ ...theirs, amount: 51 }] }), mine)).toBe('CHANGED');
    expect(verifyRemoved(read, term({ payments: [theirs], promo: 0 }), mine)).toBe('CHANGED');
    expect(verifyRemoved(read, term({ payments: [theirs], description: '' }), mine)).toBe('CHANGED');
    // A payment that never went through MRE's save comes back normalised: no mismatch.
    const raw = term({ payments: [{ date: '02/01/2027', amount: '50', type: undefined, reference: undefined, description: undefined }, mine] });
    expect(verifyRemoved(raw, term({ payments: [{ date: '02/01/2027', amount: 50, type: '', reference: '', description: '' }] }), mine)).toBe('OK');
  });
});

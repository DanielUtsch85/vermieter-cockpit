import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { bookingWindow, suggestPairs, type SuggestionCandidate, type SuggestionInput, type SuggestionTerm } from './suggestion.js';

/** VC-4-03's rule (api-design.md §37.3), each case with its own small graph. */
const eur = (amount: string) => Money.of(amount, 'EUR');
const X = '6512f0c2a1b2c3d4e5f60a01';
const Y = '6512f0c2a1b2c3d4e5f60a02';
const term = (mreTenantId: string, mreRentTerm: string, open = '800.00', inWindow = true): SuggestionTerm => ({
  mreTenantId,
  mreRentTerm,
  openAmount: eur(open),
  inWindow,
});
const tx = (transactionId: string, bookingDate: string, available = '800.00', counterpartyIban: string | null = null): SuggestionCandidate => ({
  transactionId,
  bookingDate: bookingDate as BusinessDate,
  available: eur(available),
  counterpartyIban,
});
const input = (overrides: Partial<SuggestionInput>): SuggestionInput => ({ terms: [], candidates: [], handled: [], open: [], history: [], ...overrides });
const pairs = (i: SuggestionInput) => suggestPairs(i).map((s) => `${s.transactionId}→${s.mreTenantId === X ? 'X' : 'Y'}/${s.mreRentTerm}:${s.confidence}`);

describe('bookingWindow', () => {
  it('from the 15th of the month before to the last day of the month', () => {
    expect(bookingWindow('2027010100')).toEqual({ from: '2026-12-15', to: '2027-01-31' });
    expect(bookingWindow('2028020100')).toEqual({ from: '2028-01-15', to: '2028-02-29' });
    expect(bookingWindow('2027120100')).toEqual({ from: '2027-11-15', to: '2027-12-31' });
  });
});

describe('suggestPairs (§37.3)', () => {
  it('one Transaction and one term with equal amounts → MEDIUM, EXACT_AMOUNT, the open amount', () => {
    const [s] = suggestPairs(input({ terms: [term(X, '2027010100')], candidates: [tx('t1', '2027-01-03')] }));
    expect(s).toEqual({
      transactionId: 't1',
      mreTenantId: X,
      mreRentTerm: '2027010100',
      matchedAmount: eur('800.00'),
      confidence: 'MEDIUM',
      suggestionReason: 'EXACT_AMOUNT',
    });
  });

  it('two Transactions for one term, or two terms for one Transaction → nothing', () => {
    expect(pairs(input({ terms: [term(X, '2027010100')], candidates: [tx('t1', '2027-01-03'), tx('t2', '2027-01-05')] }))).toEqual([]);
    expect(pairs(input({ terms: [term(X, '2027010100'), term(Y, '2027010100')], candidates: [tx('t1', '2027-01-03')] }))).toEqual([]);
  });

  it('the IBAN history decides one of two → HIGH; the other not suggested; history on both sides → nothing', () => {
    const two = { terms: [term(X, '2027010100')], candidates: [tx('t1', '2027-01-03', '800.00', 'DE01'), tx('t2', '2027-01-05', '800.00', 'DE02')] };
    expect(pairs(input({ ...two, history: [{ mreTenantId: X, counterpartyIban: 'DE01' }] }))).toEqual(['t1→X/2027010100:HIGH']);
    expect(suggestPairs(input({ ...two, history: [{ mreTenantId: X, counterpartyIban: 'DE01' }] }))[0]?.suggestionReason).toBe('EXACT_AMOUNT_IBAN_HISTORY');
    expect(
      pairs(
        input({
          ...two,
          history: [
            { mreTenantId: X, counterpartyIban: 'DE01' },
            { mreTenantId: X, counterpartyIban: 'DE02' },
          ],
        }),
      ),
    ).toEqual([]);
    // History of another Tenant does not decide.
    expect(pairs(input({ ...two, history: [{ mreTenantId: Y, counterpartyIban: 'DE01' }] }))).toEqual([]);
  });

  it('a unique fit with history is HIGH too', () => {
    expect(
      pairs(
        input({
          terms: [term(X, '2027010100')],
          candidates: [tx('t1', '2027-01-03', '800.00', 'DE01')],
          history: [{ mreTenantId: X, counterpartyIban: 'DE01' }],
        }),
      ),
    ).toEqual(['t1→X/2027010100:HIGH']);
  });

  it('the booking window: a day before the 15th of the month before, or after the month → no fit; its ends → fit', () => {
    const one = (date: string) => pairs(input({ terms: [term(X, '2027020100')], candidates: [tx('t1', date)] }));
    expect(one('2027-01-14')).toEqual([]);
    expect(one('2027-01-15')).toEqual(['t1→X/2027020100:MEDIUM']);
    expect(one('2027-02-28')).toEqual(['t1→X/2027020100:MEDIUM']);
    expect(one('2027-03-01')).toEqual([]);
  });

  it('an amount a cent off → no fit; an open amount ≤ 0 → skipped', () => {
    expect(pairs(input({ terms: [term(X, '2027010100')], candidates: [tx('t1', '2027-01-03', '799.99')] }))).toEqual([]);
    expect(pairs(input({ terms: [term(X, '2027010100', '0.00')], candidates: [tx('t1', '2027-01-03', '0.00')] }))).toEqual([]);
  });

  it('a handled pair (REJECTED, RELEASED, CONFIRMED) is no fit, and does not block the others', () => {
    const terms = [term(X, '2027010100')];
    const handled = [{ transactionId: 't1', mreTenantId: X, mreRentTerm: '2027010100' }];
    expect(pairs(input({ terms, candidates: [tx('t1', '2027-01-03')], handled }))).toEqual([]);
    expect(pairs(input({ terms, candidates: [tx('t1', '2027-01-03'), tx('t2', '2027-01-04')], handled }))).toEqual(['t2→X/2027010100:MEDIUM']);
  });

  it('an open suggestion T1–A blocks a new T2–A, and T1 with an open suggestion for A is not suggested for B (review on #80)', () => {
    const open = [{ transactionId: 't1', mreTenantId: X, mreRentTerm: '2027010100' }];
    expect(pairs(input({ terms: [term(X, '2027010100')], candidates: [tx('t1', '2027-01-03'), tx('t2', '2027-01-05')], open }))).toEqual([]);
    expect(pairs(input({ terms: [term(X, '2027010100'), term(X, '2027020100')], candidates: [tx('t1', '2027-01-20')], open }))).toEqual([]);
    // Never written again: alone in the graph it is not suggested a second time.
    expect(pairs(input({ terms: [term(X, '2027010100')], candidates: [tx('t1', '2027-01-03')], open }))).toEqual([]);
    // It blocks in the history step too.
    const history = [{ mreTenantId: X, counterpartyIban: 'DE02' }];
    expect(
      pairs(input({ terms: [term(X, '2027010100')], candidates: [tx('t1', '2027-01-03'), tx('t2', '2027-01-05', '800.00', 'DE02')], open, history })),
    ).toEqual([]);
  });

  it('a Transaction booked on the 20th of `to` that also fits the month after → nothing; the neighbour itself never suggested', () => {
    const terms = [term(X, '2027010100'), term(X, '2027020100', '800.00', false)];
    expect(pairs(input({ terms, candidates: [tx('t1', '2027-01-20')] }))).toEqual([]);
    expect(pairs(input({ terms: [term(X, '2027020100', '800.00', false)], candidates: [tx('t1', '2027-02-03')] }))).toEqual([]);
  });

  it('two separate unique pairs are both suggested, in Transaction id order; the input order does not matter', () => {
    const terms = [term(X, '2027010100', '800.00'), term(Y, '2027010100', '650.00')];
    const candidates = [tx('t2', '2027-01-04', '650.00'), tx('t1', '2027-01-03', '800.00')];
    const expected = ['t1→X/2027010100:MEDIUM', 't2→Y/2027010100:MEDIUM'];
    expect(pairs(input({ terms, candidates }))).toEqual(expected);
    expect(pairs(input({ terms: [...terms].reverse(), candidates: [...candidates].reverse() }))).toEqual(expected);
    // An ambiguity is never broken by input order.
    const amb = { terms: [term(X, '2027010100')], candidates: [tx('t1', '2027-01-03'), tx('t2', '2027-01-04')] };
    expect(pairs(input(amb))).toEqual(pairs(input({ ...amb, candidates: [...amb.candidates].reverse() })));
  });
});

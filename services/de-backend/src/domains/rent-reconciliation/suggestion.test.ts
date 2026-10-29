import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { bookingWindow, monthsInText, suggestPairs, type SuggestionCandidate, type SuggestionInput, type SuggestionTerm } from './suggestion.js';

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
const tx = (
  transactionId: string,
  bookingDate: string,
  available = '800.00',
  counterpartyIban: string | null = null,
  description: string | null = null,
): SuggestionCandidate => ({
  transactionId,
  bookingDate: bookingDate as BusinessDate,
  available: eur(available),
  counterpartyIban,
  description,
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

/**
 * #125 (real-data run F10): a Tenant who pays before the month. Six months, each payment on the 28th of the month
 * before: every payment fits two terms, so no pair is unique and the IBAN history (one Tenant) cannot decide.
 */
describe('early payers (#125)', () => {
  const IBAN = 'DE02120300000000202051';
  const MONTHS = ['202605', '202606', '202607', '202608', '202609', '202610'];
  const termOf = (yyyymm: string, open = '800.00', inWindow = true) => term(X, `${yyyymm}0100`, open, inWindow);
  const early = (yyyymm: string, text: string | null = null, iban: string | null = IBAN) => {
    const [y, m] = [Number(yyyymm.slice(0, 4)), Number(yyyymm.slice(4, 6))];
    const before = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    return tx(`p${yyyymm}`, `${before}-28`, '800.00', iban, text);
  };
  const reasons = (i: SuggestionInput) => suggestPairs(i).map((s) => `${s.transactionId}→${s.mreRentTerm.slice(0, 6)}:${s.suggestionReason}`);
  const chain = (texts = false, iban: string | null = IBAN) =>
    MONTHS.map((m) => early(m, texts ? `Miete ${m.slice(4)}.${m.slice(0, 4)} Mietzins + Nebenkosten` : null, iban));
  const everyMonth = (reason: string) => MONTHS.map((m) => `p${m}→${m}:${reason}`).sort();

  it('without text or anchor: nothing, as before (a chain read from its middle could be off by one month)', () => {
    expect(reasons(input({ terms: MONTHS.map((m) => termOf(m)), candidates: chain() }))).toEqual([]);
  });

  it('the month in the purpose text decides every pair → EXACT_AMOUNT_PURPOSE_MONTH (May fits only May: plain EXACT_AMOUNT)', () => {
    const expected = everyMonth('EXACT_AMOUNT_PURPOSE_MONTH').map((r) => (r.startsWith('p202605') ? 'p202605→202605:EXACT_AMOUNT' : r));
    expect(reasons(input({ terms: MONTHS.map((m) => termOf(m)), candidates: chain(true) }))).toEqual(expected);
    // With April read too, May 28 … fits two terms; the text decides it as well.
    expect(reasons(input({ terms: [termOf('202604', '800.00', false), ...MONTHS.map((m) => termOf(m))], candidates: chain(true) }))).toEqual(
      everyMonth('EXACT_AMOUNT_PURPOSE_MONTH'),
    );
  });

  it('anchored by a settled month before → the whole chain in order (EXACT_AMOUNT_IN_ORDER); the neighbour after is never suggested', () => {
    const terms = [termOf('202604', '0.00', false), ...MONTHS.map((m) => termOf(m)), termOf('202611', '800.00', false)];
    const candidates = [...chain(), early('202611')];
    expect(reasons(input({ terms, candidates }))).toEqual(everyMonth('EXACT_AMOUNT_IN_ORDER'));
  });

  it('the off-by-one trap: an open month before, or no term before (a lease start whose first payment may be missing), is no anchor', () => {
    // April open: April – Apr 28 – May – … could be either alignment; assigning April to Apr 28 shifts every month.
    expect(reasons(input({ terms: [termOf('202604', '800.00', false), ...MONTHS.map((m) => termOf(m))], candidates: chain() }))).toEqual([]);
    // April open, and May's payment (Apr 28) not imported: May 28 fits May and June; taking it for May shifts every month.
    expect(reasons(input({ terms: [termOf('202604', '800.00', false), ...MONTHS.map((m) => termOf(m))], candidates: chain().slice(1) }))).toEqual([]);
    // May first (no April term), and May 28's payment fits only June: May keeps two candidates' worth of doubt.
    expect(reasons(input({ terms: MONTHS.map((m) => termOf(m)), candidates: chain().slice(1) }))).toEqual([]);
  });

  it('the walk stops at a payment without IBAN, of another IBAN, or one that also fits another Tenant', () => {
    const terms = [termOf('202604', '0.00', false), ...MONTHS.map((m) => termOf(m))];
    const withGap = (i: number, c: SuggestionCandidate) => chain().map((x, j) => (j === i ? c : x));
    expect(reasons(input({ terms, candidates: withGap(2, early('202607', null, null)) }))).toEqual(everyMonth('EXACT_AMOUNT_IN_ORDER').slice(0, 2));
    expect(reasons(input({ terms, candidates: withGap(2, early('202607', null, 'DE89370400440532013000')) }))).toEqual(
      everyMonth('EXACT_AMOUNT_IN_ORDER').slice(0, 2),
    );
    // Y's July term of the same amount: July's payments (Jun 28, Jul 28) fit it too, so the walk stops at July.
    const other = term(Y, '2026070100');
    expect(reasons(input({ terms: [...terms, other], candidates: chain() }))).toEqual(everyMonth('EXACT_AMOUNT_IN_ORDER').slice(0, 2));
  });

  it('an open suggestion is an anchor and blocks its payment; a second run writes nothing new (idempotent)', () => {
    const terms = [termOf('202604', '0.00', false), ...MONTHS.map((m) => termOf(m))];
    const first = suggestPairs(input({ terms, candidates: chain() }));
    const open = first.map(({ transactionId, mreTenantId, mreRentTerm }) => ({ transactionId, mreTenantId, mreRentTerm }));
    expect(suggestPairs(input({ terms, candidates: chain(), open }))).toEqual([]);
    // Only May suggested so far: the rest follows from it.
    const may = open.filter((p) => p.mreRentTerm === '2026050100');
    expect(reasons(input({ terms, candidates: chain(), open: may }))).toEqual(everyMonth('EXACT_AMOUNT_IN_ORDER').slice(1));
  });

  it('on-time payments are unaffected: still EXACT_AMOUNT, unique by their windows', () => {
    const onTime = MONTHS.map((m) => tx(`p${m}`, `${m.slice(0, 4)}-${m.slice(4)}-01`, '800.00', IBAN));
    expect(reasons(input({ terms: MONTHS.map((m) => termOf(m)), candidates: onTime }))).toEqual(everyMonth('EXACT_AMOUNT'));
  });

  it('the input order does not matter', () => {
    const terms = [termOf('202604', '0.00', false), ...MONTHS.map((m) => termOf(m))];
    expect(reasons(input({ terms: [...terms].reverse(), candidates: chain().reverse() }))).toEqual(reasons(input({ terms, candidates: chain() })));
  });
});

describe('monthsInText (#125)', () => {
  it('MM.YYYY, MM/YYYY, YYYY-MM, a full date, a German month name with a year', () => {
    expect([...monthsInText('Miete 10.2026 Mietzins 1247,00 EUR + Nebenkosten 174,00 EUR')]).toEqual(['202610']);
    expect([...monthsInText('Miete 3/2027')]).toEqual(['202703']);
    expect([...monthsInText('rent 2026-11')]).toEqual(['202611']);
    expect([...monthsInText('Zahlung vom 01.10.2026')]).toEqual(['202610']);
    expect([...monthsInText('Miete Oktober 2026')]).toEqual(['202610']);
    expect([...monthsInText('Miete Okt. 2026 und März 2027')].sort()).toEqual(['202610', '202703']);
  });

  it('no month: none, a name without a year, a first name, amounts, IBANs, 13.2026', () => {
    for (const text of [
      null,
      '',
      'Miete Oktober',
      'Jan Müller',
      'August Schmidt 2026x',
      '1.421,00 EUR',
      'IBAN: DE02120300000000202051 BIC: BYLADEM1001',
      'Ref 13.2026',
    ]) {
      expect([...monthsInText(text)], String(text)).toEqual([]);
    }
  });
});

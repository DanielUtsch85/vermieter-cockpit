import { describe, expect, it } from 'vitest';
import { normalizeIbanRaw, normalizeText, parseSignedAmount, parseSourceDate } from './normalize.js';

describe('parseSignedAmount', () => {
  it.each([
    ['1.250,00', ',', { magnitude: '1250.00', negative: false }],
    ['-1.250,00', ',', { magnitude: '1250.00', negative: true }],
    ['+12,5', ',', { magnitude: '12.5', negative: false }],
    ['1250', ',', { magnitude: '1250', negative: false }],
    ['1.234.567,89', ',', { magnitude: '1234567.89', negative: false }],
    ['0,10', ',', { magnitude: '0.10', negative: false }],
    ['007,50', ',', { magnitude: '7.50', negative: false }],
    [' -1 250,00 ', ',', { magnitude: '1250.00', negative: true }],
    ['1,250.00', '.', { magnitude: '1250.00', negative: false }],
    ['-0.99', '.', { magnitude: '0.99', negative: true }],
  ] as const)('%j with decimal %j → %o', (raw, separator, expected) => {
    expect(parseSignedAmount(raw, separator)).toEqual(expected);
  });

  it.each([
    ['1,250.00', ','],
    ['1.25,00', ','],
    ['12.50', ','],
    ['1,25', '.'],
    ['1250-', ','],
    ['--5', ','],
    ['1e3', ','],
    ['EUR 5,00', ','],
    ['', ','],
    [',50', ','],
  ] as const)('rejects %j with decimal %j (never guessed)', (raw, separator) => {
    expect(parseSignedAmount(raw, separator)).toBeUndefined();
  });
});

describe('parseSourceDate', () => {
  it('reads DD.MM.YYYY and YYYY-MM-DD into business dates', () => {
    expect(parseSourceDate('01.09.2026', 'DD.MM.YYYY')).toEqual({ date: '2026-09-01' });
    expect(parseSourceDate(' 2026-09-01 ', 'YYYY-MM-DD')).toEqual({ date: '2026-09-01' });
  });

  it.each([
    ['1.9.2026', 'DD.MM.YYYY', 'INVALID_FORMAT'],
    ['31.02.2026', 'DD.MM.YYYY', 'INVALID_FORMAT'],
    ['01.09.26', 'DD.MM.YYYY', 'INVALID_FORMAT'],
    ['2026-09-01', 'DD.MM.YYYY', 'INVALID_FORMAT'],
    ['01.03.0202', 'DD.MM.YYYY', 'OUT_OF_RANGE'],
  ] as const)('%j as %s → %s', (raw, format, error) => {
    expect(parseSourceDate(raw, format)).toEqual({ error });
  });
});

describe('text and IBAN normalization (§70.3)', () => {
  it('collapses whitespace and turns empty into null', () => {
    expect(normalizeText('  Miete \n  September  ')).toBe('Miete September');
    expect(normalizeText('   ')).toBeNull();
    expect(normalizeText(undefined)).toBeNull();
  });

  it('strips IBAN formatting and upper-cases, without validating', () => {
    expect(normalizeIbanRaw('de89 3704 0044 0532 0130 00')).toBe('DE89370400440532013000');
    expect(normalizeIbanRaw('not-an-iban')).toBe('NOTANIBAN');
    expect(normalizeIbanRaw('')).toBeNull();
  });
});

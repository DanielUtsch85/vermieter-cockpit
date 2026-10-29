import { describe, expect, it } from 'vitest';
import { formatMea, meaFromColumns, parseMea } from './mea.js';

/** The Miteigentumsanteil as the Verwalter prints it (api-design.md §49.2): three decimals, kept as printed. */
describe('parseMea', () => {
  it.each([
    ['125.5/10000', '125.5/10000'],
    ['125.500/10000.000', '125.5/10000'],
    ['0125.050/10000', '125.05/10000'],
    ['1/3', '1/3'],
    ['10000/10000', '10000/10000'],
    ['0.001/1', '0.001/1'],
    ['999999999.999/999999999.999', '999999999.999/999999999.999'],
  ])('%s → %s (not reduced, trailing zeros dropped)', (input, expected) => {
    const parsed = parseMea(input);
    expect('mea' in parsed && formatMea(parsed.mea)).toBe(expected);
  });

  it.each([
    ['125,5/10000', 'INVALID_FORMAT'],
    ['125.5/10.000,000', 'INVALID_FORMAT'],
    ['125.5555/10000', 'INVALID_FORMAT'],
    ['1234567890/9999999999', 'INVALID_FORMAT'],
    ['-1/10000', 'INVALID_FORMAT'],
    ['125.5', 'INVALID_FORMAT'],
    [' 1/2', 'INVALID_FORMAT'],
    ['0/10000', 'NOT_POSITIVE'],
    ['0.000/1', 'NOT_POSITIVE'],
    ['10000.001/10000', 'OUT_OF_RANGE'],
    ['1/0', 'OUT_OF_RANGE'],
  ])('%s → %s', (input, error) => {
    expect(parseMea(input)).toEqual({ error });
  });

  it('reads the numeric(12,3) columns back to the shortest form', () => {
    expect(formatMea(meaFromColumns('125.500', '10000.000'))).toBe('125.5/10000');
    expect(formatMea(meaFromColumns('0.010', '1.000'))).toBe('0.01/1');
  });
});

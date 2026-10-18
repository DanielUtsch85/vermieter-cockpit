import { describe, expect, it } from 'vitest';
import { ExactDecimal, ExactDecimalError, RoundingMode, type ExactDecimalErrorCode } from './exact-decimal.js';

const d = (value: string) => ExactDecimal.of(value);

function expectError(fn: () => unknown, code: ExactDecimalErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ExactDecimalError);
    expect((error as ExactDecimalError).code).toBe(code);
    return;
  }
  throw new Error(`expected ExactDecimalError ${code}`);
}

describe('ExactDecimal parsing', () => {
  it.each(['0', '-0', '1', '0.0425', '-12.5', '123456789012345678901234567890.123456789'])('accepts %s', (v) => {
    expect(d(v).toString()).toBe(v === '-0' ? '0' : v);
  });

  it.each(['', '1e-7', '1E3', '+1', '.5', '1.', '01', ' 1', 'NaN', 'Infinity'])('rejects %j', (v) => {
    expectError(() => d(v), 'INVALID_DECIMAL');
  });

  it('rejects non-string input such as a JS number', () => {
    expectError(() => ExactDecimal.of(0.1 as unknown as string), 'INVALID_DECIMAL');
  });
});

describe('ExactDecimal arithmetic is exact or throws', () => {
  it('adds, subtracts and multiplies exactly', () => {
    expect(d('0.1').plus(d('0.2')).toString()).toBe('0.3');
    expect(d('1').minus(d('0.0000001')).toString()).toBe('0.9999999');
    expect(d('3333.33').times(d('0.0425')).toString()).toBe('141.666525');
  });

  it('never produces exponent notation', () => {
    expect(d('0.000001').times(d('0.000001')).toString()).toBe('0.000000000001');
    expect(d('1000000000').times(d('1000000000000')).toString()).toBe('1000000000000000000000');
  });

  it('throws instead of rounding when an exact product would exceed the precision', () => {
    const long = d(`0.${'3'.repeat(120)}`);
    expectError(() => long.times(long), 'PRECISION_EXCEEDED');
  });

  it('throws instead of rounding when an exact sum would exceed the precision', () => {
    expectError(() => d(`1${'0'.repeat(150)}`).plus(d(`0.${'1'.repeat(60)}`)), 'PRECISION_EXCEEDED');
  });
});

describe('ExactDecimal.dividedBy rounds the exact quotient once', () => {
  it.each([
    // dividend, divisor, dp, HALF_UP, HALF_EVEN, UP, DOWN, CEIL, FLOOR
    ['100', '3', 2, '33.33', '33.33', '33.34', '33.33', '33.34', '33.33'],
    ['-100', '3', 2, '-33.33', '-33.33', '-33.34', '-33.33', '-33.33', '-33.34'],
    ['1', '8', 2, '0.13', '0.12', '0.13', '0.12', '0.13', '0.12'],
    ['3', '8', 2, '0.38', '0.38', '0.38', '0.37', '0.38', '0.37'],
    ['-1', '8', 2, '-0.13', '-0.12', '-0.13', '-0.12', '-0.12', '-0.13'],
    ['1', '-8', 2, '-0.13', '-0.12', '-0.13', '-0.12', '-0.12', '-0.13'],
    ['-1', '-8', 2, '0.13', '0.12', '0.13', '0.12', '0.13', '0.12'],
    ['10', '4', 0, '3', '2', '3', '2', '3', '2'],
    ['6', '3', 2, '2', '2', '2', '2', '2', '2'],
    ['2', '3', 0, '1', '1', '1', '0', '1', '0'],
  ] as const)('%s / %s at %i dp', (a, b, dp, halfUp, halfEven, up, down, ceil, floor) => {
    const q = (mode: RoundingMode) => d(a).dividedBy(d(b), dp, mode).toString();
    expect(q('HALF_UP')).toBe(halfUp);
    expect(q('HALF_EVEN')).toBe(halfEven);
    expect(q('UP')).toBe(up);
    expect(q('DOWN')).toBe(down);
    expect(q('CEIL')).toBe(ceil);
    expect(q('FLOOR')).toBe(floor);
  });

  it('is exact for quotients just below a half (no double rounding)', () => {
    // 0.00499999999999999999999999 / 1 at 2 dp: exactly below half, must not round up
    expect(d('0.00499999999999999999999999').dividedBy(d('1'), 2, 'HALF_UP').toString()).toBe('0');
  });

  it('rejects division by zero and invalid decimal places', () => {
    expectError(() => d('1').dividedBy(d('0'), 2, 'HALF_UP'), 'DIVISION_BY_ZERO');
    expectError(() => d('1').dividedBy(d('3'), -1, 'HALF_UP'), 'INVALID_DECIMAL');
    expectError(() => d('1').dividedBy(d('3'), 1.5, 'HALF_UP'), 'INVALID_DECIMAL');
  });

  it('throws when the exact quotient would exceed the precision', () => {
    expectError(() => d(`1${'0'.repeat(150)}`).dividedBy(d(`0.${'0'.repeat(60)}1`), 0, 'DOWN'), 'PRECISION_EXCEEDED');
  });
});

describe('ExactDecimal formatting and comparison', () => {
  it('toFixed pads but never rounds', () => {
    expect(d('1.5').toFixed(2)).toBe('1.50');
    expectError(() => d('1.005').toFixed(2), 'INVALID_DECIMAL');
  });

  it('compares, detects sign and zero', () => {
    expect(d('1').compare(d('2'))).toBe(-1);
    expect(d('2.0').compare(d('2'))).toBe(0);
    expect(d('2.0').equals(d('2'))).toBe(true);
    expect(d('-0').isNegative()).toBe(false);
    expect(d('-0.01').isNegative()).toBe(true);
    expect(d('0.00').isZero()).toBe(true);
    expect(d('5').negated().toString()).toBe('-5');
    expect(d('0.5').integerDigits()).toBe(0);
    expect(d('-123.4').integerDigits()).toBe(3);
  });

  it('serializes to JSON as a plain decimal string', () => {
    expect(JSON.stringify({ rate: d('0.0425') })).toBe('{"rate":"0.0425"}');
  });
});

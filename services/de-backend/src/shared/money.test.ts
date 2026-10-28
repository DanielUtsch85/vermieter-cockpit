import { describe, expect, it } from 'vitest';
import { ExactDecimal, RoundingMode } from './exact-decimal.js';
import { Money, MoneyError, type MoneyErrorCode } from './money.js';

const d = (value: string) => ExactDecimal.of(value);

function expectMoneyError(fn: () => unknown, code: MoneyErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyError);
    expect((error as MoneyError).code).toBe(code);
    return;
  }
  throw new Error(`expected MoneyError ${code}`);
}

describe('Money.of: parsing and validation', () => {
  it.each([
    ['1250.00', '1250.00'],
    ['1250.5', '1250.50'],
    ['1250', '1250.00'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['-12.34', '-12.34'],
    ['-0', '0.00'],
    ['-0.00', '0.00'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('accepts %s as %s EUR', (input, expected) => {
    expect(Money.of(input, 'EUR').amount).toBe(expected);
  });

  it.each(['', ' 1.00', '1.00 ', '+1.00', '1e3', '1E-2', '.5', '1.', '01.00', '1,00', '1.000,00', 'NaN', 'Infinity', '0x10', '--1'])(
    'rejects malformed amount %j',
    (input) => {
      expectMoneyError(() => Money.of(input, 'EUR'), 'INVALID_AMOUNT');
    },
  );

  it('rejects non-string amounts (e.g. a JS number from untyped input)', () => {
    expectMoneyError(() => Money.of(12.5 as unknown as string, 'EUR'), 'INVALID_AMOUNT');
  });

  it.each(['1.001', '0.005', '-1.999'])('rejects %s: more decimals than EUR allows, never rounds', (input) => {
    expectMoneyError(() => Money.of(input, 'EUR'), 'SCALE_EXCEEDED');
  });

  it.each(['USD', 'eur', '', 'EURO'])('rejects unsupported currency %j', (currency) => {
    expectMoneyError(() => Money.of('1.00', currency), 'UNSUPPORTED_CURRENCY');
  });

  it('rejects amounts beyond 18 integer digits', () => {
    expectMoneyError(() => Money.of('1000000000000000000.00', 'EUR'), 'AMOUNT_OUT_OF_RANGE');
  });
});

describe('Money arithmetic is exact', () => {
  it('0.1 + 0.2 == 0.3 (no binary floating point)', () => {
    const sum = Money.of('0.1', 'EUR').add(Money.of('0.2', 'EUR'));
    expect(sum.equals(Money.of('0.3', 'EUR'))).toBe(true);
    expect(sum.amount).toBe('0.30');
  });

  it('sums many cents without drift', () => {
    const cents = Array.from({ length: 10_000 }, () => Money.of('0.01', 'EUR'));
    expect(Money.sum(cents, 'EUR').amount).toBe('100.00');
  });

  it('handles the largest supported amounts exactly', () => {
    const big = Money.of('999999999999999999.99', 'EUR');
    expect(big.subtract(Money.of('0.01', 'EUR')).amount).toBe('999999999999999999.98');
    expectMoneyError(() => big.add(Money.of('0.01', 'EUR')), 'AMOUNT_OUT_OF_RANGE');
  });

  it('subtracts into negative values and negates', () => {
    const diff = Money.of('10.00', 'EUR').subtract(Money.of('12.50', 'EUR'));
    expect(diff.amount).toBe('-2.50');
    expect(diff.isNegative()).toBe(true);
    expect(diff.negate().amount).toBe('2.50');
  });

  it('sum of an empty list is zero in the given currency', () => {
    const zero = Money.sum([], 'EUR');
    expect(zero.isZero()).toBe(true);
    expect(zero.currency).toBe('EUR');
  });
});

describe('Money comparison', () => {
  it('equals compares value and currency, ignoring input scale', () => {
    expect(Money.of('5', 'EUR').equals(Money.of('5.00', 'EUR'))).toBe(true);
    expect(Money.of('5.00', 'EUR').equals(Money.of('5.01', 'EUR'))).toBe(false);
  });

  it('compare orders amounts', () => {
    expect(Money.of('1.00', 'EUR').compare(Money.of('2.00', 'EUR'))).toBe(-1);
    expect(Money.of('2.00', 'EUR').compare(Money.of('2', 'EUR'))).toBe(0);
    expect(Money.of('3.00', 'EUR').compare(Money.of('2.00', 'EUR'))).toBe(1);
  });

  it('sign predicates', () => {
    expect(Money.zero('EUR').isZero()).toBe(true);
    expect(Money.zero('EUR').isNegative()).toBe(false);
    expect(Money.zero('EUR').isPositive()).toBe(false);
    expect(Money.of('0.01', 'EUR').isPositive()).toBe(true);
    expect(Money.of('-0.01', 'EUR').isNegative()).toBe(true);
  });
});

describe('Rounding policy: explicit, at the business boundary', () => {
  it.each([
    // value, HALF_UP, HALF_EVEN, UP, DOWN, CEIL, FLOOR
    ['1.005', '1.01', '1.00', '1.01', '1.00', '1.01', '1.00'],
    ['1.015', '1.02', '1.02', '1.02', '1.01', '1.02', '1.01'],
    ['1.0049', '1.00', '1.00', '1.01', '1.00', '1.01', '1.00'],
    ['-1.005', '-1.01', '-1.00', '-1.01', '-1.00', '-1.00', '-1.01'],
    ['2.5', '2.50', '2.50', '2.50', '2.50', '2.50', '2.50'],
  ])('rounds %s per mode', (value, halfUp, halfEven, up, down, ceil, floor) => {
    const r = (mode: RoundingMode) => Money.rounded(d(value), 'EUR', mode).amount;
    expect(r('HALF_UP')).toBe(halfUp);
    expect(r('HALF_EVEN')).toBe(halfEven);
    expect(r('UP')).toBe(up);
    expect(r('DOWN')).toBe(down);
    expect(r('CEIL')).toBe(ceil);
    expect(r('FLOOR')).toBe(floor);
  });

  it('rounds the exact product, not a floating-point approximation', () => {
    // 1.005 is 1.00499999999999989... as a double; exact decimal must round half up to 1.01.
    expect(Money.of('1.00', 'EUR').multiply(d('1.005'), RoundingMode.HALF_UP).amount).toBe('1.01');
    // interest-style product: 3333.33 * 0.0425 = 141.666525 -> 141.67
    expect(Money.of('3333.33', 'EUR').multiply(d('0.0425'), RoundingMode.HALF_UP).amount).toBe('141.67');
    // one third ownership share of 100.00
    expect(Money.of('100.00', 'EUR').multiply(d('0.3333333333'), RoundingMode.HALF_EVEN).amount).toBe('33.33');
  });

  it('no double rounding with long factors', () => {
    // exact product 0.004999999...9995 (59 nines) must round to 0.00, not 0.01
    const factor = `0.${'4'.repeat(1)}${'9'.repeat(58)}5`;
    expect(Money.of('0.01', 'EUR').multiply(d(factor), RoundingMode.HALF_UP).amount).toBe('0.00');
  });

  it('accepts only ExactDecimal as calculation input, never a string', () => {
    expectMoneyError(() => Money.rounded('1.005' as unknown as ExactDecimal, 'EUR', RoundingMode.HALF_UP), 'INVALID_AMOUNT');
  });

  // Regression (PR #3 review, a): a result computed with the global decimal.js
  // (precision 20) would be rounded twice; ExactDecimal keeps it exact.
  it('regression: no double rounding of long calculation results', () => {
    const value = d('0.004999999999999999999999');
    expect(Money.rounded(value, 'EUR', RoundingMode.HALF_UP).amount).toBe('0.00');
    expect(Money.rounded(value.times(d('1')), 'EUR', RoundingMode.HALF_UP).amount).toBe('0.00');
  });

  // Regression (PR #3 review, b): tiny intermediate results must not turn into
  // exponent notation ("1e-7") and break the rounding step.
  it('regression: tiny products stay in plain notation and round normally', () => {
    const tiny = d('0.01').times(d('0.00001'));
    expect(tiny.toString()).toBe('0.0000001');
    expect(Money.rounded(tiny, 'EUR', RoundingMode.HALF_UP).amount).toBe('0.00');
    expect(Money.rounded(tiny, 'EUR', RoundingMode.UP).amount).toBe('0.01');
  });

  it('computes a ratio from Money and rounds the share explicitly', () => {
    // one third of 100.00 via exact division, then rounded to cents
    const third = Money.of('100.00', 'EUR').toExactDecimal().dividedBy(d('3'), 10, RoundingMode.HALF_EVEN);
    expect(Money.rounded(third, 'EUR', RoundingMode.HALF_EVEN).amount).toBe('33.33');
  });

  it('rounding does not touch the global decimal.js configuration', async () => {
    const { Decimal } = await import('decimal.js');
    const before = { precision: Decimal.precision, rounding: Decimal.rounding };
    Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN });
    try {
      expect(Money.of('123.45', 'EUR').add(Money.of('0.01', 'EUR')).amount).toBe('123.46');
      expect(Money.rounded(d('1.005'), 'EUR', RoundingMode.HALF_UP).amount).toBe('1.01');
      expect(d('0.01').times(d('0.00001')).toString()).toBe('0.0000001');
    } finally {
      Decimal.set(before);
    }
  });
});

describe('Currency safety', () => {
  it('rejects mixing currencies instead of converting silently', () => {
    // Only EUR is supported in Phase 1; simulate a second currency via an unchecked cast.
    const eur = Money.of('1.00', 'EUR');
    const other = Object.assign(Object.create(Object.getPrototypeOf(eur)), eur, { currency: 'USD' }) as Money;
    expectMoneyError(() => eur.add(other), 'CURRENCY_MISMATCH');
    expectMoneyError(() => eur.subtract(other), 'CURRENCY_MISMATCH');
    expectMoneyError(() => eur.compare(other), 'CURRENCY_MISMATCH');
    expect(eur.equals(other)).toBe(false);
  });
});

describe('Serialization (api-design.md §86)', () => {
  it('serializes as decimal string plus currency', () => {
    expect(JSON.stringify({ price: Money.of('1250', 'EUR') })).toBe('{"price":{"amount":"1250.00","currency":"EUR"}}');
  });

  it('round-trips through JSON', () => {
    const m = Money.of('-0.07', 'EUR');
    expect(Money.fromJSON(JSON.parse(JSON.stringify(m))).equals(m)).toBe(true);
  });

  it('rejects JSON with a numeric amount', () => {
    expectMoneyError(() => Money.fromJSON(JSON.parse('{"amount":1250.5,"currency":"EUR"}')), 'INVALID_AMOUNT');
  });
});

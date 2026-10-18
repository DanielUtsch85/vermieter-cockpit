import { Decimal } from 'decimal.js';

/**
 * Exact decimal number for calculations that feed into Money (shares, rates,
 * interest, depreciation bases). It is the only way domain code computes with
 * decimals: `decimal.js` itself may be imported only inside `shared/`
 * (architecture test), so the global decimal.js configuration never takes part
 * in a calculation.
 *
 * No operation rounds implicitly:
 * - `plus`, `minus`, `times` are exact; if an exact result would exceed the
 *   working precision they throw instead of rounding.
 * - `dividedBy` requires the caller to name the decimal places and the rounding
 *   mode, and rounds the exact quotient (computed via integer division and
 *   remainder), so there is no double rounding.
 * - `toString()` is always plain notation, never an exponent.
 */

/** Working precision in significant digits; every exact result must fit. */
const PRECISION = 200;

const Dec = Decimal.clone({
  precision: PRECISION,
  rounding: Decimal.ROUND_DOWN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});
type Dec = InstanceType<typeof Dec>;

/** Explicit rounding modes. There is no default anywhere. */
export const RoundingMode = {
  HALF_UP: 'HALF_UP',
  HALF_EVEN: 'HALF_EVEN',
  UP: 'UP',
  DOWN: 'DOWN',
  CEIL: 'CEIL',
  FLOOR: 'FLOOR',
} as const;
export type RoundingMode = (typeof RoundingMode)[keyof typeof RoundingMode];

const DECIMAL_ROUNDING: Record<RoundingMode, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  UP: Decimal.ROUND_UP,
  DOWN: Decimal.ROUND_DOWN,
  CEIL: Decimal.ROUND_CEIL,
  FLOOR: Decimal.ROUND_FLOOR,
};

export type ExactDecimalErrorCode = 'INVALID_DECIMAL' | 'PRECISION_EXCEEDED' | 'DIVISION_BY_ZERO';

export class ExactDecimalError extends Error {
  override readonly name = 'ExactDecimalError';

  constructor(
    readonly code: ExactDecimalErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Canonical decimal string: optional minus, no leading zeros, no exponent, no '+'. */
export const DECIMAL_STRING = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export class ExactDecimal {
  private constructor(private readonly value: Dec) {}

  /** Parses a canonical decimal string such as "0.0425" or "-12.5". */
  static of(value: string): ExactDecimal {
    if (typeof value !== 'string' || !DECIMAL_STRING.test(value)) {
      throw new ExactDecimalError('INVALID_DECIMAL', `Not a canonical decimal string: ${String(value)}`);
    }
    return ExactDecimal.create(new Dec(value));
  }

  private static create(value: Dec): ExactDecimal {
    if (value.isZero()) return new ExactDecimal(new Dec(0)); // normalize -0
    if (value.precision(true) > PRECISION) {
      throw new ExactDecimalError('PRECISION_EXCEEDED', `More than ${PRECISION} significant digits`);
    }
    return new ExactDecimal(value);
  }

  plus(other: ExactDecimal): ExactDecimal {
    assertSumFits(this.value, other.value);
    return ExactDecimal.create(this.value.plus(other.value));
  }

  minus(other: ExactDecimal): ExactDecimal {
    assertSumFits(this.value, other.value);
    return ExactDecimal.create(this.value.minus(other.value));
  }

  times(other: ExactDecimal): ExactDecimal {
    if (this.value.precision(true) + other.value.precision(true) > PRECISION) {
      throw new ExactDecimalError('PRECISION_EXCEEDED', 'Exact product would exceed the working precision');
    }
    return ExactDecimal.create(this.value.times(other.value));
  }

  /** Quotient rounded to `decimalPlaces` with the given mode; the exact quotient is rounded once. */
  dividedBy(divisor: ExactDecimal, decimalPlaces: number, mode: RoundingMode): ExactDecimal {
    if (divisor.value.isZero()) {
      throw new ExactDecimalError('DIVISION_BY_ZERO', 'Division by zero');
    }
    assertDecimalPlaces(decimalPlaces);
    const scaled = ExactDecimal.create(this.value.times(new Dec(10).pow(decimalPlaces))).value;
    // Integer quotient digits plus divisor digits must fit, so quotient * divisor
    // and the remainder are computed exactly.
    const quotientDigits = Math.max(scaled.e - divisor.value.e + 2, 1);
    if (quotientDigits + divisor.value.precision(true) > PRECISION) {
      throw new ExactDecimalError('PRECISION_EXCEEDED', 'Exact quotient would exceed the working precision');
    }
    const quotient = scaled.dividedToIntegerBy(divisor.value); // truncated toward zero
    const remainder = scaled.minus(quotient.times(divisor.value));
    const rounded = roundTruncatedQuotient(quotient, remainder, divisor.value, mode);
    return ExactDecimal.create(rounded.dividedBy(new Dec(10).pow(decimalPlaces)));
  }

  /** Rounds to `decimalPlaces` with the given mode. */
  rounded(decimalPlaces: number, mode: RoundingMode): ExactDecimal {
    assertDecimalPlaces(decimalPlaces);
    return ExactDecimal.create(this.value.toDecimalPlaces(decimalPlaces, DECIMAL_ROUNDING[mode]));
  }

  decimalPlaces(): number {
    return this.value.decimalPlaces();
  }

  /** Number of digits before the decimal point (0 for |x| < 1). */
  integerDigits(): number {
    const integer = this.value.abs().truncated();
    return integer.isZero() ? 0 : integer.toFixed(0).length;
  }

  compare(other: ExactDecimal): -1 | 0 | 1 {
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  equals(other: ExactDecimal): boolean {
    return this.value.equals(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  negated(): ExactDecimal {
    return ExactDecimal.create(this.value.negated());
  }

  /** Plain notation with exactly `decimalPlaces` digits after the point. */
  toFixed(decimalPlaces: number): string {
    if (this.value.decimalPlaces() > decimalPlaces) {
      throw new ExactDecimalError('INVALID_DECIMAL', `Value has more than ${decimalPlaces} decimal places`);
    }
    return this.value.toFixed(decimalPlaces);
  }

  /** Plain notation, never an exponent. */
  toString(): string {
    return this.value.toFixed();
  }

  toJSON(): string {
    return this.toString();
  }
}

function assertDecimalPlaces(decimalPlaces: number): void {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > PRECISION) {
    throw new ExactDecimalError('INVALID_DECIMAL', `Invalid decimal places: ${decimalPlaces}`);
  }
}

/** Integer + fractional digits needed for an exact sum must fit the precision. */
function assertSumFits(a: Dec, b: Dec): void {
  const integerDigits = Math.max(a.abs().truncated().toFixed(0).length, b.abs().truncated().toFixed(0).length) + 1;
  if (integerDigits + Math.max(a.decimalPlaces(), b.decimalPlaces()) > PRECISION) {
    throw new ExactDecimalError('PRECISION_EXCEEDED', 'Exact sum would exceed the working precision');
  }
}

/**
 * Applies the rounding mode to a quotient truncated toward zero, using the exact
 * remainder: |remainder| compared with |divisor| / 2 decides the half cases.
 */
function roundTruncatedQuotient(quotient: Dec, remainder: Dec, divisor: Dec, mode: RoundingMode): Dec {
  if (remainder.isZero()) return quotient;
  const negative = remainder.isNegative() !== divisor.isNegative(); // sign of the exact quotient
  const awayFromZero = quotient.plus(negative ? -1 : 1);
  const twiceRemainder = remainder.abs().times(2);
  const half = twiceRemainder.comparedTo(divisor.abs()); // -1 below half, 0 exactly half, 1 above
  switch (mode) {
    case 'DOWN':
      return quotient;
    case 'UP':
      return awayFromZero;
    case 'CEIL':
      return negative ? quotient : awayFromZero;
    case 'FLOOR':
      return negative ? awayFromZero : quotient;
    case 'HALF_UP':
      return half >= 0 ? awayFromZero : quotient;
    case 'HALF_EVEN':
      if (half !== 0) return half > 0 ? awayFromZero : quotient;
      return quotient.mod(2).isZero() ? quotient : awayFromZero;
  }
}

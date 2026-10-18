import { Decimal } from 'decimal.js';

/**
 * Money value object (ADR-033, coding-guidelines §4–5, data-model.md §6.1).
 *
 * - Exact decimal arithmetic via an isolated decimal.js constructor; the global
 *   decimal.js configuration is never read or changed.
 * - Every value carries its currency; mixing currencies is an error.
 * - Input that is not representable in the currency's scale is rejected, never
 *   silently rounded. Rounding happens only through the explicit `rounded`
 *   operations, which require the caller to name the rounding mode.
 * - Money may be negative (e.g. a difference of two amounts). Whether a value
 *   must be non-negative — like canonical ledger amounts (data-model.md §17.4) —
 *   is a rule of the owning domain, checked there via `isNegative()`.
 */

/** Largest supported number of integer digits; keeps every operation exact (see DecimalCtor). */
export const MAX_INTEGER_DIGITS = 18;
/** Largest supported number of significant digits in a multiplication factor. */
export const MAX_FACTOR_DIGITS = 60;

/**
 * Isolated constructor. With amounts bounded to MAX_INTEGER_DIGITS + scale and
 * factors to MAX_FACTOR_DIGITS, sums and products stay far below this precision,
 * so no intermediate result is ever rounded implicitly.
 */
const DecimalCtor = Decimal.clone({
  precision: 200,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -1000,
  toExpPos: 1000,
});
type Dec = InstanceType<typeof DecimalCtor>;

/** Supported currencies and their minor-unit scale. Phase 1: EUR only (data-model.md §17.4). */
const CURRENCY_SCALE = {
  EUR: 2,
} as const;

export type CurrencyCode = keyof typeof CURRENCY_SCALE;

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return Object.hasOwn(CURRENCY_SCALE, code);
}

export function currencyScale(currency: CurrencyCode): number {
  return CURRENCY_SCALE[currency];
}

/** Explicit rounding modes for business-boundary rounding. There is no default. */
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

export type MoneyErrorCode =
  | 'INVALID_AMOUNT'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'SCALE_EXCEEDED'
  | 'UNSUPPORTED_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_FACTOR';

export class MoneyError extends Error {
  override readonly name = 'MoneyError';

  constructor(
    readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Canonical decimal string: optional minus, no leading zeros, no exponent, no '+'. */
const DECIMAL_STRING = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** API / JSON representation (api-design.md §86). */
export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

export class Money {
  private constructor(
    private readonly value: Dec,
    readonly currency: CurrencyCode,
  ) {}

  /**
   * Parses a decimal string. Rejects malformed input, unsupported currencies and
   * amounts with more decimal places than the currency allows.
   */
  static of(amount: string, currency: string): Money {
    const code = requireCurrency(currency);
    if (typeof amount !== 'string' || !DECIMAL_STRING.test(amount)) {
      throw new MoneyError('INVALID_AMOUNT', `Not a canonical decimal string: ${String(amount)}`);
    }
    const value = new DecimalCtor(amount);
    if (value.decimalPlaces() > currencyScale(code)) {
      throw new MoneyError(
        'SCALE_EXCEEDED',
        `${amount} has more than ${currencyScale(code)} decimal places for ${code}`,
      );
    }
    return Money.create(value, code);
  }

  static zero(currency: string): Money {
    return Money.create(new DecimalCtor(0), requireCurrency(currency));
  }

  /**
   * Turns the result of a calculation (e.g. an allocation share or interest) into
   * Money by rounding to the currency scale with an explicitly chosen mode. This
   * is the documented business-boundary rounding (coding-guidelines §5).
   */
  static rounded(value: string, currency: string, mode: RoundingMode): Money {
    const code = requireCurrency(currency);
    if (typeof value !== 'string' || !DECIMAL_STRING.test(value)) {
      throw new MoneyError('INVALID_AMOUNT', `Not a canonical decimal string: ${String(value)}`);
    }
    return Money.create(roundToScale(new DecimalCtor(value), code, mode), code);
  }

  static fromJSON(json: MoneyJson): Money {
    return Money.of(json.amount, json.currency);
  }

  private static create(value: Dec, currency: CurrencyCode): Money {
    if (value.isZero()) value = new DecimalCtor(0); // normalize -0
    const integerDigits = value.abs().truncated().toFixed(0).length;
    if (integerDigits > MAX_INTEGER_DIGITS) {
      throw new MoneyError(
        'AMOUNT_OUT_OF_RANGE',
        `Amount exceeds ${MAX_INTEGER_DIGITS} integer digits`,
      );
    }
    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.create(this.value.negated(), this.currency);
  }

  /**
   * Multiplies by a decimal factor (e.g. an ownership share or interest rate) and
   * rounds the exact product to the currency scale with the given mode.
   */
  multiply(factor: string, mode: RoundingMode): Money {
    if (typeof factor !== 'string' || !DECIMAL_STRING.test(factor)) {
      throw new MoneyError('INVALID_FACTOR', `Not a canonical decimal string: ${String(factor)}`);
    }
    const f = new DecimalCtor(factor);
    if (f.precision(true) > MAX_FACTOR_DIGITS) {
      throw new MoneyError('INVALID_FACTOR', `Factor exceeds ${MAX_FACTOR_DIGITS} significant digits`);
    }
    return Money.create(roundToScale(this.value.times(f), this.currency, mode), this.currency);
  }

  /** Sums amounts of one currency; an empty list needs the currency explicitly. */
  static sum(amounts: readonly Money[], currency: string): Money {
    return amounts.reduce((acc, m) => acc.add(m), Money.zero(currency));
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** -1, 0 or 1. Throws on currency mismatch. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  /** Amount as a fixed-scale decimal string, e.g. "1250.00". Used for API and NUMERIC persistence. */
  get amount(): string {
    return this.value.toFixed(currencyScale(this.currency));
  }

  toJSON(): MoneyJson {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(
        'CURRENCY_MISMATCH',
        `Cannot combine ${this.currency} with ${other.currency}`,
      );
    }
  }
}

function requireCurrency(currency: string): CurrencyCode {
  if (typeof currency !== 'string' || !isSupportedCurrency(currency)) {
    throw new MoneyError('UNSUPPORTED_CURRENCY', `Unsupported currency: ${String(currency)}`);
  }
  return currency;
}

function roundToScale(value: Dec, currency: CurrencyCode, mode: RoundingMode): Dec {
  return value.toDecimalPlaces(currencyScale(currency), DECIMAL_ROUNDING[mode]);
}

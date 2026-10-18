import { DECIMAL_STRING, ExactDecimal, type RoundingMode } from './exact-decimal.js';

/**
 * Money value object (ADR-033, coding-guidelines §4–5, data-model.md §6.1).
 *
 * - Exact decimal arithmetic via ExactDecimal; decimal.js and its global
 *   configuration are never touched outside shared/.
 * - Every value carries its currency; mixing currencies is an error.
 * - Input that is not representable in the currency's scale is rejected, never
 *   silently rounded. Rounding happens only through `Money.rounded` and
 *   `multiply`, which take an ExactDecimal and require an explicit rounding mode.
 * - Money may be negative (e.g. a difference of two amounts). Whether a value
 *   must be non-negative — like canonical ledger amounts (data-model.md §17.4) —
 *   is a rule of the owning domain, checked there via `isNegative()`.
 */

/** Largest supported number of integer digits (matches the NUMERIC column CHECK, coding-guidelines §8). */
export const MAX_INTEGER_DIGITS = 18;

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

export type MoneyErrorCode =
  | 'INVALID_AMOUNT'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'SCALE_EXCEEDED'
  | 'UNSUPPORTED_CURRENCY'
  | 'CURRENCY_MISMATCH';

export class MoneyError extends Error {
  override readonly name = 'MoneyError';

  constructor(
    readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** API / JSON representation (api-design.md §86). */
export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

export class Money {
  private constructor(
    private readonly value: ExactDecimal,
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
    const value = ExactDecimal.of(amount);
    if (value.decimalPlaces() > currencyScale(code)) {
      throw new MoneyError(
        'SCALE_EXCEEDED',
        `${amount} has more than ${currencyScale(code)} decimal places for ${code}`,
      );
    }
    return Money.create(value, code);
  }

  static zero(currency: string): Money {
    return Money.create(ExactDecimal.of('0'), requireCurrency(currency));
  }

  /**
   * Turns the result of a calculation (e.g. an allocation share or interest),
   * computed with ExactDecimal, into Money by rounding to the currency scale with
   * an explicitly chosen mode. This is the documented business-boundary rounding
   * (coding-guidelines §5).
   */
  static rounded(value: ExactDecimal, currency: string, mode: RoundingMode): Money {
    const code = requireCurrency(currency);
    if (!(value instanceof ExactDecimal)) {
      throw new MoneyError('INVALID_AMOUNT', 'Money.rounded expects an ExactDecimal');
    }
    return Money.create(value.rounded(currencyScale(code), mode), code);
  }

  static fromJSON(json: MoneyJson): Money {
    return Money.of(json.amount, json.currency);
  }

  /** Sums amounts of one currency; an empty list needs the currency explicitly. */
  static sum(amounts: readonly Money[], currency: string): Money {
    return amounts.reduce((acc, m) => acc.add(m), Money.zero(currency));
  }

  private static create(value: ExactDecimal, currency: CurrencyCode): Money {
    if (value.integerDigits() > MAX_INTEGER_DIGITS) {
      throw new MoneyError('AMOUNT_OUT_OF_RANGE', `Amount exceeds ${MAX_INTEGER_DIGITS} integer digits`);
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
   * Multiplies by an exact factor (e.g. an ownership share or interest rate) and
   * rounds the exact product to the currency scale with the given mode.
   */
  multiply(factor: ExactDecimal, mode: RoundingMode): Money {
    return Money.rounded(this.value.times(factor), this.currency, mode);
  }

  /** The exact amount, e.g. as input for a ratio computed with ExactDecimal. */
  toExactDecimal(): ExactDecimal {
    return this.value;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** -1, 0 or 1. Throws on currency mismatch. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.value.compare(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isPositive(): boolean {
    return !this.value.isNegative() && !this.value.isZero();
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

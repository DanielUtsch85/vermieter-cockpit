import { Money } from '../../shared/index.js';

/**
 * Maps Money to and from a PostgreSQL `NUMERIC` amount column plus a separate
 * currency column (ADR-031, ADR-033, coding-guidelines §8).
 *
 * Column convention (binding for every Money column pair):
 *
 *   amount   NUMERIC NOT NULL CHECK (scale(amount) <= 2 AND abs(amount) < 1e18),
 *   currency TEXT    NOT NULL CHECK (currency IN ('EUR'))
 *
 * Unconstrained `NUMERIC` plus CHECK, never `NUMERIC(p,s)`: PostgreSQL silently
 * rounds on insert into `NUMERIC(p,2)` (`'1.005'::numeric(20,2)` = 1.01), which
 * would contradict "rejected, never silently rounded" (data-model.md §17.4) for
 * any writer that bypasses Money. The bounds match `MAX_INTEGER_DIGITS` and the
 * EUR scale. When a second currency with another scale is added, the scale
 * check moves into a per-currency check.
 *
 * node-postgres returns `NUMERIC` as a string by default; this mapping relies on
 * that and refuses any other runtime type, so a misconfigured type parser that
 * yields JS numbers fails loudly instead of losing precision.
 */

/** Value to bind for the `NUMERIC` amount column. */
export function toNumericAmount(money: Money): string {
  return money.amount;
}

/** Rebuilds Money from the `NUMERIC` amount and currency columns of a row. */
export function fromNumericAmount(amount: unknown, currency: unknown): Money {
  if (typeof amount !== 'string') {
    throw new TypeError(`NUMERIC amount must arrive as a string, got ${typeof amount}`);
  }
  if (typeof currency !== 'string') {
    throw new TypeError(`currency must arrive as a string, got ${typeof currency}`);
  }
  return Money.of(amount, currency);
}

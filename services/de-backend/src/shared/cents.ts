import { Money } from './money.js';

/**
 * Exact cents of a Money in EUR (scale 2), and back (api-design.md §86): the § 82b parts and the anschaffungsnahe check
 * compute in integer cents (`bigint`), never in binary floating point (AGENTS.md §20).
 */
export function centsOf(money: Money): bigint {
  const [whole, fraction = ''] = money.amount.replace('-', '').split('.') as [string, string?];
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return money.isNegative() ? -cents : cents;
}

export function moneyOfCents(cents: bigint, currency = 'EUR'): Money {
  const abs = cents < 0n ? -cents : cents;
  return Money.of(`${cents < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`, currency);
}

/** `numerator / denominator` rounded half away from zero; `denominator > 0`. */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  const magnitude = ((numerator < 0n ? -numerator : numerator) * 2n + denominator) / (2n * denominator);
  return numerator < 0n ? -magnitude : magnitude;
}

/** `numerator / denominator` rounded half to even; `denominator > 0`. */
export function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  let q = n / denominator;
  const twice = (n % denominator) * 2n;
  if (twice > denominator || (twice === denominator && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}

/** A scaled integer as a decimal string with `places` decimals (`29700000000, 4` → `"2970000.0000"`). */
export function decimalOf(value: bigint, places: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(places);
  const fraction = places === 0 ? '' : `.${(abs % scale).toString().padStart(places, '0')}`;
  return `${negative ? '-' : ''}${abs / scale}${fraction}`;
}

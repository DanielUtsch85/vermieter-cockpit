/**
 * An ownership share as an exact fraction (api-design.md §26.1, phase-2-plan P2-D3): `n/d` with `1 ≤ n ≤ d ≤ 10000`,
 * always reduced, as in the Grundbuch. Sums are exact rationals over `bigint`, never decimals and never bounded
 * integers, so three shares of `1/3` are exactly complete however many coprime denominators meet.
 */
export interface Share {
  readonly numerator: number;
  readonly denominator: number;
}

/** A non-negative rational, reduced; the sum of shares on a day (may exceed 1 in a refused request). */
export interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export const MAX_SHARE_DENOMINATOR = 10_000;

export type ShareError = 'INVALID_FORMAT' | 'OUT_OF_RANGE';

const SHARE = /^([1-9][0-9]{0,8})\/([1-9][0-9]{0,8})$/;

export function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** `"n/d"` → the reduced share, or why not: not a fraction of positive integers, or `n > d` / `d > 10000`. */
export function parseShare(text: string): { readonly share: Share } | { readonly error: ShareError } {
  const match = SHARE.exec(text);
  if (match === null) return { error: 'INVALID_FORMAT' };
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (numerator > denominator || denominator > MAX_SHARE_DENOMINATOR) return { error: 'OUT_OF_RANGE' };
  const divisor = Number(gcd(BigInt(numerator), BigInt(denominator)));
  return { share: { numerator: numerator / divisor, denominator: denominator / divisor } };
}

export function formatShare(share: Share | Fraction): string {
  return `${share.numerator}/${share.denominator}`;
}

export const ZERO: Fraction = { numerator: 0n, denominator: 1n };

/** The exact sum, reduced. */
export function sumShares(shares: readonly (Share | Fraction)[]): Fraction {
  let numerator = 0n;
  let denominator = 1n;
  for (const share of shares) {
    const n = BigInt(share.numerator);
    const d = BigInt(share.denominator);
    numerator = numerator * d + n * denominator;
    denominator *= d;
    const divisor = gcd(numerator, denominator);
    numerator /= divisor;
    denominator /= divisor;
  }
  return { numerator, denominator };
}

/** -1, 0 or 1 as the fraction is below, at or above 1. */
export function compareToOne(fraction: Fraction): -1 | 0 | 1 {
  return fraction.numerator < fraction.denominator ? -1 : fraction.numerator === fraction.denominator ? 0 : 1;
}

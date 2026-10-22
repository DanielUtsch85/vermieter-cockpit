import { describe, expect, it } from 'vitest';
import { compareToOne, formatShare, parseShare, sumShares, type Share } from './share.js';

/** P2-D3: exact fractions, stored reduced; sums exact however many coprime denominators meet. */
describe('Share', () => {
  it('parses "n/d" with 1 ≤ n ≤ d ≤ 10000 and reduces it', () => {
    expect(parseShare('2/4')).toEqual({ share: { numerator: 1, denominator: 2 } });
    expect(parseShare('1/1')).toEqual({ share: { numerator: 1, denominator: 1 } });
    expect(parseShare('7/10')).toEqual({ share: { numerator: 7, denominator: 10 } });
    expect(parseShare('10000/10000')).toEqual({ share: { numerator: 1, denominator: 1 } });
    for (const bad of ['0/2', '1/0', '1', '0.5', '50%', ' 1/2', '1/2 ', '-1/2', '01/2', '1/ 2', '1//2', '']) {
      expect(parseShare(bad), bad).toEqual({ error: 'INVALID_FORMAT' });
    }
    for (const bad of ['3/2', '1/10001', '20000/20000']) expect(parseShare(bad), bad).toEqual({ error: 'OUT_OF_RANGE' });
  });

  it('sums exactly: three thirds are exactly 1; many coprime denominators do not overflow', () => {
    const third: Share = { numerator: 1, denominator: 3 };
    expect(sumShares([third, third, third])).toEqual({ numerator: 1n, denominator: 1n });
    expect(compareToOne(sumShares([third, third, third]))).toBe(0);
    expect(compareToOne(sumShares([third, third]))).toBe(-1);
    expect(compareToOne(sumShares([third, third, third, { numerator: 1, denominator: 10000 }]))).toBe(1);
    // 1/9973 + 1/9967 + … (large primes): the common denominator exceeds 2^64, the sum stays exact.
    const primes = [9973, 9967, 9949, 9941, 9931, 9929, 9923];
    const sum = sumShares(primes.map((p) => ({ numerator: 1, denominator: p })));
    expect(sum.denominator).toBe(primes.reduce((a, p) => a * BigInt(p), 1n));
    expect(sum.denominator > 2n ** 64n).toBe(true);
    expect(sumShares([])).toEqual({ numerator: 0n, denominator: 1n });
    expect(formatShare(sumShares([third, { numerator: 1, denominator: 6 }]))).toBe('1/2');
  });
});

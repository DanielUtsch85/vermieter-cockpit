import { addDays, type BusinessDate, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import { isConfirmed, type ShorterUsefulLife } from './asset.js';
import { bandOf, buildingRuleOn, isShorter } from './rate.js';
import type { BuildingLinearParameters, BuildingRateBand } from './rules/de-afa-building-linear.js';

/**
 * The exact arithmetic of the schedule (api-design.md §59A, §59B): reduced fractions in `bigint`, never floating
 * point (AGENTS.md §20), the calendar months as integers, and the rate of a year. Moved out of `schedule.ts` unchanged
 * by VC-8-03 so the capitalised items (`schedule-items.ts`) use the very same helpers.
 */

export interface Frac {
  readonly n: bigint;
  readonly d: bigint;
}
const gcdOf = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};
export const frac = (n: bigint, d: bigint): Frac => {
  const g = gcdOf(n, d) || 1n;
  const sign = d < 0n ? -1n : 1n;
  return { n: (sign * n) / g, d: (sign * d) / g };
};
export const ZERO: Frac = { n: 0n, d: 1n };
export const ONE: Frac = { n: 1n, d: 1n };
export const add = (a: Frac, b: Frac) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Frac, b: Frac) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Frac, b: Frac) => frac(a.n * b.n, a.d * b.d);
export const div = (a: Frac, b: Frac) => frac(a.n * b.d, a.d * b.n);
export const cmp = (a: Frac, b: Frac) => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};
export const minF = (a: Frac, b: Frac) => (cmp(a, b) <= 0 ? a : b);
export const maxF = (a: Frac, b: Frac) => (cmp(a, b) >= 0 ? a : b);
export const ofShare = (s: { readonly numerator: number | bigint; readonly denominator: number | bigint }) => frac(BigInt(s.numerator), BigInt(s.denominator));
export const show = (f: Frac) => `${f.n}/${f.d}`;
/** A §87 decimal string as an exact fraction: `"2.5"` → 5/2. */
export function ofDecimal(value: string): Frac {
  const [whole, fraction = ''] = value.split('.') as [string, string?];
  return frac(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
}

export const monthOf = (date: BusinessDate) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
export const yearOfMonth = (m: number) => Math.floor(m / 12);
export const monthLabel = (m: number) => `${yearOfMonth(m)}-${String((m % 12) + 1).padStart(2, '0')}`;
export const firstDay = (m: number) => `${monthLabel(m)}-01` as BusinessDate;
export const lastDayOf = (m: number) => addDays(firstDay(m + 1), -1);
export const yearOfDate = (date: BusinessDate) => Number(date.slice(0, 4));
export const maxDate = (a: BusinessDate, b: BusinessDate) => (a > b ? a : b);
export const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface YearRate {
  readonly rule: RuleVersion<BuildingLinearParameters>;
  readonly band: BuildingRateBand;
  readonly kind: 'BAND' | 'SHORTER_USEFUL_LIFE';
  readonly annual: Frac;
  /** A confirmed shorter life whose years are not below the band's threshold (`USEFUL_LIFE_NOT_SHORTER`). */
  readonly notShorter: boolean;
}

/** The rate of `year` for a component (§59A "The asset, the rate and the rule"); undefined without a rule or a band. */
export function rateOfYear(registry: RuleRegistry, year: number, completionYear: number | null, entry: ShorterUsefulLife | undefined): YearRate | undefined {
  const rule = buildingRuleOn(registry, year);
  if (rule === undefined || completionYear === null) return undefined;
  const band = bandOf(rule.parameters, completionYear);
  if (band === undefined) return undefined;
  const bandRate = div(ofDecimal(band.ratePercent), frac(100n, 1n));
  if (entry === undefined || !isConfirmed(entry.reviewState)) return { rule, band, kind: 'BAND', annual: bandRate, notShorter: false };
  if (!isShorter(entry.usefulLifeYears, band)) return { rule, band, kind: 'BAND', annual: bandRate, notShorter: true };
  return { rule, band, kind: 'SHORTER_USEFUL_LIFE', annual: frac(1n, BigInt(entry.usefulLifeYears)), notShorter: false };
}

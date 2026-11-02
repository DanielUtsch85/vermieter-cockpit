import { addDays, addMonths, centsOf, type BusinessDate, type Money, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import { ANSCHAFFUNGSNAHE, type AnschaffungsnaheParameters, type PerformanceParameters } from './rules/de-anschaffungsnahe.js';

/**
 * The period of performance on a classification (api-design.md §59F "The fact", VC-X-38; tax review of 2026-11-01,
 * questions 5, 14 and 16, mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01; the owner's
 * decisions of 2026-11-02): when the work a source pays for was carried out, with up to five evidenced cumulative
 * shares. Recorded as entered, never changed; a correction supersedes the classification. It is never replaced by the
 * booking, payment, invoice or statement date.
 */

/** `amount` is the cumulative part of the amount used performed up to and including `through`. */
export interface PerformancePoint {
  readonly through: BusinessDate;
  readonly amount: Money;
}

export interface Performance {
  readonly from: BusinessDate;
  readonly until: BusinessDate;
  readonly progress: readonly PerformancePoint[];
  /** Given exactly with `progress` (`null` without points); an estimated point is never an evidenced share. */
  readonly progressEstimated: boolean | null;
}

export type PerformanceRefusal =
  /** A split that is interest by §59E's list: `400 NOT_ALLOWED` at `performance`. */
  | { readonly kind: 'PERFORMANCE_NOT_ALLOWED' }
  | { readonly kind: 'PERFORMANCE_PROGRESS_EXCEEDS_AMOUNT'; readonly amountUsed: Money; readonly amount: Money }
  | { readonly kind: 'PERFORMANCE_EVIDENCE_REQUIRED' }
  | {
      readonly kind: 'PERFORMANCE_OUT_OF_RANGE';
      readonly sourceDate: BusinessDate;
      readonly from: BusinessDate;
      readonly until: BusinessDate;
      readonly allowedFrom: BusinessDate;
      readonly allowedUntil: BusinessDate;
    };

/** `DE_ANSCHAFFUNGSNAHE`'s `performance` on `date`, else the first version's (a performance before 2004 is still checked). */
export function performanceParametersOn(registry: RuleRegistry, date: BusinessDate): PerformanceParameters | undefined {
  const version = (registry.select(ANSCHAFFUNGSNAHE, date) ?? registry.versions(ANSCHAFFUNGSNAHE)[0]) as RuleVersion<AnschaffungsnaheParameters> | undefined;
  return version?.parameters.performance;
}

/**
 * The checks of a classification's `performance` that need its source (§59F "Order of checks"), after
 * `NET_AMOUNT_EXCEEDS_GROSS`: interest refused; a point not below the amount used; points without a source reference;
 * a date outside the plausible years around the source's date. The field errors (`400`) come before, in the API.
 */
export function performanceCheck(
  source: { readonly date: BusinessDate; readonly grossAmount: Money; readonly interest: boolean },
  request: { readonly performance: Performance; readonly netAmount: Money | null; readonly sourceReferences: readonly string[] },
  registry: RuleRegistry,
): PerformanceRefusal | undefined {
  const { performance } = request;
  if (source.interest) return { kind: 'PERFORMANCE_NOT_ALLOWED' };
  const amountUsed = request.netAmount ?? source.grossAmount;
  const tooHigh = performance.progress.find((p) => p.amount.compare(amountUsed) >= 0);
  if (tooHigh !== undefined) return { kind: 'PERFORMANCE_PROGRESS_EXCEEDS_AMOUNT', amountUsed, amount: tooHigh.amount };
  const p = performanceParametersOn(registry, source.date);
  if (performance.progress.length > 0 && (p?.progressEvidenceRequired ?? true) && request.sourceReferences.length === 0) {
    return { kind: 'PERFORMANCE_EVIDENCE_REQUIRED' };
  }
  const years = p?.plausibleYearsFromSourceDate ?? 3;
  const allowedFrom = addMonths(source.date, -12 * years);
  const allowedUntil = addMonths(source.date, 12 * years);
  if (performance.from < allowedFrom || performance.until > allowedUntil) {
    return { kind: 'PERFORMANCE_OUT_OF_RANGE', sourceDate: source.date, from: performance.from, until: performance.until, allowedFrom, allowedUntil };
  }
  return undefined;
}

/** Whether the performance lies wholly outside `[from, until]` (both inclusive). */
export const performedOutside = (performance: Pick<Performance, 'from' | 'until'>, window: { readonly from: BusinessDate; readonly until: BusinessDate }) =>
  performance.until < window.from || performance.from > window.until;

/**
 * The part of a source performed in `window` as two bounds in cents (§59F "The check measures the performance"), never
 * estimated and never spread by calendar days: `cum(t)` is 0 before `from`, the amount used from `until` on and each
 * evidenced point's amount on its day; where it is not known, the bounds take the known points around `t`. An
 * estimated point is not evidenced (the owner's decision of 2026-11-02; still open whether one may count): it is
 * ignored. A refund (`cents` < 0) swaps the bounds, so it never pushes a check over on a guess.
 */
export function partInWindow(
  performance: Performance,
  cents: bigint,
  window: { readonly from: BusinessDate; readonly until: BusinessDate },
): { readonly lower: bigint; readonly upper: bigint } {
  const amount = cents < 0n ? -cents : cents;
  const evidenced = performance.progressEstimated === true ? [] : performance.progress;
  const known: { day: BusinessDate; value: bigint }[] = [
    { day: addDays(performance.from, -1), value: 0n },
    ...evidenced.map((p) => ({ day: p.through, value: centsOf(p.amount) })),
    { day: performance.until, value: amount },
  ];
  const low = (t: BusinessDate) => known.filter((k) => k.day <= t).reduce((v, k) => k.value, 0n);
  const high = (t: BusinessDate) => known.find((k) => k.day >= t)?.value ?? amount;
  const before = addDays(window.from, -1);
  const max0 = (v: bigint) => (v < 0n ? 0n : v);
  const lower = max0(low(window.until) - high(before));
  const upper = max0(high(window.until) - low(before));
  return cents < 0n ? { lower: -upper, upper: -lower } : { lower, upper };
}

/** The performance as the API, the AuditRecord and a check's entry show it (Money as `{ amount, currency }`). */
export const performanceJson = (p: Performance) => ({
  from: p.from,
  until: p.until,
  progress: p.progress.map((x) => ({ through: x.through, amount: x.amount.toJSON() })),
  progressEstimated: p.progressEstimated,
});

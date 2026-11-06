import { centsOf, decimalOf, divideHalfEven, type BusinessDate, type Money, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import type { AllocationMethod, AllocationReviewState } from './allocation.js';

/**
 * The plausibility warning on a land/building allocation (api-design.md §58T, VC-X-44; Prüfbericht 2026-11-01, Frage 17,
 * mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01; Entscheidung des Projektinhabers,
 * 2026-11-06). The comparison is the user's input (P8-D3 stands: DE never computes the BMF Arbeitshilfe); only the land
 * share of the allocation and of the comparison are compared, exactly in cents. The warning marks a figure and never
 * changes one; an input is never refused for being conspicuous.
 */

export const COMPARISON_METHODS = ['BMF_TOOL', 'APPRAISAL', 'MARKET_VALUE', 'OTHER'] as const;
export type ComparisonMethod = (typeof COMPARISON_METHODS)[number];
export const MAX_COMPARISON_SOURCE_REFERENCES = 10;
export const MAX_DEVIATION_REASON_LENGTH = 2000;

/** The values of land and building by another method, with their sources („Quelle und Methodik speichern“). */
export interface AllocationComparison {
  readonly method: ComparisonMethod;
  readonly landValue: Money;
  readonly buildingValue: Money;
  readonly sourceReferences: readonly string[];
}

export const LAND_BUILDING_PLAUSIBILITY = 'DE_LAND_BUILDING_PLAUSIBILITY';
export const ALLOCATION_DEVIATES_FROM_COMPARISON = 'ALLOCATION_DEVIATES_FROM_COMPARISON';
export const ALLOCATION_PLAUSIBILITY_NOT_CHECKED = 'ALLOCATION_PLAUSIBILITY_NOT_CHECKED';

export const DEVIATION_DIRECTIONS = ['LAND_SHARE_LOWER', 'LAND_SHARE_HIGHER'] as const;
export type DeviationDirection = (typeof DEVIATION_DIRECTIONS)[number];

/** What closed a conspicuous allocation's warning (§58T rule 4 as decided, question 5); `null` while it is open. */
export type DeviationClosedBy = 'ADVISOR_CONFIRMED' | 'DEVIATION_REASON';

/** The parameters of `DE_LAND_BUILDING_PLAUSIBILITY` (§58T rule 5). */
export interface LandBuildingPlausibilityParameters {
  /** The threshold `t` on the land share, a §87 decimal string; conspicuous iff `|cL − aL| ≥ t`. */
  readonly landShareDeviation: string;
  /** Question 2: provisional, not from the tax review and not a legal threshold, until the advisor names a number. */
  readonly landShareDeviationVerified: boolean;
  readonly directions: readonly DeviationDirection[];
  /** Question 7: the methods whose allocation without a comparison carries `ALLOCATION_PLAUSIBILITY_NOT_CHECKED`. */
  readonly notCheckedMethods: readonly AllocationMethod[];
  /** Question 5: the review states that close the warning without a reason (`closedBy` the state). */
  readonly closingReviewStates: readonly AllocationReviewState[];
}

/** What the check reads of an allocation; each is judged by its own data and the version on its own `effectiveDate`. */
export interface PlausibilitySubject {
  readonly id: string;
  /** An `AllocationMethod` (the schedule's source reads it as text). */
  readonly method: string;
  /** An `AllocationReviewState` (as above). */
  readonly reviewState: string;
  readonly effectiveDate: BusinessDate;
  readonly totalAllocableAmount: Money;
  readonly landAmount: Money;
  readonly buildingAmount: Money;
  readonly comparison: AllocationComparison | null;
  readonly deviationReason: string | null;
}

export interface PlausibilityFlag {
  readonly code: typeof ALLOCATION_DEVIATES_FROM_COMPARISON | typeof ALLOCATION_PLAUSIBILITY_NOT_CHECKED;
  readonly level: 'OPEN' | 'INFORMATIVE';
  readonly details: Readonly<Record<string, unknown>>;
}

/** `ALLOCATION_DEVIATES_FROM_COMPARISON` is open while nothing closed it (an unknown `closedBy` counts as open). */
export const deviationIsOpen = (details: Readonly<Record<string, unknown>>): boolean =>
  details['closedBy'] !== 'ADVISOR_CONFIRMED' && details['closedBy'] !== 'DEVIATION_REASON';

/** A §87 decimal string as `numerator / 10^places` (the threshold "0.10" → 10 / 100). */
function fractionOf(decimal: string): { readonly n: bigint; readonly d: bigint } {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return { n: BigInt(`${whole}${fraction}`), d: 10n ** BigInt(fraction.length) };
}

/** `n / d` rounded half-even to four places, as a decimal string (`d > 0`). */
const fourPlaces = (n: bigint, d: bigint) => decimalOf(divideHalfEven(n * 10_000n, d), 4);

/** The comparison's land share `landValue / (landValue + buildingValue)`, four places half-even; for display only. */
export function comparisonLandShare(c: AllocationComparison): string {
  return fourPlaces(centsOf(c.landValue), centsOf(c.landValue) + centsOf(c.buildingValue));
}

/** `DE_LAND_BUILDING_PLAUSIBILITY` on `date`, or `undefined` without a version (then no flag of either code). */
export function plausibilityRuleOn(registry: RuleRegistry, date: BusinessDate): RuleVersion<LandBuildingPlausibilityParameters> | undefined {
  return registry.select(LAND_BUILDING_PLAUSIBILITY, date) as RuleVersion<LandBuildingPlausibilityParameters> | undefined;
}

/**
 * The flags of one allocation (§58T rule 4), derived on read and never stored. Rule 2 decides exactly, in cents, and
 * never reads a rounded share: conspicuous iff `|landValue · total − landAmount · (landValue + buildingValue)| ≥
 * t · total · (landValue + buildingValue)`.
 */
export function plausibilityFlags(a: PlausibilitySubject, registry: RuleRegistry): PlausibilityFlag[] {
  const rule = plausibilityRuleOn(registry, a.effectiveDate);
  if (rule === undefined) return [];
  // No AfA without a building part: §59A's NO_BUILDING already says so, and nothing is checked.
  if (a.buildingAmount.isZero()) return [];
  const p = rule.parameters;
  const c = a.comparison;
  if (c === null) {
    if (!(p.notCheckedMethods as readonly string[]).includes(a.method)) return [];
    return [{ code: ALLOCATION_PLAUSIBILITY_NOT_CHECKED, level: 'INFORMATIVE', details: { allocationId: a.id, method: a.method } }];
  }
  const total = centsOf(a.totalAllocableAmount);
  const land = centsOf(a.landAmount);
  const cLand = centsOf(c.landValue);
  const cSum = cLand + centsOf(c.buildingValue);
  const t = fractionOf(p.landShareDeviation);
  // (cL − aL) · total · cSum, in cents²; its sign is the direction.
  const difference = cLand * total - land * cSum;
  const magnitude = difference < 0n ? -difference : difference;
  if (magnitude * t.d < t.n * total * cSum) return [];
  const direction: DeviationDirection = difference > 0n ? 'LAND_SHARE_LOWER' : 'LAND_SHARE_HIGHER';
  if (!p.directions.includes(direction)) return [];
  const reasonGiven = a.deviationReason !== null;
  const closedBy: DeviationClosedBy | null = (p.closingReviewStates as readonly string[]).includes(a.reviewState)
    ? 'ADVISOR_CONFIRMED'
    : reasonGiven
      ? 'DEVIATION_REASON'
      : null;
  const details = {
    allocationId: a.id,
    comparisonMethod: c.method,
    allocationLandShare: fourPlaces(land, total),
    comparisonLandShare: fourPlaces(cLand, cSum),
    deviation: fourPlaces(difference, total * cSum),
    threshold: p.landShareDeviation,
    direction,
    reasonGiven,
    reviewState: a.reviewState,
    closedBy,
    rule: { ruleCode: rule.ruleCode, version: rule.version },
  };
  return [{ code: ALLOCATION_DEVIATES_FROM_COMPARISON, level: deviationIsOpen(details) ? 'OPEN' : 'INFORMATIVE', details }];
}

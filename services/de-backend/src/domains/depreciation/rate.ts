import { ExactDecimal, RoundingMode, type BusinessDate, type RuleRef, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import { isConfirmed, sortedEntries, type AssetRead } from './asset.js';
import { AFA_BUILDING_LINEAR, type BuildingBand, type BuildingLinearParameters, type BuildingRateBand } from './rules/de-afa-building-linear.js';

/** Why the band's rate is not usable for `year`, in this order (§59). */
export const ASSET_RATE_REASONS = ['ASSET_VOID', 'COMPLETION_YEAR_MISSING', 'NO_APPLICABLE_RULE', 'ASSET_NOT_CONFIRMED'] as const;
export type AssetRateReason = (typeof ASSET_RATE_REASONS)[number];

/** Why a shorter useful life does not apply, in this order (§59). */
export const USEFUL_LIFE_REASONS = ['ACQUISITION_CANCELLED', 'USEFUL_LIFE_NOT_SHORTER', 'USEFUL_LIFE_NOT_CONFIRMED'] as const;
export type UsefulLifeReason = (typeof USEFUL_LIFE_REASONS)[number];

export interface UsefulLifeRate {
  readonly acquisitionId: string;
  /** The exact fraction `1/n`. */
  readonly rate: string;
  /** `100/n`, rounded half-even to four places; for display only. */
  readonly ratePercent: string;
  readonly applies: boolean;
  readonly reasons: readonly UsefulLifeReason[];
}

/** The asset's part of the rate of `year`, derived on every read and never stored (§59). */
export interface AssetRate {
  readonly year: number;
  readonly rule: RuleRef | null;
  readonly band: BuildingBand | null;
  readonly ratePercent: string | null;
  readonly legalBasis: string | null;
  readonly shorterThanYears: number | null;
  readonly reasons: readonly AssetRateReason[];
  readonly shorterUsefulLives: readonly UsefulLifeRate[];
}

/** The version of `DE_AFA_BUILDING_LINEAR` applicable in `year`, selected on 1 January (§58); none before 2006 (§59A). */
export function buildingRuleOn(registry: RuleRegistry, year: number): RuleVersion<BuildingLinearParameters> | undefined {
  return registry.select(AFA_BUILDING_LINEAR, `${year}-01-01` as BusinessDate) as RuleVersion<BuildingLinearParameters> | undefined;
}

/** The band of a completion year, from the rule's parameters (never a constant, AGENTS.md §16). */
export function bandOf(parameters: BuildingLinearParameters, completionYear: number): BuildingRateBand | undefined {
  return parameters.bands.find(
    (b) => (b.completedFromYear === null || completionYear >= b.completedFromYear) && (b.completedToYear === null || completionYear <= b.completedToYear),
  );
}

/** § 7 Abs. 4 S. 2 EStG: shorter only below the years the statute names for the band; no arithmetic on the rate. */
export const isShorter = (usefulLifeYears: number, band: BuildingRateBand) => usefulLifeYears < band.shorterUsefulLife.shorterThanYears;

/** `1/n` × 100, rounded half-even to four places (`1/30` → `3.3333`, `1/16` → `6.2500`). */
export const reciprocalPercent = (usefulLifeYears: number) =>
  ExactDecimal.of('100')
    .dividedBy(ExactDecimal.of(String(usefulLifeYears)), 4, RoundingMode.HALF_EVEN)
    .toFixed(4);

/**
 * The `rate` block of §59 for `year`. The band and its rate are shown while the asset is unconfirmed, so the user sees
 * what confirming would give; `reasons` say why they are not usable. A shorter life applies only when the asset's
 * reasons are empty, the entry is confirmed, shorter than the band's threshold, and its Acquisition is not cancelled.
 */
export function deriveRate(read: AssetRead, year: number, registry: RuleRegistry): AssetRate {
  const { asset } = read;
  const rule = buildingRuleOn(registry, year);
  const band = rule === undefined || asset.buildingCompletionYear === null ? undefined : bandOf(rule.parameters, asset.buildingCompletionYear);
  const reasons: AssetRateReason[] = [];
  if (asset.status === 'VOID') reasons.push('ASSET_VOID');
  if (asset.buildingCompletionYear === null) reasons.push('COMPLETION_YEAR_MISSING');
  if (rule === undefined) reasons.push('NO_APPLICABLE_RULE');
  if (!isConfirmed(asset.reviewState)) reasons.push('ASSET_NOT_CONFIRMED');
  const cancelled = new Set(read.cancelledAcquisitionIds);
  const shorterUsefulLives = sortedEntries(asset.shorterUsefulLives).map((entry): UsefulLifeRate => {
    const why: UsefulLifeReason[] = [];
    if (cancelled.has(entry.acquisitionId)) why.push('ACQUISITION_CANCELLED');
    // Without a band, shortness is not known; the asset's reasons say why.
    if (band !== undefined && !isShorter(entry.usefulLifeYears, band)) why.push('USEFUL_LIFE_NOT_SHORTER');
    if (!isConfirmed(entry.reviewState)) why.push('USEFUL_LIFE_NOT_CONFIRMED');
    return {
      acquisitionId: entry.acquisitionId,
      rate: `1/${entry.usefulLifeYears}`,
      ratePercent: reciprocalPercent(entry.usefulLifeYears),
      applies: reasons.length === 0 && band !== undefined && why.length === 0,
      reasons: why,
    };
  });
  return {
    year,
    rule: rule === undefined ? null : { ruleCode: rule.ruleCode, version: rule.version },
    band: band?.band ?? null,
    ratePercent: band === undefined ? null : ExactDecimal.of(band.ratePercent).toString(),
    legalBasis: band?.legalBasis ?? null,
    shorterThanYears: band?.shorterUsefulLife.shorterThanYears ?? null,
    reasons,
    shorterUsefulLives,
  };
}

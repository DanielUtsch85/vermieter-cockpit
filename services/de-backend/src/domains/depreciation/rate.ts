import { ExactDecimal, RoundingMode, type BusinessDate, type RuleRef, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import { isConfirmed, sortedEntries, type AssetRead, type DepreciationAsset } from './asset.js';
import { methodStatusOf, type MethodStatus } from './purchase-method.js';
import { AFA_BUILDING_LINEAR, type BuildingBand, type BuildingLinearParameters, type BuildingRateBand } from './rules/de-afa-building-linear.js';
import { AFA_MOVABLE_LINEAR, type MovableLinearParameters } from './rules/de-afa-movable-linear.js';

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
  /** The exact fraction (`"1/50"` for 2 %, `"1/10"` for a separate asset of 10 years; §59B), `null` without a rate. */
  readonly rate: string | null;
  readonly legalBasis: string | null;
  readonly shorterThanYears: number | null;
  readonly reasons: readonly AssetRateReason[];
  readonly shorterUsefulLives: readonly UsefulLifeRate[];
}

/** The version of `DE_AFA_BUILDING_LINEAR` applicable in `year`, selected on 1 January (§58); none before 2006 (§59A). */
export function buildingRuleOn(registry: RuleRegistry, year: number): RuleVersion<BuildingLinearParameters> | undefined {
  return registry.select(AFA_BUILDING_LINEAR, `${year}-01-01` as BusinessDate) as RuleVersion<BuildingLinearParameters> | undefined;
}

/** The version of `DE_AFA_MOVABLE_LINEAR` applicable in `year` (§59B), selected on 1 January; none before 2023. */
export function movableRuleOn(registry: RuleRegistry, year: number): RuleVersion<MovableLinearParameters> | undefined {
  return registry.select(AFA_MOVABLE_LINEAR, `${year}-01-01` as BusinessDate) as RuleVersion<MovableLinearParameters> | undefined;
}

/** A §87 decimal percentage as the exact reduced fraction of one (`"2"` → `"1/50"`, `"2.5"` → `"1/40"`). */
export function rateFraction(ratePercent: string): string {
  const [whole, fraction = ''] = ratePercent.split('.') as [string, string?];
  let n = BigInt(whole + fraction);
  let d = 100n * 10n ** BigInt(fraction.length);
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const g = gcd(n, d);
  n /= g;
  d /= g;
  return `${n}/${d}`;
}

/** The band of a completion year, from the rule's parameters (never a constant, AGENTS.md §16). */
export function bandOf(parameters: BuildingLinearParameters, completionYear: number): BuildingRateBand | undefined {
  return parameters.bands.find(
    (b) => (b.completedFromYear === null || completionYear >= b.completedFromYear) && (b.completedToYear === null || completionYear <= b.completedToYear),
  );
}

/**
 * Whether a year of `parameters` is free of `HISTORICAL_RULE_TO_VERIFY` (§59A): the rates confirmed, and for a year
 * computed with a shorter useful life (`shorter`) also the thresholds of S. 2 that admitted it.
 */
export const isRateVerified = (parameters: BuildingLinearParameters, shorter: boolean) =>
  parameters.verified.rates && (!shorter || parameters.verified.shorterUsefulLifeThresholds);

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
  if (asset.assetType === 'SEPARATE_ASSET') return separateAssetRate(read, year, registry);
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
    rate: band === undefined ? null : rateFraction(band.ratePercent),
    legalBasis: band?.legalBasis ?? null,
    shorterThanYears: band?.shorterUsefulLife.shorterThanYears ?? null,
    reasons,
    shorterUsefulLives,
  };
}

/** §59C: a method entry's derived status, as the asset's response shows it beside the entry. */
export interface PurchaseMethodStatus {
  readonly acquisitionId: string;
  /** `null` only without any version of `DE_AFA_BUILDING_LINEAR` to judge it. */
  readonly methodStatus: MethodStatus | null;
  readonly causes: readonly string[] | null;
}

/**
 * The `methodStatus` and `causes` of each method entry (§59C "Responses"): judged by the `methodStatus` parameter of
 * the version of the entry's start year (the Acquisition's `economicTransferDate`), else the latest. A command's
 * answer does not read the start years and takes the latest (both versions carry the same parameter, a registry test).
 */
export function purchaseMethodStatuses(
  asset: DepreciationAsset,
  registry: RuleRegistry,
  startYears: Readonly<Record<string, number | null>> = {},
): PurchaseMethodStatus[] {
  const versions = registry.versions(AFA_BUILDING_LINEAR) as readonly RuleVersion<BuildingLinearParameters>[];
  const latest = versions[versions.length - 1];
  return sortedEntries(asset.purchaseMethods).map((entry) => {
    const year = startYears[entry.acquisitionId] ?? null;
    const rule = (year === null ? undefined : buildingRuleOn(registry, year)) ?? latest;
    const status = rule === undefined ? null : methodStatusOf(entry, rule.parameters.methodStatus);
    return { acquisitionId: entry.acquisitionId, methodStatus: status?.methodStatus ?? null, causes: status?.causes ?? null };
  });
}

/**
 * The `rate` block of a separate asset (§59B): `1/usefulLifeYears` of `DE_AFA_MOVABLE_LINEAR` for `year`, no band, no
 * shorter useful life. `NO_APPLICABLE_RULE` without a version for `year`, and for an asset acquired before the first
 * version (decided 2026-10-31: its residual value depends on years DE has no rule for).
 */
function separateAssetRate(read: AssetRead, year: number, registry: RuleRegistry): AssetRate {
  const { asset } = read;
  const rule = movableRuleOn(registry, year);
  const firstFrom = registry.versions(AFA_MOVABLE_LINEAR)[0]?.effectiveFrom;
  const reasons: AssetRateReason[] = [];
  if (asset.status === 'VOID') reasons.push('ASSET_VOID');
  if (rule === undefined || firstFrom === undefined || asset.acquiredOn === null || asset.acquiredOn < firstFrom) reasons.push('NO_APPLICABLE_RULE');
  if (!isConfirmed(asset.reviewState)) reasons.push('ASSET_NOT_CONFIRMED');
  const years = asset.usefulLifeYears;
  return {
    year,
    rule: rule === undefined ? null : { ruleCode: rule.ruleCode, version: rule.version },
    band: null,
    ratePercent: years === null ? null : reciprocalPercent(years),
    rate: years === null ? null : `1/${years}`,
    legalBasis: '§ 7 Abs. 1 EStG',
    shorterThanYears: null,
    reasons,
    shorterUsefulLives: [],
  };
}

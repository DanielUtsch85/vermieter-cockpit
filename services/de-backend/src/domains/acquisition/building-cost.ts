import { centsOf, divideHalfUp, moneyOfCents, type Money } from '../../shared/index.js';

/**
 * The building's acquisition cost of one Acquisition (api-design.md §58B, §59A; P8-D2, P8-D3, B5): (price + the
 * `ACTIVE` costs except the excluded categories) × `buildingAmount` / `totalAllocableAmount` of the current allocation,
 * rounded half-up to the cent once. Land never enters. Extracted unchanged from Taxation's anschaffungsnahe check by
 * VC-8-02, so the 15 % check and the AfA schedule compute one basis; both reach it here, and neither imports the other.
 */

/** The Acquisition as the basis reads it (Taxation's `CheckAcquisition` satisfies it structurally). */
export interface BasisAcquisition {
  readonly status: string;
  readonly purchasePrice: Money;
}

/** The current land/building allocation (§27.3), as the basis reads it (Taxation's `CheckAllocation` satisfies it). */
export interface BasisAllocation {
  readonly id: string;
  readonly reviewState: string;
  readonly totalAllocableAmount: Money;
  readonly buildingAmount: Money;
}

export interface BasisCost {
  readonly category: string;
  readonly amount: Money;
}

/** What the caller's rule decides; never a constant here (AGENTS.md §16). */
export interface BasisPolicy {
  /** Cost categories that are not acquisition cost (`FINANCING_RELATED`, taxation.md §6, A6). */
  readonly excludedCostCategories: readonly string[];
  /** The allocation review states that feed a figure (data-model §15). */
  readonly confirmedAllocationReviewStates: readonly string[];
}

/** Why the basis does not feed a figure, the first that applies (§59A, as the check reported them). */
export const BUILDING_COST_REASONS = ['ACQUISITION_NOT_CONFIRMED', 'NO_ALLOCATION', 'ALLOCATION_NOT_CONFIRMED', 'NO_BUILDING'] as const;
export type BuildingCostReason = (typeof BUILDING_COST_REASONS)[number];

export interface BuildingAcquisitionCost {
  /** `null` without an allocation; 0.00 when the allocation's total is 0.00. Shown even with a reason. */
  readonly basisAmount: Money | null;
  readonly purchasePrice: Money;
  /** The `ACTIVE` costs without the excluded categories. */
  readonly acquisitionCosts: Money;
  /** The excluded categories present, each summed, by category. */
  readonly excludedCosts: readonly { readonly category: string; readonly amount: Money }[];
  readonly allocation: BasisAllocation | null;
  readonly reason: BuildingCostReason | null;
}

export function buildingAcquisitionCost(
  input: { readonly acquisition: BasisAcquisition; readonly costs: readonly BasisCost[]; readonly allocation: BasisAllocation | null },
  policy: BasisPolicy,
): BuildingAcquisitionCost {
  const { acquisition, allocation } = input;
  const excluded = (c: BasisCost) => policy.excludedCostCategories.includes(c.category);
  const costCents = input.costs.filter((c) => !excluded(c)).reduce((total, c) => total + centsOf(c.amount), 0n);
  const excludedCents = new Map<string, bigint>();
  for (const c of input.costs.filter(excluded)) excludedCents.set(c.category, (excludedCents.get(c.category) ?? 0n) + centsOf(c.amount));
  const priceCents = centsOf(acquisition.purchasePrice);
  const totalCents = allocation === null ? 0n : centsOf(allocation.totalAllocableAmount);
  const buildingCents = allocation === null ? 0n : centsOf(allocation.buildingAmount);
  const basisCents = allocation === null || totalCents === 0n ? 0n : divideHalfUp((priceCents + costCents) * buildingCents, totalCents);
  const reason: BuildingCostReason | null =
    acquisition.status !== 'CONFIRMED'
      ? 'ACQUISITION_NOT_CONFIRMED'
      : allocation === null
        ? 'NO_ALLOCATION'
        : !policy.confirmedAllocationReviewStates.includes(allocation.reviewState)
          ? 'ALLOCATION_NOT_CONFIRMED'
          : buildingCents === 0n
            ? 'NO_BUILDING'
            : null;
  return {
    basisAmount: allocation === null ? null : moneyOfCents(basisCents),
    purchasePrice: acquisition.purchasePrice,
    acquisitionCosts: moneyOfCents(costCents),
    excludedCosts: [...excludedCents.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([category, cents]) => ({ category, amount: moneyOfCents(cents) })),
    allocation,
    reason,
  };
}

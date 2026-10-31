import { Money } from '../../shared/index.js';
import {
  buyerIncreases,
  structureViolations,
  type Acquisition,
  type ConfirmationOwnership,
  type ConfirmationViolation,
  type ExactFraction,
} from './acquisition.js';
import type { CostCategory } from './cost.js';

/**
 * Owner-level allocation (api-design.md §27.4, phase-2-plan P2-D10, data-model §61): the Acquisition split among its
 * own buyers by weight = acquired share / acquiredShare, the acquired share being the buyer's increase over the day
 * before the transfer date (§28.1A; the full share for a buyer who held nothing). Each amount (price, each cost category, land, building) is split into
 * cents separately by largest remainder, ties by `ownerPartyId`; totals are derived from the parts, never distributed
 * (F4b). Everything is exact: cents and fractions as bigint, no floating point.
 */

export type AllocationBasis = 'CONFIRMED' | 'PROVISIONAL';

export interface OwnerAllocationInput {
  readonly acquisition: Acquisition;
  /** The `VALID` Ownerships carrying the Acquisition's id. */
  readonly own: readonly ConfirmationOwnership[];
  /** The buyers' `VALID` Ownerships covering the transfer date (§28.1A). */
  readonly onTransferDate: readonly ConfirmationOwnership[];
  /** The buyers' `VALID` Ownerships covering the day before the transfer date (§28.1A). */
  readonly beforeTransferDate: readonly ConfirmationOwnership[];
  /** Sum of the `ACTIVE` costs' expected amounts per category; categories without costs absent. */
  readonly costs: ReadonlyMap<CostCategory, Money>;
  /** The current land/building allocation, or `null`. */
  readonly allocation: { readonly id: string; readonly landAmount: Money; readonly buildingAmount: Money } | null;
}

export interface OwnerPart {
  readonly ownerPartyId: string;
  readonly ownershipId: string;
  /** The share of the Ownership carrying the Acquisition. */
  readonly share: ExactFraction;
  /** `held_P(d − 1)`, `0/1` when none (§28.1A). */
  readonly shareBefore: ExactFraction;
  /** `held_P(d) − held_P(d − 1)`; the weight is derived from it. */
  readonly acquiredShare: ExactFraction;
  readonly weight: ExactFraction;
  readonly purchasePrice: Money;
  readonly costs: ReadonlyMap<CostCategory, Money>;
  readonly costsTotal: Money;
  readonly landAmount: Money | null;
  readonly buildingAmount: Money | null;
  readonly totalAllocableAmount: Money | null;
}

export interface AllocationTotals {
  readonly purchasePrice: Money;
  readonly costs: ReadonlyMap<CostCategory, Money>;
  readonly costsTotal: Money;
  readonly landAmount: Money | null;
  readonly buildingAmount: Money | null;
  readonly totalAllocableAmount: Money | null;
}

export type OwnerAllocationPlan =
  | {
      readonly kind: 'ALLOCATED';
      readonly basis: AllocationBasis;
      readonly allocationId: string | null;
      readonly owners: readonly OwnerPart[];
      readonly totals: AllocationTotals;
    }
  | { readonly kind: 'ACQUISITION_CANCELLED' }
  /**
   * Ownerships not meeting requirements 2–5 of §28.1 (5 as §28.1A): a `DRAFT` under way, or a `CONFIRMED` one confirmed
   * before migration 0050 under the full-share rule whose buyer already held a share (the legacy `1/1` workaround).
   */
  | { readonly kind: 'OWNERSHIP_BASIS_INCOMPLETE'; readonly violations: readonly ConfirmationViolation[] };

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));

function reduce(numerator: bigint, denominator: bigint): ExactFraction {
  const g = gcd(numerator, denominator);
  return { numerator: numerator / g, denominator: denominator / g };
}

/**
 * Splits `amount` cents by `weights` (summing to 1): `floor(amount × w)` each, the rest one cent each to the largest
 * fractional remainders, ties by key ascending. Parts are ≥ 0 and sum to `amount`; each is within one cent of `amount × w`.
 */
export function largestRemainder(amount: bigint, weights: readonly { readonly key: string; readonly weight: ExactFraction }[]): Map<string, bigint> {
  if (amount < 0n) throw new RangeError('largestRemainder: negative amount');
  const parts = weights.map(({ key, weight }) => {
    const exact = amount * weight.numerator;
    return { key, floor: exact / weight.denominator, remainder: exact % weight.denominator, denominator: weight.denominator };
  });
  let rest = amount - parts.reduce((sum, p) => sum + p.floor, 0n);
  const order = [...parts].sort((x, y) => {
    // remainder_x / den_x vs remainder_y / den_y, exactly.
    const left = x.remainder * y.denominator;
    const right = y.remainder * x.denominator;
    if (left !== right) return left > right ? -1 : 1;
    return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
  });
  const result = new Map(parts.map((p) => [p.key, p.floor]));
  for (const p of order) {
    if (rest === 0n) break;
    result.set(p.key, (result.get(p.key) ?? 0n) + 1n);
    rest -= 1n;
  }
  return result;
}

/** Money ↔ cents for the two-decimal EUR of Phase 2. */
export function toCents(money: Money): bigint {
  const [whole = '0', fraction = ''] = money.amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

export function fromCents(cents: bigint, currency: string): Money {
  return Money.of(`${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`, currency);
}

export function planOwnerAllocation(input: OwnerAllocationInput): OwnerAllocationPlan {
  const { acquisition } = input;
  if (acquisition.status === 'CANCELLED') return { kind: 'ACQUISITION_CANCELLED' };
  // The same structure check as confirmation (requirements 2–5), so PROVISIONAL means "would hold as confirmed". A
  // CONFIRMED one is checked too: one confirmed before 0050 may fail 5a/5b, and its weights would not sum to 1.
  const violations = structureViolations(acquisition, input.own, input.onTransferDate, input.beforeTransferDate);
  if (violations.length > 0) return { kind: 'OWNERSHIP_BASIS_INCOMPLETE', violations };
  const currency = acquisition.purchasePrice.currency;
  const acquired = { numerator: BigInt(acquisition.acquiredShare.numerator), denominator: BigInt(acquisition.acquiredShare.denominator) };
  // Requirements 2–5 hold: one Ownership per buyer, every increase > 0, and the increases sum to `acquiredShare`.
  const increases = new Map(buyerIncreases(acquisition, input.own, input.onTransferDate, input.beforeTransferDate).map((b) => [b.partyId, b]));
  const owners = [...input.own]
    .sort((x, y) => (x.ownerPartyId < y.ownerPartyId ? -1 : x.ownerPartyId > y.ownerPartyId ? 1 : 0))
    .map((o) => {
      const share = { numerator: BigInt(o.share.numerator), denominator: BigInt(o.share.denominator) };
      const { shareBefore, acquired: bought } = increases.get(o.ownerPartyId) as { shareBefore: ExactFraction; acquired: ExactFraction };
      return { o, share, shareBefore, bought, weight: reduce(bought.numerator * acquired.denominator, bought.denominator * acquired.numerator) };
    });
  const weights = owners.map(({ o, weight }) => ({ key: o.ownerPartyId, weight }));
  const split = (amount: Money) => largestRemainder(toCents(amount), weights);

  const price = split(acquisition.purchasePrice);
  const categories = [...input.costs.keys()].sort();
  const costParts = new Map(categories.map((category) => [category, split(input.costs.get(category) as Money)]));
  const land = input.allocation === null ? null : split(input.allocation.landAmount);
  const building = input.allocation === null ? null : split(input.allocation.buildingAmount);

  const parts: OwnerPart[] = owners.map(({ o, share, shareBefore, bought, weight }) => {
    const key = o.ownerPartyId;
    const costs = new Map(categories.map((category) => [category, costParts.get(category)?.get(key) ?? 0n]));
    const costsTotal = [...costs.values()].reduce((sum, c) => sum + c, 0n);
    const landCents = land?.get(key) ?? null;
    const buildingCents = building?.get(key) ?? null;
    return {
      ownerPartyId: key,
      ownershipId: o.id,
      share: reduce(share.numerator, share.denominator),
      shareBefore,
      acquiredShare: bought,
      weight,
      purchasePrice: fromCents(price.get(key) ?? 0n, currency),
      costs: new Map([...costs].map(([category, cents]) => [category, fromCents(cents, currency)])),
      costsTotal: fromCents(costsTotal, currency),
      landAmount: landCents === null ? null : fromCents(landCents, currency),
      buildingAmount: buildingCents === null ? null : fromCents(buildingCents, currency),
      // Derived, never distributed (F4b).
      totalAllocableAmount: landCents === null || buildingCents === null ? null : fromCents(landCents + buildingCents, currency),
    };
  });

  const costsTotal = categories.reduce((sum, category) => sum + toCents(input.costs.get(category) as Money), 0n);
  const a = input.allocation;
  return {
    kind: 'ALLOCATED',
    basis: acquisition.status === 'CONFIRMED' ? 'CONFIRMED' : 'PROVISIONAL',
    allocationId: a?.id ?? null,
    owners: parts,
    totals: {
      purchasePrice: acquisition.purchasePrice,
      costs: new Map(categories.map((category) => [category, input.costs.get(category) as Money])),
      costsTotal: fromCents(costsTotal, currency),
      landAmount: a?.landAmount ?? null,
      buildingAmount: a?.buildingAmount ?? null,
      totalAllocableAmount: a === null ? null : a.landAmount.add(a.buildingAmount),
    },
  };
}

/** Persistence port: the inputs of one read, in one snapshot; `undefined` for an unknown or foreign Acquisition. */
export interface OwnerAllocationSource {
  read(acquisitionId: string, mreRealmId: string): Promise<OwnerAllocationInput | undefined>;
}

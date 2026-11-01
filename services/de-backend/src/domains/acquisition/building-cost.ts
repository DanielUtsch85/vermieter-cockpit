import { centsOf, divideHalfUp, moneyOfCents, type Money } from '../../shared/index.js';
import { COST_CATEGORIES } from './cost.js';

/**
 * The building's acquisition cost of one Acquisition (api-design.md §58B, §59A, §59D; P8-D2, P8-D3, B5): (price + the
 * amounts in the basis) × `buildingAmount` / `totalAllocableAmount` of the current allocation, rounded half-up to the
 * cent once. Land never enters. Extracted unchanged from Taxation's anschaffungsnahe check by VC-8-02, so the 15 %
 * check and the AfA schedule compute one basis; both reach it here, and neither imports the other.
 *
 * §59D (VC-X-42; tax review of 2026-11-01, questions 10 and 24, mündlich bestätigt durch den Steuerberater, laut
 * Projektinhaber am 2026-11-01): each `ACTIVE` cost is in the basis, excluded or unclassified, by its category and its
 * current classification under the rule's `costClassification`. An unclassified cost never enters `basisAmount`; it is
 * added only to the upper bound `basisAmountWithUnclassified`, and it stops the basis (`ACQUISITION_COST_UNCLASSIFIED`).
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

/** A cost's current classification (§59D) as the basis reads it: its parts and review state. */
export interface BasisCostClassification {
  readonly id: string;
  readonly reviewState: string;
  readonly parts: readonly { readonly purpose: string; readonly amount: Money }[];
}

export interface BasisCost {
  readonly id: string;
  readonly category: string;
  readonly amount: Money;
  /** The current classification, `null` without one. */
  readonly classification: BasisCostClassification | null;
}

/**
 * The rule's `costClassification` (§59D "The rules"), in `DE_AFA_BUILDING_LINEAR@1`/`@2` (`basis.costClassification`) and
 * `DE_ANSCHAFFUNGSNAHE@1` (`costClassification`), equal in both (a registry test).
 */
export interface CostClassificationParameters {
  /** The categories that enter only by a confirmed classification. */
  readonly requiredFor: readonly string[];
  /** The purposes whose parts enter the basis. */
  readonly basisPurposes: readonly string[];
  /** The review states in which a classification decides; any other holds its cost as unclassified. */
  readonly confirmedReviewStates: readonly string[];
  readonly legalBasis: string;
  readonly source: string;
}

/** What the caller's rule decides; never a constant here (AGENTS.md §16). */
export interface BasisPolicy {
  /** Cost categories that are not acquisition cost (`FINANCING_RELATED`, taxation.md §6, A6). */
  readonly excludedCostCategories: readonly string[];
  /** The allocation review states that feed a figure (data-model §15). */
  readonly confirmedAllocationReviewStates: readonly string[];
  /** §59D: which costs need a classification and which purposes enter. */
  readonly costClassification: Pick<CostClassificationParameters, 'requiredFor' | 'basisPurposes' | 'confirmedReviewStates'>;
}

/**
 * The policy of a caller without a rule (a registry without the version): every category needs a classification and none
 * decides, so every cost not excluded is unclassified. Never a figure without a rule.
 */
export const NO_RULE_COST_CLASSIFICATION: BasisPolicy['costClassification'] = { requiredFor: COST_CATEGORIES, basisPurposes: [], confirmedReviewStates: [] };

/** Why the basis does not feed a figure, the first that applies (§59A, as the check reported them; §59D). */
export const BUILDING_COST_REASONS = [
  'ACQUISITION_NOT_CONFIRMED',
  'NO_ALLOCATION',
  'ALLOCATION_NOT_CONFIRMED',
  'NO_BUILDING',
  'ACQUISITION_COST_UNCLASSIFIED',
] as const;
export type BuildingCostReason = (typeof BUILDING_COST_REASONS)[number];

/** A cost as the basis treats it (§59D): its amount in the basis, excluded, or unclassified (the whole amount). */
export interface BasisCostTreatment {
  readonly costId: string;
  readonly category: string;
  /** The classification that decided it, `null` when the category did (or nothing did: unclassified). */
  readonly classificationId: string | null;
  readonly inBasis: Money;
  readonly excluded: Money;
  readonly unclassified: boolean;
}

export interface UnclassifiedCost {
  readonly costId: string;
  readonly category: string;
  readonly amount: Money;
  /** The current classification's review state, `null` without one. */
  readonly classificationReviewState: string | null;
}

export interface BuildingAcquisitionCost {
  /** `null` without an allocation; 0.00 when the allocation's total is 0.00. Shown even with a reason. Never with unclassified costs. */
  readonly basisAmount: Money | null;
  /** §59D: the same formula with the unclassified amounts added (the upper bound); equal to `basisAmount` without any. */
  readonly basisAmountWithUnclassified: Money | null;
  readonly purchasePrice: Money;
  /** The amounts in the basis. */
  readonly acquisitionCosts: Money;
  /** The excluded amounts, summed by category and purpose (`null` for an excluded category). */
  readonly excludedCosts: readonly { readonly category: string; readonly purpose: string | null; readonly amount: Money }[];
  /** §59D: the costs that are unclassified, in the order given. */
  readonly unclassifiedCosts: readonly UnclassifiedCost[];
  /** §59D: every cost as treated, in the order given (the recorded versions' inputs). */
  readonly costs: readonly BasisCostTreatment[];
  readonly allocation: BasisAllocation | null;
  readonly reason: BuildingCostReason | null;
}

/** A cost's treatment under the policy (§59D "The basis function"). */
export function treatCost(
  cost: BasisCost,
  policy: BasisPolicy,
): BasisCostTreatment & { readonly excludedParts: readonly { purpose: string | null; cents: bigint }[] } {
  const zero = moneyOfCents(0n);
  const whole = { costId: cost.id, category: cost.category };
  // An excluded category first: never in a basis, whatever its classification (question 24).
  if (policy.excludedCostCategories.includes(cost.category)) {
    return {
      ...whole,
      classificationId: null,
      inBasis: zero,
      excluded: cost.amount,
      unclassified: false,
      excludedParts: [{ purpose: null, cents: centsOf(cost.amount) }],
    };
  }
  const c = cost.classification;
  const rules = policy.costClassification;
  if (c === null) {
    if (rules.requiredFor.includes(cost.category)) {
      return { ...whole, classificationId: null, inBasis: zero, excluded: zero, unclassified: true, excludedParts: [] };
    }
    return { ...whole, classificationId: null, inBasis: cost.amount, excluded: zero, unclassified: false, excludedParts: [] };
  }
  // A classification that is not confirmed: a person has said that its purpose is in question, whatever the category.
  if (!rules.confirmedReviewStates.includes(c.reviewState)) {
    return { ...whole, classificationId: c.id, inBasis: zero, excluded: zero, unclassified: true, excludedParts: [] };
  }
  let inCents = 0n;
  const excludedParts: { purpose: string | null; cents: bigint }[] = [];
  for (const p of c.parts) {
    if (rules.basisPurposes.includes(p.purpose)) inCents += centsOf(p.amount);
    else excludedParts.push({ purpose: p.purpose, cents: centsOf(p.amount) });
  }
  const excludedCents = excludedParts.reduce((s, p) => s + p.cents, 0n);
  return { ...whole, classificationId: c.id, inBasis: moneyOfCents(inCents), excluded: moneyOfCents(excludedCents), unclassified: false, excludedParts };
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildingAcquisitionCost(
  input: { readonly acquisition: BasisAcquisition; readonly costs: readonly BasisCost[]; readonly allocation: BasisAllocation | null },
  policy: BasisPolicy,
): BuildingAcquisitionCost {
  const { acquisition, allocation } = input;
  const treated = input.costs.map((c) => ({ cost: c, t: treatCost(c, policy) }));
  const costCents = treated.reduce((total, { t }) => total + centsOf(t.inBasis), 0n);
  const unclassifiedCents = treated.filter(({ t }) => t.unclassified).reduce((total, { cost }) => total + centsOf(cost.amount), 0n);
  const excludedCents = new Map<string, { category: string; purpose: string | null; cents: bigint }>();
  for (const { t } of treated) {
    for (const p of t.excludedParts) {
      const key = `${t.category}|${p.purpose ?? ''}`;
      const found = excludedCents.get(key);
      excludedCents.set(key, { category: t.category, purpose: p.purpose, cents: (found?.cents ?? 0n) + p.cents });
    }
  }
  const priceCents = centsOf(acquisition.purchasePrice);
  const totalCents = allocation === null ? 0n : centsOf(allocation.totalAllocableAmount);
  const buildingCents = allocation === null ? 0n : centsOf(allocation.buildingAmount);
  // Each bound rounded half-up once, from its own exact product.
  const bound = (cents: bigint) => (allocation === null || totalCents === 0n ? 0n : divideHalfUp((priceCents + cents) * buildingCents, totalCents));
  const unclassifiedCosts = treated
    .filter(({ t }) => t.unclassified)
    .map(({ cost }) => ({
      costId: cost.id,
      category: cost.category,
      amount: cost.amount,
      classificationReviewState: cost.classification?.reviewState ?? null,
    }));
  const reason: BuildingCostReason | null =
    acquisition.status !== 'CONFIRMED'
      ? 'ACQUISITION_NOT_CONFIRMED'
      : allocation === null
        ? 'NO_ALLOCATION'
        : !policy.confirmedAllocationReviewStates.includes(allocation.reviewState)
          ? 'ALLOCATION_NOT_CONFIRMED'
          : buildingCents === 0n
            ? 'NO_BUILDING'
            : unclassifiedCosts.length > 0
              ? 'ACQUISITION_COST_UNCLASSIFIED'
              : null;
  return {
    basisAmount: allocation === null ? null : moneyOfCents(bound(costCents)),
    basisAmountWithUnclassified: allocation === null ? null : moneyOfCents(bound(costCents + unclassifiedCents)),
    purchasePrice: acquisition.purchasePrice,
    acquisitionCosts: moneyOfCents(costCents),
    excludedCosts: [...excludedCents.values()]
      .sort((a, b) => byText(a.category, b.category) || byText(a.purpose ?? '', b.purpose ?? ''))
      .map((e) => ({ category: e.category, purpose: e.purpose, amount: moneyOfCents(e.cents) })),
    unclassifiedCosts,
    costs: treated.map(({ t }) => ({
      costId: t.costId,
      category: t.category,
      classificationId: t.classificationId,
      inBasis: t.inBasis,
      excluded: t.excluded,
      unclassified: t.unclassified,
    })),
    allocation,
    reason,
  };
}

/** The details of a basis reason (§59D: `ACQUISITION_COST_UNCLASSIFIED` names the costs, sorted); `{}` for the others. */
export function buildingCostReasonDetails(cost: BuildingAcquisitionCost): Readonly<Record<string, unknown>> {
  return cost.reason === 'ACQUISITION_COST_UNCLASSIFIED' ? { costIds: cost.unclassifiedCosts.map((c) => c.costId).sort(byText) } : {};
}

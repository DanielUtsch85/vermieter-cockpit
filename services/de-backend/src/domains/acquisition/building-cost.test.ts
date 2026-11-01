import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import {
  BUILDING_COST_REASONS,
  NO_RULE_COST_CLASSIFICATION,
  buildingAcquisitionCost,
  buildingCostReasonDetails,
  type BasisAllocation,
  type BasisCost,
  type BasisPolicy,
} from './building-cost.js';

/**
 * The building's acquisition cost (api-design.md §58B, §59A, §59D; P8-D2, B5), extracted from the anschaffungsnahe check
 * by VC-8-02: rounded half-up once, land never in it, the excluded categories and the classification policy parameters.
 * The check's own tests stay where they are. Figures are synthetic (ACC8's purchase).
 */
const eur = (amount: string) => Money.of(amount, 'EUR');
const policy: BasisPolicy = {
  excludedCostCategories: ['FINANCING_RELATED'],
  confirmedAllocationReviewStates: ['CONFIRMED', 'ADVISOR_CONFIRMED'],
  costClassification: {
    requiredFor: ['NOTARY', 'LAND_REGISTRY', 'OTHER'],
    basisPurposes: ['OWNERSHIP_TRANSFER'],
    confirmedReviewStates: ['CONFIRMED', 'ADVISOR_CONFIRMED'],
  },
};
const allocation = (overrides: Partial<BasisAllocation> = {}): BasisAllocation => ({
  id: '0000bbbb-0000-4000-8000-000000000030',
  reviewState: 'CONFIRMED',
  totalAllocableAmount: eur('318000.00'),
  buildingAmount: eur('254400.00'),
  ...overrides,
});
const id = (n: number) => `0000cccc-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const classified = (n: number, parts: readonly (readonly [string, string])[], reviewState = 'CONFIRMED') => ({
  id: id(n + 50),
  reviewState,
  parts: parts.map(([purpose, amount]) => ({ purpose, amount: eur(amount) })),
});
const cost = (n: number, category: string, amount: string, classification: BasisCost['classification'] = null): BasisCost => ({
  id: id(n),
  category,
  amount: eur(amount),
  classification,
});
/** ACC8's costs, the notary and land registry costs confirmed as costs of the transfer (§59D). */
const costs = [
  cost(1, 'REAL_ESTATE_TRANSFER_TAX', '15000.00'),
  cost(2, 'NOTARY', '2000.00', classified(2, [['OWNERSHIP_TRANSFER', '2000.00']])),
  cost(3, 'LAND_REGISTRY', '1000.00', classified(3, [['OWNERSHIP_TRANSFER', '1000.00']])),
  cost(4, 'FINANCING_RELATED', '1200.00'),
  cost(5, 'FINANCING_RELATED', '300.00'),
];
const confirmed = { status: 'CONFIRMED', purchasePrice: eur('300000.00') };
const whole = allocation({ buildingAmount: eur('318000.00') });
const basisOf = (list: readonly BasisCost[], p: BasisPolicy = policy, alloc: BasisAllocation | null = whole) =>
  buildingAcquisitionCost({ acquisition: confirmed, costs: list, allocation: alloc }, p);

describe('buildingAcquisitionCost (§59A "The basis of a component")', () => {
  it('ACC8: (300,000.00 + 18,000.00) × 254,400.00 / 318,000.00 = 254,400.00; land out, FINANCING_RELATED out and shown summed', () => {
    const c = buildingAcquisitionCost({ acquisition: confirmed, costs, allocation: allocation() }, policy);
    expect(c.basisAmount?.amount).toBe('254400.00');
    expect(c.basisAmountWithUnclassified?.amount).toBe('254400.00');
    expect(c.purchasePrice.amount).toBe('300000.00');
    expect(c.acquisitionCosts.amount).toBe('18000.00');
    expect(c.excludedCosts.map((e) => [e.category, e.purpose, e.amount.amount])).toEqual([['FINANCING_RELATED', null, '1500.00']]);
    expect(c.unclassifiedCosts).toEqual([]);
    expect(c.reason).toBeNull();
  });

  it('the total is price + costs: a building of the whole allocation gives price + the counted costs', () => {
    expect(basisOf(costs).basisAmount?.amount).toBe('318000.00');
  });

  it('any excluded category passed in is left out (the rule decides, never a constant)', () => {
    const c = basisOf(costs, { ...policy, excludedCostCategories: ['FINANCING_RELATED', 'NOTARY'] });
    expect([c.basisAmount?.amount, c.acquisitionCosts.amount]).toEqual(['316000.00', '16000.00']);
    expect(c.excludedCosts.map((e) => [e.category, e.purpose, e.amount.amount])).toEqual([
      ['FINANCING_RELATED', null, '1500.00'],
      ['NOTARY', null, '2000.00'],
    ]);
    expect(basisOf(costs, { ...policy, excludedCostCategories: [] }).basisAmount?.amount).toBe('319500.00');
  });

  it('rounded half-up to the cent once: 0.05 × 1/2 = 0.025 → 0.03 (half-even would give 0.02), 0.01 × 1/2 → 0.01', () => {
    const half = allocation({ totalAllocableAmount: eur('2.00'), buildingAmount: eur('1.00') });
    const price = (amount: string) =>
      buildingAcquisitionCost({ acquisition: { ...confirmed, purchasePrice: eur(amount) }, costs: [], allocation: half }, policy).basisAmount?.amount;
    expect([price('0.05'), price('0.01'), price('0.03')]).toEqual(['0.03', '0.01', '0.02']);
  });

  it('each reason alone and the first that applies: ACQUISITION_NOT_CONFIRMED, NO_ALLOCATION, ALLOCATION_NOT_CONFIRMED, NO_BUILDING, ACQUISITION_COST_UNCLASSIFIED', () => {
    expect(BUILDING_COST_REASONS).toEqual([
      'ACQUISITION_NOT_CONFIRMED',
      'NO_ALLOCATION',
      'ALLOCATION_NOT_CONFIRMED',
      'NO_BUILDING',
      'ACQUISITION_COST_UNCLASSIFIED',
    ]);
    const open = [...costs, cost(6, 'OTHER', '100.00')];
    const reason = (status: string, alloc: BasisAllocation | null, list = costs) =>
      buildingAcquisitionCost({ acquisition: { ...confirmed, status }, costs: list, allocation: alloc }, policy).reason;
    expect(reason('DRAFT', allocation())).toBe('ACQUISITION_NOT_CONFIRMED');
    expect(reason('CANCELLED', allocation())).toBe('ACQUISITION_NOT_CONFIRMED');
    expect(reason('CONFIRMED', null)).toBe('NO_ALLOCATION');
    expect(reason('CONFIRMED', allocation({ reviewState: 'UNREVIEWED' }))).toBe('ALLOCATION_NOT_CONFIRMED');
    expect(reason('CONFIRMED', allocation({ reviewState: 'NEEDS_REVIEW' }))).toBe('ALLOCATION_NOT_CONFIRMED');
    expect(reason('CONFIRMED', allocation({ reviewState: 'ADVISOR_CONFIRMED' }))).toBeNull();
    expect(reason('CONFIRMED', allocation({ buildingAmount: eur('0.00') }))).toBe('NO_BUILDING');
    expect(reason('CONFIRMED', allocation(), open)).toBe('ACQUISITION_COST_UNCLASSIFIED');
    // In order: a DRAFT without an allocation is ACQUISITION_NOT_CONFIRMED; an unconfirmed allocation of land only too;
    // §59D's reason comes after NO_BUILDING and the others.
    expect(reason('DRAFT', null)).toBe('ACQUISITION_NOT_CONFIRMED');
    expect(reason('CONFIRMED', allocation({ reviewState: 'UNREVIEWED', buildingAmount: eur('0.00') }))).toBe('ALLOCATION_NOT_CONFIRMED');
    expect(reason('DRAFT', allocation(), open)).toBe('ACQUISITION_NOT_CONFIRMED');
    expect(reason('CONFIRMED', null, open)).toBe('NO_ALLOCATION');
    expect(reason('CONFIRMED', allocation({ reviewState: 'UNREVIEWED' }), open)).toBe('ALLOCATION_NOT_CONFIRMED');
    expect(reason('CONFIRMED', allocation({ buildingAmount: eur('0.00') }), open)).toBe('NO_BUILDING');
  });

  it('the basis is shown with a reason (what confirming would give); without an allocation it is null; a total of 0.00 gives 0.00', () => {
    expect(buildingAcquisitionCost({ acquisition: confirmed, costs, allocation: allocation({ reviewState: 'UNREVIEWED' }) }, policy).basisAmount?.amount).toBe(
      '254400.00',
    );
    const none = buildingAcquisitionCost({ acquisition: confirmed, costs, allocation: null }, policy);
    expect([none.basisAmount, none.basisAmountWithUnclassified]).toEqual([null, null]);
    const zero = buildingAcquisitionCost(
      { acquisition: confirmed, costs, allocation: allocation({ totalAllocableAmount: eur('0.00'), buildingAmount: eur('0.00') }) },
      policy,
    );
    expect([zero.basisAmount?.amount, zero.reason]).toEqual(['0.00', 'NO_BUILDING']);
  });
});

describe('buildingAcquisitionCost: costs in the basis only when classified (§59D)', () => {
  const transfer = (n: number, amount: string, state = 'CONFIRMED') => classified(n, [['OWNERSHIP_TRANSFER', amount]], state);
  const one = (c: BasisCost) => {
    const b = basisOf([c]);
    return {
      inBasis: b.acquisitionCosts.amount,
      excluded: b.excludedCosts.map((e) => [e.category, e.purpose, e.amount.amount]),
      unclassified: b.unclassifiedCosts.map((u) => u.costId),
    };
  };

  it('the table: REAL_ESTATE_TRANSFER_TAX and BROKER by category; NOTARY, LAND_REGISTRY, OTHER unclassified without one; FINANCING_RELATED excluded', () => {
    for (const category of ['REAL_ESTATE_TRANSFER_TAX', 'BROKER'])
      expect(one(cost(1, category, '500.00'))).toEqual({ inBasis: '500.00', excluded: [], unclassified: [] });
    for (const category of ['NOTARY', 'LAND_REGISTRY', 'OTHER'])
      expect(one(cost(1, category, '500.00'))).toEqual({ inBasis: '0.00', excluded: [], unclassified: [id(1)] });
    expect(one(cost(1, 'FINANCING_RELATED', '500.00'))).toEqual({ inBasis: '0.00', excluded: [['FINANCING_RELATED', null, '500.00']], unclassified: [] });
  });

  it('with a confirmed classification the classification decides, whatever the category (OWNERSHIP_TRANSFER in, the others out)', () => {
    for (const category of ['REAL_ESTATE_TRANSFER_TAX', 'BROKER', 'NOTARY', 'LAND_REGISTRY', 'OTHER']) {
      expect(one(cost(1, category, '500.00', transfer(1, '500.00')))).toEqual({ inBasis: '500.00', excluded: [], unclassified: [] });
      expect(one(cost(1, category, '500.00', transfer(1, '500.00', 'ADVISOR_CONFIRMED')))).toMatchObject({ inBasis: '500.00' });
      expect(one(cost(1, category, '500.00', classified(1, [['FINANCING', '500.00']])))).toEqual({
        inBasis: '0.00',
        excluded: [[category, 'FINANCING', '500.00']],
        unclassified: [],
      });
      expect(one(cost(1, category, '500.00', classified(1, [['NOT_ACQUISITION_COST', '500.00']])))).toEqual({
        inBasis: '0.00',
        excluded: [[category, 'NOT_ACQUISITION_COST', '500.00']],
        unclassified: [],
      });
    }
  });

  it('a FINANCING purpose on OTHER is excluded; a FINANCING_RELATED cost stays excluded whatever its classification (question 24)', () => {
    expect(one(cost(1, 'OTHER', '700.00', classified(1, [['FINANCING', '700.00']])))).toMatchObject({ inBasis: '0.00', unclassified: [] });
    for (const state of ['UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED']) {
      const c = cost(1, 'FINANCING_RELATED', '700.00', classified(1, [['FINANCING', '700.00']], state));
      expect(one(c)).toEqual({ inBasis: '0.00', excluded: [['FINANCING_RELATED', null, '700.00']], unclassified: [] });
      expect(basisOf([c]).basisAmountWithUnclassified?.amount).toBe('300000.00');
    }
  });

  it('a classification that is not confirmed holds the cost as unclassified, whatever its category (a BROKER cost too)', () => {
    for (const state of ['UNREVIEWED', 'NEEDS_REVIEW']) {
      for (const category of ['BROKER', 'REAL_ESTATE_TRANSFER_TAX', 'NOTARY', 'OTHER']) {
        const b = basisOf([cost(1, category, '500.00', transfer(1, '500.00', state))]);
        expect([b.acquisitionCosts.amount, b.reason]).toEqual(['0.00', 'ACQUISITION_COST_UNCLASSIFIED']);
        expect(b.unclassifiedCosts).toEqual([{ costId: id(1), category, amount: eur('500.00'), classificationReviewState: state }]);
      }
    }
    expect(basisOf([cost(1, 'OTHER', '500.00')]).unclassifiedCosts[0]?.classificationReviewState).toBeNull();
  });

  it('a two-part notary cost: the transfer part in, the land-charge part (FINANCING) out', () => {
    const notary = cost(
      1,
      'NOTARY',
      '2500.00',
      classified(1, [
        ['OWNERSHIP_TRANSFER', '1800.00'],
        ['FINANCING', '700.00'],
      ]),
    );
    const b = basisOf([notary]);
    expect([b.basisAmount?.amount, b.acquisitionCosts.amount, b.reason]).toEqual(['301800.00', '1800.00', null]);
    expect(b.excludedCosts.map((e) => [e.category, e.purpose, e.amount.amount])).toEqual([['NOTARY', 'FINANCING', '700.00']]);
    expect(b.costs).toEqual([
      { costId: id(1), category: 'NOTARY', classificationId: id(51), inBasis: eur('1800.00'), excluded: eur('700.00'), unclassified: false },
    ]);
  });

  it('both bounds (ACC8 before the classification): 252,000.00 without the 3,000.00 and 254,400.00 with them; the reason names the costs', () => {
    const open = [
      cost(1, 'REAL_ESTATE_TRANSFER_TAX', '15000.00'),
      cost(3, 'LAND_REGISTRY', '1000.00'),
      cost(2, 'NOTARY', '2000.00'),
      cost(4, 'FINANCING_RELATED', '1500.00'),
    ];
    const b = buildingAcquisitionCost({ acquisition: confirmed, costs: open, allocation: allocation() }, policy);
    expect([b.basisAmount?.amount, b.basisAmountWithUnclassified?.amount, b.acquisitionCosts.amount]).toEqual(['252000.00', '254400.00', '15000.00']);
    expect(b.unclassifiedCosts.map((u) => [u.costId, u.amount.amount])).toEqual([
      [id(3), '1000.00'],
      [id(2), '2000.00'],
    ]);
    expect([b.reason, buildingCostReasonDetails(b)]).toEqual(['ACQUISITION_COST_UNCLASSIFIED', { costIds: [id(2), id(3)] }]);
    expect(buildingCostReasonDetails(basisOf(costs))).toEqual({});
  });

  it('each bound rounded half-up once from its own product: price 0.03 + 0.01 unclassified over 1/2 gives 0.02 and 0.02 (never 0.02 + 0.01)', () => {
    const half = allocation({ totalAllocableAmount: eur('2.00'), buildingAmount: eur('1.00') });
    const bounds = (price: string, open: string) => {
      const b = buildingAcquisitionCost(
        { acquisition: { ...confirmed, purchasePrice: eur(price) }, costs: [cost(1, 'OTHER', open)], allocation: half },
        policy,
      );
      return [b.basisAmount?.amount, b.basisAmountWithUnclassified?.amount];
    };
    expect(bounds('0.03', '0.01')).toEqual(['0.02', '0.02']);
    expect(bounds('0.01', '0.01')).toEqual(['0.01', '0.01']);
    expect(bounds('0.04', '0.01')).toEqual(['0.02', '0.03']);
  });

  it('the policy is read from the parameter: another requiredFor, basisPurposes or confirmedReviewStates changes the result', () => {
    const broker = [cost(1, 'BROKER', '500.00'), cost(2, 'OTHER', '200.00', transfer(2, '200.00'))];
    expect(basisOf(broker).acquisitionCosts.amount).toBe('700.00');
    const stricter = basisOf(broker, { ...policy, costClassification: { ...policy.costClassification, requiredFor: ['BROKER', 'OTHER'] } });
    expect([stricter.acquisitionCosts.amount, stricter.unclassifiedCosts.map((u) => u.costId)]).toEqual(['200.00', [id(1)]]);
    const looser = basisOf([cost(1, 'OTHER', '200.00')], { ...policy, costClassification: { ...policy.costClassification, requiredFor: [] } });
    expect([looser.acquisitionCosts.amount, looser.reason]).toEqual(['200.00', null]);
    const noPurpose = basisOf(broker, { ...policy, costClassification: { ...policy.costClassification, basisPurposes: [] } });
    expect(noPurpose.acquisitionCosts.amount).toBe('500.00');
    const advisorOnly = basisOf(broker, { ...policy, costClassification: { ...policy.costClassification, confirmedReviewStates: ['ADVISOR_CONFIRMED'] } });
    expect(advisorOnly.unclassifiedCosts.map((u) => u.costId)).toEqual([id(2)]);
  });

  it('without a rule (NO_RULE_COST_CLASSIFICATION) every cost not excluded is unclassified: never a figure on a guess', () => {
    const b = basisOf(costs, { ...policy, costClassification: NO_RULE_COST_CLASSIFICATION });
    expect([b.acquisitionCosts.amount, b.reason, b.unclassifiedCosts.length]).toEqual(['0.00', 'ACQUISITION_COST_UNCLASSIFIED', 3]);
  });

  it('counter-check: no FINANCING part and no excluded category ever enters either bound, whatever the classification', () => {
    const list = [
      cost(
        1,
        'NOTARY',
        '1000.00',
        classified(1, [
          ['FINANCING', '400.00'],
          ['OWNERSHIP_TRANSFER', '600.00'],
        ]),
      ),
      cost(2, 'FINANCING_RELATED', '900.00', transfer(2, '900.00')),
      cost(3, 'OTHER', '50.00'),
    ];
    const b = basisOf(list);
    expect([b.basisAmount?.amount, b.basisAmountWithUnclassified?.amount]).toEqual(['300600.00', '300650.00']);
  });
});

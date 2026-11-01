import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { BUILDING_COST_REASONS, buildingAcquisitionCost, type BasisAllocation, type BasisPolicy } from './building-cost.js';

/**
 * The building's acquisition cost (api-design.md §58B, §59A; P8-D2, B5), extracted from the anschaffungsnahe check by
 * VC-8-02: rounded half-up once, land never in it, the excluded categories a parameter. The check's own tests stay
 * where they are, unchanged. Figures are synthetic (ACC8's purchase).
 */
const eur = (amount: string) => Money.of(amount, 'EUR');
const policy: BasisPolicy = { excludedCostCategories: ['FINANCING_RELATED'], confirmedAllocationReviewStates: ['CONFIRMED', 'ADVISOR_CONFIRMED'] };
const allocation = (overrides: Partial<BasisAllocation> = {}): BasisAllocation => ({
  id: '0000bbbb-0000-4000-8000-000000000030',
  reviewState: 'CONFIRMED',
  totalAllocableAmount: eur('318000.00'),
  buildingAmount: eur('254400.00'),
  ...overrides,
});
const costs = [
  { category: 'REAL_ESTATE_TRANSFER_TAX', amount: eur('15000.00') },
  { category: 'NOTARY', amount: eur('2000.00') },
  { category: 'LAND_REGISTRY', amount: eur('1000.00') },
  { category: 'FINANCING_RELATED', amount: eur('1200.00') },
  { category: 'FINANCING_RELATED', amount: eur('300.00') },
];
const confirmed = { status: 'CONFIRMED', purchasePrice: eur('300000.00') };

describe('buildingAcquisitionCost (§59A "The basis of a component")', () => {
  it('ACC8: (300,000.00 + 18,000.00) × 254,400.00 / 318,000.00 = 254,400.00; land out, FINANCING_RELATED out and shown summed', () => {
    const cost = buildingAcquisitionCost({ acquisition: confirmed, costs, allocation: allocation() }, policy);
    expect(cost.basisAmount?.amount).toBe('254400.00');
    expect(cost.purchasePrice.amount).toBe('300000.00');
    expect(cost.acquisitionCosts.amount).toBe('18000.00');
    expect(cost.excludedCosts.map((e) => [e.category, e.amount.amount])).toEqual([['FINANCING_RELATED', '1500.00']]);
    expect(cost.reason).toBeNull();
  });

  it('the total is price + costs: a building of the whole allocation gives price + the counted costs', () => {
    const cost = buildingAcquisitionCost({ acquisition: confirmed, costs, allocation: allocation({ buildingAmount: eur('318000.00') }) }, policy);
    expect(cost.basisAmount?.amount).toBe('318000.00');
  });

  it('any excluded category passed in is left out (the rule decides, never a constant)', () => {
    const cost = buildingAcquisitionCost(
      { acquisition: confirmed, costs, allocation: allocation({ buildingAmount: eur('318000.00') }) },
      { ...policy, excludedCostCategories: ['FINANCING_RELATED', 'NOTARY'] },
    );
    expect([cost.basisAmount?.amount, cost.acquisitionCosts.amount]).toEqual(['316000.00', '16000.00']);
    expect(cost.excludedCosts.map((e) => [e.category, e.amount.amount])).toEqual([
      ['FINANCING_RELATED', '1500.00'],
      ['NOTARY', '2000.00'],
    ]);
    const none = buildingAcquisitionCost(
      { acquisition: confirmed, costs, allocation: allocation({ buildingAmount: eur('318000.00') }) },
      { ...policy, excludedCostCategories: [] },
    );
    expect(none.basisAmount?.amount).toBe('319500.00');
  });

  it('rounded half-up to the cent once: 0.05 × 1/2 = 0.025 → 0.03 (half-even would give 0.02), 0.01 × 1/2 → 0.01', () => {
    const half = allocation({ totalAllocableAmount: eur('2.00'), buildingAmount: eur('1.00') });
    expect(
      buildingAcquisitionCost({ acquisition: { ...confirmed, purchasePrice: eur('0.05') }, costs: [], allocation: half }, policy).basisAmount?.amount,
    ).toBe('0.03');
    expect(
      buildingAcquisitionCost({ acquisition: { ...confirmed, purchasePrice: eur('0.01') }, costs: [], allocation: half }, policy).basisAmount?.amount,
    ).toBe('0.01');
    expect(
      buildingAcquisitionCost({ acquisition: { ...confirmed, purchasePrice: eur('0.03') }, costs: [], allocation: half }, policy).basisAmount?.amount,
    ).toBe('0.02');
  });

  it('each reason alone and the first that applies: ACQUISITION_NOT_CONFIRMED, NO_ALLOCATION, ALLOCATION_NOT_CONFIRMED, NO_BUILDING', () => {
    expect(BUILDING_COST_REASONS).toEqual(['ACQUISITION_NOT_CONFIRMED', 'NO_ALLOCATION', 'ALLOCATION_NOT_CONFIRMED', 'NO_BUILDING']);
    const reason = (status: string, alloc: BasisAllocation | null) =>
      buildingAcquisitionCost({ acquisition: { ...confirmed, status }, costs, allocation: alloc }, policy).reason;
    expect(reason('DRAFT', allocation())).toBe('ACQUISITION_NOT_CONFIRMED');
    expect(reason('CANCELLED', allocation())).toBe('ACQUISITION_NOT_CONFIRMED');
    expect(reason('CONFIRMED', null)).toBe('NO_ALLOCATION');
    expect(reason('CONFIRMED', allocation({ reviewState: 'UNREVIEWED' }))).toBe('ALLOCATION_NOT_CONFIRMED');
    expect(reason('CONFIRMED', allocation({ reviewState: 'NEEDS_REVIEW' }))).toBe('ALLOCATION_NOT_CONFIRMED');
    expect(reason('CONFIRMED', allocation({ reviewState: 'ADVISOR_CONFIRMED' }))).toBeNull();
    expect(reason('CONFIRMED', allocation({ buildingAmount: eur('0.00') }))).toBe('NO_BUILDING');
    // In order: a DRAFT without an allocation is ACQUISITION_NOT_CONFIRMED; an unconfirmed allocation of land only too.
    expect(reason('DRAFT', null)).toBe('ACQUISITION_NOT_CONFIRMED');
    expect(reason('CONFIRMED', allocation({ reviewState: 'UNREVIEWED', buildingAmount: eur('0.00') }))).toBe('ALLOCATION_NOT_CONFIRMED');
  });

  it('the basis is shown with a reason (what confirming would give); without an allocation it is null; a total of 0.00 gives 0.00', () => {
    expect(buildingAcquisitionCost({ acquisition: confirmed, costs, allocation: allocation({ reviewState: 'UNREVIEWED' }) }, policy).basisAmount?.amount).toBe(
      '254400.00',
    );
    expect(buildingAcquisitionCost({ acquisition: confirmed, costs, allocation: null }, policy).basisAmount).toBeNull();
    const zero = buildingAcquisitionCost(
      { acquisition: confirmed, costs, allocation: allocation({ totalAllocableAmount: eur('0.00'), buildingAmount: eur('0.00') }) },
      policy,
    );
    expect([zero.basisAmount?.amount, zero.reason]).toEqual(['0.00', 'NO_BUILDING']);
  });
});

import { describe, expect, it } from 'vitest';
import type { AllocationComparison } from '../acquisition/index.js';
import type { ScheduleAllocation } from './schedule-model.js';
import { acc8, acquisition, day, eur } from './schedule.test-support.js';
import { amount, codes, component, derive, yearOf } from './schedule-purchase.test-support.js';
import { INFORMATIVE_CODES, flagIsOpen, isOpen } from './schedule-review.js';

/**
 * §58T (VC-X-44) in §59A's purchase component: the current allocation's plausibility flags as raised, the level by the
 * details (`closedBy`), the years `PROVISIONAL` while the deviation is open, the review counts, the rule never named in
 * `ruleVersions`, and every figure unchanged (a seeded property test). ACC8's purchase (synthetic): total 318,000.00,
 * land 63,600.00 (aL = 0.2000), building 254,400.00; the comparison 127,200.00 / 190,800.00 (cL = 0.4000, +0.2000).
 */
const COMPARISON: AllocationComparison = {
  method: 'BMF_TOOL',
  landValue: eur('127200.00'),
  buildingValue: eur('190800.00'),
  sourceReferences: ['BMF-Arbeitshilfe (synthetisch)'],
};
const REASON = 'Bodenwert laut Vertrag gemindert (synthetisch)';
const base = acquisition().allocation as ScheduleAllocation;
const withAllocation = (over: Partial<ScheduleAllocation>, plausibility: Partial<NonNullable<ScheduleAllocation['plausibility']>> = {}) =>
  acc8({
    acquisitions: [
      acquisition({
        allocation: {
          ...base,
          ...over,
          plausibility: { landAmount: eur('63600.00'), effectiveDate: day('2026-07-01'), comparison: COMPARISON, deviationReason: null, ...plausibility },
        },
      }),
    ],
  });
const statuses = (s: ReturnType<typeof derive>) => [2026, 2027].map((y) => yearOf(component(s), y).calculationStatus);

describe('the plausibility flags in the schedule (§58T, §59A)', () => {
  it('open without a reason: the flag on the component, both years PROVISIONAL, counted open; the figures as without it', () => {
    const s = derive(withAllocation({}));
    const c = component(s);
    expect(codes(c.flags)).toEqual(['ALLOCATION_DEVIATES_FROM_COMPARISON']);
    expect(c.flags[0]?.details).toMatchObject({ deviation: '0.2000', closedBy: null, direction: 'LAND_SHARE_LOWER' });
    expect(statuses(s)).toEqual(['PROVISIONAL', 'PROVISIONAL']);
    expect(s.years.map((y) => y.calculationStatus)).toEqual(['PROVISIONAL', 'PROVISIONAL']);
    expect(s.review.open).toEqual([{ code: 'ALLOCATION_DEVIATES_FROM_COMPARISON', count: 1 }]);
    expect([amount(c.basis.amount), amount(yearOf(c, 2026).amount), amount(yearOf(c, 2027).amount)]).toEqual(['254400.00', '2544.00', '5088.00']);
    expect(s.ruleVersions.map((r) => r.ruleCode)).not.toContain('DE_LAND_BUILDING_PLAUSIBILITY');
  });

  it('with a reason (closedBy DEVIATION_REASON) or ADVISOR_CONFIRMED without one (question 5): CALCULATED, counted informative', () => {
    for (const [over, plausibility, closedBy] of [
      [{}, { deviationReason: REASON }, 'DEVIATION_REASON'],
      [{ reviewState: 'ADVISOR_CONFIRMED' }, {}, 'ADVISOR_CONFIRMED'],
    ] as const) {
      const s = derive(withAllocation(over, plausibility));
      expect(component(s).flags[0]?.details['closedBy']).toBe(closedBy);
      expect(statuses(s)).toEqual(['CALCULATED', 'CALCULATED']);
      expect(s.review).toEqual({ open: [], info: [{ code: 'ALLOCATION_DEVIATES_FROM_COMPARISON', count: 1 }] });
    }
  });

  it('a contract split without a comparison: the informative hint, CALCULATED; a BMF_TOOL split without one carries nothing', () => {
    const hint = derive(withAllocation({}, { comparison: null }));
    expect(component(hint).flags).toEqual([{ code: 'ALLOCATION_PLAUSIBILITY_NOT_CHECKED', details: { allocationId: base.id, method: 'PURCHASE_CONTRACT' } }]);
    expect(statuses(hint)).toEqual(['CALCULATED', 'CALCULATED']);
    expect(hint.review).toEqual({ open: [], info: [{ code: 'ALLOCATION_PLAUSIBILITY_NOT_CHECKED', count: 1 }] });
    expect(component(derive(withAllocation({ method: 'BMF_TOOL' }, { comparison: null }))).flags).toEqual([]);
  });

  it('E2′: a replacement with the reason but UNREVIEWED is NOT_CALCULABLE with ALLOCATION_NOT_CONFIRMED; the flag still shown, informative', () => {
    const s = derive(withAllocation({ reviewState: 'UNREVIEWED' }, { deviationReason: REASON }));
    const c = component(s);
    expect(codes(c.reasons)).toContain('ALLOCATION_NOT_CONFIRMED');
    expect(c.flags[0]?.details).toMatchObject({ closedBy: 'DEVIATION_REASON', reviewState: 'UNREVIEWED' });
    expect(statuses(s)).toEqual(['NOT_CALCULABLE', 'NOT_CALCULABLE']);
    expect(amount(yearOf(c, 2026).amount)).toBeNull();
    expect(statuses(s)).not.toContain('CALCULATED');
  });

  it('by code the deviation is open and the hint informative: a merged flag (details replaced) never closes the deviation', () => {
    // A recorded version judges a code without raised sources by code (version-record.ts): it must count as open.
    expect([isOpen('ALLOCATION_DEVIATES_FROM_COMPARISON'), INFORMATIVE_CODES.includes('ALLOCATION_DEVIATES_FROM_COMPARISON')]).toEqual([true, false]);
    expect(isOpen('ALLOCATION_PLAUSIBILITY_NOT_CHECKED')).toBe(false);
    // As raised, the details decide; with the details of a merged flag it is open.
    expect(flagIsOpen({ code: 'ALLOCATION_DEVIATES_FROM_COMPARISON', details: { closedBy: 'DEVIATION_REASON' } })).toBe(false);
    expect(flagIsOpen({ code: 'ALLOCATION_DEVIATES_FROM_COMPARISON', details: { componentIds: ['x'] } })).toBe(true);
  });

  it('a fixture without the plausibility read (as before §58T) raises nothing', () => {
    expect(component(derive(acc8())).flags).toEqual([]);
  });

  it('a seeded property test: every figure is byte-identical with and without a comparison, a reason or a review state change', () => {
    let seed = 0x44a11;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const text = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    const figures = (s: ReturnType<typeof derive>) =>
      JSON.stringify([
        s.components.map((c) => [c.basis.amount, c.years.map((y) => [y.year, y.amount, y.cumulative, y.residualValue, y.owners.map((o) => o.amount)])]),
        s.years.map((y) => [y.year, y.amount, y.residualValue]),
      ]);
    for (let i = 0; i < 60; i++) {
      const total = 100_000_00 + next(400_000_00);
      const land = next(total);
      const allocation = (plausibility: ScheduleAllocation['plausibility']) =>
        acc8({
          acquisitions: [
            acquisition({
              allocation: {
                ...base,
                totalAllocableAmount: eur(text(total)),
                buildingAmount: eur(text(total - land)),
                ...(plausibility ? { plausibility } : {}),
              },
            }),
          ],
          to: 2030,
        });
      const without = figures(derive(allocation(undefined)));
      const comparison: AllocationComparison = {
        ...COMPARISON,
        landValue: eur(text(next(300_000_00))),
        buildingValue: eur(text(1 + next(300_000_00))),
      };
      for (const deviationReason of [null, REASON]) {
        const s = derive(allocation({ landAmount: eur(text(land)), effectiveDate: day('2026-07-01'), comparison, deviationReason }));
        expect(figures(s), `case ${i}`).toBe(without);
      }
    }
  });
});

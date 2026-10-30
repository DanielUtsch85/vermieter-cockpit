import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { derivePlan, financialYearOf, inFinancialYear, planFor, proposeHausgeld, type PlanComponents, type PlanFigures } from './economic-plan.js';

/** The Wirtschaftsplan and the Hausgeld proposal (api-design.md §49.5–§49.6). Figures are invented. */
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;

const figures = (overrides: Partial<PlanFigures> = {}): PlanFigures => ({
  monthlyHausgeld: eur('300.00'),
  monthlyReserveContribution: eur('60.00'),
  recoverableCosts: eur('2400.00'),
  nonRecoverableCosts: eur('1200.00'),
  income: null,
  annualReserveContribution: null,
  costLines: [],
  ...overrides,
});
const json = (c: PlanComponents) => ({ recoverable: c.recoverable.amount, nonRecoverable: c.nonRecoverable.amount, reserve: c.reserve.amount });

describe('derivePlan', () => {
  it('splits the Hausgeld by the ratio of the groups; the rest is non-recoverable, so both sum to it exactly', () => {
    expect(json(derivePlan(figures()).components)).toEqual({ recoverable: '200.00', nonRecoverable: '100.00', reserve: '60.00' });
    // 100.00 × 1/3 = 33.333… → 33.33; the rest 66.67.
    const third = derivePlan(figures({ monthlyHausgeld: eur('100.00'), recoverableCosts: eur('1.00'), nonRecoverableCosts: eur('2.00') }));
    expect(json(third.components)).toEqual({ recoverable: '33.33', nonRecoverable: '66.67', reserve: '60.00' });
    // Half-up: 0.05 × 1/2 = 0.025 → 0.03.
    expect(
      json(derivePlan(figures({ monthlyHausgeld: eur('0.05'), recoverableCosts: eur('1.00'), nonRecoverableCosts: eur('1.00') })).components).recoverable,
    ).toBe('0.03');
  });

  it('NO_COST_GROUPS: without groups nothing is claimed recoverable', () => {
    const plan = derivePlan(figures({ recoverableCosts: eur('0'), nonRecoverableCosts: eur('0') }));
    expect(json(plan.components)).toEqual({ recoverable: '0.00', nonRecoverable: '300.00', reserve: '60.00' });
    expect(plan.flags.map((f) => f.code)).toContain('NO_COST_GROUPS');
    expect(
      derivePlan(figures({ monthlyHausgeld: eur('0'), recoverableCosts: eur('0'), nonRecoverableCosts: eur('0') })).flags.map((f) => f.code),
    ).not.toContain('NO_COST_GROUPS');
  });

  it('LINES_DIFFER_FROM_GROUPS per group, only with cost lines', () => {
    const line = (group: 'RECOVERABLE' | 'NON_RECOVERABLE', unitShare: string, position: number) => ({
      position,
      description: 'x',
      allocationKey: 'Miteigentumsanteile',
      totalAmount: eur('9999.00'),
      unitShare: eur(unitShare),
      group,
    });
    const plan = derivePlan(figures({ costLines: [line('RECOVERABLE', '2400.00', 1), line('NON_RECOVERABLE', '1000.00', 2)] }));
    expect(plan.flags).toEqual([{ code: 'LINES_DIFFER_FROM_GROUPS', details: { group: 'NON_RECOVERABLE', lines: eur('1000.00'), printed: eur('1200.00') } }]);
  });

  it('HAUSGELD_DIFFERS_FROM_PLAN beyond 12 cents a year, income netted; RESERVE_DIFFERS_FROM_PLAN only with the annual figure', () => {
    expect(derivePlan(figures()).flags).toEqual([]);
    expect(derivePlan(figures({ monthlyHausgeld: eur('300.01') })).flags).toEqual([]);
    expect(derivePlan(figures({ monthlyHausgeld: eur('300.02') })).flags.map((f) => f.code)).toEqual(['HAUSGELD_DIFFERS_FROM_PLAN']);
    expect(derivePlan(figures({ monthlyHausgeld: eur('290.00'), income: eur('120.00') })).flags).toEqual([]);
    expect(derivePlan(figures({ annualReserveContribution: eur('720.00') })).flags).toEqual([]);
    expect(derivePlan(figures({ annualReserveContribution: eur('700.00') })).flags).toEqual([
      { code: 'RESERVE_DIFFERS_FROM_PLAN', details: { annual: eur('720.00'), planned: eur('700.00') } },
    ]);
  });
});

describe('financial year and the plan for a date', () => {
  it('a calendar year and a year starting in July', () => {
    expect(financialYearOf(2026, 1)).toEqual({ from: '2026-01-01', until: '2026-12-31' });
    expect(financialYearOf(2026, 7)).toEqual({ from: '2026-07-01', until: '2027-06-30' });
    expect(inFinancialYear(day('2027-06-30'), 2026, 7)).toBe(true);
    expect(inFinancialYear(day('2026-06-30'), 2026, 7)).toBe(false);
  });

  it('the ACTIVE plan with the latest effectiveFrom on or before the date', () => {
    const at = new Date();
    const plans = [
      { id: 'a', status: 'ACTIVE' as const, effectiveFrom: day('2025-01-01'), createdAt: at },
      { id: 'b', status: 'ACTIVE' as const, effectiveFrom: day('2026-03-01'), createdAt: at },
      { id: 'v', status: 'VOID' as const, effectiveFrom: day('2026-02-01'), createdAt: at },
    ];
    expect(planFor(plans, day('2026-02-28'))?.id).toBe('a');
    expect(planFor(plans, day('2026-03-01'))?.id).toBe('b');
    expect(planFor(plans, day('2024-12-31'))).toBeUndefined();
  });
});

describe('proposeHausgeld', () => {
  const components = derivePlan(figures()).components; // 200 / 100 / 60
  const splits = (p: ReturnType<typeof proposeHausgeld>) => p.splits.map((s) => [s.financialCategoryCode, s.amount.amount]);

  it('FULL, HAUSGELD_ONLY and RESERVE_ONLY (the two debits of F5)', () => {
    expect(proposeHausgeld(eur('360.00'), components)).toMatchObject({ case: 'FULL', flags: [] });
    expect(splits(proposeHausgeld(eur('360.00'), components))).toEqual([
      ['WEG_RECOVERABLE', '200.00'],
      ['WEG_NON_RECOVERABLE', '100.00'],
      ['WEG_RESERVE_CONTRIBUTION', '60.00'],
    ]);
    expect(splits(proposeHausgeld(eur('300.00'), components))).toEqual([
      ['WEG_RECOVERABLE', '200.00'],
      ['WEG_NON_RECOVERABLE', '100.00'],
    ]);
    expect(proposeHausgeld(eur('300.00'), components).case).toBe('HAUSGELD_ONLY');
    expect(proposeHausgeld(eur('60.00'), components)).toMatchObject({ case: 'RESERVE_ONLY', flags: [] });
  });

  it('R = 0: A = H is FULL, not ambiguous; H = 0: A = R is FULL (review on #146)', () => {
    const noReserve = derivePlan(figures({ monthlyReserveContribution: eur('0') })).components;
    expect(proposeHausgeld(eur('300.00'), noReserve)).toMatchObject({ case: 'FULL', flags: [] });
    expect(splits(proposeHausgeld(eur('300.00'), noReserve))).toEqual([
      ['WEG_RECOVERABLE', '200.00'],
      ['WEG_NON_RECOVERABLE', '100.00'],
    ]);
    const reserveOnly = derivePlan(figures({ monthlyHausgeld: eur('0') })).components;
    expect(proposeHausgeld(eur('60.00'), reserveOnly)).toMatchObject({ case: 'FULL', flags: [] });
    expect(splits(proposeHausgeld(eur('60.00'), reserveOnly))).toEqual([['WEG_RESERVE_CONTRIBUTION', '60.00']]);
  });

  it('AMBIGUOUS only when the matching cases give different splits (H = R > 0)', () => {
    const even = derivePlan(figures({ monthlyHausgeld: eur('60.00') })).components;
    expect(proposeHausgeld(eur('60.00'), even)).toEqual({
      case: 'AMBIGUOUS',
      splits: [],
      flags: [{ code: 'AMBIGUOUS_AMOUNT', details: { cases: ['HAUSGELD_ONLY', 'RESERVE_ONLY'] } }],
    });
    expect(proposeHausgeld(eur('120.00'), even).case).toBe('FULL');
  });

  it('PROPORTIONAL: the proportions, half-up, the rest on the largest part, and the difference', () => {
    const p = proposeHausgeld(eur('370.00'), components);
    expect(p.case).toBe('PROPORTIONAL');
    // 370 × 200/360 = 205.555… → 205.56; × 100/360 = 102.777… → 102.78; × 60/360 = 61.666… → 61.67; sum 370.01 → rest −0.01 on the largest.
    expect(splits(p)).toEqual([
      ['WEG_RECOVERABLE', '205.55'],
      ['WEG_NON_RECOVERABLE', '102.78'],
      ['WEG_RESERVE_CONTRIBUTION', '61.67'],
    ]);
    expect(p.flags).toEqual([{ code: 'AMOUNT_DIFFERS_FROM_PLAN', details: { difference: eur('10.00') } }]);
    expect(proposeHausgeld(eur('100.00'), components).flags).toEqual([{ code: 'AMOUNT_DIFFERS_FROM_PLAN', details: { difference: eur('-260.00') } }]);
  });
});

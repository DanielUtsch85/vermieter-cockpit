import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import type { DepreciationAsset } from './asset.js';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2 } from './rules/de-afa-building-linear.js';
import type { ScheduleAcquisition, ScheduleComponent, ScheduleInput } from './schedule.js';
import { A, B, W, X, acc8, acquisition, asset, day, eur, life, ownership } from './schedule.test-support.js';
import { amount, codes, component, derive, ownerIn, sole, withParameters, yearOf } from './schedule-purchase.test-support.js';

/**
 * VC-8-02 domain (api-design.md §59A): the reasons, the rule versions (`DE_AFA_BUILDING_LINEAR` @1/@2) and the historical
 * cases, calculationStatus, and the rule's parameters from the registry. Moved out of `schedule.test.ts` unchanged
 * (issue #191); the inputs as there.
 */
describe('reasons, the rule versions and the historical cases (§59A, decided 2026-10-31)', () => {
  const reasonsOf = (input: ScheduleInput) => codes(component(derive(input)).reasons);

  it('the basis function’s reasons alone: ACQUISITION_NOT_CONFIRMED (a DRAFT with Ownerships), NO_ALLOCATION, ALLOCATION_NOT_CONFIRMED, NO_BUILDING', () => {
    const allocation = acquisition().allocation as NonNullable<ScheduleAcquisition['allocation']>;
    expect(reasonsOf(sole({ status: 'DRAFT' }))).toEqual(['ACQUISITION_NOT_CONFIRMED']);
    expect(reasonsOf(sole({ allocation: null }))).toEqual(['NO_ALLOCATION']);
    expect(reasonsOf(sole({ allocation: { ...allocation, reviewState: 'UNREVIEWED' } }))).toEqual(['ALLOCATION_NOT_CONFIRMED']);
    expect(reasonsOf(sole({ allocation: { ...allocation, reviewState: 'NEEDS_REVIEW' } }))).toEqual(['ALLOCATION_NOT_CONFIRMED']);
    expect(reasonsOf(sole({ allocation: { ...allocation, buildingAmount: eur('0.00') } }))).toEqual(['NO_BUILDING']);
    // The basis is still shown with an unconfirmed allocation, so the user sees what confirming would give.
    expect(amount(component(derive(sole({ allocation: { ...allocation, reviewState: 'UNREVIEWED' } }))).basis.amount)).toBe('254400.00');
  });

  it('a DRAFT without Ownerships is not listed; a CANCELLED one never reaches the derivation', () => {
    const s = derive({ ...acc8(), acquisitions: [acquisition(), acquisition({ id: X, status: 'DRAFT' })] });
    expect(s.components.map((c) => (c as ScheduleComponent).acquisitionId)).toEqual([W]);
  });

  it('every reason in its order: the basis function’s first, then USEFUL_LIFE_NOT_CONFIRMED, HISTORICAL_RULE_NOT_SUPPORTED, DEPRECIATION_METHOD_UNKNOWN', () => {
    const input = sole(
      { status: 'DRAFT', allocation: null, contractDate: day('2005-06-01'), economicTransferDate: day('2005-07-01') },
      { buildingCompletionYear: 2005, shorterUsefulLives: [life({ reviewState: 'NEEDS_REVIEW' })] },
    );
    // 2005 has no rule: DEPRECIATION_METHOD_UNKNOWN reads the rule of the first year, so it cannot hold before 2006.
    expect(reasonsOf(input)).toEqual(['ACQUISITION_NOT_CONFIRMED', 'USEFUL_LIFE_NOT_CONFIRMED', 'HISTORICAL_RULE_NOT_SUPPORTED']);
    const later = sole(
      { status: 'DRAFT', allocation: null, contractDate: day('2019-03-01'), economicTransferDate: day('2019-04-01') },
      { buildingCompletionYear: 2019, shorterUsefulLives: [life({ reviewState: 'UNREVIEWED' })] },
    );
    expect(reasonsOf(later)).toEqual(['ACQUISITION_NOT_CONFIRMED', 'USEFUL_LIFE_NOT_CONFIRMED', 'DEPRECIATION_METHOD_UNKNOWN']);
  });

  it('NO_APPLICABLE_RULE for a year without a version from 2006 on (a test registry ending @2 in 2040)', () => {
    const ending = new RuleRegistry([DE_AFA_BUILDING_LINEAR_V1, { ...DE_AFA_BUILDING_LINEAR_V2, effectiveTo: day('2040-01-01') }]);
    const c = component(derive(sole({ economicTransferDate: day('2026-01-01') }), ending));
    expect(c.reasons[0]?.code).toBe('NO_APPLICABLE_RULE');
    expect((c.reasons[0]?.details['yearsWithoutRule'] as number[]).slice(0, 2)).toEqual([2040, 2041]);
    expect(c.status).toBe('NOT_COMPUTABLE');
  });

  it("the asset's reasons stop every component: ASSET_VOID, COMPLETION_YEAR_MISSING, ASSET_NOT_CONFIRMED; the basis is shown, the amounts are null", () => {
    for (const [facts, code] of [
      [{ status: 'VOID' }, 'ASSET_VOID'],
      [{ buildingCompletionYear: null }, 'COMPLETION_YEAR_MISSING'],
      [{ reviewState: 'NEEDS_REVIEW' }, 'ASSET_NOT_CONFIRMED'],
      [{ reviewState: 'UNREVIEWED' }, 'ASSET_NOT_CONFIRMED'],
    ] as const) {
      const s = derive({ ...acc8(), asset: asset(facts as Partial<DepreciationAsset>) });
      expect(s.reasons.map((r) => r.code)).toEqual([code]);
      expect(s.status).toBe('DEPRECIATION_NOT_AVAILABLE');
      expect(component(s).status).toBe('NOT_COMPUTABLE');
      expect(amount(component(s).basis.amount)).toBe('254400.00');
      for (const y of component(s).years) expect([y.amount, y.cumulative, y.residualValue, y.calculationStatus]).toEqual([null, null, null, 'NOT_CALCULABLE']);
      for (const y of s.years) expect([y.status, y.amount, y.calculationStatus]).toEqual(['DEPRECIATION_NOT_AVAILABLE', null, 'NOT_CALCULABLE']);
    }
    // Never a default completion year: without one, no rate either.
    expect(component(derive({ ...acc8(), asset: asset({ buildingCompletionYear: null }) })).rate).toBeNull();
  });

  it('HISTORICAL_RULE_NOT_SUPPORTED for a start on 2005-12-31, and for a start in 2006 with a contract dated 2005: no year computed, 2023 included', () => {
    for (const [contract, transfer] of [
      ['2005-11-01', '2005-12-31'],
      ['2005-12-20', '2006-02-01'],
    ] as const) {
      const s = derive(sole({ contractDate: day(contract), economicTransferDate: day(transfer) }, {}, { from: 2005, to: 2030 }));
      const c = component(s);
      expect(c.reasons).toEqual([
        { code: 'HISTORICAL_RULE_NOT_SUPPORTED', details: { contractDate: contract, startDate: transfer, supportedFrom: '2006-01-01' } },
      ]);
      for (const y of c.years) expect([y.amount, y.calculationStatus]).toEqual([null, 'NOT_CALCULABLE']);
      expect(yearOf(c, 2023).amount).toBeNull();
    }
    // A contract and a start on 2006-01-01 are computed.
    expect(component(derive(sole({ contractDate: day('2006-01-01'), economicTransferDate: day('2006-01-01') }))).status).toBe('COMPUTABLE');
  });

  it('a start in 2020: 2020–2022 with @1, from 2023 @2, the same rate, no break; @1’s rates confirmed, so CALCULATED throughout', () => {
    const s = derive(sole({ contractDate: day('2020-03-01'), economicTransferDate: day('2020-04-01') }, {}, { from: 2020, to: 2024 }));
    const c = component(s);
    // Prüfbericht 01.11.2026, Frage 1 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01):
    // HISTORICAL_RULE_TO_VERIFY no longer rests on a year computed with @1's rates.
    expect(c.years.map((y) => [y.year, y.rule?.version, y.rule?.band, amount(y.amount), y.calculationStatus, codes(ownerIn(y, A)?.flags ?? [])])).toEqual([
      [2020, 1, 'A', '3816.00', 'CALCULATED', []],
      [2021, 1, 'A', '5088.00', 'CALCULATED', []],
      [2022, 1, 'A', '5088.00', 'CALCULATED', []],
      [2023, 2, 'B', '5088.00', 'CALCULATED', []],
      [2024, 2, 'B', '5088.00', 'CALCULATED', []],
    ]);
    expect(amount(yearOf(c, 2023).cumulative)).toBe('19080.00');
    expect(s.ruleVersions.map((v) => [v.version, v.status, v.years])).toEqual([
      [1, 'SUPERSEDED', [2020, 2021, 2022]],
      [2, 'ACTIVE', [2023, 2024]],
    ]);
    expect(s.review.open).toEqual([]);
    // The same start with @1's rates unverified again: the flag on each of 2020–2022, as before the review.
    const v1 = DE_AFA_BUILDING_LINEAR_V1.parameters;
    const unverified = new RuleRegistry([
      { ...DE_AFA_BUILDING_LINEAR_V1, parameters: { ...v1, verified: { ...v1.verified, rates: false } } },
      DE_AFA_BUILDING_LINEAR_V2,
    ]);
    const before = derive(sole({ contractDate: day('2020-03-01'), economicTransferDate: day('2020-04-01') }, {}, { from: 2020, to: 2024 }), unverified);
    expect(ownerIn(yearOf(component(before), 2020), A)?.flags[0]).toEqual({
      code: 'HISTORICAL_RULE_TO_VERIFY',
      details: { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 1 },
    });
    expect(before.review.open).toEqual([{ code: 'HISTORICAL_RULE_TO_VERIFY', count: 3 }]);
  });

  it('a shorter useful life under @1 keeps HISTORICAL_RULE_TO_VERIFY: the review confirmed the rates, not the thresholds 50 / 40 of S. 2 then', () => {
    const s = derive(
      sole(
        { contractDate: day('2020-03-01'), economicTransferDate: day('2020-04-01') },
        { shorterUsefulLives: [life({ evidence: { ...life().evidence, date: day('2020-04-01') } })] },
        { from: 2022, to: 2023 },
      ),
    );
    const c = component(s);
    expect(c.years.map((y) => [y.year, y.rule?.version, y.calculationStatus, codes(ownerIn(y, A)?.flags ?? [])])).toEqual([
      [2022, 1, 'PROVISIONAL', ['HISTORICAL_RULE_TO_VERIFY']],
      [2023, 2, 'CALCULATED', []],
    ]);
  });

  it('a building completed in 1920, bought in 2010: 2.5 % in both versions (band B in @1, C in @2)', () => {
    const c = component(
      derive(sole({ contractDate: day('2010-01-01'), economicTransferDate: day('2010-01-01') }, { buildingCompletionYear: 1920 }, { from: 2022, to: 2023 })),
    );
    expect(c.years.map((y) => [y.rule?.band, amount(y.amount)])).toEqual([
      ['B', '6360.00'],
      ['C', '6360.00'],
    ]);
  });

  it('the rate follows the completion year, never the start: a 2023 purchase of a 1990 building is 2 %', () => {
    const c = component(
      derive(sole({ contractDate: day('2023-01-01'), economicTransferDate: day('2023-01-01') }, { buildingCompletionYear: 1990 }, { from: 2023, to: 2023 })),
    );
    expect([c.rate?.ratePercent, amount(yearOf(c, 2023).amount)]).toEqual(['2', '5088.00']);
  });

  it('DEPRECIATION_METHOD_UNKNOWN only for completion year = first year ≥ 2018: 2017 computed, a 2018 building bought in 2019 computed', () => {
    const run = (completion: number, start: string) =>
      component(derive(sole({ contractDate: day(start), economicTransferDate: day(start) }, { buildingCompletionYear: completion })));
    expect(run(2018, '2018-06-01').reasons).toEqual([{ code: 'DEPRECIATION_METHOD_UNKNOWN', details: { completionYear: 2018, firstYear: 2018 } }]);
    expect(run(2026, '2026-06-01').reasons.map((r) => r.code)).toEqual(['DEPRECIATION_METHOD_UNKNOWN']);
    expect(run(2017, '2017-06-01').status).toBe('COMPUTABLE');
    expect(run(2018, '2019-01-01').status).toBe('COMPUTABLE');
    // It is a reason (open), never informative.
    expect(
      derive(sole({ contractDate: day('2018-06-01'), economicTransferDate: day('2018-06-01') }, { buildingCompletionYear: 2018 })).review.open,
    ).toContainEqual({
      code: 'DEPRECIATION_METHOD_UNKNOWN',
      count: 1,
    });
  });

  it('a shorter life: applied (SHORTER_USEFUL_LIFE), not confirmed (not computable), not shorter (band rate, open), evidence after the first year (USEFUL_LIFE_START_TO_VERIFY)', () => {
    const run = (entry: Parameters<typeof life>[0]) =>
      component(derive(sole({ economicTransferDate: day('2026-01-01') }, { shorterUsefulLives: [life(entry)] }, { from: 2026, to: 2026 })));
    const applied = run({});
    expect([applied.status, codes(applied.flags), amount(yearOf(applied, 2026).amount), yearOf(applied, 2026).calculationStatus]).toEqual([
      'COMPUTABLE',
      ['SHORTER_USEFUL_LIFE'],
      '8480.00',
      'CALCULATED',
    ]);
    const unconfirmed = run({ reviewState: 'NEEDS_REVIEW' });
    expect([unconfirmed.status, codes(unconfirmed.reasons), yearOf(unconfirmed, 2026).amount]).toEqual(['NOT_COMPUTABLE', ['USEFUL_LIFE_NOT_CONFIRMED'], null]);
    const notShorter = run({ usefulLifeYears: 50 });
    expect([codes(notShorter.flags), amount(yearOf(notShorter, 2026).amount), yearOf(notShorter, 2026).calculationStatus]).toEqual([
      ['USEFUL_LIFE_NOT_SHORTER'],
      '5088.00',
      'PROVISIONAL',
    ]);
    const later = run({ evidence: { source: 'Gutachten', date: day('2027-02-01'), documentReference: null } });
    expect(later.flags).toEqual([
      { code: 'SHORTER_USEFUL_LIFE', details: { usefulLifeYears: 30 } },
      { code: 'USEFUL_LIFE_START_TO_VERIFY', details: { evidenceDate: '2027-02-01', firstYear: 2026 } },
    ]);
    expect(amount(yearOf(later, 2026).amount)).toBe('8480.00');
  });

  it('ACQUISITION_COST_UNPAID is informative and changes nothing', () => {
    const costs = acquisition().costs.map((c, i) => (i === 0 ? { ...c, paymentStatus: 'EXPECTED' } : c));
    const s = derive({ ...acc8(), acquisitions: [acquisition({ costs })] });
    expect(component(s).flags).toEqual([{ code: 'ACQUISITION_COST_UNPAID', details: { costIds: ['0000ffff-0000-4000-8000-000000000051'] } }]);
    expect(amount(component(s).basis.amount)).toBe('254400.00');
    expect(s.years[0]?.calculationStatus).toBe('CALCULATED');
    expect(s.review.info).toEqual([{ code: 'ACQUISITION_COST_UNPAID', count: 1 }]);
  });
});

describe('calculationStatus (decided 2026-10-31): never 0.00 for a missing figure', () => {
  it('each value, and the component year’s from its owners’ (NOT_CALCULABLE when any is, the others still shown)', () => {
    const calculated = derive(acc8());
    expect(component(calculated).years.map((y) => y.calculationStatus)).toEqual(['CALCULATED', 'CALCULATED']);
    const provisional = derive(
      acc8(),
      withParameters((p) => ({ ...p, verified: { ...p.verified, rates: false } })),
    );
    expect(component(provisional).years.map((y) => y.calculationStatus)).toEqual(['PROVISIONAL', 'PROVISIONAL']);
    // Without economicTransferDate it is no longer provisional (TRANSFER_DATE_ASSUMED withdrawn) but not calculable.
    const undated = derive({ ...acc8(), acquisitions: [acquisition({ economicTransferDate: null, contractDate: day('2026-07-01') })] });
    expect(component(undated).years.map((y) => y.calculationStatus)).toEqual(['NOT_CALCULABLE', 'NOT_CALCULABLE']);
    const missing = derive({
      ...acc8({ from: 2029, to: 2029 }),
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2029-06-30', W)],
    });
    const y = yearOf(component(missing), 2029);
    expect([y.calculationStatus, ownerIn(y, A)?.calculationStatus, ownerIn(y, B)?.calculationStatus]).toEqual([
      'NOT_CALCULABLE',
      'CALCULATED',
      'NOT_CALCULABLE',
    ]);
  });

  it('counter-check: every NOT_CALCULABLE year has amount null, in the component, the owner and the property sums', () => {
    const inputs: ScheduleInput[] = [
      { ...acc8(), acquisitions: [acquisition({ status: 'DRAFT' })] },
      {
        ...acc8(),
        acquisitions: [
          acquisition({ allocation: { ...(acquisition().allocation as NonNullable<ScheduleAcquisition['allocation']>), reviewState: 'UNREVIEWED' } }),
        ],
      },
      { ...acc8(), asset: asset({ reviewState: 'UNREVIEWED' }) },
      { ...acc8(), asset: asset({ shorterUsefulLives: [life({ reviewState: 'UNREVIEWED' })] }) },
      { ...acc8({ from: 2029, to: 2030 }), ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2029-06-30', W)] },
    ];
    for (const input of inputs) {
      const s = derive(input);
      for (const c of s.components) {
        for (const y of c.years) {
          if (y.calculationStatus === 'NOT_CALCULABLE') expect(y.amount).toBeNull();
          for (const o of y.owners) if (o.calculationStatus === 'NOT_CALCULABLE') expect(o.amount).toBeNull();
        }
      }
      for (const y of s.years) if (y.calculationStatus === 'NOT_CALCULABLE') expect(y.amount).toBeNull();
      expect(s.years.some((y) => y.calculationStatus === 'NOT_CALCULABLE')).toBe(true);
    }
  });

  it('a second Acquisition with an unconfirmed allocation makes the years PARTIAL (the property sum null)', () => {
    const allocation = acquisition().allocation as NonNullable<ScheduleAcquisition['allocation']>;
    const s = derive({
      ...acc8({ from: 2027, to: 2027 }),
      acquisitions: [
        acquisition({ acquiredShare: { numerator: 3, denominator: 5 } }),
        acquisition({
          id: X,
          acquiredShare: { numerator: 2, denominator: 5 },
          contractDate: day('2026-06-15'),
          allocation: { ...allocation, reviewState: 'UNREVIEWED' },
        }),
      ],
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', null, X)],
    });
    expect(s.status).toBe('PARTIAL');
    expect(s.years[0]).toMatchObject({ status: 'PARTIAL', amount: null, calculationStatus: 'NOT_CALCULABLE' });
    // A bought 3/5 in W alone (weight 1/1), so A's part is W's whole basis.
    expect(s.years[0]?.owners?.map((o) => [o.ownerPartyId, amount(o.amount)])).toEqual([
      [A, '5088.00'],
      [B, null],
    ]);
  });
});

describe("the rule's parameters come from the registry (AGENTS.md §16)", () => {
  it('another band rate in a test registry changes the figures', () => {
    const slower = withParameters((p) => ({ ...p, bands: p.bands.map((b) => ({ ...b, ratePercent: '1' })) }));
    expect(amount(yearOf(component(derive(acc8(), slower)), 2027).amount)).toBe('2544.00');
  });

  it('another excluded category in a test registry changes the basis (the basis reads the rule, not a constant)', () => {
    const noNotary = withParameters((p) => ({ ...p, basis: { ...p.basis, excludedCostCategories: ['FINANCING_RELATED', 'NOTARY'] } }));
    // (300,000 + 15,000) × 254,400 / 318,000 = 252,000.00.
    expect(amount(component(derive(acc8(), noNotary)).basis.amount)).toBe('252000.00');
  });

  it('methodUnknownFromCompletionYear read from the rule: 2019 in a test registry computes a 2018 new building', () => {
    const later = withParameters((p) => ({ ...p, methodUnknownFromCompletionYear: 2019 }));
    const input = sole({ contractDate: day('2018-06-01'), economicTransferDate: day('2018-06-01') }, { buildingCompletionYear: 2018 });
    expect(component(derive(input, later)).status).toBe('COMPUTABLE');
  });

  it('the start’s parameters come from the version of the start year, never the newest (closes the gap of #204)', () => {
    // The registry's @1 and @2 read the same start parameters, so a test registry makes @1's differ: under @1 the first
    // month does not count and NOTARY is excluded. A start in 2020 reads @1; one in 2024 reads @2. The mutation "always
    // the newest version as the start's rule" (`ruleAtStart` in `purchase-work.ts`) turns this test red.
    const v1 = DE_AFA_BUILDING_LINEAR_V1.parameters;
    const differing = new RuleRegistry([
      {
        ...DE_AFA_BUILDING_LINEAR_V1,
        parameters: {
          ...v1,
          firstYear: { ...v1.firstYear, startMonthCounts: false },
          basis: { ...v1.basis, excludedCostCategories: ['FINANCING_RELATED', 'NOTARY'] },
        },
      },
      DE_AFA_BUILDING_LINEAR_V2,
    ]);
    const at2020 = component(
      derive(sole({ contractDate: day('2020-03-01'), economicTransferDate: day('2020-04-01') }, {}, { from: 2020, to: 2020 }), differing),
    );
    // (300,000 + 15,000) × 254,400 / 318,000 = 252,000.00; April does not count, so May–December: 8 months.
    expect([amount(at2020.basis.amount), at2020.start?.firstYearMonths, yearOf(at2020, 2020).months]).toEqual(['252000.00', 8, 8]);
    const at2024 = component(
      derive(sole({ contractDate: day('2024-03-01'), economicTransferDate: day('2024-04-01') }, {}, { from: 2024, to: 2024 }), differing),
    );
    expect([amount(at2024.basis.amount), at2024.start?.firstYearMonths, yearOf(at2024, 2024).months]).toEqual(['254400.00', 9, 9]);
  });

  it('HISTORICAL_RULE_TO_VERIFY disappears with a test registry that marks @1 verified in full (rates and thresholds)', () => {
    const verified = new RuleRegistry([
      { ...DE_AFA_BUILDING_LINEAR_V1, parameters: { ...DE_AFA_BUILDING_LINEAR_V1.parameters, verified: { rates: true, shorterUsefulLifeThresholds: true } } },
      DE_AFA_BUILDING_LINEAR_V2,
    ]);
    const c = component(derive(sole({ contractDate: day('2020-03-01'), economicTransferDate: day('2020-04-01') }, {}, { from: 2020, to: 2020 }), verified));
    expect([yearOf(c, 2020).calculationStatus, ownerIn(yearOf(c, 2020), A)?.flags]).toEqual(['CALCULATED', []]);
  });
});

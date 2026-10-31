import { describe, expect, it } from 'vitest';
import { RuleRegistry, type Money } from '../../shared/index.js';
import type { DepreciationAsset } from './asset.js';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import {
  deriveSchedule,
  type ComponentYear,
  type DepreciationSchedule,
  type ScheduleAcquisition,
  type ScheduleComponent,
  type ScheduleInput,
} from './schedule.js';
import { A, B, C, D, W, X, Y, acc8, acquisition, asset, day, eur, life, ownership } from './schedule.test-support.js';

/**
 * VC-8-02 domain (api-design.md §59A, §28.1A "Effect on §59A"): the schedule of the purchase, derived from synthetic
 * inputs with Depreciation's own registry (never `domains/tax-rules/`). Every date is explicit; `today` only sets the
 * default range. The figures are ACC8's purchase (basis 254,400.00 at 2 %, 5,088.00 a year) and its variants.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
const derive = (input: ScheduleInput, reg: RuleRegistry = registry) => deriveSchedule(input, reg);
const amount = (m: Money | null | undefined) => (m === null || m === undefined ? null : m.amount);
const component = (s: DepreciationSchedule, i = 0) => s.components[i] as ScheduleComponent;
const yearOf = (c: ScheduleComponent, year: number) => c.years.find((y) => y.year === year) as ComponentYear;
const ownerIn = (y: ComponentYear, partyId: string) => y.owners.find((o) => o.ownerPartyId === partyId);
const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);
const cents = (m: Money | null | undefined) => BigInt((m?.amount ?? '0').replace('.', ''));
/** A registry whose rule versions both carry other parameters. */
const withParameters = (change: (p: BuildingLinearParameters) => BuildingLinearParameters) =>
  new RuleRegistry([
    { ...DE_AFA_BUILDING_LINEAR_V1, parameters: change(DE_AFA_BUILDING_LINEAR_V1.parameters) },
    { ...DE_AFA_BUILDING_LINEAR_V2, parameters: change(DE_AFA_BUILDING_LINEAR_V2.parameters) },
  ]);
/** A sole owner A of `acq` (1/1) from its transfer date. */
const sole = (acq: Partial<ScheduleAcquisition>, assetFacts: Partial<DepreciationAsset> = {}, extra: Partial<ScheduleInput> = {}): ScheduleInput => {
  const a = acquisition(acq);
  return {
    asset: asset(assetFacts),
    acquisitions: [a],
    ownerships: [ownership(A, '1/1', a.economicTransferDate ?? a.contractDate, null, a.id)],
    today: day('2026-10-30'),
    from: 2000,
    to: 2100,
    ownerPartyId: null,
    ...extra,
  };
};
/** An Acquisition whose basis is exactly `basis` (price = total = building, no costs). */
const exactBasis = (basis: string, overrides: Partial<ScheduleAcquisition> = {}): Partial<ScheduleAcquisition> => ({
  purchasePrice: eur(basis),
  costs: [],
  allocation: {
    id: '0000bbbb-0000-4000-8000-000000000031',
    method: 'PURCHASE_CONTRACT',
    reviewState: 'CONFIRMED',
    totalAllocableAmount: eur(basis),
    buildingAmount: eur(basis),
  },
  ...overrides,
});
/** A deterministic generator (synthetic inputs, reproducible failures). */
function random(seed: number) {
  let state = seed;
  return (max: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % max;
  };
}

describe("ACC8's purchase (§59A, the example)", () => {
  it('A 3/5 and B 2/5 of 254,400.00 at 2 % from 2026-07-01: 2026 and 2027 at the property level, as the response example', () => {
    const s = derive(acc8());
    expect(s).toMatchObject({ level: 'PROPERTY', status: 'AVAILABLE', reasons: [], range: { from: 2026, to: 2027, truncated: false } });
    const c = component(s);
    expect(c).toMatchObject({ componentId: `ACQUISITION:${W}`, kind: 'ACQUISITION', status: 'COMPUTABLE', reasons: [], flags: [] });
    expect(amount(c.basis.amount)).toBe('254400.00');
    expect(c.start).toEqual({ date: '2026-07-01', dateSource: 'ECONOMIC_TRANSFER_DATE', month: '2026-07', firstYearMonths: 6 });
    expect(c.rate).toEqual({
      kind: 'BAND',
      band: 'B',
      ratePercent: '2',
      rate: '1/50',
      usefulLifeYears: null,
      legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG',
    });
    expect(c.end).toEqual({ lastYear: 2076, lastMonth: '2076-06' });
    expect(c.owners.map((o) => [o.ownerPartyId, o.share, o.acquiredShare, o.weight, amount(o.basis)])).toEqual([
      [A, '3/5', '3/5', '3/5', '152640.00'],
      [B, '2/5', '2/5', '2/5', '101760.00'],
    ]);
    expect([2026, 2027].map((y) => [y, amount(yearOf(c, y).amount), amount(yearOf(c, y).cumulative), amount(yearOf(c, y).residualValue)])).toEqual([
      [2026, '2544.00', '2544.00', '251856.00'],
      [2027, '5088.00', '7632.00', '246768.00'],
    ]);
    expect(yearOf(c, 2026).owners.map((o) => [o.months, o.fraction, amount(o.amount), amount(o.residualValue), o.calculationStatus])).toEqual([
      [6, '1/1', '1526.40', '151113.60', 'CALCULATED'],
      [6, '1/1', '1017.60', '100742.40', 'CALCULATED'],
    ]);
    expect(yearOf(c, 2026).rule).toEqual({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2, band: 'B', legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG' });
    expect(s.years.map((y) => [y.year, y.status, y.calculationStatus, amount(y.amount), y.owners?.map((o) => amount(o.amount))])).toEqual([
      [2026, 'AVAILABLE', 'CALCULATED', '2544.00', ['1526.40', '1017.60']],
      [2027, 'AVAILABLE', 'CALCULATED', '5088.00', ['3052.80', '2035.20']],
    ]);
    expect(s.ruleVersions).toEqual([
      {
        ruleCode: 'DE_AFA_BUILDING_LINEAR',
        version: 2,
        title: 'Lineare Gebäude-AfA im Privatvermögen (§ 7 Abs. 4 EStG)',
        legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 und S. 2 EStG',
        status: 'ACTIVE',
        years: [2026, 2027],
      },
    ]);
  });

  it('the owner level: only A, the years are A’s, owners and notOwned null', () => {
    const s = derive(acc8({ ownerPartyId: A }));
    expect(s.level).toBe('OWNER');
    expect(component(s).owners.map((o) => o.ownerPartyId)).toEqual([A]);
    expect(yearOf(component(s), 2027).owners.map((o) => o.ownerPartyId)).toEqual([A]);
    expect(s.years.map((y) => [amount(y.amount), y.owners, y.notOwned])).toEqual([
      ['1526.40', null, null],
      ['3052.80', null, null],
    ]);
  });

  it('counter-check: land is never in the basis (254,400.00, not 318,000.00), nor FINANCING_RELATED (the 1,200.00)', () => {
    const c = component(derive(acc8()));
    expect(amount(c.basis.amount)).toBe('254400.00');
    expect(amount(c.basis.acquisitionCosts)).toBe('18000.00');
    expect(c.basis.excludedCosts.map((e) => [e.category, amount(e.amount)])).toEqual([['FINANCING_RELATED', '1200.00']]);
    // With 1,200.00 counted the basis would be (319,200.00 × 254,400 / 318,000) = 255,360.00.
    expect(amount(c.basis.amount)).not.toBe('255360.00');
  });

  it('the default range: the earliest start to the last year with AfA; today only when nothing is computable; truncated at 2100', () => {
    const open = derive(acc8({ from: undefined, to: undefined }));
    expect(open.range).toEqual({ from: 2026, to: 2076, truncated: false });
    const none = derive({ ...acc8({ from: undefined, to: undefined }), acquisitions: [], ownerships: [] });
    expect(none.range).toEqual({ from: 2026, to: 2026, truncated: false });
    // A purchase in 2090 runs past 2100: the default `to` is clamped and says so.
    const late = derive(sole({ economicTransferDate: day('2090-01-01'), contractDate: day('2089-12-01') }, {}, { from: undefined, to: undefined }));
    expect(late.range).toEqual({ from: 2090, to: 2100, truncated: true });
    expect(derive(sole({ economicTransferDate: day('2090-01-01'), contractDate: day('2089-12-01') }, {}, { to: 2100 })).range.truncated).toBe(false);
  });
});

describe('the start and the first year (§ 7 Abs. 1 S. 4 EStG, P8-D5)', () => {
  const firstYear = (date: string) => {
    const c = component(derive(sole({ economicTransferDate: day(date) }, {}, { from: 2026, to: 2027 })));
    return [c.start.firstYearMonths, amount(yearOf(c, 2026)?.amount)];
  };

  it('January 12/12, April 9/12, July 6/12, December 1/12 of 5,088.00', () => {
    expect(['2026-01-01', '2026-04-01', '2026-07-01', '2026-12-31'].map(firstYear)).toEqual([
      [12, '5088.00'],
      [9, '3816.00'],
      [6, '2544.00'],
      [1, '424.00'],
    ]);
  });

  it('a start on the 1st and on the last day of a month give the same months', () => {
    expect(firstYear('2026-04-30')).toEqual(firstYear('2026-04-01'));
    expect(firstYear('2026-12-01')).toEqual(firstYear('2026-12-31'));
  });

  it('a transfer on 2027-01-01: no component year in 2026, the year AVAILABLE with 0.00 (P8-D12); 5,088.00 in 2027', () => {
    const s = derive(sole({ economicTransferDate: day('2027-01-01') }, {}, { from: 2026, to: 2027 }));
    expect(component(s).years.map((y) => y.year)).toEqual([2027]);
    expect(s.years.map((y) => [y.year, y.status, amount(y.amount)])).toEqual([
      [2026, 'AVAILABLE', '0.00'],
      [2027, 'AVAILABLE', '5088.00'],
    ]);
  });

  it('TRANSFER_DATE_ASSUMED: without economicTransferDate the contract date starts it, the assumption is never silent and every year is provisional', () => {
    const s = derive(sole({ economicTransferDate: null, contractDate: day('2026-04-20') }, {}, { from: 2026, to: 2027 }));
    const c = component(s);
    expect(c.start).toMatchObject({ date: '2026-04-20', dateSource: 'CONTRACT_DATE', firstYearMonths: 9 });
    expect(c.flags).toEqual([{ code: 'TRANSFER_DATE_ASSUMED', details: { contractDate: '2026-04-20' } }]);
    expect(c.years.map((y) => [y.calculationStatus, ownerIn(y, A)?.calculationStatus])).toEqual([
      ['PROVISIONAL', 'PROVISIONAL'],
      ['PROVISIONAL', 'PROVISIONAL'],
    ]);
    expect(s.years[0]?.flags).toEqual([{ code: 'TRANSFER_DATE_ASSUMED', details: { componentIds: [c.componentId] } }]);
    expect(s.review.open).toEqual([{ code: 'TRANSFER_DATE_ASSUMED', count: 1 }]);
  });

  it('the start month not counted (a test registry): the first year loses one twelfth', () => {
    const notCounted = withParameters((p) => ({ ...p, firstYear: { ...p.firstYear, startMonthCounts: false } }));
    const c = component(derive(sole({ economicTransferDate: day('2026-07-01') }, {}, { from: 2026, to: 2026 }), notCounted));
    expect([c.start.firstYearMonths, amount(yearOf(c, 2026).amount)]).toEqual([5, '2120.00']);
  });
});

describe('the cap and the remainder (depreciation.md §7)', () => {
  const run = (completionYear: number, lives: DepreciationAsset['shorterUsefulLives'] = []) =>
    component(
      derive(sole(exactBasis('100000.00', { economicTransferDate: day('2026-01-01') }), { buildingCompletionYear: completionYear, shorterUsefulLives: lives })),
    );
  const total = (c: ScheduleComponent) => c.years.reduce((sum, y) => sum + cents(y.amount), 0n);

  it('600, 480 and 400 months for 2 %, 2.5 % and 3 %, 12·n for 1/n: the cumulative AfA equals the basis exactly at the end, nothing after', () => {
    const cases: [ScheduleComponent, string][] = [
      [run(1995), '2075-12'],
      [run(1900), '2065-12'],
      [run(2024), '2059-04'],
      [run(1995, [life({ usefulLifeYears: 30 })]), '2055-12'],
    ];
    for (const [c, lastMonth] of cases) {
      expect(c.end?.lastMonth).toBe(lastMonth);
      expect(total(c)).toBe(10_000_000n);
      expect(amount(c.years[c.years.length - 1]?.residualValue)).toBe('0.00');
      expect(c.years[c.years.length - 1]?.year).toBe(Number(lastMonth.slice(0, 4)));
      for (const y of c.years) expect(cents(y.cumulative) <= 10_000_000n).toBe(true);
    }
    // 3 %: 33 years at 3,000.00 and 4 months of the rest (1,000.00).
    expect(amount(yearOf(run(2024), 2059).amount)).toBe('1000.00');
  });

  it('a shorter life past its end takes nothing: 30 years from 2026 end in 2055', () => {
    const c = run(1995, [life({ usefulLifeYears: 30 })]);
    expect(c.years.map((y) => y.year).filter((y) => y > 2055)).toEqual([]);
    expect(c.rate).toMatchObject({ kind: 'SHORTER_USEFUL_LIFE', rate: '1/30', ratePercent: '3.3333', usefulLifeYears: 30 });
  });
});

describe('cumulative rounding (P8-D8): one rounding per owner and year, half-up', () => {
  it('1,000.01 at 2 % from January: year 1 is 20.00, year 25 is 20.01, the 50 years sum to exactly 1,000.01', () => {
    const c = component(derive(sole(exactBasis('1000.01', { economicTransferDate: day('2026-01-01') }))));
    expect(c.years).toHaveLength(50);
    expect(amount(yearOf(c, 2026).amount)).toBe('20.00');
    expect(amount(yearOf(c, 2050).amount)).toBe('20.01');
    expect(c.years.reduce((sum, y) => sum + cents(y.amount), 0n)).toBe(100_001n);
    // Rounding each year separately would give 20.00 fifty times, 0.01 short.
    expect(c.years.filter((y) => amount(y.amount) === '20.01')).toHaveLength(1);
  });

  it('property: random bases (1 cent to 10^12 cents), rates and start months; every year ≥ 0, within one cent of the exact amount, summing to the basis', () => {
    const next = random(20261031);
    for (let run = 0; run < 25; run++) {
      const basisCents = 1n + BigInt(next(1_000_000)) * BigInt(next(1_000_000)) + BigInt(next(100));
      const basis = `${basisCents / 100n}.${String(basisCents % 100n).padStart(2, '0')}`;
      const month = 1 + next(12);
      const completionYear = [1900, 1995, 2024][next(3)] as number;
      const lives = next(3) === 0 ? [life({ usefulLifeYears: 1 + next(30) })] : [];
      const start = day(`2026-${String(month).padStart(2, '0')}-01`);
      const c = component(
        derive(sole(exactBasis(basis, { economicTransferDate: start }), { buildingCompletionYear: completionYear, shorterUsefulLives: lives })),
      );
      expect(c.status, `run ${run}`).toBe('COMPUTABLE');
      let sum = 0n;
      for (const y of c.years) {
        const value = cents(y.amount);
        expect(value >= 0n, `run ${run} ${y.year}`).toBe(true);
        sum += value;
        expect(cents(y.cumulative) <= basisCents).toBe(true);
      }
      expect(sum, `run ${run}`).toBe(basisCents);
      // Each year within one cent of basis × (that year's share of the life), computed independently in exact fractions.
      const rate = c.rate?.rate as string;
      const [rn, rd] = rate.split('/').map(BigInt) as [bigint, bigint];
      let done = 0n; // twelfths of the rate, as numerator over 12·rd
      for (const y of c.years) {
        const months = BigInt(y.months as number);
        const capped = rd * 12n - done < rn * months ? rd * 12n - done : rn * months;
        done += capped;
        const exactTimes = basisCents * capped; // over 12·rd
        const diff = cents(y.amount) * 12n * rd - exactTimes;
        expect(diff <= 12n * rd && diff >= -12n * rd, `run ${run} ${y.year}`).toBe(true);
      }
    }
  });
});

describe('per owner (§27.4, P8-D8)', () => {
  it('a partial acquisition: A buys 1/2 (acquiredShare 1/2) and its weight is 1/1; D holds the other half without a purchase', () => {
    const s = derive({
      ...acc8(),
      acquisitions: [acquisition({ acquiredShare: { numerator: 1, denominator: 2 } })],
      ownerships: [ownership(A, '1/2', '2026-07-01', null, W), ownership(D, '1/2', '2020-01-01', null, null)],
    });
    expect(component(s).owners.map((o) => [o.ownerPartyId, o.share, o.weight, amount(o.basis)])).toEqual([[A, '1/2', '1/1', '254400.00']]);
    expect(codes(s.years[0]?.flags ?? [])).toContain('OWNER_WITHOUT_ACQUISITION');
  });

  it('largest remainder on an odd cent: three owners of 1/3 and a basis of 1,000.00 → 333.34, 333.33, 333.33 (ties by ownerPartyId)', () => {
    const s = derive({
      ...acc8({ from: 2026, to: 2075 }),
      acquisitions: [acquisition(exactBasis('1000.00', { economicTransferDate: day('2026-01-01') }))],
      ownerships: [ownership(C, '1/3', '2026-01-01', null, W), ownership(A, '1/3', '2026-01-01', null, W), ownership(B, '1/3', '2026-01-01', null, W)],
    });
    const c = component(s);
    expect(c.owners.map((o) => [o.ownerPartyId, amount(o.basis)])).toEqual([
      [A, '333.34'],
      [B, '333.33'],
      [C, '333.33'],
    ]);
    for (const y of c.years) expect(y.owners.reduce((sum, o) => sum + cents(o.amount), 0n)).toBe(cents(y.amount));
  });

  it('property: random shares (up to 20 owners, denominators up to 10,000): owners sum to the component and components to the property in every year', () => {
    const next = random(27_04);
    for (let run = 0; run < 12; run++) {
      const denominator = 2 + next(9_999);
      const owners = Math.min(1 + next(20), denominator);
      const cuts = new Set<number>();
      while (cuts.size < owners - 1) cuts.add(1 + next(denominator - 1));
      const bounds = [0, ...[...cuts].sort((x, y) => x - y), denominator];
      const parties = Array.from({ length: owners }, (_, i) => `0000aaaa-0000-4000-8000-${String(100 + i).padStart(12, '0')}`);
      const rows = parties.map((p, i) => ownership(p, `${(bounds[i + 1] as number) - (bounds[i] as number)}/${denominator}`, '2026-03-01', null, W));
      const s = derive({
        ...acc8({ from: 2026, to: 2035 }),
        acquisitions: [acquisition({ economicTransferDate: day('2026-03-01') })],
        ownerships: rows,
      });
      const c = component(s);
      for (const y of c.years) {
        expect(
          y.owners.reduce((sum, o) => sum + cents(o.amount), 0n),
          `run ${run} ${y.year}`,
        ).toBe(cents(y.amount));
        expect(cents(s.years.find((t) => t.year === y.year)?.amount)).toBe(cents(y.amount));
        const ownersTotal = (s.years.find((t) => t.year === y.year)?.owners ?? []).reduce((sum, o) => sum + cents(o.amount), 0n);
        expect(ownersTotal).toBe(cents(y.amount));
      }
      expect(c.owners.reduce((sum, o) => sum + cents(o.basis), 0n)).toBe(cents(c.basis.amount));
    }
  });

  it('mutation guard: a buyer of a later purchase never depreciates the seller’s basis (each component its own buyers)', () => {
    const s = derive({
      ...acc8({ from: 2029, to: 2030 }),
      acquisitions: [
        acquisition(),
        acquisition({
          ...exactBasis('120000.00'),
          id: X,
          sellerPartyIds: [B],
          acquiredShare: { numerator: 2, denominator: 5 },
          contractDate: day('2029-06-01'),
          economicTransferDate: day('2029-07-01'),
        }),
      ],
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2029-06-30', W), ownership(C, '2/5', '2029-07-01', null, X)],
    });
    expect(component(s, 0).owners.map((o) => o.ownerPartyId)).toEqual([A, B]);
    expect(component(s, 1).owners.map((o) => [o.ownerPartyId, amount(o.basis)])).toEqual([[C, '120000.00']]);
    expect(yearOf(component(s, 0), 2030).owners.map((o) => o.ownerPartyId)).toEqual([A]);
    // The components sum to the property, and the owners across components to the property, in every year.
    for (const y of s.years) {
      const parts = s.components.map((c) => c.years.find((cy) => cy.year === y.year)).filter((cy) => cy !== undefined);
      expect(parts.reduce((sum, cy) => sum + cents(cy?.amount), 0n)).toBe(cents(y.amount));
      expect((y.owners ?? []).reduce((sum, o) => sum + cents(o.amount), 0n)).toBe(cents(y.amount));
    }
    expect(amount(s.years.find((y) => y.year === 2030)?.amount)).toBe('5452.80');
  });
});

describe('the tenure, a reduced share, the end (P8-D8, P8-D9)', () => {
  /** B sells its 2/5 to C effective `transfer`; C's Acquisition X with `economicTransferDate` (or not). */
  const sale = (transfer: string, economic: boolean, reg: RuleRegistry = registry) => {
    const lastDay = new Date(`${transfer}T00:00:00Z`);
    lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    const until = lastDay.toISOString().slice(0, 10);
    return derive(
      {
        ...acc8({ from: 2028, to: 2030 }),
        acquisitions: [
          acquisition(),
          acquisition({
            ...exactBasis('110000.00'),
            id: X,
            sellerPartyIds: [B],
            acquiredShare: { numerator: 2, denominator: 5 },
            contractDate: day(transfer),
            economicTransferDate: economic ? day(transfer) : null,
          }),
        ],
        ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', until, W), ownership(C, '2/5', transfer, null, X)],
      },
      reg,
    );
  };

  it('B sells to C on 2029-07-01: B’s 2029 is 6/12 = 1,017.60, PROVISIONAL with DISPOSAL_YEAR_TO_VERIFY; C’s component from July', () => {
    const s = sale('2029-07-01', true);
    const w = component(s, 0);
    const b2029 = ownerIn(yearOf(w, 2029), B);
    expect([b2029?.months, amount(b2029?.amount), b2029?.calculationStatus]).toEqual([6, '1017.60', 'PROVISIONAL']);
    expect(b2029?.flags).toEqual([
      {
        code: 'DISPOSAL_YEAR_TO_VERIFY',
        details: { lastDay: '2029-06-30', months: 6, endMonthCounts: true, legalBasis: 'R 7.4 Abs. 8 EStR (reviewer input on #173; VERIFY)' },
      },
    ]);
    expect(w.owners.find((o) => o.ownerPartyId === B)?.tenure).toEqual({
      from: '2026-07-01',
      lastDay: '2029-06-30',
      lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE',
    });
    expect(ownerIn(yearOf(w, 2030), B)).toBeUndefined();
    expect(component(s, 1).start).toMatchObject({ date: '2029-07-01', month: '2029-07' });
    expect(ownerIn(yearOf(w, 2028), B)?.flags).toEqual([]);
    // The seller's residual value stays as it was; nothing passes to the buyer.
    expect(amount(ownerIn(yearOf(w, 2029), B)?.residualValue)).toBe(amount({ amount: (101760 - 1017.6 - 2035.2 * 2 - 1017.6).toFixed(2) } as Money));
  });

  it('a sale on the 15th: endMonthCounts true takes the month of the last day (7/12 = 1,187.20), false does not (6/12 = 1,017.60)', () => {
    expect(amount(ownerIn(yearOf(component(sale('2029-07-15', true), 0), 2029), B)?.amount)).toBe('1187.20');
    const notCounting = withParameters((p) => ({ ...p, end: { ...p.end, disposal: { ...p.end.disposal, endMonthCounts: false } } }));
    expect(amount(ownerIn(yearOf(component(sale('2029-07-15', true, notCounting), 0), 2029), B)?.amount)).toBe('1017.60');
    // On the 1st both agree.
    expect(amount(ownerIn(yearOf(component(sale('2029-07-01', true, notCounting), 0), 2029), B)?.amount)).toBe('1017.60');
  });

  it('15 November: 11/12 of the year for the seller with endMonthCounts true', () => {
    const s = derive({
      ...acc8({ from: 2029, to: 2029 }),
      acquisitions: [
        acquisition({ economicTransferDate: day('2026-01-01') }),
        acquisition({ ...exactBasis('1.00'), id: X, sellerPartyIds: [A], contractDate: day('2029-11-15'), economicTransferDate: day('2029-11-15') }),
      ],
      ownerships: [ownership(A, '1/1', '2026-01-01', '2029-11-14', W), ownership(C, '1/1', '2029-11-15', null, X)],
    });
    expect(amount(ownerIn(yearOf(component(s, 0), 2029), A)?.amount)).toBe('4664.00');
    expect(ownerIn(yearOf(component(s, 0), 2029), A)?.months).toBe(11);
  });

  it('DISPOSAL_DATE_MISSING without the buyer’s Acquisition: B’s 2029 NOT_CALCULABLE with amount null (never 0.00), 2028 computed, A shown', () => {
    const s = derive({
      ...acc8({ from: 2028, to: 2030 }),
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2029-06-30', W)],
    });
    const w = component(s);
    const b2029 = ownerIn(yearOf(w, 2029), B);
    expect(b2029).toMatchObject({ amount: null, residualValue: null, months: null, calculationStatus: 'NOT_CALCULABLE' });
    expect(b2029?.reasons).toEqual([{ code: 'DISPOSAL_DATE_MISSING', details: { validUntil: '2029-06-30', buyerAcquisitionId: null } }]);
    expect(amount(ownerIn(yearOf(w, 2028), B)?.amount)).toBe('2035.20');
    expect(amount(ownerIn(yearOf(w, 2029), A)?.amount)).toBe('3052.80');
    expect(yearOf(w, 2029)).toMatchObject({ amount: null, cumulative: null, residualValue: null, calculationStatus: 'NOT_CALCULABLE' });
    const y2029 = s.years.find((y) => y.year === 2029);
    expect(y2029).toMatchObject({ status: 'PARTIAL', calculationStatus: 'NOT_CALCULABLE', amount: null, residualValue: null });
    expect(y2029?.owners?.map((o) => [o.ownerPartyId, amount(o.amount)])).toEqual([
      [A, '3052.80'],
      [B, null],
    ]);
    // Nothing follows the year of the end.
    expect(ownerIn(yearOf(w, 2030), B)).toBeUndefined();
    expect(w.owners.find((o) => o.ownerPartyId === B)?.tenure).toEqual({ from: '2026-07-01', lastDay: '2029-06-30', lastDaySource: 'VALID_UNTIL' });
  });

  it('DISPOSAL_DATE_MISSING when the buyer’s Acquisition has no economicTransferDate: the buyer named', () => {
    const b2029 = ownerIn(yearOf(component(sale('2029-07-01', false), 0), 2029), B);
    expect(b2029?.reasons).toEqual([{ code: 'DISPOSAL_DATE_MISSING', details: { validUntil: '2029-06-30', buyerAcquisitionId: X } }]);
  });

  it('a DRAFT buyer’s Acquisition gives no cut-off, even with its economicTransferDate: B’s 2029 DISPOSAL_DATE_MISSING, 2028 computed', () => {
    const s = derive({
      ...acc8({ from: 2028, to: 2030 }),
      acquisitions: [
        acquisition(),
        acquisition({
          ...exactBasis('110000.00'),
          id: X,
          status: 'DRAFT',
          sellerPartyIds: [B],
          acquiredShare: { numerator: 2, denominator: 5 },
          contractDate: day('2029-07-01'),
          economicTransferDate: day('2029-07-01'),
        }),
      ],
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2029-06-30', W), ownership(C, '2/5', '2029-07-01', null, X)],
    });
    const w = component(s, 0);
    const b2029 = ownerIn(yearOf(w, 2029), B);
    expect(b2029).toMatchObject({ amount: null, calculationStatus: 'NOT_CALCULABLE' });
    expect(b2029?.reasons).toEqual([{ code: 'DISPOSAL_DATE_MISSING', details: { validUntil: '2029-06-30', buyerAcquisitionId: null } }]);
    expect(amount(ownerIn(yearOf(w, 2028), B)?.amount)).toBe('2035.20');
  });

  it('DISPOSAL_YEAR_TO_VERIFY only while the rule says unverified: a test registry with verified true computes the same, CALCULATED', () => {
    const verified = withParameters((p) => ({ ...p, end: { ...p.end, disposal: { ...p.end.disposal, verified: true } } }));
    const b2029 = ownerIn(yearOf(component(sale('2029-07-01', true, verified), 0), 2029), B);
    expect([amount(b2029?.amount), b2029?.flags, b2029?.calculationStatus]).toEqual(['1017.60', [], 'CALCULATED']);
  });

  it('a share changed by §26.2 without a sale does not end the tenure: A 1/1 closed and continued at 1/1 the next day', () => {
    const s = derive({
      ...acc8({ from: 2027, to: 2029 }),
      acquisitions: [acquisition({ economicTransferDate: day('2026-01-01') })],
      ownerships: [ownership(A, '1/1', '2026-01-01', '2027-12-31', W), ownership(A, '1/1', '2028-01-01', null, null)],
    });
    const w = component(s);
    expect(w.owners[0]?.tenure.lastDay).toBeNull();
    expect([2027, 2028, 2029].map((y) => amount(yearOf(w, y).amount))).toEqual(['5088.00', '5088.00', '5088.00']);
    expect(s.years.flatMap((y) => codes(y.flags))).toEqual([]);
  });

  it('a reduced share keeps the fraction still held (OWNER_SHARE_CHANGED) and never rises again without a purchase', () => {
    const s = derive({
      ...acc8({ from: 2028, to: 2031 }),
      acquisitions: [
        acquisition({ economicTransferDate: day('2026-01-01') }),
        acquisition({
          ...exactBasis('100000.00'),
          id: X,
          sellerPartyIds: [A],
          acquiredShare: { numerator: 1, denominator: 2 },
          contractDate: day('2028-07-01'),
          economicTransferDate: day('2028-07-01'),
        }),
      ],
      ownerships: [
        ownership(A, '1/1', '2026-01-01', '2028-06-30', W),
        ownership(A, '1/2', '2028-07-01', '2029-12-31', null),
        ownership(C, '1/2', '2028-07-01', '2029-12-31', X),
        // A back at 1/1 from 2030 without an Acquisition (C's half came back, not recorded as a purchase).
        ownership(A, '1/1', '2030-01-01', null, null),
      ],
    });
    const w = component(s, 0);
    const a2028 = ownerIn(yearOf(w, 2028), A);
    // 6 months at 1/1, 6 at 1/2: 2,544.00 + 1,272.00.
    expect([amount(a2028?.amount), a2028?.fraction, a2028?.calculationStatus]).toEqual(['3816.00', '1/2', 'PROVISIONAL']);
    expect(a2028?.flags).toEqual([
      {
        code: 'DISPOSAL_YEAR_TO_VERIFY',
        details: { lastDay: '2028-06-30', months: 12, endMonthCounts: true, legalBasis: 'R 7.4 Abs. 8 EStR (reviewer input on #173; VERIFY)' },
      },
      { code: 'OWNER_SHARE_CHANGED', details: { date: '2028-07-01', from: '1/1', to: '1/2' } },
    ]);
    expect([2030, 2031].map((y) => [amount(ownerIn(yearOf(w, y), A)?.amount), ownerIn(yearOf(w, y), A)?.fraction])).toEqual([
      ['2544.00', '1/2'],
      ['2544.00', '1/2'],
    ]);
    // The half held again without a purchase is uncovered.
    expect(s.years.find((y) => y.year === 2030)?.flags.find((f) => f.code === 'OWNER_WITHOUT_ACQUISITION')?.details).toEqual({
      ownerPartyId: A,
      from: '2030-01-01',
      heldShare: '1/1',
      coveredShare: '1/2',
    });
  });

  it('a reduced share without the buyer’s date: that year and every later one NOT_CALCULABLE for the owner', () => {
    const s = derive({
      ...acc8({ from: 2028, to: 2029 }),
      acquisitions: [acquisition({ economicTransferDate: day('2026-01-01') })],
      ownerships: [ownership(A, '1/1', '2026-01-01', '2028-06-30', W), ownership(A, '1/2', '2028-07-01', null, null)],
    });
    for (const y of [2028, 2029]) {
      expect(ownerIn(yearOf(component(s), y), A)).toMatchObject({
        amount: null,
        calculationStatus: 'NOT_CALCULABLE',
        reasons: [{ code: 'DISPOSAL_DATE_MISSING' }],
      });
    }
  });
});

describe('OWNER_WITHOUT_ACQUISITION (P8-D8)', () => {
  const flagged = (s: DepreciationSchedule, year: number) =>
    s.years
      .find((y) => y.year === year)
      ?.flags.filter((f) => f.code === 'OWNER_WITHOUT_ACQUISITION')
      .map((f) => f.details);

  it('an inherited share: B’s 2/5 passes to D the next day without an Acquisition', () => {
    const s = derive({
      ...acc8({ from: 2029, to: 2030 }),
      acquisitions: [
        acquisition(),
        acquisition({
          ...exactBasis('1.00'),
          id: X,
          status: 'CONFIRMED',
          sellerPartyIds: [C],
          contractDate: day('2020-01-01'),
          economicTransferDate: day('2020-01-01'),
        }),
      ].slice(0, 1),
      ownerships: [
        ownership(A, '3/5', '2026-07-01', null, W),
        ownership(B, '2/5', '2026-07-01', '2029-06-30', W),
        ownership(D, '2/5', '2029-07-01', null, null),
      ],
    });
    expect(flagged(s, 2029)).toEqual([{ ownerPartyId: D, from: '2029-07-01', heldShare: '2/5', coveredShare: '0/1' }]);
    expect(flagged(s, 2030)).toEqual([{ ownerPartyId: D, from: '2030-01-01', heldShare: '2/5', coveredShare: '0/1' }]);
    expect(s.years.find((y) => y.year === 2029)?.calculationStatus).not.toBe('CALCULATED');
    // At D's owner level: no component, years of 0.00, and the flag.
    const own = derive({
      ...acc8({ from: 2029, to: 2030, ownerPartyId: D }),
      ownerships: [
        ownership(A, '3/5', '2026-07-01', null, W),
        ownership(B, '2/5', '2026-07-01', '2029-06-30', W),
        ownership(D, '2/5', '2029-07-01', null, null),
      ],
    });
    expect(own.components).toEqual([]);
    expect(own.years.map((y) => [amount(y.amount), codes(y.flags)])).toEqual([
      ['0.00', ['OWNER_WITHOUT_ACQUISITION']],
      ['0.00', ['OWNER_WITHOUT_ACQUISITION']],
    ]);
  });

  it('a share raised by §26.2 without an Acquisition: A 3/5 → 4/5', () => {
    const s = derive({
      ...acc8({ from: 2028, to: 2028 }),
      ownerships: [
        ownership(A, '3/5', '2026-07-01', '2027-12-31', W),
        ownership(A, '4/5', '2028-01-01', null, null),
        ownership(B, '1/5', '2026-07-01', null, W),
      ],
    });
    expect(flagged(s, 2028)).toEqual([{ ownerPartyId: A, from: '2028-01-01', heldShare: '4/5', coveredShare: '3/5' }]);
  });

  it('an owner with no Acquisition at all', () => {
    const s = derive({ ...acc8({ from: 2026, to: 2026 }), acquisitions: [], ownerships: [ownership(D, '1/1', '2020-01-01', null, null)] });
    expect(flagged(s, 2026)).toEqual([{ ownerPartyId: D, from: '2026-01-01', heldShare: '1/1', coveredShare: '0/1' }]);
    expect(s.review.open).toEqual([{ code: 'OWNER_WITHOUT_ACQUISITION', count: 1 }]);
  });
});

describe('an existing owner buying a further share (§28.1A "Effect on §59A")', () => {
  /** A 1/2 (W) buys B's 1/2 in X on 2028-07-01: O1 and O2 end on 2028-06-30, O3 A 1/1 carries X. */
  const furtherShare = (xShare: string, xStatus = 'CONFIRMED') => {
    const [n, d] = xShare.split('/').map(Number) as [number, number];
    return {
      ...acc8({ from: 2028, to: 2029 }),
      acquisitions: [
        acquisition({ economicTransferDate: day('2026-01-01'), acquiredShare: { numerator: 1, denominator: 1 } }),
        acquisition({
          ...exactBasis('130000.00'),
          id: X,
          status: xStatus,
          sellerPartyIds: [B],
          acquiredShare: { numerator: n, denominator: d },
          contractDate: day('2028-06-01'),
          economicTransferDate: day('2028-07-01'),
        }),
      ],
      ownerships: [
        ownership(A, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(B, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(A, '1/1', '2028-07-01', null, X),
      ],
    };
  };

  it('W and X both computed in full from the transfer: no BUYER_ALREADY_OWNER, no OWNER_WITHOUT_ACQUISITION; W unchanged by O1’s end', () => {
    const s = derive(furtherShare('1/2'));
    const [w, x] = [component(s, 0), component(s, 1)];
    expect([w.status, x.status, x.reasons]).toEqual(['COMPUTABLE', 'COMPUTABLE', []]);
    expect(x.owners.map((o) => [o.ownerPartyId, o.share, o.shareBefore, o.acquiredShare, o.weight, amount(o.basis)])).toEqual([
      [A, '1/1', '1/2', '1/2', '1/1', '130000.00'],
    ]);
    // A's half of W keeps depreciating at 1/1 of A's part (2,544.00 a year), through O3.
    expect(w.owners.find((o) => o.ownerPartyId === A)?.tenure.lastDay).toBeNull();
    expect([2028, 2029].map((y) => [amount(ownerIn(yearOf(w, y), A)?.amount), ownerIn(yearOf(w, y), A)?.fraction])).toEqual([
      ['2544.00', '1/1'],
      ['2544.00', '1/1'],
    ]);
    expect(amount(yearOf(x, 2029).amount)).toBe('2600.00');
    expect(s.years.flatMap((y) => codes(y.flags)).filter((c) => c === 'OWNER_WITHOUT_ACQUISITION' || c === 'BUYER_ALREADY_OWNER')).toEqual([]);
  });

  it('a later reduction across both components is pro rata, flagged SHARE_REDUCTION_SPLIT_TO_VERIFY; with one component it is not', () => {
    const base = furtherShare('1/2');
    const s = derive({
      ...base,
      acquisitions: [
        ...base.acquisitions,
        acquisition({
          ...exactBasis('140000.00'),
          id: Y,
          sellerPartyIds: [A],
          acquiredShare: { numerator: 1, denominator: 2 },
          contractDate: day('2029-07-01'),
          economicTransferDate: day('2029-07-01'),
        }),
      ],
      ownerships: [
        ownership(A, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(B, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(A, '1/1', '2028-07-01', '2029-06-30', X),
        ownership(A, '1/2', '2029-07-01', null, null),
        ownership(C, '1/2', '2029-07-01', null, Y),
      ],
    });
    for (const c of [component(s, 0), component(s, 1)]) {
      const a = ownerIn(yearOf(c, 2029), A);
      expect(a?.fraction).toBe('1/2');
      expect(codes(a?.flags ?? [])).toEqual(['DISPOSAL_YEAR_TO_VERIFY', 'OWNER_SHARE_CHANGED', 'SHARE_REDUCTION_SPLIT_TO_VERIFY']);
      expect(a?.flags.find((f) => f.code === 'SHARE_REDUCTION_SPLIT_TO_VERIFY')?.details).toEqual({
        date: '2029-07-01',
        from: '1/1',
        to: '1/2',
        componentIds: [`ACQUISITION:${W}`, `ACQUISITION:${X}`],
      });
    }
    // One component only: the reduction is not split, so no SHARE_REDUCTION_SPLIT_TO_VERIFY (the reduced-share test above).
  });

  it('the legacy 1/1 workaround (X confirmed with acquiredShare 1/1) is still BUYER_ALREADY_OWNER, not computed; W unaffected', () => {
    const s = derive(furtherShare('1/1'));
    const x = component(s, 1);
    expect(x.status).toBe('NOT_COMPUTABLE');
    expect(x.reasons).toEqual([{ code: 'BUYER_ALREADY_OWNER', details: { ownerPartyIds: [A], expected: '1/1', actual: '1/2' } }]);
    expect(yearOf(x, 2029)).toMatchObject({ amount: null, calculationStatus: 'NOT_CALCULABLE' });
    expect(component(s, 0).status).toBe('COMPUTABLE');
    expect(amount(ownerIn(yearOf(component(s, 0), 2029), A)?.amount)).toBe('2544.00');
  });

  it('a DRAFT X is listed with ACQUISITION_NOT_CONFIRMED only', () => {
    const x = component(derive(furtherShare('1/1', 'DRAFT')), 1);
    expect(x.reasons).toEqual([{ code: 'ACQUISITION_NOT_CONFIRMED', details: {} }]);
  });
});

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
    expect(s.components.map((c) => c.acquisitionId)).toEqual([W]);
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

  it('a start in 2020: 2020–2022 with @1 (HISTORICAL_RULE_TO_VERIFY, PROVISIONAL), from 2023 @2 (CALCULATED), the same rate, no break', () => {
    const s = derive(sole({ contractDate: day('2020-03-01'), economicTransferDate: day('2020-04-01') }, {}, { from: 2020, to: 2024 }));
    const c = component(s);
    expect(c.years.map((y) => [y.year, y.rule?.version, y.rule?.band, amount(y.amount), y.calculationStatus, codes(ownerIn(y, A)?.flags ?? [])])).toEqual([
      [2020, 1, 'A', '3816.00', 'PROVISIONAL', ['HISTORICAL_RULE_TO_VERIFY']],
      [2021, 1, 'A', '5088.00', 'PROVISIONAL', ['HISTORICAL_RULE_TO_VERIFY']],
      [2022, 1, 'A', '5088.00', 'PROVISIONAL', ['HISTORICAL_RULE_TO_VERIFY']],
      [2023, 2, 'B', '5088.00', 'CALCULATED', []],
      [2024, 2, 'B', '5088.00', 'CALCULATED', []],
    ]);
    expect(amount(yearOf(c, 2023).cumulative)).toBe('19080.00');
    expect(ownerIn(yearOf(c, 2020), A)?.flags[0]).toEqual({ code: 'HISTORICAL_RULE_TO_VERIFY', details: { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 1 } });
    expect(s.ruleVersions.map((v) => [v.version, v.status, v.years])).toEqual([
      [1, 'SUPERSEDED', [2020, 2021, 2022]],
      [2, 'ACTIVE', [2023, 2024]],
    ]);
    expect(s.review.open).toEqual([{ code: 'HISTORICAL_RULE_TO_VERIFY', count: 3 }]);
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
    const provisional = derive({ ...acc8(), acquisitions: [acquisition({ economicTransferDate: null, contractDate: day('2026-07-01') })] });
    expect(component(provisional).years.map((y) => y.calculationStatus)).toEqual(['PROVISIONAL', 'PROVISIONAL']);
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

  it('HISTORICAL_RULE_TO_VERIFY disappears with a test registry that marks @1 verified', () => {
    const verified = new RuleRegistry([
      { ...DE_AFA_BUILDING_LINEAR_V1, parameters: { ...DE_AFA_BUILDING_LINEAR_V1.parameters, verified: true } },
      DE_AFA_BUILDING_LINEAR_V2,
    ]);
    const c = component(derive(sole({ contractDate: day('2020-03-01'), economicTransferDate: day('2020-04-01') }, {}, { from: 2020, to: 2020 }), verified));
    expect([yearOf(c, 2020).calculationStatus, ownerIn(yearOf(c, 2020), A)?.flags]).toEqual(['CALCULATED', []]);
  });
});

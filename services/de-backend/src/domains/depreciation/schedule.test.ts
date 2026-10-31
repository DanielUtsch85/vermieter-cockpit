import { describe, expect, it } from 'vitest';
import type { DepreciationAsset } from './asset.js';
import type { ScheduleComponent } from './schedule.js';
import { A, B, C, D, W, X, acc8, acquisition, day, life, ownership } from './schedule.test-support.js';
import { amount, cents, codes, component, derive, exactBasis, ownerIn, random, sole, withParameters, yearOf } from './schedule-purchase.test-support.js';

/**
 * VC-8-02 domain (api-design.md §59A, §28.1A "Effect on §59A"): the schedule of the purchase, derived from synthetic
 * inputs with Depreciation's own registry (never `domains/tax-rules/`). Every date is explicit; `today` only sets the
 * default range. The figures are ACC8's purchase (basis 254,400.00 at 2 %, 5,088.00 a year) and its variants.
 */
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
    return [c.start?.firstYearMonths, amount(yearOf(c, 2026)?.amount)];
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

  it('TRANSFER_DATE_MISSING (§59A open question 6, decided 2026-10-31): without economicTransferDate not computable in every year, amounts null', () => {
    const s = derive(sole({ economicTransferDate: null, contractDate: day('2026-04-20') }, {}, { from: 2026, to: 2027 }));
    const c = component(s);
    const reason = { code: 'TRANSFER_DATE_MISSING', details: { contractDate: '2026-04-20' } };
    expect(c).toMatchObject({ status: 'NOT_COMPUTABLE', reasons: [reason], start: null, rate: null, end: null, flags: [] });
    expect(amount(c.basis.amount)).toBe('254400.00');
    expect(c.years.map((y) => [y.year, y.calculationStatus, y.amount, y.cumulative, y.residualValue, y.months, y.reasons])).toEqual([
      [2026, 'NOT_CALCULABLE', null, null, null, null, [{ code: 'TRANSFER_DATE_MISSING', details: { ownerPartyIds: [A] } }]],
      [2027, 'NOT_CALCULABLE', null, null, null, null, [{ code: 'TRANSFER_DATE_MISSING', details: { ownerPartyIds: [A] } }]],
    ]);
    expect(c.years.map((y) => ownerIn(y, A))).toEqual(
      [2026, 2027].map(() => ({
        ownerPartyId: A,
        months: null,
        fraction: null,
        amount: null,
        residualValue: null,
        calculationStatus: 'NOT_CALCULABLE',
        reasons: [reason],
        flags: [],
      })),
    );
    expect(s.years.map((y) => [y.year, y.status, y.calculationStatus, y.amount, y.residualValue, y.owners])).toEqual([
      [2026, 'DEPRECIATION_NOT_AVAILABLE', 'NOT_CALCULABLE', null, null, [{ ownerPartyId: A, amount: null }]],
      [2027, 'DEPRECIATION_NOT_AVAILABLE', 'NOT_CALCULABLE', null, null, [{ ownerPartyId: A, amount: null }]],
    ]);
    expect(s.years[0]?.reasons).toEqual([{ code: 'TRANSFER_DATE_MISSING', details: { componentIds: [c.componentId] } }]);
    expect(s).toMatchObject({ status: 'DEPRECIATION_NOT_AVAILABLE', review: { open: [{ code: 'TRANSFER_DATE_MISSING', count: 1 }] } });
    // The share is still covered by its Acquisition: no OWNER_WITHOUT_ACQUISITION for the undated purchase.
    expect(s.years.flatMap((y) => codes(y.flags))).toEqual([]);
  });

  it('counter-check: the contract date is never the start (no month, rate, end or owner tenure from it, in any range, and no TRANSFER_DATE_ASSUMED)', () => {
    for (const contract of ['2026-01-01', '2026-04-20', '2026-12-31']) {
      const s = derive(sole({ economicTransferDate: null, contractDate: day(contract) }, {}, { from: 2000, to: 2100 }));
      const c = component(s);
      expect([c.status, c.start, c.rate, c.end, c.owners.map((o) => o.tenure.from)]).toEqual(['NOT_COMPUTABLE', null, null, null, [null]]);
      // Its years run from the contract's year (the transfer is never before it) to `to`, every one without a figure.
      expect(c.years.map((y) => y.year)).toEqual(Array.from({ length: 2100 - 2026 + 1 }, (_, i) => 2026 + i));
      expect(c.years.every((y) => y.amount === null && y.rule === null && y.owners.every((o) => o.amount === null && o.months === null))).toBe(true);
      expect(s.years.filter((y) => y.year < 2026).every((y) => y.status === 'AVAILABLE' && amount(y.amount) === '0.00')).toBe(true);
      expect(JSON.stringify(s)).not.toContain('TRANSFER_DATE_ASSUMED');
      expect(JSON.stringify(s)).not.toContain('CONTRACT_DATE');
    }
    // The same purchase with the date entered is computed from it, not from the contract.
    const dated = component(derive(sole({ economicTransferDate: day('2026-07-01'), contractDate: day('2026-04-20') }, {}, { from: 2026, to: 2026 })));
    expect([dated.status, dated.start?.date, dated.start?.dateSource, amount(yearOf(dated, 2026).amount)]).toEqual([
      'COMPUTABLE',
      '2026-07-01',
      'ECONOMIC_TRANSFER_DATE',
      '2544.00',
    ]);
  });

  it('TRANSFER_DATE_MISSING beside the other reasons: before HISTORICAL_RULE_NOT_SUPPORTED, which the contract alone still gives (a 2005 contract)', () => {
    const c = component(derive(sole({ economicTransferDate: null, contractDate: day('2005-06-01') }, {}, { from: 2005, to: 2006 })));
    expect(c.reasons).toEqual([
      { code: 'TRANSFER_DATE_MISSING', details: { contractDate: '2005-06-01' } },
      { code: 'HISTORICAL_RULE_NOT_SUPPORTED', details: { contractDate: '2005-06-01', startDate: null, supportedFrom: '2006-01-01' } },
    ]);
  });

  it('the start month not counted (a test registry): the first year loses one twelfth', () => {
    const notCounted = withParameters((p) => ({ ...p, firstYear: { ...p.firstYear, startMonthCounts: false } }));
    const c = component(derive(sole({ economicTransferDate: day('2026-07-01') }, {}, { from: 2026, to: 2026 }), notCounted));
    expect([c.start?.firstYearMonths, amount(yearOf(c, 2026).amount)]).toEqual([5, '2120.00']);
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

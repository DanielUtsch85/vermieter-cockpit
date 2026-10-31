import { describe, expect, it } from 'vitest';
import { RuleRegistry, centsOf, type Money } from '../../shared/index.js';
import type { CapitalizedItem } from './capitalized-item.js';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { deriveSchedule, type ComponentYear, type DepreciationSchedule, type ScheduleComponent, type ScheduleInput } from './schedule.js';
import type { ItemComponent } from './schedule-items.js';
import { A, B, C, D, W, X, Y, acc8, acquisition, asset, capitalized, day, eur, kitchen, life, ownership } from './schedule.test-support.js';

/**
 * VC-8-03 domain (api-design.md §59B): the capitalised items of the building and a separate asset's schedule, derived
 * from synthetic inputs with Depreciation's own registry. ACC8 (synthetic): the purchase of 254,400.00 at 2 % from
 * 2026-07-01, A 3/5 and B 2/5; the repair of 2027-03-10 (35,700.00) and the Sonderumlage use of 2028-02-15 (9,000.00),
 * both capitalised on the anschaffungsnahe check; the Einbauküche (6,000.00) as a separate asset of 10 years.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
const withParameters = (change: (p: BuildingLinearParameters) => BuildingLinearParameters) =>
  new RuleRegistry([
    { ...DE_AFA_BUILDING_LINEAR_V1, parameters: change(DE_AFA_BUILDING_LINEAR_V1.parameters) },
    { ...DE_AFA_BUILDING_LINEAR_V2, parameters: change(DE_AFA_BUILDING_LINEAR_V2.parameters) },
    ...DEPRECIATION_RULE_VERSIONS.filter((v) => v.ruleCode !== 'DE_AFA_BUILDING_LINEAR'),
  ]);
const monthOfDate = withParameters((p) => ({ ...p, subsequentCostStart: { ...p.subsequentCostStart, method: 'MONTH_OF_DATE' } }));
const perItem = withParameters((p) => ({ ...p, subsequentCostEnd: { ...p.subsequentCostEnd, method: 'PER_ITEM_SERIES' } }));
const startVerified = withParameters((p) => ({ ...p, subsequentCostStart: { ...p.subsequentCostStart, verified: true } }));

const REPAIR = '0000eeee-0000-4000-8000-000000000071';
const USE = '0000eeee-0000-4000-8000-000000000091';
const EXTENSION = '0000eeee-0000-4000-8000-000000000072';
const REFUND = '0000eeee-0000-4000-8000-000000000073';
const KITCHEN_SPLIT = '0000eeee-0000-4000-8000-000000000061';
const repair = (overrides: Partial<CapitalizedItem> = {}) =>
  capitalized(REPAIR, '2027-03-10', '35700.00', undefined, { netAmount: eur('30000.00'), anschaffungsnaheAcquisitionId: W, ...overrides });
const use = (overrides: Partial<CapitalizedItem> = {}) =>
  capitalized(USE, '2028-02-15', '9000.00', undefined, {
    sourceType: 'WEG_ASSESSMENT_USE',
    sourcePosition: 1,
    dateSource: 'USE',
    taxCategory: 'WEG_SPENDING',
    anschaffungsnaheAcquisitionId: W,
    ...overrides,
  });
const derive = (input: ScheduleInput, reg: RuleRegistry = registry) => deriveSchedule(input, reg);
const items = (s: DepreciationSchedule) => s.components.filter((c): c is ItemComponent => c.kind === 'CAPITALIZED_ITEM');
const item = (s: DepreciationSchedule, i = 0) => items(s)[i] as ItemComponent;
const yearOf = (c: ItemComponent, year: number) => c.years.find((y) => y.year === year) as ComponentYear;
const amount = (m: Money | null | undefined) => (m === null || m === undefined ? null : m.amount);
const owner = (y: ComponentYear | undefined, party: string) => y?.owners.find((o) => o.ownerPartyId === party);
const ownerAmounts = (y: ComponentYear | undefined) => [amount(owner(y, A)?.amount), amount(owner(y, B)?.amount)];
const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);
const cents = (m: Money | null | undefined) => (m === null || m === undefined ? 0n : centsOf(m));
function random(seed: number) {
  let state = seed;
  return (max: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % max;
  };
}

describe('ACC8: the repair and the use capitalised (§59B "Response")', () => {
  const s = derive(acc8({ from: 2027, to: 2028, capitalizedItems: [repair(), use()] }));

  it('START_OF_YEAR: 714.00 (A 428.40, B 285.60) in 2027 and 180.00 (A 108.00, B 72.00) in 2028; 5,802.00 and 5,982.00', () => {
    expect(s.components.map((c) => c.componentId)).toEqual([`ACQUISITION:${W}`, `TRANSACTION_SPLIT:${REPAIR}`, `WEG_ASSESSMENT_USE:${USE}:1`]);
    const r = item(s);
    expect(r).toMatchObject({
      kind: 'CAPITALIZED_ITEM',
      status: 'COMPUTABLE',
      reasons: [],
      start: { date: '2027-03-10', dateSource: 'ITEM_DATE', method: 'START_OF_YEAR', month: '2027-01', firstYearMonths: 12 },
      rate: { kind: 'BAND', band: 'B', ratePercent: '2', rate: '1/50', usefulLifeYears: null },
      end: { lastYear: 2076, lastMonth: '2076-07' },
      notOwned: null,
    });
    expect(r.source).toMatchObject({
      sourceType: 'TRANSACTION_SPLIT',
      sourceId: REPAIR,
      sourcePosition: null,
      date: '2027-03-10',
      anschaffungsnaheAcquisitionId: W,
    });
    expect(r.owners.map((o) => [o.ownerPartyId, o.share, o.basis.amount, o.firstMonth, o.rate])).toEqual([
      [A, '3/5', '21420.00', '2027-01', '1/50'],
      [B, '2/5', '14280.00', '2027-01', '1/50'],
    ]);
    expect([amount(yearOf(r, 2027).amount), ...ownerAmounts(yearOf(r, 2027))]).toEqual(['714.00', '428.40', '285.60']);
    expect(amount(yearOf(r, 2028).residualValue)).toBe('34272.00');
    const u = item(s, 1);
    expect(u.start).toMatchObject({ month: '2028-01', firstYearMonths: 12 });
    expect([amount(yearOf(u, 2028).amount), ...ownerAmounts(yearOf(u, 2028))]).toEqual(['180.00', '108.00', '72.00']);
    expect(s.years.map((y) => [y.year, amount(y.amount), y.owners?.map((o) => amount(o.amount)), amount(y.residualValue)])).toEqual([
      [2027, '5802.00', ['3481.20', '2320.80'], '281754.00'],
      [2028, '5982.00', ['3589.20', '2392.80'], '284772.00'],
    ]);
    expect(s.excludedItems).toEqual([]);
  });

  it('the net amount is never the basis (P8-D2): the repair is 35,700.00, not 30,000.00', () => {
    expect(item(s).basis).toEqual({ amount: eur('35700.00'), netAmount: eur('30000.00'), amountUsed: 'GROSS_LINE_AMOUNT' });
  });

  it('SUBSEQUENT_COST_START_TO_VERIFY: an open flag of the component, every year PROVISIONAL (review on #186); gone with verified', () => {
    for (const c of items(s)) {
      expect(c.flags).toContainEqual({
        code: 'SUBSEQUENT_COST_START_TO_VERIFY',
        details: {
          date: c.source.date,
          method: 'START_OF_YEAR',
          firstMonth: c.start.month,
          legalBasis: 'R 7.4 Abs. 9 S. 3 EStR (reviewer input on #173; VERIFY)',
        },
      });
      for (const y of c.years) expect(y.calculationStatus).toBe('PROVISIONAL');
    }
    expect(s.review.open).toContainEqual({ code: 'SUBSEQUENT_COST_START_TO_VERIFY', count: 2 });
    expect(s.review.info).toContainEqual({ code: 'ANSCHAFFUNGSNAHE_CAPITALIZED', count: 2 });
    const verified = derive(acc8({ from: 2027, to: 2028, capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null })] }), startVerified);
    expect(codes(item(verified).flags)).toEqual([]);
    expect(item(verified).years.map((y) => y.calculationStatus)).toEqual(['CALCULATED', 'CALCULATED']);
  });

  it('ANSCHAFFUNGSNAHE_CAPITALIZED (informative) with the Acquisition; the extension of 2030 without it: 240.00 a year', () => {
    expect(item(s).flags).toContainEqual({ code: 'ANSCHAFFUNGSNAHE_CAPITALIZED', details: { acquisitionId: W } });
    const ext = derive(acc8({ from: 2030, to: 2031, capitalizedItems: [capitalized(EXTENSION, '2030-09-15', '12000.00')] }));
    expect(codes(item(ext).flags)).toEqual(['SUBSEQUENT_COST_START_TO_VERIFY']);
    expect(item(ext).years.map((y) => [y.year, amount(y.amount), ...ownerAmounts(y)])).toEqual([
      [2030, '240.00', '144.00', '96.00'],
      [2031, '240.00', '144.00', '96.00'],
    ]);
    expect(amount(ext.years[0]?.amount)).toBe('5328.00');
  });

  it('MONTH_OF_DATE (a test registry): 595.00 (10/12) and 165.00 (11/12), as phase-8-plan ACC8 shows', () => {
    const m = derive(acc8({ from: 2027, to: 2028, capitalizedItems: [repair(), use()] }), monthOfDate);
    expect(item(m).start).toMatchObject({ method: 'MONTH_OF_DATE', month: '2027-03', firstYearMonths: 10 });
    expect(amount(yearOf(item(m), 2027).amount)).toBe('595.00');
    expect(amount(yearOf(item(m, 1), 2028).amount)).toBe('165.00');
  });

  it('not before the owner’s start: an item of 2026-09-15 after a transfer on 2026-07-01 counts from July 2026 (6/12)', () => {
    const early = derive(acc8({ from: 2026, to: 2027, capitalizedItems: [capitalized(EXTENSION, '2026-09-15', '12000.00')] }));
    const c = item(early);
    expect(c.start.month).toBe('2026-01');
    expect(c.owners.map((o) => o.firstMonth)).toEqual(['2026-07', '2026-07']);
    expect([yearOf(c, 2026).months, amount(yearOf(c, 2026).amount), amount(yearOf(c, 2027).amount)]).toEqual([6, '120.00', '240.00']);
  });

  it('before the user capitalises (the sources DEDUCTIBLE): no item component; the suggestion moves nothing', () => {
    const deductible = derive(acc8({ from: 2027, to: 2028, capitalizedItems: [repair({ treatment: 'DEDUCTIBLE', anschaffungsnaheAcquisitionId: null })] }));
    expect(deductible.components.map((c) => c.kind)).toEqual(['ACQUISITION']);
    expect(deductible.years.map((y) => amount(y.amount))).toEqual(['5088.00', '5088.00']);
  });
});

describe('the end: one pooled basis per tenure (§59B "The end", decided 2026-10-31, provisional)', () => {
  const full = (reg: RuleRegistry = registry) => derive(acc8({ from: 2075, to: 2078, capitalizedItems: [repair(), use()] }), reg);

  it('POOLED_BASIS: the repair ends 2076-07, the use 2076-08; the overflow after the purchase’s end goes to the oldest part first', () => {
    const s = full();
    expect(item(s).end).toEqual({ lastYear: 2076, lastMonth: '2076-07' });
    expect(item(s, 1).end).toEqual({ lastYear: 2076, lastMonth: '2076-08' });
    // 2076: the repair takes its residual in July; the use 180.00 own + the overflow (2 % of the whole basis from July).
    expect(amount(yearOf(item(s), 2076).amount)).toBe('714.00');
    expect(amount(yearOf(item(s, 1), 2076).amount)).toBe('360.00');
    // Every part at most its basis: the cumulative AfA equals the basis exactly at the end.
    for (const c of items(s)) expect(amount(yearOf(c, 2076).residualValue)).toBe('0.00');
  });

  it('PER_ITEM_SERIES (a test registry): the repair ends 2076-12, the use 2077-12', () => {
    const s = full(perItem);
    expect(item(s).end).toEqual({ lastYear: 2076, lastMonth: '2076-12' });
    expect(item(s, 1).end).toEqual({ lastYear: 2077, lastMonth: '2077-12' });
  });

  it('SUBSEQUENT_COST_END_TO_VERIFY on A’s and B’s 2076 and 2077 under either value, through the per-item end (review on #180)', () => {
    for (const reg of [registry, perItem]) {
      const s = full(reg);
      const flagged = items(s).flatMap((c) =>
        c.years.flatMap((y) =>
          y.owners.filter((o) => codes(o.flags).includes('SUBSEQUENT_COST_END_TO_VERIFY')).map((o) => `${c.componentId}/${y.year}/${o.ownerPartyId}`),
        ),
      );
      expect(flagged).toEqual([
        `TRANSACTION_SPLIT:${REPAIR}/2076/${A}`,
        `TRANSACTION_SPLIT:${REPAIR}/2076/${B}`,
        `WEG_ASSESSMENT_USE:${USE}:1/2076/${A}`,
        `WEG_ASSESSMENT_USE:${USE}:1/2076/${B}`,
        `WEG_ASSESSMENT_USE:${USE}:1/2077/${A}`,
        `WEG_ASSESSMENT_USE:${USE}:1/2077/${B}`,
      ]);
      expect(items(s).every((c) => c.years.filter((y) => y.year === 2075).every((y) => y.calculationStatus === 'PROVISIONAL'))).toBe(true);
    }
    // Under POOLED_BASIS 2077 is listed with the use's amount 0.00 and its per-item amount in alternativeAmount.
    const u2077 = yearOf(item(full(), 1), 2077);
    expect(ownerAmounts(u2077)).toEqual(['0.00', '0.00']);
    expect(owner(u2077, A)?.flags).toEqual([
      {
        code: 'SUBSEQUENT_COST_END_TO_VERIFY',
        details: {
          exhaustedComponentId: `ACQUISITION:${W}`,
          exhaustedLastMonth: '2076-06',
          method: 'POOLED_BASIS',
          alternativeMethod: 'PER_ITEM_SERIES',
          alternativeLastMonth: '2077-12',
          alternativeAmount: { amount: '108.00', currency: 'EUR' },
        },
      },
    ]);
    expect(u2077.calculationStatus).toBe('PROVISIONAL');
  });

  it('counter-check: no flagged year before the first exhaustion (a 3 % purchase of 2024 and an item of 2050)', () => {
    const input: ScheduleInput = {
      asset: asset({ buildingCompletionYear: 2023 }),
      acquisitions: [acquisition({ contractDate: day('2024-01-10'), economicTransferDate: day('2024-02-01') })],
      ownerships: [ownership(A, '3/5', '2024-02-01', null, W), ownership(B, '2/5', '2024-02-01', null, W)],
      capitalizedItems: [capitalized(EXTENSION, '2050-05-05', '12000.00')],
      today: day('2026-10-30'),
      from: 2050,
      to: 2100,
      ownerPartyId: null,
    };
    for (const reg of [registry, perItem]) {
      const c = item(derive(input, reg));
      // 400 months from 2024-02: the purchase ends 2057-05; the item starts 2050-01 at 3 %.
      const flaggedYears = [
        ...new Set(c.years.filter((y) => y.owners.some((o) => codes(o.flags).includes('SUBSEQUENT_COST_END_TO_VERIFY'))).map((y) => y.year)),
      ];
      expect(flaggedYears).toEqual([
        2057, 2058, 2059, 2060, 2061, 2062, 2063, 2064, 2065, 2066, 2067, 2068, 2069, 2070, 2071, 2072, 2073, 2074, 2075, 2076, 2077, 2078, 2079, 2080, 2081,
        2082, 2083,
      ]);
      expect(c.years.filter((y) => y.year < 2057).every((y) => y.owners.every((o) => o.flags.length === 0))).toBe(true);
    }
  });

  it('until the purchase is exhausted every year equals the per-item reading exactly (random items and dates)', () => {
    const next = random(59);
    for (let run = 0; run < 12; run++) {
      const list = Array.from({ length: 1 + next(3) }, (_, i) =>
        capitalized(
          `0000eeee-0000-4000-8000-0000000001${String(run).padStart(2, '0')}${i}`,
          `20${27 + next(40)}-${String(1 + next(12)).padStart(2, '0')}-15`,
          `${1 + next(90000)}.${String(next(100)).padStart(2, '0')}`,
        ),
      );
      const pooled = derive(acc8({ from: 2027, to: 2075, capitalizedItems: list }));
      const series = derive(acc8({ from: 2027, to: 2075, capitalizedItems: list }), perItem);
      expect(pooled.years.map((y) => amount(y.amount))).toEqual(series.years.map((y) => amount(y.amount)));
    }
  });

  it('a sale ends the pool with its parts unexhausted: the residual stays, no overflow after the last month, the buyer without a part', () => {
    const c = acquisition({
      id: X,
      contractDate: day('2030-05-01'),
      economicTransferDate: day('2030-07-01'),
      sellerPartyIds: [B],
      acquiredShare: { numerator: 2, denominator: 5 },
    });
    const input = acc8({
      from: 2029,
      to: 2031,
      acquisitions: [acquisition(), c],
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2030-06-30', W), ownership(C, '2/5', '2030-07-01', null, X)],
      capitalizedItems: [capitalized(EXTENSION, '2028-05-05', '10000.00')],
    });
    const s = derive(input);
    const e = item(s);
    expect(owner(yearOf(e, 2030), B)).toMatchObject({ months: 6, amount: eur('40.00'), calculationStatus: 'PROVISIONAL' });
    expect(codes(owner(yearOf(e, 2030), B)?.flags ?? [])).toContain('DISPOSAL_YEAR_TO_VERIFY');
    expect(owner(yearOf(e, 2031), B)).toBeUndefined();
    expect(owner(yearOf(e, 2031), C)).toBeUndefined();
    expect(e.owners.find((o) => o.ownerPartyId === B)?.tenure).toEqual({
      from: '2026-07-01',
      lastDay: '2030-06-30',
      lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE',
    });
    // The component's residual keeps B's unexhausted part: 10,000.00 − A's 4 × 120.00 − B's 80.00 + 80.00 + 40.00.
    expect(amount(yearOf(e, 2031).residualValue)).toBe('9320.00');
    expect(e.years.flatMap((y) => y.owners.flatMap((o) => codes(o.flags))).includes('SUBSEQUENT_COST_END_TO_VERIFY')).toBe(false);
  });

  it('DISPOSAL_DATE_MISSING: without the buyer’s transfer date the item part’s year of the sale is not computed, never 0.00', () => {
    const s = derive(
      acc8({
        from: 2029,
        to: 2031,
        ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2030-06-30', W)],
        capitalizedItems: [capitalized(EXTENSION, '2028-05-05', '10000.00')],
      }),
    );
    const y = yearOf(item(s), 2030);
    expect(owner(y, B)).toMatchObject({ amount: null, calculationStatus: 'NOT_CALCULABLE', reasons: [{ code: 'DISPOSAL_DATE_MISSING' }] });
    expect(owner(y, A)?.amount).toEqual(eur('120.00'));
    expect([y.amount, y.calculationStatus]).toEqual([null, 'NOT_CALCULABLE']);
    expect(amount(yearOf(item(s), 2029).amount)).toBe('200.00');
  });

  it('a buy-back after a sale is a new tenure and a new pool: its exhaustion is the new purchase’s, the earlier pool kept its residual', () => {
    const x = acquisition({ id: X, contractDate: day('2030-05-01'), economicTransferDate: day('2030-07-01'), sellerPartyIds: [A] });
    const y = acquisition({ id: Y, contractDate: day('2032-05-01'), economicTransferDate: day('2032-07-01'), sellerPartyIds: [D] });
    const s = derive({
      asset: asset(),
      acquisitions: [acquisition(), x, y],
      ownerships: [
        ownership(A, '1/1', '2026-07-01', '2030-06-30', W),
        ownership(D, '1/1', '2030-07-01', '2032-06-30', X),
        ownership(A, '1/1', '2032-07-01', null, Y),
      ],
      capitalizedItems: [
        capitalized(EXTENSION, '2028-05-05', '10000.00', [[A, '1/1']]),
        capitalized(REFUND.replace('73', '74'), '2033-05-05', '10000.00', [[A, '1/1']]),
      ],
      today: day('2026-10-30'),
      from: 2028,
      to: 2100,
      ownerPartyId: null,
    });
    const [first, second] = items(s) as [ItemComponent, ItemComponent];
    expect(first.end).toEqual({ lastYear: 2030, lastMonth: '2030-06' });
    expect(amount(yearOf(first, 2030).residualValue)).toBe('9500.00');
    expect(second.owners[0]?.tenure.from).toBe('2032-07-01');
    const flag = second.years.flatMap((yr) => yr.owners.flatMap((o) => o.flags)).find((f) => f.code === 'SUBSEQUENT_COST_END_TO_VERIFY');
    expect(flag?.details).toMatchObject({ exhaustedComponentId: `ACQUISITION:${Y}`, exhaustedLastMonth: '2082-06' });
  });

  it('a refund takes no overflow and leaves the pool’s end unchanged; its years are ≤ 0 and sum to its basis', () => {
    const base = derive(acc8({ from: 2026, to: 2100, capitalizedItems: [repair(), use()] }));
    const withRefund = derive(acc8({ from: 2026, to: 2100, capitalizedItems: [repair(), use(), capitalized(REFUND, '2031-04-04', '-1000.00')] }));
    expect(
      items(withRefund)
        .slice(0, 2)
        .map((c) => c.end),
    ).toEqual(items(base).map((c) => c.end));
    const refund = items(withRefund)[2] as ItemComponent;
    expect(codes(refund.flags)).toEqual(['CAPITALIZED_REFUND', 'SUBSEQUENT_COST_START_TO_VERIFY']);
    expect(refund.years.every((y) => cents(y.amount) <= 0n)).toBe(true);
    expect(refund.years.reduce((sum, y) => sum + cents(y.amount), 0n)).toBe(-100000n);
    expect(amount(yearOf(refund, 2031).amount)).toBe('-20.00');
    expect(ownerAmounts(yearOf(refund, 2031))).toEqual(['-12.00', '-8.00']);
  });
});

describe('the rate (B11; §59B "The rate and the end")', () => {
  const ext = (overrides: Partial<ScheduleInput> = {}) =>
    acc8({ from: 2027, to: 2028, capitalizedItems: [capitalized(EXTENSION, '2027-05-02', '12000.00')], ...overrides });

  it('a confirmed shorter life of the owner’s purchase: 1/30 for the item too, flagged SUBSEQUENT_COST_SHORTER_LIFE_TO_VERIFY', () => {
    const s = derive(ext({ asset: asset({ shorterUsefulLives: [life()] }) }));
    const c = item(s);
    expect(c.owners.map((o) => o.rate)).toEqual(['1/30', '1/30']);
    expect(ownerAmounts(yearOf(c, 2027))).toEqual(['240.00', '160.00']);
    expect(c.flags).toContainEqual({ code: 'SUBSEQUENT_COST_SHORTER_LIFE_TO_VERIFY', details: { ownerPartyIds: [A, B], usefulLifeYears: 30 } });
  });

  it('an unconfirmed entry: the owners’ item parts are not computed (USEFUL_LIFE_NOT_CONFIRMED); one not shorter: the band', () => {
    const unconfirmed = item(derive(ext({ asset: asset({ shorterUsefulLives: [life({ reviewState: 'UNREVIEWED' })] }) })));
    expect(owner(yearOf(unconfirmed, 2027), A)).toMatchObject({
      amount: null,
      calculationStatus: 'NOT_CALCULABLE',
      reasons: [{ code: 'USEFUL_LIFE_NOT_CONFIRMED' }],
    });
    const notShorter = item(derive(ext({ asset: asset({ shorterUsefulLives: [life({ usefulLifeYears: 60 })] }) })));
    expect(notShorter.owners.map((o) => o.rate)).toEqual(['1/50', '1/50']);
    expect(ownerAmounts(yearOf(notShorter, 2027))).toEqual(['144.00', '96.00']);
    expect(codes(notShorter.flags)).not.toContain('SUBSEQUENT_COST_SHORTER_LIFE_TO_VERIFY');
  });

  it('an heir’s part and the NOT_OWNED part run at the band’s rate, pools of their own beside a 1/n purchase pool', () => {
    const s = derive({
      asset: asset({ shorterUsefulLives: [life()] }),
      acquisitions: [acquisition({ acquiredShare: { numerator: 3, denominator: 5 } })],
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(C, '1/5', '2027-01-01', null, null)],
      capitalizedItems: [
        capitalized(EXTENSION, '2028-05-05', '10000.00', [
          [A, '3/5'],
          [C, '1/5'],
        ]),
      ],
      today: day('2026-10-30'),
      from: 2028,
      to: 2028,
      ownerPartyId: null,
    });
    const c = item(s);
    expect(c.owners.map((o) => [o.ownerPartyId, o.basis.amount, o.rate])).toEqual([
      [A, '6000.00', '1/30'],
      [C, '2000.00', '1/50'],
    ]);
    expect(c.notOwned).toEqual({ share: '1/5', basis: eur('2000.00') });
    const y = yearOf(c, 2028);
    expect([amount(owner(y, A)?.amount), amount(owner(y, C)?.amount), amount(y.notOwned), amount(y.amount)]).toEqual(['200.00', '40.00', '40.00', '280.00']);
    expect(c.flags).toContainEqual({
      code: 'CAPITALIZED_ITEM_NOT_OWNED',
      details: { notOwnedBasis: { amount: '2000.00', currency: 'EUR' }, date: '2028-05-05' },
    });
    expect(amount(s.years[0]?.notOwned)).toBe('40.00');
  });

  it('NO_APPLICABLE_RULE for an item starting before 2006 (§59A as decided: no version before it); 2006–2022 HISTORICAL_RULE_TO_VERIFY', () => {
    const early = item(derive(acc8({ capitalizedItems: [capitalized(EXTENSION, '2005-12-31', '1000.00')] })));
    expect(early.reasons).toEqual([{ code: 'NO_APPLICABLE_RULE', details: { firstMonth: '2005-01', supportedFrom: '2006-01-01' } }]);
    expect(early.years.every((y) => y.amount === null)).toBe(true);
    const old = derive({
      asset: asset(),
      acquisitions: [acquisition({ contractDate: day('2019-11-01'), economicTransferDate: day('2020-01-01') })],
      ownerships: [ownership(A, '1/1', '2020-01-01', null, W)],
      capitalizedItems: [capitalized(EXTENSION, '2022-03-03', '1000.00', [[A, '1/1']])],
      today: day('2026-10-30'),
      from: 2022,
      to: 2023,
      ownerPartyId: null,
    });
    expect(codes(owner(yearOf(item(old), 2022), A)?.flags ?? [])).toEqual(['HISTORICAL_RULE_TO_VERIFY']);
    expect(owner(yearOf(item(old), 2023), A)?.flags).toEqual([]);
  });

  it('the 2006 boundary from the other side: an item of 2006-06-30 on a purchase of 2006-01-01 is computed from 2006-01, HISTORICAL_RULE_TO_VERIFY (review on #187)', () => {
    const s = derive({
      asset: asset(),
      acquisitions: [acquisition({ contractDate: day('2006-01-01'), economicTransferDate: day('2006-01-01') })],
      ownerships: [ownership(A, '1/1', '2006-01-01', null, W)],
      capitalizedItems: [capitalized(EXTENSION, '2006-06-30', '1000.00', [[A, '1/1']])],
      today: day('2026-10-30'),
      from: 2006,
      to: 2006,
      ownerPartyId: null,
    });
    const boundary = item(s);
    expect(boundary.reasons).toEqual([]);
    expect(boundary.start?.month).toBe('2006-01');
    const year = owner(yearOf(boundary, 2006), A);
    expect(year?.amount).not.toBeNull();
    expect(codes(year?.flags ?? [])).toContain('HISTORICAL_RULE_TO_VERIFY');
  });

  it('a purchase before 2006 (not computable): under POOLED_BASIS the item is computed until the purchase’s nominal last month, then NO_APPLICABLE_RULE', () => {
    const input = (transfer: string, from: number): ScheduleInput => ({
      asset: asset({ buildingCompletionYear: 1960 }),
      acquisitions: [acquisition({ contractDate: day(transfer), economicTransferDate: day(transfer) })],
      ownerships: [ownership(A, '1/1', transfer, null, W)],
      capitalizedItems: [capitalized(EXTENSION, '2027-04-04', '12000.00', [[A, '1/1']])],
      today: day('2026-10-30'),
      from,
      to: 2079,
      ownerPartyId: null,
    });
    // A purchase of 2001-01 at 2 %: nominal last month 2050-12.
    const pooled = item(derive(input('2001-01-01', 2049)));
    expect(owner(yearOf(pooled, 2049), A)?.amount).toEqual(eur('240.00'));
    expect(owner(yearOf(pooled, 2050), A)).toMatchObject({
      amount: null,
      reasons: [{ code: 'NO_APPLICABLE_RULE', details: { poolComponentId: `ACQUISITION:${W}`, nominalLastMonth: '2050-12' } }],
    });
    const series = item(derive(input('2001-01-01', 2049), perItem));
    expect(owner(yearOf(series, 2049), A)?.flags).toEqual([]);
    expect(owner(yearOf(series, 2050), A)).toMatchObject({ amount: eur('240.00'), flags: [{ code: 'SUBSEQUENT_COST_END_TO_VERIFY' }] });
    expect(owner(yearOf(series, 2076), A)?.amount).toEqual(eur('240.00'));
    // A purchase of 1975, nominally ended 2024: the item is not computed in any year under POOLED_BASIS.
    const old = item(derive(input('1975-01-01', 2027)));
    expect(old.years.every((y) => y.owners.every((o) => o.amount === null))).toBe(true);
  });
});

describe('the owner’s purchase without economicTransferDate (§59A open question 6, decided 2026-10-31; VC-X-33)', () => {
  /** ACC8 with W undated: contract 2026-03-01, the Ownerships from it (§27.1's transferDate), an item of 2026-09-15. */
  const undated = (reg: RuleRegistry = registry) =>
    derive(
      acc8({
        from: 2026,
        to: 2027,
        acquisitions: [acquisition({ contractDate: day('2026-03-01'), economicTransferDate: null })],
        ownerships: [ownership(A, '3/5', '2026-03-01', null, W), ownership(B, '2/5', '2026-03-01', null, W)],
        capitalizedItems: [capitalized(EXTENSION, '2026-09-15', '12000.00')],
      }),
      reg,
    );

  it('never before the owner’s start, and that start unknown: every owner part TRANSFER_DATE_MISSING, amounts null, under either end method', () => {
    for (const reg of [registry, perItem]) {
      const c = item(undated(reg));
      const reason = { code: 'TRANSFER_DATE_MISSING', details: { acquisitionId: W, contractDate: '2026-03-01' } };
      // The contract date is never the owner's first month (it would be 2026-03).
      expect(c.owners.map((o) => [o.ownerPartyId, o.firstMonth])).toEqual([
        [A, null],
        [B, null],
      ]);
      expect(c.years.map((y) => [y.year, y.amount, y.calculationStatus, y.owners.map((o) => [o.amount, o.calculationStatus, o.reasons])])).toEqual(
        [2026, 2027].map((year) => [
          year,
          null,
          'NOT_CALCULABLE',
          [
            [null, 'NOT_CALCULABLE', [reason]],
            [null, 'NOT_CALCULABLE', [reason]],
          ],
        ]),
      );
    }
  });

  it('a later purchase of the pool undated: POOL_PURCHASE_NOT_COMPUTABLE from the first year (no nominal months from the contract date); the seller’s DISPOSAL_DATE_MISSING names it', () => {
    const input = (reg: RuleRegistry) =>
      derive(
        {
          asset: asset(),
          acquisitions: [
            acquisition(),
            acquisition({
              id: X,
              sellerPartyIds: [B],
              acquiredShare: { numerator: 1, denominator: 2 },
              contractDate: day('2028-06-01'),
              economicTransferDate: null,
            }),
          ],
          ownerships: [
            ownership(A, '1/2', '2026-07-01', '2028-05-31', W),
            ownership(B, '1/2', '2026-07-01', '2028-05-31', W),
            ownership(A, '1/1', '2028-06-01', null, X),
          ],
          capitalizedItems: [
            capitalized(EXTENSION, '2027-04-04', '12000.00', [
              [A, '1/2'],
              [B, '1/2'],
            ]),
          ],
          today: day('2026-10-30'),
          from: 2027,
          to: 2029,
          ownerPartyId: null,
        },
        reg,
      );
    const s = input(registry);
    const [w, x] = s.components as [ScheduleComponent, ScheduleComponent];
    expect([x.acquisitionId, x.status, x.reasons, x.start]).toEqual([
      X,
      'NOT_COMPUTABLE',
      [{ code: 'TRANSFER_DATE_MISSING', details: { contractDate: '2028-06-01' } }],
      null,
    ]);
    // §28.1A: A's half bought in X is still read at its Ownership change: no BUYER_ALREADY_OWNER, no OWNER_WITHOUT_ACQUISITION.
    expect(x.owners.map((o) => [o.ownerPartyId, o.shareBefore, o.acquiredShare, o.tenure.from])).toEqual([[A, '1/2', '1/2', null]]);
    expect(s.years.flatMap((y) => codes(y.flags))).not.toContain('OWNER_WITHOUT_ACQUISITION');
    // The seller B's year of the sale: DISPOSAL_DATE_MISSING naming the undated buyer X; A's W part goes on.
    const w2028 = w.years.find((y) => y.year === 2028) as ComponentYear;
    expect(owner(w2028, B)?.reasons).toEqual([{ code: 'DISPOSAL_DATE_MISSING', details: { validUntil: '2028-05-31', buyerAcquisitionId: X } }]);
    expect(amount(owner(w2028, A)?.amount)).toBe('2544.00');
    // A's item part: the pool's purchase X has no start, so no nominal last month; not computed in any year.
    const c = item(s);
    const pool = {
      code: 'POOL_PURCHASE_NOT_COMPUTABLE',
      details: { poolComponentId: `ACQUISITION:${X}`, nominalLastMonth: null, reasons: ['TRANSFER_DATE_MISSING', 'NOT_COMPUTABLE'] },
    };
    expect([2027, 2028, 2029].map((y) => owner(yearOf(c, y), A))).toEqual(
      [2027, 2028, 2029].map(() => expect.objectContaining({ amount: null, calculationStatus: 'NOT_CALCULABLE', reasons: [pool] })),
    );
    // B's part (B's own tenure, W only) is computed until the sale, then DISPOSAL_DATE_MISSING.
    expect(amount(owner(yearOf(c, 2027), B)?.amount)).toBe('120.00');
    expect(owner(yearOf(c, 2028), B)?.reasons).toEqual([{ code: 'DISPOSAL_DATE_MISSING', details: { validUntil: '2028-05-31', buyerAcquisitionId: X } }]);
    // PER_ITEM_SERIES (a test registry): A's part computed on its own series and flagged from its first year.
    const series = item(input(perItem));
    expect(owner(yearOf(series, 2027), A)).toMatchObject({ amount: eur('120.00'), flags: [{ code: 'SUBSEQUENT_COST_END_TO_VERIFY' }] });
  });
});

describe('per owner (§59B "Per owner"; §58C’s parts)', () => {
  it('the running minimum against the share on the item’s date; a share raised later takes nothing more', () => {
    // A buys B's 2/5 on 2029-07-01 (§28.1A, the increase): A's part of the 2028 item stays 3/5 of it.
    const x = acquisition({
      id: X,
      contractDate: day('2029-05-01'),
      economicTransferDate: day('2029-07-01'),
      sellerPartyIds: [B],
      acquiredShare: { numerator: 2, denominator: 5 },
    });
    const s = derive(
      acc8({
        from: 2028,
        to: 2030,
        acquisitions: [acquisition(), x],
        ownerships: [
          ownership(A, '3/5', '2026-07-01', '2029-06-30', W),
          ownership(A, '1/1', '2029-07-01', null, X),
          ownership(B, '2/5', '2026-07-01', '2029-06-30', W),
        ],
        capitalizedItems: [capitalized(EXTENSION, '2028-05-05', '10000.00')],
      }),
    );
    expect([2028, 2029, 2030].map((y) => amount(owner(yearOf(item(s), y), A)?.amount))).toEqual(['120.00', '120.00', '120.00']);
  });

  it('a share reduced within the tenure lowers the part (OWNER_SHARE_CHANGED), never rising again', () => {
    const x = acquisition({
      id: X,
      contractDate: day('2029-05-01'),
      economicTransferDate: day('2029-07-01'),
      sellerPartyIds: [A],
      acquiredShare: { numerator: 3, denominator: 10 },
    });
    const s = derive(
      acc8({
        from: 2029,
        to: 2031,
        acquisitions: [acquisition(), x],
        ownerships: [
          ownership(A, '3/5', '2026-07-01', '2029-06-30', W),
          ownership(A, '3/10', '2029-07-01', null, W),
          ownership(B, '2/5', '2026-07-01', null, W),
          ownership(C, '3/10', '2029-07-01', null, X),
        ],
        capitalizedItems: [capitalized(EXTENSION, '2028-05-05', '10000.00')],
      }),
    );
    const c = item(s);
    expect([2029, 2030, 2031].map((y) => amount(owner(yearOf(c, y), A)?.amount))).toEqual(['90.00', '60.00', '60.00']);
    expect(codes(owner(yearOf(c, 2029), A)?.flags ?? [])).toEqual(['DISPOSAL_YEAR_TO_VERIFY', 'OWNER_SHARE_CHANGED']);
  });

  it('owners + NOT_OWNED = the component = the property, and every part at most its basis (random shares, items, refunds, sales)', () => {
    const next = random(7);
    for (let run = 0; run < 10; run++) {
      const a = 1 + next(9);
      const shares: [string, string][] = [
        [A, `${a}/10`],
        [B, `${(10 - a) * (next(2) === 0 ? 1 : 0)}/10`],
      ];
      const list = Array.from({ length: 1 + next(3) }, (_, i) =>
        capitalized(
          `0000eeee-0000-4000-8000-0000000002${String(run).padStart(2, '0')}${i}`,
          `20${27 + next(20)}-0${1 + next(9)}-1${next(10)}`,
          `${next(4) === 0 ? '-' : ''}${1 + next(50000)}.${String(next(100)).padStart(2, '0')}`,
          shares.filter(([, s]) => !s.startsWith('0/')),
        ),
      );
      const s = derive({
        asset: asset(),
        acquisitions: [acquisition({ acquiredShare: { numerator: 1, denominator: 1 } })],
        ownerships: [ownership(A, '1/1', '2026-07-01', null, W)],
        capitalizedItems: list,
        today: day('2026-10-30'),
        from: 2026,
        to: 2100,
        ownerPartyId: null,
      });
      for (const c of items(s)) {
        for (const y of c.years) {
          if (y.amount === null) continue;
          expect(cents(y.amount)).toBe(y.owners.reduce((sum, o) => sum + cents(o.amount), 0n) + cents(y.notOwned));
        }
        const basis = cents(c.basis.amount);
        const total = c.years.reduce((sum, y) => sum + cents(y.amount), 0n);
        expect(total < 0n ? -total : total).toBeLessThanOrEqual(basis < 0n ? -basis : basis);
      }
      for (const y of s.years) {
        const listed = s.components.flatMap((c) => c.years.filter((cy) => cy.year === y.year));
        expect(cents(y.amount)).toBe(listed.reduce((sum, cy) => sum + cents(cy.amount), 0n));
      }
    }
  });

  it('at the owner level: the item components with that owner only, no NOT_OWNED', () => {
    const s = derive(acc8({ from: 2027, to: 2027, ownerPartyId: B, capitalizedItems: [repair()] }));
    expect(item(s).owners.map((o) => o.ownerPartyId)).toEqual([B]);
    // B's purchase part 2,035.20 + B's repair part 285.60.
    expect(amount(s.years[0]?.amount)).toBe('2320.80');
    expect([item(s).notOwned, s.years[0]?.notOwned, s.years[0]?.owners]).toEqual([null, null, null]);
  });
});

describe('reasons and carried flags (§59B "Reasons and flags")', () => {
  it('ITEM_CLASSIFICATION_NEEDS_REVIEW: listed with its basis, amounts null, the year PARTIAL (never a figure without it)', () => {
    const s = derive(acc8({ from: 2027, to: 2027, capitalizedItems: [repair({ reviewState: 'NEEDS_REVIEW' })] }));
    const c = item(s);
    expect(c.status).toBe('NOT_COMPUTABLE');
    expect(codes(c.reasons)).toEqual(['ITEM_CLASSIFICATION_NEEDS_REVIEW']);
    expect(c.basis.amount).toEqual(eur('35700.00'));
    expect([yearOf(c, 2027).amount, yearOf(c, 2027).calculationStatus]).toEqual([null, 'NOT_CALCULABLE']);
    expect([s.years[0]?.status, s.years[0]?.amount]).toEqual(['PARTIAL', null]);
  });

  it('the states that feed a figure are the rule’s parameter (a test registry accepting NEEDS_REVIEW computes it)', () => {
    const accepting = withParameters((p) => ({ ...p, basis: { ...p.basis, capitalizedItemReviewStates: ['NEEDS_REVIEW'] } }));
    expect(item(derive(acc8({ from: 2027, to: 2027, capitalizedItems: [repair({ reviewState: 'NEEDS_REVIEW' })] }), accepting)).status).toBe('COMPUTABLE');
    expect(item(derive(acc8({ from: 2027, to: 2027, capitalizedItems: [repair()] }), accepting)).status).toBe('NOT_COMPUTABLE');
  });

  it('CAPITALIZED_YEAR_DIFFERS for a taxYear override; DATE_IS_BOOKING_DATE, WITHDRAWAL_DATE_ASSUMED and ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE carried', () => {
    const flags = [
      { code: 'WITHDRAWAL_DATE_ASSUMED', details: { date: '2028-02-15' } },
      { code: 'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE', details: { acquisitionId: W } },
      { code: 'RULE_SUPERSEDED', details: {} },
    ];
    const c = item(derive(acc8({ from: 2028, to: 2028, capitalizedItems: [use({ taxYear: 2027, flags })] })));
    expect(codes(c.flags)).toEqual([
      'ANSCHAFFUNGSNAHE_CAPITALIZED',
      'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE',
      'CAPITALIZED_YEAR_DIFFERS',
      'SUBSEQUENT_COST_START_TO_VERIFY',
      'WITHDRAWAL_DATE_ASSUMED',
    ]);
    expect(c.flags.find((f) => f.code === 'CAPITALIZED_YEAR_DIFFERS')?.details).toEqual({ date: '2028-02-15', taxYear: 2027 });
  });

  it('REFUND_EXCEEDS_CAPITALIZED for a refund after a sale (B capitalised nothing on the refund’s date)', () => {
    const c = acquisition({
      id: X,
      contractDate: day('2030-05-01'),
      economicTransferDate: day('2030-07-01'),
      sellerPartyIds: [B],
      acquiredShare: { numerator: 2, denominator: 5 },
    });
    const s = derive(
      acc8({
        from: 2031,
        to: 2031,
        acquisitions: [acquisition(), c],
        ownerships: [
          ownership(A, '3/5', '2026-07-01', null, W),
          ownership(B, '2/5', '2026-07-01', '2030-06-30', W),
          ownership(C, '2/5', '2030-07-01', null, X),
        ],
        capitalizedItems: [
          capitalized(EXTENSION, '2028-05-05', '1000.00'),
          capitalized(REFUND, '2031-02-02', '-2000.00', [
            [A, '3/5'],
            [C, '2/5'],
          ]),
        ],
      }),
    );
    const refund = items(s)[1] as ItemComponent;
    expect(refund.flags.filter((f) => f.code === 'REFUND_EXCEEDS_CAPITALIZED')).toEqual([
      {
        code: 'REFUND_EXCEEDS_CAPITALIZED',
        details: { ownerPartyId: A, basisSum: { amount: '-600.00', currency: 'EUR' }, refundComponentId: `TRANSACTION_SPLIT:${REFUND}` },
      },
      {
        code: 'REFUND_EXCEEDS_CAPITALIZED',
        details: { ownerPartyId: C, basisSum: { amount: '-800.00', currency: 'EUR' }, refundComponentId: `TRANSACTION_SPLIT:${REFUND}` },
      },
    ]);
    expect(refund.years.every((y) => y.amount !== null)).toBe(true);
  });

  it('REFUND_EXCEEDS_CAPITALIZED at the boundary: a sum of −0.01 is flagged, a sum of exactly 0.00 is not (review on #187)', () => {
    const refundFlags = (refund: string) => {
      const s = derive(
        acc8({
          from: 2031,
          to: 2031,
          ownerships: [ownership(A, '1/1', '2026-07-01', null, W)],
          capitalizedItems: [capitalized(EXTENSION, '2028-05-05', '1000.00', [[A, '1/1']]), capitalized(REFUND, '2031-02-02', refund, [[A, '1/1']])],
        }),
      );
      return (items(s)[1] as ItemComponent).flags.filter((f) => f.code === 'REFUND_EXCEEDS_CAPITALIZED');
    };
    expect(refundFlags('-1000.01')).toEqual([
      {
        code: 'REFUND_EXCEEDS_CAPITALIZED',
        details: { ownerPartyId: A, basisSum: { amount: '-0.01', currency: 'EUR' }, refundComponentId: `TRANSACTION_SPLIT:${REFUND}` },
      },
    ]);
    expect(refundFlags('-1000.00')).toEqual([]);
  });

  it('CAPITALIZED_ITEM_NOT_OWNED only for a NOT_OWNED basis other than 0.00: 0.01 at 3/5 leaves it 0.00, 0.02 gives it 0.01 (review on #187)', () => {
    const notOwned = (amount: string) => {
      const s = derive(
        acc8({
          from: 2028,
          to: 2028,
          acquisitions: [acquisition({ acquiredShare: { numerator: 3, denominator: 5 } })],
          ownerships: [ownership(A, '3/5', '2026-07-01', null, W)],
          capitalizedItems: [capitalized(EXTENSION, '2028-05-05', amount, [[A, '3/5']])],
        }),
      );
      return [item(s).notOwned, item(s).flags.filter((f) => f.code === 'CAPITALIZED_ITEM_NOT_OWNED')];
    };
    expect(notOwned('0.01')).toEqual([{ share: '2/5', basis: eur('0.00') }, []]);
    expect(notOwned('0.02')).toEqual([
      { share: '2/5', basis: eur('0.01') },
      [{ code: 'CAPITALIZED_ITEM_NOT_OWNED', details: { notOwnedBasis: { amount: '0.01', currency: 'EUR' }, date: '2028-05-05' } }],
    ]);
  });

  it('the asset’s reasons stop the items too', () => {
    const s = derive(acc8({ asset: asset({ reviewState: 'UNREVIEWED' }), from: 2027, to: 2027, capitalizedItems: [repair()] }));
    expect(item(s).status).toBe('NOT_COMPUTABLE');
    expect(yearOf(item(s), 2027).amount).toBeNull();
  });
});

describe('a separate asset (§59B "Separate assets", P8-D7)', () => {
  const kitchenItem = (overrides: Partial<CapitalizedItem> = {}, date = '2027-04-28', amountText = '6000.00') =>
    capitalized(KITCHEN_SPLIT, date, amountText, undefined, { taxCategory: 'OTHER_EXPENSE', ...overrides });
  const separate = (assetOverrides = {}, list: CapitalizedItem[] = [kitchenItem()], extra: Partial<ScheduleInput> = {}) => {
    const k = kitchen({ items: list.map((i) => ({ sourceType: i.sourceType, sourceId: i.sourceId, sourcePosition: i.sourcePosition })), ...assetOverrides });
    return derive(acc8({ asset: k, from: 2027, to: 2037, capitalizedItems: list, ...extra }));
  };

  it('ACC8’s Einbauküche: 2027 450.00 (A 270.00, B 180.00), 600.00 a year, 2037 150.00, the last month 2037-03, 120 months in all', () => {
    const s = separate();
    expect(s).toMatchObject({ assetType: 'SEPARATE_ASSET', status: 'AVAILABLE', excludedItems: null, flags: [] });
    expect(s.asset).toEqual({
      status: 'ACTIVE',
      description: 'Einbauküche, Wohnung 3 (synthetisch)',
      usefulLifeYears: 10,
      acquiredOn: '2027-04-20',
      reviewState: 'CONFIRMED',
    });
    const c = item(s);
    expect(c).toMatchObject({
      start: { date: '2027-04-20', dateSource: 'ACQUIRED_ON', method: 'MONTH_OF_ACQUISITION', month: '2027-04', firstYearMonths: 9 },
      rate: { kind: 'USEFUL_LIFE', band: null, ratePercent: '10.0000', rate: '1/10', usefulLifeYears: 10, legalBasis: '§ 7 Abs. 1 EStG' },
      end: { lastYear: 2037, lastMonth: '2037-03' },
      flags: [],
    });
    expect(c.years.map((y) => [y.year, amount(y.amount)])).toEqual([
      [2027, '450.00'],
      ...[2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035, 2036].map((y) => [y, '600.00']),
      [2037, '150.00'],
    ]);
    expect(ownerAmounts(yearOf(c, 2027))).toEqual(['270.00', '180.00']);
    expect(yearOf(c, 2027).rule).toEqual({ ruleCode: 'DE_AFA_MOVABLE_LINEAR', version: 1, band: null, legalBasis: null });
    expect(c.years.reduce((sum, y) => sum + (y.months ?? 0), 0)).toBe(120);
    expect(s.ruleVersions.map((v) => [v.ruleCode, v.version])).toEqual([['DE_AFA_MOVABLE_LINEAR', 1]]);
    expect(s.components.every((x) => x.kind === 'CAPITALIZED_ITEM')).toBe(true);
  });

  it('the month of acquiredOn, never the item’s date: December 1/12, January 12/12', () => {
    expect(amount(yearOf(item(separate({ acquiredOn: day('2027-12-05') }, [kitchenItem({}, '2027-04-28')])), 2027).amount)).toBe('50.00');
    expect(amount(yearOf(item(separate({ acquiredOn: day('2027-01-02') })), 2027).amount)).toBe('600.00');
  });

  it('an item booked after acquiredOn: the same year no flag, the next year LATER_ITEM_TO_VERIFY', () => {
    expect(codes(item(separate({}, [kitchenItem({}, '2027-11-30')])).flags)).toEqual([]);
    expect(item(separate({ acquiredOn: day('2027-12-20') }, [kitchenItem({}, '2028-01-10')])).flags).toEqual([
      { code: 'LATER_ITEM_TO_VERIFY', details: { date: '2028-01-10', acquiredOn: '2027-12-20' } },
    ]);
  });

  it('NO_CAPITALIZED_ITEMS without a counting CAPITALIZED item; LINKED_ITEM_NOT_CAPITALIZED for a reclassified or anschaffungsnahe one', () => {
    expect(separate({}, []).reasons).toEqual([{ code: 'NO_CAPITALIZED_ITEMS', details: {} }]);
    const reclassified = separate({}, [kitchenItem({ treatment: 'DEDUCTIBLE', parts: [] })]);
    expect(codes(reclassified.reasons)).toEqual(['NO_CAPITALIZED_ITEMS']);
    expect(item(reclassified).reasons).toEqual([
      { code: 'LINKED_ITEM_NOT_CAPITALIZED', details: { counts: true, treatment: 'DEDUCTIBLE', anschaffungsnaheAcquisitionId: null } },
    ]);
    const both = separate({}, [kitchenItem(), capitalized(EXTENSION, '2027-04-28', '500.00', undefined, { anschaffungsnaheAcquisitionId: W })]);
    expect(both.status).toBe('PARTIAL');
    expect(items(both).map((c) => [c.componentId, c.status, codes(c.reasons)])).toEqual([
      [`TRANSACTION_SPLIT:${KITCHEN_SPLIT}`, 'COMPUTABLE', []],
      [`TRANSACTION_SPLIT:${EXTENSION}`, 'NOT_COMPUTABLE', ['LINKED_ITEM_NOT_CAPITALIZED']],
    ]);
  });

  it('GWG_THRESHOLD_MAY_APPLY (informative) at 800.00 and not at 800.01, by the gross cost or the net amounts', () => {
    expect(codes(separate({}, [kitchenItem({}, '2027-04-28', '800.00')]).flags)).toEqual(['GWG_THRESHOLD_MAY_APPLY']);
    expect(codes(separate({}, [kitchenItem({}, '2027-04-28', '800.01')]).flags)).toEqual([]);
    expect(codes(separate({}, [kitchenItem({ netAmount: eur('800.00') }, '2027-04-28', '952.00')]).flags)).toEqual(['GWG_THRESHOLD_MAY_APPLY']);
    expect(codes(separate({}, [kitchenItem({ netAmount: eur('800.01') }, '2027-04-28', '952.01')]).flags)).toEqual([]);
    const s = separate({}, [kitchenItem({}, '2027-04-28', '800.00')]);
    expect(s.review.info).toContainEqual({ code: 'GWG_THRESHOLD_MAY_APPLY', count: 1 });
    expect(s.flags[0]?.details).toMatchObject({ netThreshold: '800.00', grossCost: { amount: '800.00', currency: 'EUR' }, netCost: null });
  });

  it('NO_APPLICABLE_RULE for acquiredOn in 2022, in every year (decided 2026-10-31)', () => {
    const c = item(separate({ acquiredOn: day('2022-12-01') }, [kitchenItem({}, '2022-12-05')]));
    expect(c.reasons).toEqual([{ code: 'NO_APPLICABLE_RULE', details: { acquiredOn: '2022-12-01', supportedFrom: '2023-01-01' } }]);
    expect(c.years.every((y) => y.amount === null)).toBe(true);
  });

  it('the asset’s reasons: VOID and not confirmed stop it; no COMPLETION_YEAR_MISSING and no OWNER_WITHOUT_ACQUISITION', () => {
    expect(codes(separate({ status: 'VOID', reviewState: 'UNREVIEWED' }).reasons)).toEqual(['ASSET_VOID', 'ASSET_NOT_CONFIRMED']);
    expect(separate().years.flatMap((y) => codes(y.flags))).not.toContain('OWNER_WITHOUT_ACQUISITION');
  });
});

describe('the building and the separate asset never share an item (§59B "Never twice")', () => {
  const kitchenLink = { assetId: kitchen().id, sourceType: 'TRANSACTION_SPLIT' as const, sourceId: KITCHEN_SPLIT, sourcePosition: null };
  const all = [repair(), capitalized(KITCHEN_SPLIT, '2027-04-28', '6000.00')];

  it('a linked item leaves the building’s basis and is listed in excludedItems; after a void (no ACTIVE link) it is back', () => {
    const linked = derive(acc8({ from: 2027, to: 2027, capitalizedItems: all, links: [kitchenLink] }));
    expect(items(linked).map((c) => c.componentId)).toEqual([`TRANSACTION_SPLIT:${REPAIR}`]);
    expect(linked.excludedItems).toEqual([{ componentId: `TRANSACTION_SPLIT:${KITCHEN_SPLIT}`, separateAssetId: kitchen().id }]);
    const voided = derive(acc8({ from: 2027, to: 2027, capitalizedItems: all, links: [] }));
    expect(
      items(voided)
        .map((c) => c.componentId)
        .sort(),
    ).toEqual([`TRANSACTION_SPLIT:${KITCHEN_SPLIT}`, `TRANSACTION_SPLIT:${REPAIR}`]);
    expect(voided.excludedItems).toEqual([]);
  });

  it('every capitalised item is a component of exactly one asset, and the item components start in the year of their date', () => {
    const building = derive(acc8({ from: 2027, to: 2028, capitalizedItems: [...all, use()], links: [kitchenLink] }));
    const separate = derive(acc8({ asset: kitchen({ items: [kitchenLink] }), from: 2027, to: 2028, capitalizedItems: [...all, use()] }));
    const ids = [...items(building), ...items(separate)].map((c) => c.componentId).sort();
    expect(ids).toEqual([`TRANSACTION_SPLIT:${KITCHEN_SPLIT}`, `TRANSACTION_SPLIT:${REPAIR}`, `WEG_ASSESSMENT_USE:${USE}:1`].sort());
    for (const c of items(building)) expect(c.years[0]?.year).toBe(Number(c.source.date?.slice(0, 4)));
  });
});

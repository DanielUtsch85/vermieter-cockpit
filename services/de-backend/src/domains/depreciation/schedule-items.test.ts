import { describe, expect, it } from 'vitest';
import type { RuleRegistry } from '../../shared/index.js';
import type { ScheduleInput } from './schedule.js';
import type { ItemComponent } from './schedule-items.js';
import { A, B, C, D, W, X, Y, acc8, acquisition, asset, capitalized, day, eur, life, ownership } from './schedule.test-support.js';
import {
  EXTENSION,
  REFUND,
  REPAIR,
  USE,
  amount,
  cents,
  codes,
  derive,
  item,
  items,
  monthOfDate,
  owner,
  ownerAmounts,
  perItem,
  random,
  registry,
  repair,
  startVerified,
  use,
  yearOf,
} from './schedule-items.test-support.js';

/**
 * VC-8-03 domain (api-design.md §59B): the capitalised items of the building and a separate asset's schedule, derived
 * from synthetic inputs with Depreciation's own registry. ACC8 (synthetic): the purchase of 254,400.00 at 2 % from
 * 2026-07-01, A 3/5 and B 2/5; the repair of 2027-03-10 (35,700.00) and the Sonderumlage use of 2028-02-15 (9,000.00),
 * both capitalised on the anschaffungsnahe check; the Einbauküche (6,000.00) as a separate asset of 10 years.
 */
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

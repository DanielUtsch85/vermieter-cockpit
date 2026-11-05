import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import { yearStages, type StageRule } from './recording-stage.js';
import { DE_RECORDING_STAGES_V1 } from './rules/de-recording-stages.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { deriveSchedule } from './schedule.js';
import { acc8, acquisition, capitalized, day, kitchen, ownership, A, B, C, D, W, X, Y } from './schedule.test-support.js';
import { KITCHEN_SPLIT, REPAIR, repair } from './schedule-items.test-support.js';
import type { PurchaseCheckFacts, ScheduleInput } from './schedule-model.js';
import { readOf } from './version.test-support.js';

/**
 * The owner's decisions 236-1 to 236-4 on the release stage (Entscheidung des Projektinhabers, 2026-11-02; api-design.md
 * §60A "As implemented"), on ACC8 and its variants (synthetic): an excluded item raises nothing on the building (236-1);
 * several purchases with a share reduction are stage 3 from the first reduction's year on only (236-2, 236-3); a check
 * above the threshold with a proposal not yet followed meets `ANSCHAFFUNGSNAHE_CHECK_OPEN` (stage 2) from the first
 * summed source’s year on (236-4; the mapping `DE_RECORDING_STAGES@1` unchanged); decision 3 of the third round: only a
 * reduction at which more than one purchase of the owner is active starts 236-2. The stage never changes a figure.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
const rule = DE_RECORDING_STAGES_V1 as StageRule;
const conclusive: PurchaseCheckFacts = { acquisitionId: W, status: 'NOT_ABOVE_THRESHOLD', wegHausgeldMaintenanceNotCounted: false, summedSources: [] };
const P = `ACQUISITION:${W}`;
const stagesOf = (input: ScheduleInput, years: readonly number[], checks: readonly PurchaseCheckFacts[] = [conclusive], r: StageRule | null = rule) => {
  const schedule = deriveSchedule({ ...input, from: Math.min(...years), to: Math.max(...years), ownerPartyId: null }, registry);
  return yearStages(schedule, { ...readOf(input), purchaseChecks: checks }, years, r);
};
const summary = (input: ScheduleInput, years: readonly number[], checks?: readonly PurchaseCheckFacts[], r?: StageRule | null) =>
  stagesOf(input, years, checks, r).map((y) => [y.year, y.stage, y.components.map((c) => [c.componentId, c.stage, c.criteria])]);
const source = (taxYear: number, treatment: string | null) => ({ taxYear, treatment });
const above = (...summedSources: PurchaseCheckFacts['summedSources']): PurchaseCheckFacts => ({ ...conclusive, status: 'ABOVE_THRESHOLD', summedSources });

describe('236-1: an item held by an ACTIVE separate asset carries its stage on that asset only', () => {
  const ref = { sourceType: 'TRANSACTION_SPLIT' as const, sourceId: KITCHEN_SPLIT, sourcePosition: null };
  const link = { ...ref, assetId: kitchen().id };
  const item = capitalized(KITCHEN_SPLIT, '2027-04-20', '12000.00');

  it('the building is stage 1 with the purchase only; the separate asset keeps its own stage 2', () => {
    const building = acc8({ capitalizedItems: [item], links: [link] });
    expect(summary(building, [2027, 2028])).toEqual([
      [2027, 1, [[P, 1, ['PURCHASE']]]],
      [2028, 1, [[P, 1, ['PURCHASE']]]],
    ]);
    const separate = acc8({ asset: kitchen({ items: [ref] }), capitalizedItems: [item] });
    expect(summary(separate, [2027])).toEqual([[2027, 2, [[`TRANSACTION_SPLIT:${KITCHEN_SPLIT}`, 2, ['MOVABLE_ASSET']]]]]);
  });

  it('an excluded Loan interest or anschaffungsnahe item, or a later addition on the asset, raises nothing on the building either', () => {
    const interest = capitalized(KITCHEN_SPLIT, '2027-04-20', '12000.00', undefined, { taxCategory: 'LOAN_INTEREST', anschaffungsnaheAcquisitionId: W });
    const later = capitalized(REPAIR, '2028-03-01', '800.00');
    const links = [link, { ...link, sourceId: REPAIR }];
    expect(stagesOf(acc8({ capitalizedItems: [interest, later], links }), [2027, 2028]).map((y) => [y.stage, y.components.length])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    // The asset itself: its later addition makes every one of its years 3 (§60A's table, unchanged).
    const separate = acc8({ asset: kitchen({ items: [ref, { ...ref, sourceId: REPAIR }] }), capitalizedItems: [item, later] });
    expect(stagesOf(separate, [2027, 2028]).map((y) => y.stage)).toEqual([3, 3]);
  });

  it('counter-check: without an ACTIVE link (the asset voided) the item is on the building again and raises it to 2', () => {
    expect(summary(acc8({ capitalizedItems: [item], links: [] }), [2027])).toEqual([
      [
        2027,
        2,
        [
          [P, 1, ['PURCHASE']],
          [`TRANSACTION_SPLIT:${KITCHEN_SPLIT}`, 2, ['CAPITALIZED_ITEM']],
        ],
      ],
    ]);
  });
});

describe('236-2 and 236-3: several purchases of one owner, stage 3 only from the first share reduction on', () => {
  // A buys 3/5 (W, 2026) and B’s 2/5 (X, 2030).
  const second = acquisition({ id: X, contractDate: day('2030-05-01'), economicTransferDate: day('2030-07-01'), sellerPartyIds: [B] });
  const twice = (extra: Partial<ScheduleInput> = {}) =>
    acc8({
      acquisitions: [acquisition(), { ...second, acquiredShare: { numerator: 2, denominator: 5 } }],
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2030-06-30', W), ownership(A, '2/5', '2030-07-01', null, X)],
      ...extra,
    });
  const checks = [conclusive, { ...conclusive, acquisitionId: X }];
  const stages = (input: ScheduleInput, years: readonly number[]) => stagesOf(input, years, checks).map((y) => y.stage);

  it('236-3: two purchases without a reduction are 1 in every year', () => {
    expect(stages(twice(), [2026, 2030, 2031, 2040])).toEqual([1, 1, 1, 1]);
  });

  it('a reduction by a row of A ending on 2032-12-31 counts from 2033, the year of the day A holds less', () => {
    const input = twice({
      ownerships: [
        ownership(A, '3/5', '2026-07-01', '2032-12-31', W),
        ownership(A, '2/5', '2033-01-01', null, W),
        ownership(B, '2/5', '2026-07-01', '2030-06-30', W),
        ownership(A, '2/5', '2030-07-01', null, X),
        ownership(C, '1/5', '2033-01-01', null, null),
      ],
    });
    expect(stages(input, [2031, 2032, 2033, 2034])).toEqual([1, 1, 3, 3]);
  });

  it('a sale by A without a transfer date counts from its contract year (no transfer precedes it)', () => {
    const sale = acquisition({
      id: '0000cccc-0000-4000-8000-000000000009',
      contractDate: day('2034-11-20'),
      economicTransferDate: null,
      sellerPartyIds: [A],
      acquiredShare: { numerator: 1, denominator: 5 },
    });
    const input = twice({ acquisitions: [...twice().acquisitions, sale] });
    const years = stagesOf(input, [2033, 2034, 2035], [...checks, { ...conclusive, acquisitionId: sale.id }]);
    expect(years.map((y) => y.components.find((c) => c.componentId === P)?.criteria)).toEqual([
      ['PURCHASE'],
      ['PURCHASE', 'SEVERAL_PURCHASES_PARTIAL_SALE'],
      ['PURCHASE', 'SEVERAL_PURCHASES_PARTIAL_SALE'],
    ]);
  });

  it('two reductions (a row in 2033, a sale in 2036): the first one decides, from 2033 on', () => {
    const sale = acquisition({
      id: '0000cccc-0000-4000-8000-000000000009',
      contractDate: day('2036-02-01'),
      economicTransferDate: day('2036-03-01'),
      sellerPartyIds: [A],
      acquiredShare: { numerator: 1, denominator: 5 },
    });
    const input = twice({
      acquisitions: [...twice().acquisitions, sale],
      ownerships: [
        ownership(A, '3/5', '2026-07-01', '2032-12-31', W),
        ownership(A, '2/5', '2033-01-01', null, W),
        ownership(B, '2/5', '2026-07-01', '2030-06-30', W),
        ownership(A, '2/5', '2030-07-01', null, X),
        ownership(C, '1/5', '2033-01-01', null, null),
      ],
    });
    const years = stagesOf(input, [2032, 2033, 2035, 2036], [...checks, { ...conclusive, acquisitionId: sale.id }]);
    expect(years.map((y) => y.components.find((c) => c.componentId === P)?.stage)).toEqual([1, 3, 3, 3]);
  });

  it('only the owner with several purchases is raised: a sale by B, who bought once, raises nothing', () => {
    // B’s 2/5 ends in 2030 (sold to A): a reduction of B, who bought once. A has two purchases but no reduction.
    expect(stagesOf(twice(), [2030, 2031], checks).flatMap((y) => y.components.map((c) => c.criteria))).toEqual([
      ['PURCHASE'],
      ['PURCHASE'],
      ['PURCHASE'],
      ['PURCHASE'],
    ]);
  });
});

describe('decision 3: SEVERAL_PURCHASES_PARTIAL_SALE only from a reduction at which more than one purchase of the owner is active', () => {
  // Entscheidung des Projektinhabers, 2026-11-02 (third round, 3). The rows follow §28.1A (one row per owner and day): A
  // buys W (1/1, 2020), sells 2/5 to B (Y, 2022), buys them back (X, 2024) and, in the second case, sells 1/5 to C (Z, 2026).
  const Z = '0000cccc-0000-4000-8000-000000000009';
  const on = (date: string) => ({ contractDate: day(date), economicTransferDate: day(date) });
  const w = acquisition({ ...on('2020-07-01') });
  const y = acquisition({ id: Y, ...on('2022-07-01'), sellerPartyIds: [A], acquiredShare: { numerator: 2, denominator: 5 } });
  const x = acquisition({ id: X, ...on('2024-07-01'), sellerPartyIds: [B], acquiredShare: { numerator: 2, denominator: 5 } });
  const z = acquisition({ id: Z, ...on('2026-07-01'), sellerPartyIds: [A], acquiredShare: { numerator: 1, denominator: 5 } });
  const ids = [W, X, Y, Z];
  const checks = ids.map((acquisitionId) => ({ ...conclusive, acquisitionId }));
  const layers = (laterReduction: boolean) =>
    acc8({
      acquisitions: laterReduction ? [w, y, x, z] : [w, y, x],
      ownerships: [
        ownership(A, '1/1', '2020-07-01', '2022-06-30', W),
        ownership(A, '3/5', '2022-07-01', '2024-06-30', null),
        ownership(B, '2/5', '2022-07-01', '2024-06-30', Y),
        ownership(A, '1/1', '2024-07-01', laterReduction ? '2026-06-30' : null, X),
        ...(laterReduction ? [ownership(A, '4/5', '2026-07-01', null, null), ownership(C, '1/5', '2026-07-01', null, Z)] : []),
      ],
    });
  const years = [2021, 2022, 2023, 2024, 2025, 2026, 2027];
  const several = (input: ScheduleInput, ys = years) =>
    stagesOf(input, ys, checks).map((s) => [
      s.year,
      s.stage,
      s.components.filter((c) => c.criteria.includes('SEVERAL_PURCHASES_PARTIAL_SALE')).map((c) => c.componentId),
    ]);

  it('a reduction while A holds one purchase (2022), a second purchase in 2024, no later reduction: never, 1 in every year', () => {
    expect(several(layers(false))).toEqual(years.map((year) => [year, 1, []]));
  });

  it('the same and a further reduction in 2026, with W and X active: both purchases of A are 3 from 2026 on, not before', () => {
    expect(several(layers(true))).toEqual([
      ...[2021, 2022, 2023, 2024, 2025].map((year) => [year, 1, []]),
      [2026, 3, [`ACQUISITION:${W}`, `ACQUISITION:${X}`]],
      [2027, 3, [`ACQUISITION:${W}`, `ACQUISITION:${X}`]],
    ]);
  });

  it('the later reduction as a reduced row alone, and as a sale alone: from 2026 on either way', () => {
    const rowOnly = layers(true);
    const asRow = { ...rowOnly, acquisitions: [w, y, x, { ...z, sellerPartyIds: [D] }] };
    // A sale by A on 2026-07-01 with A's row unchanged (the buyer's row not given): the sale alone is the reduction.
    const asSale = acc8({
      acquisitions: [w, y, x, z],
      ownerships: [
        ownership(A, '1/1', '2020-07-01', '2022-06-30', W),
        ownership(A, '3/5', '2022-07-01', '2024-06-30', null),
        ownership(B, '2/5', '2022-07-01', '2024-06-30', Y),
        ownership(A, '1/1', '2024-07-01', null, X),
      ],
    });
    for (const input of [asRow, asSale]) {
      expect(several(input, [2025, 2026]).map(([year, stage]) => [year, stage])).toEqual([
        [2025, 1],
        [2026, 3],
      ]);
    }
  });

  it('a reduction on the day of the second purchase transfer: X has begun that day, so W and X are active and it starts', () => {
    // A (W 1/2) buys the 1/2 of D (X) and sells 1/4 to C (Z), both on 2024-07-01: A holds 3/4 from then on.
    const input = acc8({
      acquisitions: [
        { ...w, acquiredShare: { numerator: 1, denominator: 2 } },
        { ...x, sellerPartyIds: [D], acquiredShare: { numerator: 1, denominator: 2 } },
        { ...z, ...on('2024-07-01'), acquiredShare: { numerator: 1, denominator: 4 } },
      ],
      ownerships: [
        ownership(A, '1/2', '2020-07-01', '2024-06-30', W),
        ownership(D, '1/2', '2020-07-01', '2024-06-30', W),
        ownership(A, '3/4', '2024-07-01', null, X),
        ownership(C, '1/4', '2024-07-01', null, Z),
      ],
    });
    expect(several(input, [2023, 2024, 2025])).toEqual([
      [2023, 1, []],
      [2024, 3, [`ACQUISITION:${W}`, `ACQUISITION:${X}`]],
      [2025, 3, [`ACQUISITION:${W}`, `ACQUISITION:${X}`]],
    ]);
  });

  it('two purchases, then a reduction (2024): from the reduction year on', () => {
    const input = acc8({
      acquisitions: [w, { ...x, ...on('2022-07-01') }, { ...z, ...on('2024-07-01') }],
      ownerships: [
        ownership(A, '3/5', '2020-07-01', '2022-06-30', W),
        ownership(B, '2/5', '2020-07-01', '2022-06-30', W),
        ownership(A, '1/1', '2022-07-01', '2024-06-30', X),
        ownership(A, '4/5', '2024-07-01', null, null),
        ownership(C, '1/5', '2024-07-01', null, Z),
      ],
    });
    expect(several(input, [2021, 2022, 2023, 2024, 2025]).map(([year, stage]) => [year, stage])).toEqual([
      [2021, 1],
      [2022, 1],
      [2023, 1],
      [2024, 3],
      [2025, 3],
    ]);
  });

  it('a purchase fully disposed before the second one is no longer active: a later reduction with only X held starts nothing', () => {
    // A sells all of W to B (Y, 2022), buys it back (X, 2024) and sells 1/5 to C (Z, 2026): only X is active then.
    const input = acc8({
      acquisitions: [w, { ...y, acquiredShare: { numerator: 1, denominator: 1 } }, { ...x, acquiredShare: { numerator: 1, denominator: 1 } }, z],
      ownerships: [
        ownership(A, '1/1', '2020-07-01', '2022-06-30', W),
        ownership(B, '1/1', '2022-07-01', '2024-06-30', Y),
        ownership(A, '1/1', '2024-07-01', '2026-06-30', X),
        ownership(A, '4/5', '2026-07-01', null, null),
        ownership(C, '1/5', '2026-07-01', null, Z),
      ],
    });
    expect(several(input)).toEqual(years.map((year) => [year, 1, []]));
  });

  it('a purchase this very reduction ends still counts as active: W and X wholly sold (a) or ended without a follow-up row (b), from 2026', () => {
    // A holds W (2020) and X (2024); on 2026-07-01 A holds nothing: (a) a sale of the whole share to C, (b) the last row
    // of A ending on 2026-06-30 without a follow-up row. W and X end with this reduction (their lastDay is the day before).
    const rows = (sold: boolean) => [
      ownership(A, '1/1', '2020-07-01', '2022-06-30', W),
      ownership(A, '3/5', '2022-07-01', '2024-06-30', null),
      ownership(B, '2/5', '2022-07-01', '2024-06-30', Y),
      ownership(A, '1/1', '2024-07-01', '2026-06-30', X),
      ...(sold ? [ownership(C, '1/1', '2026-07-01', null, Z)] : []),
    ];
    const wholeSale = acc8({ acquisitions: [w, y, x, { ...z, acquiredShare: { numerator: 1, denominator: 1 } }], ownerships: rows(true) });
    const ended = acc8({ acquisitions: [w, y, x], ownerships: rows(false) });
    for (const input of [wholeSale, ended]) {
      const stages = stagesOf(input, [2025, 2026], checks);
      expect(stages.map((s) => s.components.find((c) => c.componentId === P)?.criteria)).toEqual([
        ['PURCHASE'],
        ['PURCHASE', 'SEVERAL_PURCHASES_PARTIAL_SALE'],
      ]);
      expect(stages[1]?.components.find((c) => c.componentId === `ACQUISITION:${X}`)?.criteria).toEqual(['PURCHASE', 'SEVERAL_PURCHASES_PARTIAL_SALE']);
    }
  });

  it('a part that bought nothing (the share of its buyer not increased, §28.1A; a DRAFT) is no layer of its own', () => {
    const draft = { ...x, status: 'DRAFT' as const, sellerPartyIds: [D] };
    const input = acc8({
      acquisitions: [w, draft, z],
      ownerships: [
        ownership(A, '1/1', '2020-07-01', '2024-06-30', W),
        ownership(A, '1/1', '2024-07-01', '2026-06-30', X),
        ownership(A, '4/5', '2026-07-01', null, null),
        ownership(C, '1/5', '2026-07-01', null, Z),
      ],
    });
    expect(several(input)).toEqual(years.map((year) => [year, 1, []]));
  });

  it('a second purchase without a transfer date counts as active (the cautious reading): the reduction of 2022 starts it', () => {
    const undated = { ...x, ...on('2021-07-01'), economicTransferDate: null };
    const input = acc8({
      acquisitions: [w, undated, y],
      ownerships: [
        ownership(A, '1/2', '2020-07-01', '2021-06-30', W),
        ownership(D, '1/2', '2020-07-01', '2021-06-30', W),
        ownership(A, '1/1', '2021-07-01', '2022-06-30', X),
        ownership(A, '3/5', '2022-07-01', null, null),
        ownership(B, '2/5', '2022-07-01', null, Y),
      ],
    });
    const stages = stagesOf(input, [2022, 2023], checks);
    expect(stages.map((s) => s.components.find((c) => c.componentId === P)?.criteria)).toEqual([
      ['PURCHASE', 'SEVERAL_PURCHASES_PARTIAL_SALE'],
      ['PURCHASE', 'SEVERAL_PURCHASES_PARTIAL_SALE'],
    ]);
  });
});

describe('236-4: a check above the threshold with a proposal not yet followed is stage 2', () => {
  it('a DEDUCTIBLE summed source dated 2027: 1 in 2026, 2 from 2027 on, on the purchase', () => {
    expect(summary(acc8(), [2026, 2027, 2028], [above(source(2027, 'DEDUCTIBLE'))])).toEqual([
      [2026, 1, [[P, 1, ['PURCHASE']]]],
      [2027, 2, [[P, 2, ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN']]]],
      [2028, 2, [[P, 2, ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN']]]],
    ]);
  });

  it('from the year of the first summed source, a followed one included, while any one is not followed', () => {
    const checks = [above(source(2026, 'CAPITALIZED'), source(2028, 'DEDUCTIBLE'))];
    expect(stagesOf(acc8(), [2026, 2027], checks).map((y) => y.stage)).toEqual([2, 2]);
  });

  it('every proposal followed: the purchase is 1, and the capitalised item carries its own stage 2', () => {
    const followed = [above(source(2027, 'CAPITALIZED'))];
    expect(summary(acc8({ capitalizedItems: [repair()] }), [2026, 2027], followed)).toEqual([
      [2026, 1, [[P, 1, ['PURCHASE']]]],
      [
        2027,
        2,
        [
          [P, 1, ['PURCHASE']],
          [`TRANSACTION_SPLIT:${REPAIR}`, 2, ['CAPITALIZED_ITEM', 'ANSCHAFFUNGSNAHE_CAPITALIZATION']],
        ],
      ],
    ]);
  });

  it('decision 2: a DISTRIBUTED_82B summed source counts like DEDUCTIBLE (not followed), from its year on; a source without treatment too', () => {
    // Entscheidung des Projektinhabers, 2026-11-02 (third round, 2): distributed maintenance is still not capitalised.
    expect(summary(acc8(), [2026, 2027], [above(source(2027, 'DISTRIBUTED_82B'))])).toEqual(summary(acc8(), [2026, 2027], [above(source(2027, 'DEDUCTIBLE'))]));
    expect(stagesOf(acc8(), [2026, 2027], [above(source(2027, 'DISTRIBUTED_82B'))]).map((y) => y.stage)).toEqual([1, 2]);
    expect(stagesOf(acc8(), [2027], [above(source(2027, null))])[0]?.stage).toBe(2);
    // Counter-check: once it is CAPITALIZED the proposal is followed.
    expect(stagesOf(acc8(), [2027], [above(source(2027, 'CAPITALIZED'))])[0]?.stage).toBe(1);
  });

  it('above the threshold without a summed source: no fact (an explicit guard, not Math.min() of nothing), 1 in every year', () => {
    expect(summary(acc8(), [2026, 2027], [above()])).toEqual([
      [2026, 1, [[P, 1, ['PURCHASE']]]],
      [2027, 1, [[P, 1, ['PURCHASE']]]],
    ]);
  });

  it('the fact meets the criterion of A1 once: with an open Hausgeld flag as well it is CHECK_OPEN in every year, listed once', () => {
    const both = { ...above(source(2027, 'DEDUCTIBLE')), wegHausgeldMaintenanceNotCounted: true };
    expect(stagesOf(acc8(), [2026, 2027], [both]).map((y) => y.components[0]?.criteria)).toEqual([
      ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN'],
      ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN'],
    ]);
  });

  it('counter-checks: not above with DEDUCTIBLE sources is 1; NOT_COMPUTABLE stays the open check of A1 in every year', () => {
    const notAbove = { ...conclusive, summedSources: [source(2027, 'DEDUCTIBLE')] };
    expect(stagesOf(acc8(), [2026, 2027], [notAbove]).map((y) => y.stage)).toEqual([1, 1]);
    const open = { ...notAbove, status: 'NOT_COMPUTABLE' as const };
    expect(stagesOf(acc8(), [2026, 2027], [open]).map((y) => y.components[0]?.criteria)).toEqual([
      ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN'],
      ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN'],
    ]);
  });

  it('the proposal of another purchase does not raise this one', () => {
    expect(stagesOf(acc8(), [2027], [conclusive, { ...above(source(2027, 'DEDUCTIBLE')), acquisitionId: X }])[0]?.stage).toBe(1);
  });

  it('the stage of the fact is the mapping of ANSCHAFFUNGSNAHE_CHECK_OPEN (read from the registry, no new criterion)', () => {
    const raised: StageRule = {
      ...rule,
      parameters: { criteria: rule.parameters.criteria.map((c) => (c.code === 'ANSCHAFFUNGSNAHE_CHECK_OPEN' ? { ...c, stage: 3 as const } : c)) },
    };
    expect(stagesOf(acc8(), [2026, 2027], [above(source(2027, 'DEDUCTIBLE'))], raised).map((y) => y.stage)).toEqual([1, 3]);
  });
});

describe('§58M: a check not final for WEG_STATEMENT_MISSING is stage 2 (Entscheidung des Projektinhabers, 2026-11-05)', () => {
  const missing = (from: number | null): PurchaseCheckFacts => ({ ...conclusive, wegStatementMissingFrom: from });

  it('from the first year of the window (2026, the transfer of ACC8) in every year of it: CHECK_OPEN, listed once', () => {
    expect(summary(acc8(), [2026, 2027, 2028], [missing(2026)])).toEqual([
      [2026, 2, [[P, 2, ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN']]]],
      [2027, 2, [[P, 2, ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN']]]],
      [2028, 2, [[P, 2, ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN']]]],
    ]);
    // With the Hausgeld flag as well (A1): the same criterion, listed once.
    const both = { ...missing(2026), wegHausgeldMaintenanceNotCounted: true };
    expect(summary(acc8(), [2026, 2027], [both])).toEqual(summary(acc8(), [2026, 2027], [missing(2026)]));
  });

  it('the year it is dated from counts: not before it (a dated fact, like 236-4)', () => {
    expect(stagesOf(acc8(), [2026, 2027], [missing(2027)]).map((y) => y.stage)).toEqual([1, 2]);
  });

  it('counter-checks: final (no missing statement, null or absent) is 1; another purchase not final does not raise this one', () => {
    expect(stagesOf(acc8(), [2026, 2027], [missing(null)]).map((y) => y.stage)).toEqual([1, 1]);
    expect(stagesOf(acc8(), [2026, 2027], [conclusive]).map((y) => y.stage)).toEqual([1, 1]);
    expect(stagesOf(acc8(), [2026, 2027], [conclusive, { ...missing(2026), acquisitionId: X }]).map((y) => y.stage)).toEqual([1, 1]);
  });

  it('the stage is the mapping of ANSCHAFFUNGSNAHE_CHECK_OPEN (no new criterion: DE_RECORDING_STAGES@1 unchanged)', () => {
    const raised: StageRule = {
      ...rule,
      parameters: { criteria: rule.parameters.criteria.map((c) => (c.code === 'ANSCHAFFUNGSNAHE_CHECK_OPEN' ? { ...c, stage: 3 as const } : c)) },
    };
    expect(stagesOf(acc8(), [2026, 2027], [missing(2026)], raised).map((y) => y.stage)).toEqual([3, 3]);
  });
});

describe('money unchanged: the stage reads the schedule and changes none of it', () => {
  it.each([
    [
      '236-1',
      acc8({
        capitalizedItems: [capitalized(KITCHEN_SPLIT, '2027-04-20', '12000.00')],
        links: [{ assetId: kitchen().id, sourceType: 'TRANSACTION_SPLIT' as const, sourceId: KITCHEN_SPLIT, sourcePosition: null }],
      }),
    ],
    ['236-4', acc8({ capitalizedItems: [repair()] })],
    [
      'decision 3',
      acc8({
        acquisitions: [
          acquisition({ contractDate: day('2020-07-01'), economicTransferDate: day('2020-07-01') }),
          acquisition({
            id: X,
            contractDate: day('2024-07-01'),
            economicTransferDate: day('2024-07-01'),
            sellerPartyIds: [B],
            acquiredShare: { numerator: 2, denominator: 5 },
          }),
        ],
        ownerships: [
          ownership(A, '3/5', '2020-07-01', '2024-06-30', W),
          ownership(B, '2/5', '2020-07-01', '2024-06-30', W),
          ownership(A, '1/1', '2024-07-01', '2026-06-30', X),
          ownership(A, '4/5', '2026-07-01', null, null),
        ],
      }),
    ],
  ])('%s: the schedule is byte for byte the same after the stages are derived, under @1, another mapping and no version', (_label, input) => {
    const schedule = deriveSchedule({ ...input, from: 2026, to: 2028, ownerPartyId: null }, registry);
    const before = JSON.stringify(schedule);
    const lowered: StageRule = { ...rule, parameters: { criteria: rule.parameters.criteria.map((c) => ({ ...c, stage: 1 as const })) } };
    for (const r of [rule, lowered, null]) {
      yearStages(schedule, { ...readOf(input), purchaseChecks: [above(source(2027, 'DEDUCTIBLE'))] }, [2026, 2027, 2028], r);
    }
    expect(JSON.stringify(schedule)).toBe(before);
  });
});

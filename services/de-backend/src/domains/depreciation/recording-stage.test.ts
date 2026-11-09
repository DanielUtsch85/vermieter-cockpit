import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import { componentIdOf } from './capitalized-item.js';
import { yearStages, type StageRule } from './recording-stage.js';
import { DE_RECORDING_STAGES_V1, RECORDING_STAGE_RULES, STAGE_CRITERIA, type RecordingStagesParameters } from './rules/de-recording-stages.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { deriveSchedule } from './schedule.js';
import { acc8, acquisition, asset, capitalized, day, kitchen, life, ownership, A, B, C, W, X } from './schedule.test-support.js';
import { EXTENSION, REPAIR, repair } from './schedule-items.test-support.js';
import type { PurchaseCheckFacts, ScheduleInput, ScheduleRead } from './schedule-model.js';
import { readOf } from './version.test-support.js';

/**
 * The release stage of a component and a year (VC-X-45, api-design.md §60A "The stage of a component and of a year"),
 * on ACC8 and its variants (synthetic): each criterion alone, combinations (the highest wins), A1, not-computable
 * components and components without a start still counted, the mapping read from the registry. The decisions 236-1 to
 * 236-4 are in `recording-stage-decisions.test.ts`.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
const rule = DE_RECORDING_STAGES_V1;
const conclusive: PurchaseCheckFacts = { acquisitionId: W, status: 'NOT_ABOVE_THRESHOLD', wegHausgeldMaintenanceNotCounted: false, summedSources: [] };
const readWith = (input: ScheduleInput, checks: readonly PurchaseCheckFacts[] = [conclusive, { ...conclusive, acquisitionId: X }]): ScheduleRead => ({
  ...readOf(input),
  purchaseChecks: checks,
});
const stagesOf = (input: ScheduleInput, years: readonly number[], checks?: readonly PurchaseCheckFacts[], r: StageRule | null = rule) => {
  const read = readWith(input, checks);
  const schedule = deriveSchedule({ ...input, from: Math.min(...years), to: Math.max(...years), ownerPartyId: null }, registry);
  return yearStages(schedule, read, years, r);
};
const summary = (input: ScheduleInput, years: readonly number[], checks?: readonly PurchaseCheckFacts[], r?: StageRule | null) =>
  stagesOf(input, years, checks, r).map((y) => [y.year, y.stage, y.components.map((c) => [c.componentId, c.stage, c.criteria])]);
const P = `ACQUISITION:${W}`;
const loanInterest = (id: string, date: string) =>
  capitalized(id, date, '4000.00', undefined, {
    taxCategory: 'LOAN_INTEREST',
    loan: { loanId: '0000eeee-0000-4000-8000-0000000000a1', allocationSetId: '0000eeee-0000-4000-8000-0000000000a2', share: '1/1' },
  });

describe('DE_RECORDING_STAGES@1 (§60A, A3)', () => {
  it('lists every criterion once, each with a stage of 1, 2 or 3, in the order of §60A (unchanged by 236-1 to 236-4)', () => {
    const { criteria } = DE_RECORDING_STAGES_V1.parameters;
    expect(criteria.map((c) => c.code)).toEqual([...STAGE_CRITERIA]);
    expect(criteria.map((c) => [c.code, c.stage])).toEqual([
      ['PURCHASE', 1],
      ['CAPITALIZED_ITEM', 2],
      ['ANSCHAFFUNGSNAHE_CAPITALIZATION', 2],
      ['ANSCHAFFUNGSNAHE_CHECK_OPEN', 2],
      ['LOAN_INTEREST_COMPONENT', 2],
      ['MOVABLE_ASSET', 2],
      ['SHORTER_USEFUL_LIFE_ENTRY', 3],
      ['SEVERAL_PURCHASES_PARTIAL_SALE', 3],
      ['MOVABLE_ASSET_LATER_ADDITION', 3],
    ]);
    expect(RECORDING_STAGE_RULES.codes()).toEqual(['DE_RECORDING_STAGES']);
  });
});

describe('the stage of a component and of a year (§60A)', () => {
  it('a purchase alone is stage 1 in each of its years; a year without a component is stage 1 with none', () => {
    expect(summary(acc8(), [2025, 2026, 2027])).toEqual([
      [2025, 1, []],
      [2026, 1, [[P, 1, ['PURCHASE']]]],
      [2027, 1, [[P, 1, ['PURCHASE']]]],
    ]);
  });

  it('a capitalised item is stage 2 in its years only: a year mixing the stage-1 purchase and the stage-2 item is 2', () => {
    const input = acc8({ capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null })] });
    const item = `TRANSACTION_SPLIT:${REPAIR}`;
    expect(summary(input, [2026, 2027])).toEqual([
      [2026, 1, [[P, 1, ['PURCHASE']]]],
      [
        2027,
        2,
        [
          [P, 1, ['PURCHASE']],
          [item, 2, ['CAPITALIZED_ITEM']],
        ],
      ],
    ]);
  });

  it('an anschaffungsnahe capitalisation adds its criterion; the stage stays 2', () => {
    const [, y2027] = stagesOf(acc8({ capitalizedItems: [repair()] }), [2026, 2027]);
    expect(y2027?.components.find((c) => c.kind === 'CAPITALIZED_ITEM')).toMatchObject({
      stage: 2,
      criteria: ['CAPITALIZED_ITEM', 'ANSCHAFFUNGSNAHE_CAPITALIZATION'],
    });
  });

  it('a year with a Loan interest component is at least 2, and 3 with a shorter-life entry as well (the highest wins)', () => {
    const interest = loanInterest(EXTENSION, '2027-02-01');
    const [y2026, y2027] = stagesOf(acc8({ capitalizedItems: [interest] }), [2026, 2027]);
    expect([y2026?.stage, y2027?.stage]).toEqual([1, 2]);
    expect(y2027?.components.find((c) => c.kind === 'CAPITALIZED_ITEM')?.criteria).toEqual(['CAPITALIZED_ITEM', 'LOAN_INTEREST_COMPONENT']);
    const withLife = acc8({ asset: asset({ shorterUsefulLives: [life()] }), capitalizedItems: [interest] });
    expect(stagesOf(withLife, [2027]).map((y) => y.stage)).toEqual([3]);
    // A PropertyReference's interest split (no Loan) is Loan interest by its category too.
    const plain = capitalized(EXTENSION, '2027-02-01', '4000.00', undefined, { taxCategory: 'LOAN_INTEREST' });
    expect(stagesOf(acc8({ capitalizedItems: [plain] }), [2027])[0]?.stage).toBe(2);
  });

  it.each(['UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'ADVISOR_CONFIRMED'] as const)(
    'a purchase with a %s shorter-life entry is 3 („auch unbestätigt“)',
    (state) => {
      const input = acc8({ asset: asset({ shorterUsefulLives: [life({ reviewState: state, advisorPartyId: state === 'ADVISOR_CONFIRMED' ? C : null })] }) });
      expect(summary(input, [2026])).toEqual([[2026, 3, [[P, 3, ['PURCHASE', 'SHORTER_USEFUL_LIFE_ENTRY']]]]]);
    },
  );

  it('a shorter-life entry of another purchase raises nothing; an item in the pool of the shorter-life purchase is 3', () => {
    expect(stagesOf(acc8({ asset: asset({ shorterUsefulLives: [life({ acquisitionId: X })] }) }), [2026])[0]?.stage).toBe(1);
    const input = acc8({ asset: asset({ shorterUsefulLives: [life()] }), capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null })] });
    expect(stagesOf(input, [2027])[0]?.components.find((c) => c.kind === 'CAPITALIZED_ITEM')).toMatchObject({
      stage: 3,
      criteria: ['CAPITALIZED_ITEM', 'SHORTER_USEFUL_LIFE_ENTRY'],
    });
  });

  it('A1: a running window alone (or a check above the threshold) is 1; a NOT_COMPUTABLE check or an open WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED is 2', () => {
    const stage = (check: Partial<PurchaseCheckFacts>) => stagesOf(acc8(), [2026], [{ ...conclusive, ...check }])[0]?.stage;
    expect([stage({}), stage({ status: 'ABOVE_THRESHOLD' })]).toEqual([1, 1]);
    expect([stage({ status: 'NOT_COMPUTABLE' }), stage({ wegHausgeldMaintenanceNotCounted: true })]).toEqual([2, 2]);
    expect(stagesOf(acc8(), [2026], [{ ...conclusive, status: 'NOT_COMPUTABLE' }])[0]?.components[0]?.criteria).toEqual([
      'PURCHASE',
      'ANSCHAFFUNGSNAHE_CHECK_OPEN',
    ]);
    // A check the snapshot does not give is not known to be conclusive: open (the conservative reading).
    expect(stagesOf(acc8(), [2026], [])[0]?.stage).toBe(2);
    expect(yearStages(deriveSchedule(acc8(), registry), readOf(acc8()), [2026], rule)[0]?.stage).toBe(2);
  });

  it('several purchases of one owner with a share reduction are 3 from the year of the first reduction on (236-2); without a reduction 1 (236-3)', () => {
    // A buys 3/5 (W, 2026) and B’s 2/5 (X, 2030): two purchases, no reduction.
    const second = acquisition({ id: X, contractDate: day('2030-05-01'), economicTransferDate: day('2030-07-01'), sellerPartyIds: [B] });
    const twice = acc8({
      acquisitions: [acquisition(), { ...second, acquiredShare: { numerator: 2, denominator: 5 } }],
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2030-06-30', W), ownership(A, '2/5', '2030-07-01', null, X)],
    });
    expect(stagesOf(twice, [2026, 2031]).map((y) => y.stage)).toEqual([1, 1]);
    // A row of A ending on a row change that keeps or raises A's share is no reduction either.
    const rowChange = acc8({
      acquisitions: twice.acquisitions,
      ownerships: [
        ownership(A, '3/5', '2026-07-01', '2030-06-30', W),
        ownership(A, '3/5', '2030-07-01', null, W),
        ownership(B, '2/5', '2026-07-01', '2030-06-30', W),
        ownership(A, '2/5', '2030-07-01', null, X),
      ],
    });
    expect(stagesOf(rowChange, [2026, 2031]).map((y) => y.stage)).toEqual([1, 1]);
    // A later sells 1/5 to C (a share reduction in 2033): both of A’s purchases are 3 from 2033 on, 1 before (236-2).
    const third = acquisition({
      id: '0000cccc-0000-4000-8000-000000000003',
      contractDate: day('2033-05-01'),
      economicTransferDate: day('2033-07-01'),
      sellerPartyIds: [A],
    });
    const sold = acc8({
      acquisitions: [
        acquisition(),
        { ...second, acquiredShare: { numerator: 2, denominator: 5 } },
        { ...third, acquiredShare: { numerator: 1, denominator: 5 } },
      ],
      ownerships: [
        ownership(A, '3/5', '2026-07-01', null, W),
        ownership(B, '2/5', '2026-07-01', '2030-06-30', W),
        ownership(A, '2/5', '2030-07-01', '2033-06-30', X),
        ownership(A, '1/5', '2033-07-01', null, X),
        ownership(C, '1/5', '2033-07-01', null, third.id),
      ],
    });
    const stages = stagesOf(sold, [2026, 2031, 2032, 2033, 2034]);
    expect(stages.map((y) => y.stage)).toEqual([1, 1, 1, 3, 3]);
    expect(stages[2]?.components.find((c) => c.componentId === P)?.criteria).toEqual(['PURCHASE']);
    expect(stages[3]?.components.map((c) => [c.componentId, c.criteria])).toEqual([
      [P, ['PURCHASE', 'SEVERAL_PURCHASES_PARTIAL_SALE']],
      [`ACQUISITION:${X}`, ['PURCHASE', 'SEVERAL_PURCHASES_PARTIAL_SALE']],
      // C’s one purchase is not raised by A’s reduction (its check is not in the snapshot: open).
      [`ACQUISITION:${third.id}`, ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN']],
    ]);
  });

  it('a not-computable component still raises its years; a purchase without a start raises every year of the run', () => {
    const a = acquisition();
    const unconfirmed = acc8({
      asset: asset({ shorterUsefulLives: [life()] }),
      acquisitions: [acquisition({ allocation: { ...(a.allocation as NonNullable<typeof a.allocation>), reviewState: 'UNREVIEWED' } })],
    });
    const schedule = deriveSchedule({ ...unconfirmed, from: 2026, to: 2027 }, registry);
    expect(schedule.components[0]?.status).toBe('NOT_COMPUTABLE');
    expect(stagesOf(unconfirmed, [2026, 2027]).map((y) => y.stage)).toEqual([3, 3]);
    const undated = acc8({
      asset: asset({ shorterUsefulLives: [life({ acquisitionId: X })] }),
      acquisitions: [acquisition(), acquisition({ id: X, contractDate: day('2029-03-01'), economicTransferDate: null, sellerPartyIds: [A] })],
    });
    expect(stagesOf(undated, [2026, 2027, 2028]).map((y) => y.stage)).toEqual([3, 3, 3]);
  });

  it('a separate asset is 2; a later addition makes every one of its years 3', () => {
    const id = REPAIR.replace('71', '61');
    const ref = { sourceType: 'TRANSACTION_SPLIT' as const, sourceId: id, sourcePosition: null };
    const own = { ...acc8(), asset: kitchen({ items: [ref] }), capitalizedItems: [capitalized(id, '2027-04-20', '12000.00')] };
    expect(summary(own, [2027, 2028])).toEqual([
      [2027, 2, [[`TRANSACTION_SPLIT:${id}`, 2, ['MOVABLE_ASSET']]]],
      [2028, 2, [[`TRANSACTION_SPLIT:${id}`, 2, ['MOVABLE_ASSET']]]],
    ]);
    const laterId = REPAIR.replace('71', '62');
    const later = {
      ...own,
      asset: kitchen({ items: [ref, { ...ref, sourceId: laterId }] }),
      capitalizedItems: [...own.capitalizedItems, capitalized(laterId, '2028-03-01', '800.00')],
    };
    const stages = stagesOf(later, [2027, 2028]);
    expect(stages.map((y) => y.stage)).toEqual([3, 3]);
    // Both items (the asset's start counts for each, §59B) carry the asset's later addition.
    expect(stages[0]?.components.map((c) => c.criteria)).toEqual([
      ['MOVABLE_ASSET', 'MOVABLE_ASSET_LATER_ADDITION'],
      ['MOVABLE_ASSET', 'MOVABLE_ASSET_LATER_ADDITION'],
    ]);
  });

  it('an item the building excludes (an ACTIVE separate asset holds it) raises nothing on the building (236-1)', () => {
    const item = capitalized(EXTENSION, '2027-04-20', '12000.00');
    const input = acc8({ capitalizedItems: [item], links: [{ ...item, assetId: '0000dddd-0000-4000-8000-000000000002' }] });
    const stages = stagesOf(input, [2026, 2027]);
    expect(deriveSchedule({ ...input, from: 2026, to: 2027 }, registry).excludedItems).toEqual([
      { componentId: componentIdOf(item), separateAssetId: '0000dddd-0000-4000-8000-000000000002' },
    ]);
    expect(stages.map((y) => [y.year, y.stage, y.components.map((c) => c.kind)])).toEqual([
      [2026, 1, ['ACQUISITION']],
      [2027, 1, ['ACQUISITION']],
    ]);
  });

  it('the mapping is read from the registry: another version changes the stage; an unmapped criterion or no version is 3', () => {
    const input = acc8({ capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null })] });
    const mapped = (criteria: RecordingStagesParameters['criteria']): StageRule => ({ ...rule, version: 2, parameters: { criteria } });
    const raised = mapped(rule.parameters.criteria.map((c) => (c.code === 'CAPITALIZED_ITEM' ? { ...c, stage: 3 as const } : c)));
    expect(stagesOf(input, [2027], undefined, raised)[0]?.stage).toBe(3);
    const lowered = mapped(rule.parameters.criteria.map((c) => (c.code === 'CAPITALIZED_ITEM' ? { ...c, stage: 1 as const } : c)));
    expect(stagesOf(input, [2027], undefined, lowered)[0]?.stage).toBe(1);
    expect(stagesOf(input, [2027], undefined, mapped(rule.parameters.criteria.filter((c) => c.code !== 'CAPITALIZED_ITEM')))[0]?.stage).toBe(3);
    expect(stagesOf(acc8(), [2026], undefined, null)[0]?.stage).toBe(3);
  });

  it('the stage changes no figure: the schedule is the same object whatever is derived from it', () => {
    const input = acc8({ asset: asset({ shorterUsefulLives: [life()] }), capitalizedItems: [repair()] });
    const schedule = deriveSchedule({ ...input, from: 2026, to: 2028 }, registry);
    const before = JSON.stringify(schedule);
    yearStages(schedule, readWith(input), [2026, 2027, 2028], rule);
    expect(JSON.stringify(schedule)).toBe(before);
  });
});

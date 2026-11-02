import { ruleKey, type BusinessDate, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import { byText, yearOfDate } from './exact.js';
import { componentIdOf } from './capitalized-item.js';
import {
  RECORDING_STAGES_RULE,
  RECORDING_STAGE_RULES,
  STAGE_CRITERIA,
  type RecordingStage,
  type RecordingStagesParameters,
  type StageCriterion,
} from './rules/de-recording-stages.js';
import type { DepreciationSchedule, ItemComponent, ScheduleComponent, ScheduleRead } from './schedule-model.js';

/**
 * The release stage of each component and year (VC-X-45, api-design.md §60A): a component's stage is the highest stage
 * of its criteria under `DE_RECORDING_STAGES`, a year's the highest stage of **every** component active in it,
 * computable or not, with a figure or not, and of every item the building excludes (never dropped; decided 2026-11-02).
 * Facts decide, never review states: an unconfirmed shorter-life entry is stage 3. Pure; it reads the derived schedule
 * and the snapshot's facts, and changes no figure, reason or status.
 */

export interface ComponentStage {
  readonly componentId: string;
  /** `EXCLUDED_ITEM`: an item the building excludes because an `ACTIVE` separate asset holds it (§59B). */
  readonly kind: 'ACQUISITION' | 'CAPITALIZED_ITEM' | 'EXCLUDED_ITEM';
  readonly stage: RecordingStage;
  /** In §60A's order. */
  readonly criteria: readonly StageCriterion[];
}

export interface YearStage {
  readonly year: number;
  readonly stage: RecordingStage;
  /** Every component counted in the year, in `componentId` order; empty for a year without one. */
  readonly components: readonly ComponentStage[];
}

export type StageRule = RuleVersion<RecordingStagesParameters>;

/** The version of `DE_RECORDING_STAGES` applicable on `today` (default registry `RECORDING_STAGE_RULES`, never `TAX_RULES`). */
export function stageRuleOn(today: BusinessDate, registry: RuleRegistry = RECORDING_STAGE_RULES): StageRule | null {
  return (registry.select(RECORDING_STAGES_RULE, today) as StageRule | undefined) ?? null;
}

/** `"DE_RECORDING_STAGES@1"`, or `null` without an applicable version (every component is then stage 3). */
export const stageRulesOf = (rule: StageRule | null): string | null => (rule === null ? null : ruleKey(rule));

const maxStage = (stages: readonly RecordingStage[]): RecordingStage => stages.reduce<RecordingStage>((m, s) => (s > m ? s : m), 1);

function stageOf(criteria: readonly StageCriterion[], rule: StageRule | null): RecordingStage {
  if (rule === null) return 3;
  // A criterion the version does not map counts as the highest stage (the most conservative reading).
  return maxStage(criteria.map((c) => rule.parameters.criteria.find((x) => x.code === c)?.stage ?? 3));
}

const ordered = (criteria: Iterable<StageCriterion>): StageCriterion[] =>
  [...new Set(criteria)].sort((a, b) => STAGE_CRITERIA.indexOf(a) - STAGE_CRITERIA.indexOf(b));

/** The criteria of a purchase component (§59A, §59C, §59G; A1; the decisions of 2026-11-02). */
function purchaseCriteria(c: ScheduleComponent, read: ScheduleRead, purchaseIds: readonly string[]): StageCriterion[] {
  const criteria: StageCriterion[] = ['PURCHASE'];
  // A shorter-life entry on the purchase, in any review state („auch unbestätigt“).
  if (read.asset.shorterUsefulLives.some((e) => e.acquisitionId === c.acquisitionId)) criteria.push('SHORTER_USEFUL_LIFE_ENTRY');
  // A1: the check NOT_COMPUTABLE, or WEG Hausgeld maintenance not counted; a running window alone is not. A check the
  // snapshot does not give is not known to be conclusive: open as well.
  const check = read.purchaseChecks?.find((x) => x.acquisitionId === c.acquisitionId);
  if (check === undefined || check.status === 'NOT_COMPUTABLE' || check.wegHausgeldMaintenanceNotCounted) criteria.push('ANSCHAFFUNGSNAHE_CHECK_OPEN');
  // An owner with more than one purchase component of the building and a share reduction: every purchase of that owner.
  const buyers = new Set([...read.ownerships.filter((o) => o.acquisitionId === c.acquisitionId).map((o) => o.partyId), ...c.owners.map((o) => o.ownerPartyId)]);
  for (const party of buyers) {
    const own = read.ownerships.filter((o) => o.partyId === party);
    const bought = new Set(own.flatMap((o) => (o.acquisitionId !== null && purchaseIds.includes(o.acquisitionId) ? [o.acquisitionId] : [])));
    const reduced = read.acquisitions.some((a) => a.sellerPartyIds.includes(party)) || shareReduced(own);
    if (bought.size > 1 && reduced) criteria.push('SEVERAL_PURCHASES_PARTIAL_SALE');
  }
  return criteria;
}

const nextDay = (date: BusinessDate): BusinessDate => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10) as BusinessDate;
};

/** Whether a Party's share ever falls: on the day after one of its rows ends it holds less than on that day. */
function shareReduced(rows: readonly ScheduleRead['ownerships'][number][]): boolean {
  const held = (date: BusinessDate) =>
    rows
      .filter((o) => o.validFrom <= date && (o.validUntil === null || date <= o.validUntil))
      .reduce((sum, o) => ({ n: sum.n * BigInt(o.share.denominator) + BigInt(o.share.numerator) * sum.d, d: sum.d * BigInt(o.share.denominator) }), {
        n: 0n,
        d: 1n,
      });
  return rows.some((o) => {
    if (o.validUntil === null) return false;
    const before = held(o.validUntil);
    const after = held(nextDay(o.validUntil));
    return after.n * before.d < before.n * after.d;
  });
}

/** The criteria every item has from its source (§58B, §59E): an anschaffungsnahe capitalisation, Loan interest. */
function sourceCriteria(source: {
  readonly anschaffungsnaheAcquisitionId: string | null;
  readonly taxCategory: string | null;
  readonly loan?: unknown;
  readonly constructionPeriodInterestId?: string | null;
}): StageCriterion[] {
  const criteria: StageCriterion[] = [];
  if (source.anschaffungsnaheAcquisitionId !== null) criteria.push('ANSCHAFFUNGSNAHE_CAPITALIZATION');
  if ((source.loan ?? null) !== null || (source.constructionPeriodInterestId ?? null) !== null || source.taxCategory === 'LOAN_INTEREST') {
    criteria.push('LOAN_INTEREST_COMPONENT');
  }
  return criteria;
}

/** A later item of a separate asset: dated in a year after `acquiredOn` (§59B `LATER_ITEM_TO_VERIFY`); unknown dates count. */
const isLater = (c: ItemComponent, acquiredOn: BusinessDate | null) =>
  c.source.date === null || acquiredOn === null || yearOfDate(c.source.date) > yearOfDate(acquiredOn);

function itemCriteria(c: ItemComponent, read: ScheduleRead, laterAddition: boolean): StageCriterion[] {
  if (read.asset.assetType === 'SEPARATE_ASSET') {
    // A later addition raises the separate asset's every active year (§60A's table): each of its components.
    return ['MOVABLE_ASSET', ...sourceCriteria(c.source), ...(laterAddition ? (['MOVABLE_ASSET_LATER_ADDITION'] as const) : [])];
  }
  const criteria: StageCriterion[] = ['CAPITALIZED_ITEM', ...sourceCriteria(c.source)];
  // An item in the pool of an owner whose purchase has a shorter-life entry takes that life: stage 3 like the purchase.
  const acquisitionIds = new Set(
    read.ownerships.filter((o) => c.owners.some((p) => p.ownerPartyId === o.partyId || p.ownershipIds.includes(o.id))).map((o) => o.acquisitionId),
  );
  if (read.asset.shorterUsefulLives.some((e) => acquisitionIds.has(e.acquisitionId))) criteria.push('SHORTER_USEFUL_LIFE_ENTRY');
  return criteria;
}

interface Counted {
  readonly stage: ComponentStage;
  /** The years the component counts in; `null` for every year (its start is unknown). */
  readonly years: ReadonlySet<number> | null;
}

/** Every component of the property-level schedule, and every excluded item, with its stage and its years. */
function counted(schedule: DepreciationSchedule, read: ScheduleRead, rule: StageRule | null): Counted[] {
  const purchaseIds = schedule.components.flatMap((c) => (c.kind === 'ACQUISITION' ? [c.acquisitionId] : []));
  const laterAddition =
    read.asset.assetType === 'SEPARATE_ASSET' && schedule.components.some((c) => c.kind === 'CAPITALIZED_ITEM' && isLater(c, read.asset.acquiredOn));
  const list: Counted[] = schedule.components.map((c) => {
    const criteria = ordered(c.kind === 'ACQUISITION' ? purchaseCriteria(c, read, purchaseIds) : itemCriteria(c, read, laterAddition));
    // A component without a start (`TRANSFER_DATE_MISSING`, or an item without a usable start) counts in every year.
    const unknownStart = c.kind === 'ACQUISITION' ? c.start === null : c.start.month === null;
    return {
      stage: { componentId: c.componentId, kind: c.kind, stage: stageOf(criteria, rule), criteria },
      years: unknownStart ? null : new Set(c.years.map((y) => y.year)),
    };
  });
  // The items a building excludes (an ACTIVE separate asset holds them): not dropped; a movable asset's item, counted in
  // the building's years from its date on (unknown: every year).
  for (const excluded of schedule.excludedItems ?? []) {
    const item = read.capitalizedItems.find((i) => componentIdOf(i) === excluded.componentId);
    const criteria = ordered(['MOVABLE_ASSET', ...(item === undefined ? [] : sourceCriteria(item))]);
    const from = item === undefined ? null : yearOfDate(item.date);
    const years = from === null ? null : new Set(schedule.years.map((y) => y.year).filter((y) => y >= from));
    list.push({ stage: { componentId: excluded.componentId, kind: 'EXCLUDED_ITEM', stage: stageOf(criteria, rule), criteria }, years });
  }
  return list;
}

/**
 * The stage of each year in `years` from the property-level `schedule` (whose range covers them) and its snapshot: the
 * highest stage of the components counted in it; stage 1 and no component for a year without one.
 */
export function yearStages(schedule: DepreciationSchedule, read: ScheduleRead, years: readonly number[], rule: StageRule | null): YearStage[] {
  const all = counted(schedule, read, rule);
  return years.map((year) => {
    const components = all
      .filter((c) => c.years === null || c.years.has(year))
      .map((c) => c.stage)
      .sort((a, b) => byText(a.componentId, b.componentId));
    return { year, stage: maxStage(components.map((c) => c.stage)), components };
  });
}

/** The years above the released stage, ascending (the refusal's and the flag's), each with every component of it. */
export const aboveReleased = (stages: readonly YearStage[], released: RecordingStage): YearStage[] => stages.filter((y) => y.stage > released);

/** A year's stage as the refusal and the flag name it (§60A). */
export const stageDetails = (y: YearStage) => ({
  year: y.year,
  stage: y.stage,
  components: y.components.map((c) => ({ componentId: c.componentId, kind: c.kind, stage: c.stage, criteria: c.criteria })),
});

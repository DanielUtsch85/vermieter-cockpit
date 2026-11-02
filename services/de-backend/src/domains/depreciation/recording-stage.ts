import { addDays, ruleKey, type BusinessDate, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import { byText, yearOfDate } from './exact.js';
import {
  RECORDING_STAGES_RULE,
  RECORDING_STAGE_RULES,
  STAGE_CRITERIA,
  type RecordingStage,
  type RecordingStagesParameters,
  type StageCriterion,
} from './rules/de-recording-stages.js';
import type { DepreciationSchedule, ItemComponent, PurchaseCheckFacts, ScheduleComponent, ScheduleRead } from './schedule-model.js';

/**
 * The release stage of each component and year (VC-X-45, api-design.md §60A): a component's stage in a year is the
 * highest stage of its criteria applying in that year under `DE_RECORDING_STAGES`, a year's the highest stage of
 * **every** component active in it, computable or not, with a figure or not (decided 2026-11-02). An item the building
 * excludes because an `ACTIVE` separate asset holds it is not the building's: it carries its stage on that asset only
 * (Entscheidung des Projektinhabers, 2026-11-02, 236-1). Facts decide, never review states: an unconfirmed shorter-life
 * entry is stage 3. Pure; it reads the derived schedule and the snapshot's facts, and changes no figure, reason or status.
 */

export interface ComponentStage {
  readonly componentId: string;
  readonly kind: 'ACQUISITION' | 'CAPITALIZED_ITEM';
  /** In the year it is reported for. */
  readonly stage: RecordingStage;
  /** The criteria applying in that year, in §60A's order. */
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

/** A criterion and the first year it applies in; `null`: every year the component counts in. */
interface Dated {
  readonly code: StageCriterion;
  readonly from: number | null;
}

const always = (codes: readonly StageCriterion[]): Dated[] => codes.map((code) => ({ code, from: null }));

/** The criteria of a purchase component (§59A, §59C, §59G; A1; the decisions of 2026-11-02, 236-2 and 236-4, and 3 of the third round). */
function purchaseCriteria(c: ScheduleComponent, read: ScheduleRead, purchases: readonly ScheduleComponent[]): Dated[] {
  const criteria: StageCriterion[] = ['PURCHASE'];
  // A shorter-life entry on the purchase, in any review state („auch unbestätigt“).
  if (read.asset.shorterUsefulLives.some((e) => e.acquisitionId === c.acquisitionId)) criteria.push('SHORTER_USEFUL_LIFE_ENTRY');
  // A1: the check NOT_COMPUTABLE, or WEG Hausgeld maintenance not counted; a running window alone is not. A check the
  // snapshot does not give is not known to be conclusive: open as well.
  const check = read.purchaseChecks?.find((x) => x.acquisitionId === c.acquisitionId);
  if (check === undefined || check.status === 'NOT_COMPUTABLE' || check.wegHausgeldMaintenanceNotCounted) criteria.push('ANSCHAFFUNGSNAHE_CHECK_OPEN');
  const dated = always(criteria);
  // 236-4: above the threshold with a proposal not yet followed is open too (like A1's Hausgeld flag), from the year of
  // the first summed source on; the mapping is unchanged (one more fact meeting the same criterion).
  const proposal = check === undefined ? null : openProposalFrom(check);
  if (proposal !== null) dated.push({ code: 'ANSCHAFFUNGSNAHE_CHECK_OPEN', from: proposal });
  // 236-2 with decision 3 (third round): every purchase of an owner from the year of the owner's first share reduction
  // at which more than one of its purchases is active on; a reduction while it holds one purchase starts nothing, a later
  // purchase is a new layer (before it each purchase counts for itself, 236-3).
  const buyers = new Set([...read.ownerships.filter((o) => o.acquisitionId === c.acquisitionId).map((o) => o.partyId), ...c.owners.map((o) => o.ownerPartyId)]);
  const from: number[] = [];
  for (const party of buyers) {
    const first = firstLayeredReduction(party, read, purchases);
    if (first !== null) from.push(first);
  }
  if (from.length > 0) dated.push({ code: 'SEVERAL_PURCHASES_PARTIAL_SALE', from: Math.min(...from) });
  return dated;
}

/**
 * 236-4: the first year of a check `ABOVE_THRESHOLD` while one of its summed sources is not `CAPITALIZED` (its proposal
 * not followed: `DEDUCTIBLE`, or `DISTRIBUTED_82B`, counted like it: Entscheidung des Projektinhabers, 2026-11-02,
 * decision 2 of the third round); `null` otherwise, and without a summed source (explicitly, not `Math.min()`). The year
 * is the earliest tax year of the summed sources (the earliest of the check's `affectedYears`, §58B, or earlier where a
 * source straddling the window, which is never suggested as a whole, comes first).
 */
function openProposalFrom(check: PurchaseCheckFacts): number | null {
  if (check.status !== 'ABOVE_THRESHOLD' || check.summedSources.length === 0) return null;
  if (check.summedSources.every((s) => s.treatment === 'CAPITALIZED')) return null;
  return Math.min(...check.summedSources.map((s) => s.taxYear));
}

/**
 * The number of the Party's purchases active at a reduction on `day` (decision 3; the reading of api-design.md §60A
 * "VC-X-45 follow-up 2"): the building's purchase components with an owner part of the Party that bought a share
 * (`acquiredShare` above 0, §28.1A) which has begun on that day (its start, the economic transfer `tenure.from`, on or
 * before it) and is not wholly sold before it (its `tenure.lastDay`, if any, not before the day before: a part this very
 * reduction ends still counts). A part whose start or last day the schedule does not know counts as active (the cautious
 * reading; a not-computable component has no `lastDay`).
 */
function activePurchases(party: string, day: BusinessDate, purchases: readonly ScheduleComponent[]): number {
  const dayBefore = addDays(day, -1);
  return purchases.filter((p) =>
    p.owners.some(
      (o) =>
        o.ownerPartyId === party &&
        BigInt(o.acquiredShare.split('/')[0] as string) > 0n &&
        (o.tenure.from === null || o.tenure.from <= day) &&
        (o.tenure.lastDay === null || dayBefore <= o.tenure.lastDay),
    ),
  ).length;
}

/**
 * The year of a Party's first share reduction at which more than one of its purchases is active, `null` without one. A
 * reduction is a sale by it (`sellerPartyIds`; on the transfer date, else on the contract date, which no transfer
 * precedes), or the day after one of its rows ends, on which it holds less.
 */
function firstLayeredReduction(party: string, read: ScheduleRead, purchases: readonly ScheduleComponent[]): number | null {
  const rows = read.ownerships.filter((o) => o.partyId === party);
  const held = (date: BusinessDate) =>
    rows
      .filter((o) => o.validFrom <= date && (o.validUntil === null || date <= o.validUntil))
      .reduce((sum, o) => ({ n: sum.n * BigInt(o.share.denominator) + BigInt(o.share.numerator) * sum.d, d: sum.d * BigInt(o.share.denominator) }), {
        n: 0n,
        d: 1n,
      });
  const days = [
    ...read.acquisitions.filter((a) => a.sellerPartyIds.includes(party)).map((a) => a.economicTransferDate ?? a.contractDate),
    ...rows.flatMap((o) => {
      if (o.validUntil === null) return [];
      const before = held(o.validUntil);
      const after = held(addDays(o.validUntil, 1));
      return after.n * before.d < before.n * after.d ? [addDays(o.validUntil, 1)] : [];
    }),
  ];
  const years = days.filter((d) => activePurchases(party, d, purchases) > 1).map(yearOfDate);
  return years.length === 0 ? null : Math.min(...years);
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
  readonly componentId: string;
  readonly kind: ComponentStage['kind'];
  readonly criteria: readonly Dated[];
  /** The years the component counts in; `null` for every year (its start is unknown). */
  readonly years: ReadonlySet<number> | null;
}

/** Every component of the property-level schedule with its criteria and its years; no item the building excludes (236-1). */
function counted(schedule: DepreciationSchedule, read: ScheduleRead): Counted[] {
  const purchases = schedule.components.filter((c): c is ScheduleComponent => c.kind === 'ACQUISITION');
  const laterAddition =
    read.asset.assetType === 'SEPARATE_ASSET' && schedule.components.some((c) => c.kind === 'CAPITALIZED_ITEM' && isLater(c, read.asset.acquiredOn));
  return schedule.components.map((c) => {
    const criteria = c.kind === 'ACQUISITION' ? purchaseCriteria(c, read, purchases) : always(itemCriteria(c, read, laterAddition));
    // A component without a start (`TRANSFER_DATE_MISSING`, or an item without a usable start) counts in every year.
    const unknownStart = c.kind === 'ACQUISITION' ? c.start === null : c.start.month === null;
    return { componentId: c.componentId, kind: c.kind, criteria, years: unknownStart ? null : new Set(c.years.map((y) => y.year)) };
  });
}

/** A counted component's stage in `year`: the criteria applying in it. */
function stageIn(c: Counted, year: number, rule: StageRule | null): ComponentStage {
  const criteria = ordered(c.criteria.flatMap((x) => (x.from === null || year >= x.from ? [x.code] : [])));
  return { componentId: c.componentId, kind: c.kind, stage: stageOf(criteria, rule), criteria };
}

/**
 * The stage of each year in `years` from the property-level `schedule` (whose range covers them) and its snapshot: the
 * highest stage of the components counted in it; stage 1 and no component for a year without one.
 */
export function yearStages(schedule: DepreciationSchedule, read: ScheduleRead, years: readonly number[], rule: StageRule | null): YearStage[] {
  const all = counted(schedule, read);
  return years.map((year) => {
    const components = all
      .filter((c) => c.years === null || c.years.has(year))
      .map((c) => stageIn(c, year, rule))
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

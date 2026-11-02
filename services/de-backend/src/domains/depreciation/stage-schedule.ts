import type { BusinessDate, RuleRegistry } from '../../shared/index.js';
import { byText } from './exact.js';
import { aboveReleased, stageDetails, stageRuleOn, stageRulesOf, yearStages, type StageRule, type YearStage } from './recording-stage.js';
import type { RecordingStage, StageCriterion } from './rules/de-recording-stages.js';
import type { DepreciationSchedule, Flag, ScheduleRead } from './schedule-model.js';
import type { RecordedSchedule, RecordedScheduleYear } from './version-schedule.js';

/**
 * The schedule read with its release stages (VC-X-45, api-design.md §60A "The schedule read"): `recordingStage` (the
 * installation's released stage and the mapping's version, A6: shown whatever the main switch says), `years[].stage`,
 * and the open flag `DEPRECIATION_STAGE_NOT_RELEASED` on each year above the released stage. It changes no figure,
 * reason, status or other flag.
 */

export const STAGE_NOT_RELEASED = 'DEPRECIATION_STAGE_NOT_RELEASED';

export interface StagedScheduleYear extends RecordedScheduleYear {
  /** `null` for a year without a component. */
  readonly stage: {
    readonly stage: RecordingStage;
    readonly components: readonly { readonly componentId: string; readonly stage: RecordingStage; readonly criteria: readonly StageCriterion[] }[];
  } | null;
}

export interface StagedSchedule extends Omit<RecordedSchedule, 'years'> {
  readonly years: readonly StagedScheduleYear[];
  readonly recordingStage: { readonly released: RecordingStage; readonly rules: string | null };
}

/** The stages of `years` from the property-level schedule, under the version applicable on `today`. */
export function stagesOf(
  property: DepreciationSchedule,
  read: ScheduleRead,
  years: readonly number[],
  today: BusinessDate,
  stageRegistry?: RuleRegistry,
): { readonly rule: StageRule | null; readonly stages: readonly YearStage[] } {
  const rule = stageRuleOn(today, stageRegistry);
  return { rule, stages: yearStages(property, read, years, rule) };
}

export function withStages(
  recorded: RecordedSchedule,
  property: DepreciationSchedule,
  read: ScheduleRead,
  context: { readonly releasedStage: RecordingStage; readonly today: BusinessDate; readonly stageRegistry?: RuleRegistry },
): StagedSchedule {
  const { releasedStage } = context;
  const { rule, stages } = stagesOf(
    property,
    read,
    recorded.years.map((y) => y.year),
    context.today,
    context.stageRegistry,
  );
  const above = aboveReleased(stages, releasedStage);
  const years = recorded.years.map((y, i): StagedScheduleYear => {
    const s = stages[i] as YearStage;
    const stage =
      s.components.length === 0
        ? null
        : { stage: s.stage, components: s.components.map((c) => ({ componentId: c.componentId, stage: c.stage, criteria: c.criteria })) };
    if (!above.includes(s)) return { ...y, stage };
    const { year: _year, ...details } = stageDetails(s);
    const flag: Flag = { code: STAGE_NOT_RELEASED, details: { stage: details.stage, releasedStage, components: details.components } };
    return { ...y, stage, flags: [...y.flags, flag].sort((a, b) => byText(a.code, b.code)) };
  });
  const open =
    above.length === 0
      ? recorded.review.open
      : [...recorded.review.open.filter((o) => o.code !== STAGE_NOT_RELEASED), { code: STAGE_NOT_RELEASED, count: above.length }].sort((a, b) =>
          byText(a.code, b.code),
        );
  return { ...recorded, years, review: { open, info: recorded.review.info }, recordingStage: { released: releasedStage, rules: stageRulesOf(rule) } };
}

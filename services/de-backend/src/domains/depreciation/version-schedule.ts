import type { BusinessDate, RuleRegistry } from '../../shared/index.js';
import { centsText, type Fingerprinter } from './fingerprint.js';
import type { DepreciationSchedule, Flag, ScheduleRead, ScheduleYear } from './schedule-model.js';
import { compareYear, liveSchedule, reproduce, type RecordingState, type Reproduction, type YearComparison } from './version-compare.js';
import type { ScheduleVersion } from './version-model.js';

/**
 * The schedule read with its recording state (api-design.md §60 "Reads", "Flags"; P8-D10): per year the asset's input
 * fingerprint (the record command's precondition), `NOT_RECORDED`, `UNCHANGED` or `CHANGED_SINCE_RECORDED`, the open
 * flags `DEPRECIATION_SCHEDULE_NOT_RECORDED`, `DEPRECIATION_CHANGED_SINCE_RECORDED` and
 * `RECORDED_VERSION_NOT_REPRODUCIBLE`, the `CURRENT` version, and `recordingEnabled` (decided 2026-10-31, third set,
 * open question 10), which only reports the installation's switch: it changes no figure, flag, reason or status.
 */

export const RECORDING_FLAGS = ['DEPRECIATION_SCHEDULE_NOT_RECORDED', 'DEPRECIATION_CHANGED_SINCE_RECORDED', 'RECORDED_VERSION_NOT_REPRODUCIBLE'] as const;

export interface RecordedScheduleYear extends ScheduleYear {
  readonly inputFingerprint: string;
  readonly recording: RecordingState | null;
}

export interface RecordedSchedule extends Omit<DepreciationSchedule, 'years'> {
  readonly years: readonly RecordedScheduleYear[];
  readonly recordedVersion: {
    readonly versionId: string;
    readonly versionNumber: number;
    readonly throughYear: number;
    readonly recordedAt: Date;
    readonly reproducible: boolean;
  } | null;
  readonly recordingEnabled: boolean;
}

const money = (cents: bigint | null, currency: string) => (cents === null ? null : { amount: centsText(cents), currency });

/** The details of `DEPRECIATION_CHANGED_SINCE_RECORDED` (§60 "Flags"). */
export function changedDetails(assetId: string, version: ScheduleVersion, c: YearComparison) {
  const currency = version.inputs.currency;
  return {
    assetId,
    versionId: version.versionId,
    versionNumber: version.versionNumber,
    year: c.year,
    recorded: money(c.recorded, currency),
    derived: money(c.derived, currency),
    amountChanged: c.amountChanged,
    causes: c.causes,
    owners: c.owners.map((o) => ({
      partKey: o.partKey,
      ownerPartyId: o.ownerPartyId,
      recorded: money(o.recorded, currency),
      derived: money(o.derived, currency),
    })),
    components: c.components.map((x) => ({
      componentId: x.componentId,
      change: x.change,
      recorded: money(x.recorded, currency),
      derived: money(x.derived, currency),
    })),
  };
}

export function withRecording(
  schedule: DepreciationSchedule,
  read: ScheduleRead,
  context: {
    readonly registry: RuleRegistry;
    readonly fingerprinter: Fingerprinter;
    readonly today: BusinessDate;
    readonly current: ScheduleVersion | null;
    readonly recordingEnabled: boolean;
  },
): RecordedSchedule {
  const { current, fingerprinter } = context;
  const horizon = Math.max(schedule.range.to, current?.throughYear ?? schedule.range.to);
  const live = liveSchedule(read, context.registry, fingerprinter, context.today, horizon);
  const reproduction: Reproduction | null = current === null ? null : reproduce(current, context.registry, fingerprinter);
  const counts = new Map<string, number>();
  const years = schedule.years.map((y): RecordedScheduleYear => {
    const c = compareYear(current, live, y.year, fingerprinter, schedule.ownerPartyId);
    const flags: Flag[] = [];
    if (c.state === 'NOT_RECORDED') {
      flags.push({
        code: 'DEPRECIATION_SCHEDULE_NOT_RECORDED',
        details: {
          assetId: schedule.assetId,
          assetType: schedule.assetType,
          currentVersionId: current?.versionId ?? null,
          currentThroughYear: current?.throughYear ?? null,
        },
      });
    }
    if (c.state === 'CHANGED_SINCE_RECORDED' && current !== null) {
      flags.push({ code: 'DEPRECIATION_CHANGED_SINCE_RECORDED', details: changedDetails(schedule.assetId, current, c) });
    }
    if (reproduction !== null && !reproduction.reproducible && current !== null && reproduction.years.includes(y.year)) {
      flags.push({
        code: 'RECORDED_VERSION_NOT_REPRODUCIBLE',
        details: { assetId: schedule.assetId, versionId: current.versionId, causes: reproduction.causes, years: reproduction.years },
      });
    }
    for (const f of flags) counts.set(f.code, (counts.get(f.code) ?? 0) + 1);
    return {
      ...y,
      inputFingerprint: c.inputFingerprint,
      recording: c.state,
      flags: [...y.flags, ...flags].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    };
  });
  const open = [...schedule.review.open.filter((o) => !counts.has(o.code)), ...[...counts.entries()].map(([code, count]) => ({ code, count }))].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
  return {
    ...schedule,
    years,
    review: { open, info: schedule.review.info },
    recordedVersion:
      current === null
        ? null
        : {
            versionId: current.versionId,
            versionNumber: current.versionNumber,
            throughYear: current.throughYear,
            recordedAt: current.recordedAt,
            reproducible: reproduction?.reproducible ?? true,
          },
    recordingEnabled: context.recordingEnabled,
  };
}

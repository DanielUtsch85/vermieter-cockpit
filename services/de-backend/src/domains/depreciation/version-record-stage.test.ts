import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import type { RecordingStage } from './rules/de-recording-stages.js';
import { deriveSchedule } from './schedule.js';
import { acc8, asset, day, life, W } from './schedule.test-support.js';
import { REPAIR, repair } from './schedule-items.test-support.js';
import type { PurchaseCheckFacts, ScheduleInput, ScheduleRead } from './schedule-model.js';
import { STAGE_NOT_RELEASED, withStages } from './stage-schedule.js';
import { inputFingerprint } from './version-fingerprint.js';
import type { RecordRequest, ScheduleVersion } from './version-model.js';
import { planRecord } from './version-record.js';
import { withRecording } from './version-schedule.js';
import { identity, live, readOf, recordInMemory } from './version.test-support.js';

/**
 * The stage check of the record command and the schedule read (VC-X-45, api-design.md §60A): the whole run refused when
 * any year is above the released stage, after `SCHEDULE_NOT_COMPLETE` and before the precondition; nothing recorded;
 * money unchanged by the stage; the read's `recordingStage`, `years[].stage` and `DEPRECIATION_STAGE_NOT_RELEASED`.
 * ACC8 and the repair capitalised in 2027 (synthetic).
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
const today = day('2028-03-01');
const checks: readonly PurchaseCheckFacts[] = [{ acquisitionId: W, status: 'NOT_ABOVE_THRESHOLD', wegHausgeldMaintenanceNotCounted: false, summedSources: [] }];
const readWith = (input: ScheduleInput): ScheduleRead => ({ ...readOf(input), purchaseChecks: checks });
const base = acc8();
const withRepair = acc8({ capitalizedItems: [repair({ anschaffungsnaheAcquisitionId: null })] });
const withLife = acc8({ asset: asset({ shorterUsefulLives: [life()] }) });
const fingerprintOf = (input: ScheduleInput, year: number) => inputFingerprint(live(input, registry, year, today).inputs, year, identity);
const request = (input: ScheduleInput, throughYear: number, extra: Partial<RecordRequest> = {}): RecordRequest => ({
  throughYear,
  reason: 'AfA laut Einkommensteuererklärung (synthetisch)',
  expectedInputFingerprint: fingerprintOf(input, throughYear),
  acceptChangedYears: [],
  ...extra,
});
const plan = (input: ScheduleInput, releasedStage: RecordingStage, req: RecordRequest, current: ScheduleVersion | null = null) =>
  planRecord({ schedule: readWith(input), current }, req, { registry, fingerprinter: identity, today, recordedBy: 'anna@example.com', releasedStage });
const ITEM = `TRANSACTION_SPLIT:${REPAIR}`;
const PURCHASE = `ACQUISITION:${W}`;

describe('the stage check of the record command (§60A, step 5)', () => {
  it('released 1: ACC8 records; with the repair the whole run through 2027 is refused, every year above named; through 2026 records', () => {
    expect(plan(base, 1, request(base, 2027)).kind).toBe('RECORD');
    const refused = plan(withRepair, 1, request(withRepair, 2027));
    expect(refused).toEqual({
      kind: 'REFUSED',
      refusal: {
        kind: 'STAGE_NOT_RELEASED',
        details: {
          releasedStage: 1,
          years: [
            {
              year: 2027,
              stage: 2,
              components: [
                { componentId: PURCHASE, kind: 'ACQUISITION', stage: 1, criteria: ['PURCHASE'] },
                { componentId: ITEM, kind: 'CAPITALIZED_ITEM', stage: 2, criteria: ['CAPITALIZED_ITEM'] },
              ],
            },
          ],
        },
      },
    });
    // No partial record: 2026 (stage 1) is not recorded either. An earlier throughYear within the stage records.
    expect(plan(withRepair, 1, request(withRepair, 2026)).kind).toBe('RECORD');
  });

  it('released 2 records the repair; released 2 with a shorter-life purchase refuses every year (3); released 3 records it', () => {
    expect(plan(withRepair, 2, request(withRepair, 2027)).kind).toBe('RECORD');
    const refused = plan(withLife, 2, request(withLife, 2027));
    expect(refused.kind === 'REFUSED' && refused.refusal.kind === 'STAGE_NOT_RELEASED' ? refused.refusal.details['years'] : null).toEqual(
      [2026, 2027].map((year) => ({
        year,
        stage: 3,
        components: [{ componentId: PURCHASE, kind: 'ACQUISITION', stage: 3, criteria: ['PURCHASE', 'SHORTER_USEFUL_LIFE_ENTRY'] }],
      })),
    );
    expect(plan(withLife, 3, request(withLife, 2027)).kind).toBe('RECORD');
  });

  it('a missing fact stays blocking at every stage: SCHEDULE_NOT_COMPLETE first, also at released 3; with the fact supplied the stage refuses', () => {
    const unconfirmed = acc8({ asset: asset({ shorterUsefulLives: [life({ reviewState: 'UNREVIEWED' })] }) });
    for (const released of [1, 2, 3] as const) {
      expect(plan(unconfirmed, released, request(unconfirmed, 2027))).toMatchObject({ kind: 'REFUSED', refusal: { kind: 'SCHEDULE_NOT_COMPLETE' } });
    }
    expect(plan(withLife, 1, request(withLife, 2027))).toMatchObject({ kind: 'REFUSED', refusal: { kind: 'STAGE_NOT_RELEASED' } });
  });

  it('the stage comes before the precondition and the no-op: a stale fingerprint and a recorded run are refused by the stage', () => {
    expect(plan(withRepair, 1, request(withRepair, 2027, { expectedInputFingerprint: 'stale' }))).toMatchObject({ refusal: { kind: 'STAGE_NOT_RELEASED' } });
    const v1 = recordInMemory(withRepair, registry, 2027, today);
    expect(plan(withRepair, 2, request(withRepair, 2027), v1).kind).toBe('NOOP');
    expect(plan(withRepair, 1, request(withRepair, 2027), v1)).toMatchObject({ refusal: { kind: 'STAGE_NOT_RELEASED' } });
  });

  it('money unchanged: the version recorded at stages 2 and 3 is the same, and its figures are the schedule’s', () => {
    const at = (stage: RecordingStage) => {
      const d = plan(withRepair, stage, request(withRepair, 2027));
      if (d.kind !== 'RECORD') throw new Error(d.kind);
      return d;
    };
    expect(at(2).version).toEqual(at(3).version);
    expect(at(3).version.years.map((y) => [y.year, y.amount])).toEqual([
      [2026, 254400n],
      [2027, 580200n],
    ]);
    // The stages go to the RECORDED AuditRecord only (§60A "Recorded versions"), never to the version.
    expect(at(2).stages).toEqual({
      releasedStage: 2,
      stageRules: 'DE_RECORDING_STAGES@1',
      years: [
        { year: 2026, stage: 1 },
        { year: 2027, stage: 2 },
      ],
    });
    expect(JSON.stringify(at(3).version, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/DE_RECORDING_STAGES|stage/i);
  });
});

describe('the schedule read with its stages (§60A "The schedule read")', () => {
  const read = (input: ScheduleInput, releasedStage: RecordingStage, ownerPartyId: string | null = null) => {
    const r = readWith(input);
    const schedule = deriveSchedule({ ...input, today, from: 2026, to: 2028, ownerPartyId }, registry);
    const property = deriveSchedule({ ...input, today, from: 2026, to: 2028, ownerPartyId: null }, registry);
    const recorded = withRecording(schedule, r, { registry, fingerprinter: identity, today, current: null, recordingEnabled: false });
    return { recorded, staged: withStages(recorded, property, r, { releasedStage, today }) };
  };

  it('released 1: the flag on exactly the years above it (open, in the review), recordingStage and years[].stage; figures and other flags unchanged', () => {
    const { recorded, staged } = read(withRepair, 1);
    expect(staged.recordingStage).toEqual({ released: 1, rules: 'DE_RECORDING_STAGES@1' });
    expect(staged.years.map((y) => [y.year, y.stage?.stage, y.flags.some((f) => f.code === STAGE_NOT_RELEASED)])).toEqual([
      [2026, 1, false],
      [2027, 2, true],
      [2028, 2, true],
    ]);
    expect(staged.years[1]?.flags.find((f) => f.code === STAGE_NOT_RELEASED)?.details).toEqual({
      stage: 2,
      releasedStage: 1,
      components: [
        { componentId: PURCHASE, kind: 'ACQUISITION', stage: 1, criteria: ['PURCHASE'] },
        { componentId: ITEM, kind: 'CAPITALIZED_ITEM', stage: 2, criteria: ['CAPITALIZED_ITEM'] },
      ],
    });
    expect(staged.review.open).toContainEqual({ code: STAGE_NOT_RELEASED, count: 2 });
    for (const [i, y] of staged.years.entries()) {
      const before = recorded.years[i];
      expect([y.amount, y.residualValue, y.owners, y.status, y.calculationStatus, y.reasons, y.recording]).toEqual([
        before?.amount,
        before?.residualValue,
        before?.owners,
        before?.status,
        before?.calculationStatus,
        before?.reasons,
        before?.recording,
      ]);
      expect(y.flags.filter((f) => f.code !== STAGE_NOT_RELEASED)).toEqual(before?.flags);
    }
    expect(staged.components).toEqual(recorded.components);
  });

  it('released 2 or 3: no flag; a year without a component has stage null; the owner level reads the asset’s stage', () => {
    for (const released of [2, 3] as const)
      expect(read(withRepair, released).staged.years.flatMap((y) => y.flags.map((f) => f.code))).not.toContain(STAGE_NOT_RELEASED);
    const early = deriveSchedule({ ...base, today, from: 2025, to: 2025, ownerPartyId: null }, registry);
    const r = readWith(base);
    const staged = withStages(withRecording(early, r, { registry, fingerprinter: identity, today, current: null, recordingEnabled: false }), early, r, {
      releasedStage: 1,
      today,
    });
    expect(staged.years.map((y) => y.stage)).toEqual([null]);
    const owner = read(withRepair, 1, acc8().ownerships[1]?.partyId).staged;
    expect(owner.years.map((y) => y.stage?.stage)).toEqual([1, 2, 2]);
  });
});

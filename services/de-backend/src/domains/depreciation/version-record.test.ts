import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { acquisition, acc8, asset, day } from './schedule.test-support.js';
import { repair } from './schedule-items.test-support.js';
import type { ScheduleInput } from './schedule-model.js';
import { compareYear } from './version-compare.js';
import { inputFingerprint } from './version-fingerprint.js';
import type { RecordRequest, ScheduleVersion } from './version-model.js';
import { planRecord } from './version-record.js';
import { A, B, identity, live, readOf, recordInMemory } from './version.test-support.js';

/**
 * The record command's decision (api-design.md §60 "Order of checks", steps 3–9) and the comparison of a year with the
 * `CURRENT` version, on ACC8 (synthetic): version 1 through 2027 (2,544.00 and 5,088.00), the repair capitalised after
 * the crossing (2027 `CHANGED_SINCE_RECORDED`, 5,088.00 → 5,802.00, the repair `ADDED`), 2028 `NOT_RECORDED`.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
const today = day('2028-03-01');
const owners = acc8().ownerships;
const base = acc8({ ownerships: owners });
const withRepair = acc8({ ownerships: owners, capitalizedItems: [repair()] });
const context = { registry, fingerprinter: identity, today, recordedBy: 'anna@example.com' };
const fingerprintOf = (input: ScheduleInput, year: number) => inputFingerprint(live(input, registry, year, today).inputs, year, identity);
const request = (input: ScheduleInput, throughYear: number, extra: Partial<RecordRequest> = {}): RecordRequest => ({
  throughYear,
  reason: 'AfA laut Einkommensteuererklärung (synthetisch)',
  expectedInputFingerprint: fingerprintOf(input, throughYear),
  acceptChangedYears: [],
  ...extra,
});
const plan = (input: ScheduleInput, current: ScheduleVersion | null, req: RecordRequest) => planRecord({ schedule: readOf(input), current }, req, context);
const v1 = () => recordInMemory(base, registry, 2027, day('2028-01-20'));

describe('the record command’s order of checks (§60, steps 3–9)', () => {
  it('records ACC8 through 2027: 2,544.00 and 5,088.00, A 3/5 and B 2/5, every year with its fingerprints', () => {
    const decision = plan(base, null, request(base, 2027));
    expect(decision.kind).toBe('RECORD');
    if (decision.kind !== 'RECORD') return;
    expect(decision.version.years.map((y) => [y.year, y.amount])).toEqual([
      [2026, 254400n],
      [2027, 508800n],
    ]);
    expect(decision.version.entries.filter((e) => e.year === 2027).map((e) => [e.partKey, e.amount])).toEqual([
      [`OWNER:${A}`, 305280n],
      [`OWNER:${B}`, 203520n],
    ]);
    expect(decision.version.inputFingerprint).toBe(fingerprintOf(base, 2027));
  });

  it('3. a VOID asset: ASSET_NOT_ACTIVE', () => {
    const voided = { ...base, asset: asset({ status: 'VOID', voidedAt: new Date(), voidReason: 'x' }) };
    expect(plan(voided, null, request(voided, 2027))).toMatchObject({ kind: 'REFUSED', refusal: { kind: 'ASSET_NOT_ACTIVE', status: 'VOID' } });
  });

  it('4. an unconfirmed asset, an unconfirmed allocation: SCHEDULE_NOT_COMPLETE; an earlier throughYear still records when only later years lack a figure', () => {
    const unconfirmed = { ...base, asset: asset({ reviewState: 'UNREVIEWED' }) };
    expect(plan(unconfirmed, null, request(unconfirmed, 2027))).toMatchObject({
      kind: 'REFUSED',
      refusal: { kind: 'SCHEDULE_NOT_COMPLETE', details: { reasons: ['ASSET_NOT_CONFIRMED'] } },
    });
    const a = acquisition();
    const allocation = {
      ...base,
      acquisitions: [acquisition({ allocation: { ...(a.allocation as NonNullable<typeof a.allocation>), reviewState: 'UNREVIEWED' } })],
    };
    const refused = plan(allocation, null, request(allocation, 2027));
    expect(refused).toMatchObject({ kind: 'REFUSED', refusal: { kind: 'SCHEDULE_NOT_COMPLETE' } });
    if (refused.kind === 'REFUSED' && refused.refusal.kind === 'SCHEDULE_NOT_COMPLETE') {
      expect((refused.refusal.details['years'] as { year: number }[]).map((y) => y.year)).toEqual([2026, 2027]);
    }
  });

  it('5. nothing active up to throughYear: NOTHING_TO_RECORD with the first year (null without a component)', () => {
    expect(plan(base, null, request(base, 2025))).toMatchObject({
      kind: 'REFUSED',
      refusal: { kind: 'NOTHING_TO_RECORD', throughYear: 2025, firstYear: 2026 },
    });
    const empty = { ...base, acquisitions: [], ownerships: [] };
    expect(plan(empty, null, request(empty, 2027))).toMatchObject({ kind: 'REFUSED', refusal: { kind: 'NOTHING_TO_RECORD', firstYear: null } });
  });

  it('6. a CURRENT version with a later throughYear: THROUGH_YEAR_BEFORE_CURRENT', () => {
    const current = v1();
    expect(plan(base, current, request(base, 2026))).toMatchObject({
      kind: 'REFUSED',
      refusal: { kind: 'THROUGH_YEAR_BEFORE_CURRENT', currentVersionId: current.versionId, currentThroughYear: 2027 },
    });
  });

  it('7. a stale expectedInputFingerprint: SCHEDULE_CHANGED with both fingerprints; counter-check: the fresh one records', () => {
    const stale = request(base, 2027).expectedInputFingerprint;
    expect(plan(withRepair, null, { ...request(withRepair, 2027), expectedInputFingerprint: stale })).toMatchObject({
      kind: 'REFUSED',
      refusal: { kind: 'SCHEDULE_CHANGED', expectedInputFingerprint: stale, currentInputFingerprint: fingerprintOf(withRepair, 2027) },
    });
    expect(plan(withRepair, null, request(withRepair, 2027)).kind).toBe('RECORD');
  });

  it('8. the no-op: the same run, every year unchanged, answers the CURRENT version whatever the reason says', () => {
    const current = v1();
    expect(plan(base, current, request(base, 2027, { reason: 'anders' }))).toEqual({ kind: 'NOOP', version: current });
  });

  it('9. acceptChangedYears: missing 2027 refused, naming an unchanged 2026 refused, exactly [2027] records', () => {
    const current = v1();
    expect(plan(withRepair, current, request(withRepair, 2028))).toMatchObject({
      kind: 'REFUSED',
      refusal: {
        kind: 'RECORDED_YEARS_WOULD_CHANGE',
        changedYears: [{ year: 2027, recorded: 508800n, derived: 580200n, causes: ['INPUTS'] }],
        acceptChangedYears: [],
      },
    });
    expect(plan(withRepair, current, request(withRepair, 2028, { acceptChangedYears: [2026, 2027] }))).toMatchObject({
      kind: 'REFUSED',
      refusal: { kind: 'RECORDED_YEARS_WOULD_CHANGE' },
    });
    const accepted = plan(withRepair, current, request(withRepair, 2028, { acceptChangedYears: [2027] }));
    expect(accepted.kind).toBe('RECORD');
    if (accepted.kind === 'RECORD') {
      expect(accepted.changedYears).toEqual([{ year: 2027, recorded: 508800n, derived: 580200n }]);
      expect(accepted.version.years.find((y) => y.year === 2027)?.amount).toBe(580200n);
    }
  });
});

describe('the comparison of a year with the CURRENT version (§60)', () => {
  const state = (input: ScheduleInput) => live(input, registry, 2028, today);

  it('no version: NOT_RECORDED on every year with an active component, null before the first one', () => {
    expect([2025, 2026, 2027].map((y) => compareYear(null, state(base), y, identity).state)).toEqual([null, 'NOT_RECORDED', 'NOT_RECORDED']);
  });

  it('after the repair: 2026 UNCHANGED, 2027 CHANGED_SINCE_RECORDED (5,088.00 → 5,802.00, the repair ADDED, A and B), 2028 NOT_RECORDED', () => {
    const current = v1();
    const [y2026, y2027, y2028] = [2026, 2027, 2028].map((y) => compareYear(current, state(withRepair), y, identity));
    expect(y2026?.state).toBe('UNCHANGED');
    expect(y2028?.state).toBe('NOT_RECORDED');
    expect(y2027).toMatchObject({
      state: 'CHANGED_SINCE_RECORDED',
      recorded: 508800n,
      derived: 580200n,
      amountChanged: true,
      causes: ['INPUTS'],
      owners: [
        { partKey: `OWNER:${A}`, recorded: 305280n, derived: 348120n },
        { partKey: `OWNER:${B}`, recorded: 203520n, derived: 232080n },
      ],
      components: [{ componentId: expect.stringMatching(/^TRANSACTION_SPLIT:/), change: 'ADDED', recorded: null, derived: 71400n }],
    });
  });

  it('an allocation superseded with the same amounts: CHANGED_SINCE_RECORDED with amountChanged false, the purchase INPUTS_CHANGED', () => {
    const a = acquisition();
    const superseded = {
      ...base,
      acquisitions: [acquisition({ allocation: { ...(a.allocation as NonNullable<typeof a.allocation>), id: '0000bbbb-0000-4000-8000-000000000031' } })],
    };
    expect(compareYear(v1(), state(superseded), 2026, identity)).toMatchObject({
      state: 'CHANGED_SINCE_RECORDED',
      amountChanged: false,
      components: [{ change: 'INPUTS_CHANGED' }],
    });
  });

  it('a changed rule hash: RULE_VERSION among the causes; a raised calculation version: CALCULATION', () => {
    const changed = new RuleRegistry(
      DEPRECIATION_RULE_VERSIONS.map((v) => (v.ruleCode === 'DE_AFA_BUILDING_LINEAR' && v.version === 2 ? { ...v, source: `${v.source}.` } : v)),
    );
    expect(compareYear(v1(), live(base, changed, 2028, today), 2027, identity).causes).toContain('RULE_VERSION');
    // A version recorded under an earlier calculation version (its fingerprints include it).
    const old = v1();
    const inputs = { ...old.inputs, calculationVersion: 0 };
    const earlier = {
      ...old,
      calculationVersion: 0,
      inputs,
      years: old.years.map((y) => ({ ...y, inputFingerprint: inputFingerprint(inputs, y.year, identity) })),
    };
    expect(compareYear(earlier, state(base), 2027, identity)).toMatchObject({ state: 'CHANGED_SINCE_RECORDED', amountChanged: false, causes: ['CALCULATION'] });
  });

  it('the same inputs, another output (a calculation defect): CHANGED_SINCE_RECORDED with CALCULATION, not by the input fingerprint alone', () => {
    const old = v1();
    const tampered = { ...old, years: old.years.map((y) => (y.year === 2027 ? { ...y, outputFingerprint: 'f'.repeat(64) } : y)) };
    expect(compareYear(tampered, state(base), 2027, identity)).toMatchObject({
      state: 'CHANGED_SINCE_RECORDED',
      amountChanged: false,
      causes: ['CALCULATION'],
    });
    expect(compareYear(tampered, state(base), 2026, identity).state).toBe('UNCHANGED');
  });

  it('at the owner level: CHANGED only with the owner’s own parts; an owner untouched by the change stays UNCHANGED', () => {
    const current = v1();
    expect(compareYear(current, state(withRepair), 2027, identity, A)).toMatchObject({ state: 'CHANGED_SINCE_RECORDED', recorded: 305280n, derived: 348120n });
    expect(compareYear(current, state(base), 2027, identity, A).state).toBe('UNCHANGED');
  });
});

import { describe, expect, it } from 'vitest';
import { computeVersionEntries, deriveSchedule, reproduce, type ScheduleVersion } from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { RuleRegistry, type BusinessDate } from '../../shared/index.js';
import { sha256Fingerprinter } from '../hashing/index.js';
import { createDatabase } from './database.js';
import { checkStoredRuleReferences } from './tax-rule-check.js';
import { OTHER_REALM, REALM, TODAY, databaseUrl, useScheduleVersionDatabase } from './depreciation-schedule-version.test-support.js';

/**
 * VC-8-04 persistence (api-design.md §60, migration 0052): the record path (switch on, as test-only construction) —
 * a version recorded, read back row by row and recomputed to its own entries, equal to the schedule read; the no-op,
 * the supersede and its AuditRecords, the replay, the Realm filter; the start check over the recorded references and
 * their hashes. The schema's guards past the repository are `depreciation-schedule-version-schema.test.ts`'s.
 */
describe.skipIf(databaseUrl === undefined)('recorded schedule versions (§60, migration 0052)', () => {
  const { ctx, acc8, allocate, record, counts } = useScheduleVersionDatabase('schedule_version_repository_test');
  const recorded = (outcome: Awaited<ReturnType<typeof record>>): ScheduleVersion => {
    if (outcome.kind !== 'RECORDED' && outcome.kind !== 'UNCHANGED') throw new Error(`${outcome.kind} ${JSON.stringify(outcome)}`);
    return outcome.version;
  };

  it('records ACC8 through 2027: read back row by row it recomputes to its own entries and equals the schedule read (2,544.00, 5,088.00)', async () => {
    const { assetId } = await acc8();
    const version = recorded(await record(assetId, { throughYear: 2027 }));
    expect([version.versionNumber, version.status, version.fromYear, version.throughYear, version.version]).toEqual([1, 'CURRENT', 2026, 2027, 1]);
    expect(version.years.map((y) => [y.year, y.amount])).toEqual([
      [2026, 254400n],
      [2027, 508800n],
    ]);
    expect(version.inputs.rules).toEqual([
      { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2, ruleVersionHash: expect.stringMatching(/^[0-9a-f]{64}$/), firstYear: 2026, lastYear: 2027 },
    ]);
    expect(reproduce(version, TAX_RULES, sha256Fingerprinter)).toEqual({ reproducible: true, causes: [], years: [] });
    expect(computeVersionEntries(version.inputs, TAX_RULES, 2026, 2027)).toEqual(version.entries);
    const read = await ctx.source.read(assetId, REALM, null);
    if (read === undefined) throw new Error('no read');
    const schedule = deriveSchedule({ ...read, today: TODAY, from: 2026, to: 2027, ownerPartyId: null }, TAX_RULES);
    for (const y of schedule.years) {
      const owners = version.entries.filter((e) => e.year === y.year).map((e) => [e.partKey.slice(6), e.amount]);
      expect(owners).toEqual((y.owners ?? []).map((o) => [o.ownerPartyId, BigInt((o.amount?.amount ?? '0').replace('.', ''))]));
    }
    expect(read.currentVersion?.versionId).toBe(version.versionId);
    const audit = await ctx.pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1`, [version.versionId]);
    expect(audit.rows).toEqual([
      {
        action: 'RECORDED',
        metadata: expect.objectContaining({
          assetId,
          versionNumber: 1,
          fromYear: 2026,
          throughYear: 2027,
          supersedesVersionId: null,
          acceptedChangedYears: [],
        }),
      },
    ]);
  });

  it('the no-op writes nothing; an allocation superseded with the same amounts must be named, then supersedes version 1 in one transaction', async () => {
    const { assetId, w, allocation } = await acc8();
    const v1 = recorded(await record(assetId, { throughYear: 2027 }));
    const before = await counts();
    const again = await record(assetId, { throughYear: 2027, reason: 'noch einmal' });
    expect([again.kind, recorded(again).versionId]).toEqual(['UNCHANGED', v1.versionId]);
    expect(await counts()).toEqual(before);
    await allocate(REALM, w, allocation);
    const afterAllocation = await counts();
    expect(await record(assetId, { throughYear: 2027 })).toMatchObject({ kind: 'REFUSED', refusal: { kind: 'RECORDED_YEARS_WOULD_CHANGE' } });
    expect(await counts()).toEqual(afterAllocation);
    const childXmin = async () =>
      (await ctx.pool.query(`SELECT xmin::text AS x FROM depreciation_schedule_entry WHERE version_id = $1 ORDER BY year, part_key`, [v1.versionId])).rows;
    const xminBefore = await childXmin();
    const v2 = recorded(await record(assetId, { throughYear: 2027, acceptChangedYears: [2026, 2027] }));
    expect([v2.versionNumber, v2.status, v2.supersedesVersionId]).toEqual([2, 'CURRENT', v1.versionId]);
    const list = await ctx.versions.list(assetId, REALM, null);
    expect(list?.map((v) => [v.versionNumber, v.status, v.supersededByVersionId])).toEqual([
      [2, 'CURRENT', null],
      [1, 'SUPERSEDED', v2.versionId],
    ]);
    expect((await ctx.versions.list(assetId, REALM, ['SUPERSEDED']))?.map((v) => v.versionNumber)).toEqual([1]);
    // Version 1's figures stay byte for byte: its child rows untouched (their xmin), its header changed by the supersede step only.
    expect(await childXmin()).toEqual(xminBefore);
    const found = await ctx.versions.find(assetId, REALM, v1.versionId);
    expect(found?.version.entries).toEqual(v1.entries);
    expect(
      (await ctx.pool.query(`SELECT action, previous_version, new_version FROM audit_record WHERE entity_id = $1 ORDER BY action`, [v1.versionId])).rows,
    ).toEqual([
      { action: 'RECORDED', previous_version: null, new_version: 1 },
      { action: 'SUPERSEDED', previous_version: 1, new_version: 2 },
    ]);
  });

  it('Idempotency-Key: the replay answers the recorded result; another payload under the same key is IDEMPOTENCY_CONFLICT; a refusal claims no key', async () => {
    const { assetId } = await acc8();
    const stale = '0'.repeat(64);
    expect(await record(assetId, { throughYear: 2027, expectedInputFingerprint: stale }, { key: 'k-1' })).toMatchObject({
      kind: 'REFUSED',
      refusal: { kind: 'SCHEDULE_CHANGED' },
    });
    expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM idempotency_key WHERE key = 'k-1'`)).rows[0].n).toBe(0);
    const first = recorded(await record(assetId, { throughYear: 2027 }, { key: 'k-1' }));
    const replay = await record(assetId, { throughYear: 2027 }, { key: 'k-1' });
    expect(replay).toMatchObject({ kind: 'RECORDED', replayed: true, version: { versionId: first.versionId } });
    expect(await record(assetId, { throughYear: 2026 }, { key: 'k-1' })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
  });

  it('Realm isolation: another Realm’s asset is NOT_FOUND to record, list and read; a version of another asset under this path is not found', async () => {
    const mine = await acc8();
    const theirs = await acc8(OTHER_REALM);
    const v = recorded(await record(theirs.assetId, { throughYear: 2026 }, { realm: OTHER_REALM }));
    expect(await record(theirs.assetId, { throughYear: 2026, expectedInputFingerprint: '0'.repeat(64) })).toEqual({ kind: 'NOT_FOUND' });
    expect(await ctx.versions.list(theirs.assetId, REALM, null)).toBeUndefined();
    expect(await ctx.versions.find(theirs.assetId, REALM, v.versionId)).toBeUndefined();
    expect(await ctx.versions.find(mine.assetId, REALM, v.versionId)).toBeUndefined();
    expect(await ctx.versions.find(theirs.assetId, OTHER_REALM, v.versionId)).toBeDefined();
  });

  it('an unconfirmed asset: SCHEDULE_NOT_COMPLETE and no row; a VOID asset: ASSET_NOT_ACTIVE, its versions still listed', async () => {
    const unconfirmed = await acc8(REALM, 'UNREVIEWED');
    const before = await counts();
    expect(await record(unconfirmed.assetId, { throughYear: 2027 })).toMatchObject({ kind: 'REFUSED', refusal: { kind: 'SCHEDULE_NOT_COMPLETE' } });
    expect(await counts()).toEqual(before);
    const { assetId } = await acc8();
    recorded(await record(assetId, { throughYear: 2026 }));
    expect((await ctx.assets.void(assetId, REALM, 'falsche PropertyReference', new Date(), { actorType: 'USER', actorId: 'x' })).kind).toBe('VOIDED');
    expect(await record(assetId, { throughYear: 2027, expectedInputFingerprint: '0'.repeat(64) })).toMatchObject({
      kind: 'REFUSED',
      refusal: { kind: 'ASSET_NOT_ACTIVE' },
    });
    expect((await ctx.versions.list(assetId, REALM, null))?.length).toBe(1);
  });

  describe('the start check over the recorded references (§58, §60)', () => {
    it('the real source returns the recorded references; a hash unequal to the registry’s stops the start naming both; effectiveTo set since starts', async () => {
      const { assetId } = await acc8();
      recorded(await record(assetId, { throughYear: 2026 }));
      const db = createDatabase(ctx.pool);
      expect(await checkStoredRuleReferences(db)).toContainEqual({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 });
      const versions = TAX_RULES.versions('DE_AFA_BUILDING_LINEAR');
      const edited = new RuleRegistry([
        ...TAX_RULES.versions('DE_CATEGORY_DEFAULTS'),
        ...TAX_RULES.versions('DE_AFA_MOVABLE_LINEAR'),
        ...versions.map((v) => (v.version === 2 ? { ...v, title: `${v.title} (in place geändert)` } : v)),
      ]);
      await expect(checkStoredRuleReferences(db, edited)).rejects.toThrow(
        /Recorded rule versions changed in place: DE_AFA_BUILDING_LINEAR@2 \(recorded [0-9a-f]{64}, registry [0-9a-f]{64}\)/,
      );
      const closed = new RuleRegistry([
        ...TAX_RULES.versions('DE_CATEGORY_DEFAULTS'),
        ...TAX_RULES.versions('DE_AFA_MOVABLE_LINEAR'),
        ...versions.map((v) => (v.version === 2 ? { ...v, effectiveTo: '2090-01-01' as BusinessDate } : v)),
      ]);
      expect(await checkStoredRuleReferences(db, closed)).toContainEqual({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 });
      // Counter-check: the start check ignoring the hash would let the edited registry start.
      expect(await checkStoredRuleReferences(db, edited, { storedRuleReferences: () => Promise.resolve([]) })).not.toContainEqual({
        ruleCode: 'DE_AFA_BUILDING_LINEAR',
        version: 2,
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { planRecord, type RecordOutcome, type RecordRequest } from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { Money } from '../../shared/index.js';
import { sha256Fingerprinter } from '../hashing/index.js';
import { createDatabase } from './database.js';
import { PostgresScheduleVersionRepository } from './depreciation-schedule-version-repository.js';
import { NOW, REALM, TODAY, actor, databaseUrl, useScheduleVersionDatabase } from './depreciation-schedule-version.test-support.js';
import { waitForLocks } from './rent-reconciliation.test-support.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';

/**
 * The record's concurrency (api-design.md §60 "Concurrency and consistency", P8-D14), with a test seam that holds the
 * record's transaction between two statements of its derivation (after the asset's read):
 * - one snapshot: an input committed while the record derives is not in the version (REPEATABLE READ);
 * - two records of one asset: the second waits on the PropertyReference row, fails to serialise, and on retry sees the
 *   first's CURRENT version (a no-op, or a correct supersede); never two CURRENT versions, never a raw 23505;
 * - the asset `FOR UPDATE`: a holder of the asset row stops the record before its derivation;
 * - a record against an amend of the completion year, both orders.
 * The pool names itself (`application_name`), so `waitForLocks` counts only this file's sessions.
 */
describe.skipIf(databaseUrl === undefined)('recorded schedule versions under concurrency (§60)', () => {
  const { ctx, acc8, fingerprintOf } = useScheduleVersionDatabase('schedule_version_concurrency_test');

  /** A gate the seam waits on; `entered` resolves once the record reached it. */
  function gate() {
    let open!: () => void;
    let entered!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    let calls = 0;
    const seam = async () => {
      calls += 1;
      entered();
      await opened;
    };
    return { seam, open, reached, calls: () => calls };
  }
  const repositoryWith = (seam?: () => Promise<void>) =>
    new PostgresScheduleVersionRepository(
      createDatabase(ctx.pool),
      new PostgresTaxClassificationRepository(createDatabase(ctx.pool)).capitalizedSources,
      () => NOW,
      seam,
    );
  const recordWith = async (repository: PostgresScheduleVersionRepository, assetId: string, request: RecordRequest): Promise<RecordOutcome> =>
    repository.record({
      assetId,
      mreRealmId: REALM,
      actor,
      decide: (read) => planRecord(read, request, { registry: TAX_RULES, fingerprinter: sha256Fingerprinter, today: TODAY, recordedBy: actor.actorId }),
    });
  const request = async (assetId: string, throughYear: number, extra: Partial<RecordRequest> = {}): Promise<RecordRequest> => ({
    throughYear,
    reason: 'AfA laut Einkommensteuererklärung (synthetisch)',
    expectedInputFingerprint: await fingerprintOf(assetId, throughYear),
    acceptChangedYears: [],
    ...extra,
  });
  const currentCount = async (assetId: string) =>
    Number((await ctx.pool.query(`SELECT count(*) AS n FROM depreciation_schedule_version WHERE asset_id = $1 AND status = 'CURRENT'`, [assetId])).rows[0].n);
  /** What the session waiting on a lock is running (this file's sessions only). */
  const waitingQuery = async () =>
    (
      await ctx.pool.query(
        `SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND application_name = current_setting('application_name') AND datname = current_database()`,
      )
    ).rows.map((r: { query: string }) => r.query);

  it('one snapshot: an allocation committed between two statements of the derivation is not in the version, which equals a read of the state before', async () => {
    const { assetId, w, allocation } = await acc8();
    const before = await request(assetId, 2027);
    const g = gate();
    const recording = recordWith(repositoryWith(g.seam), assetId, before);
    await g.reached;
    // Another writer commits a superseding allocation (another building amount) while the record holds its snapshot.
    const superseding = await ctx.allocations.create(
      {
        mreRealmId: REALM,
        acquisitionId: w,
        totalAllocableAmount: Money.of('318000.00', 'EUR'),
        landAmount: Money.of('68000.00', 'EUR'),
        buildingAmount: Money.of('250000.00', 'EUR'),
        method: 'PURCHASE_CONTRACT',
        reviewState: 'CONFIRMED',
        effectiveDate: null,
        advisorPartyId: null,
        sourceReferences: [],
        notes: null,
        supersedes: allocation,
      },
      actor,
    );
    expect(superseding.kind).toBe('CREATED');
    g.open();
    const outcome = await recording;
    expect(outcome.kind).toBe('RECORDED');
    if (outcome.kind !== 'RECORDED') return;
    // The version is the state before: the old allocation and its figures (2,544.00 and 5,088.00), its precondition met.
    expect(outcome.version.inputs.components[0]?.acquisition?.allocationId).toBe(allocation);
    expect(outcome.version.years.map((y) => y.amount)).toEqual([254400n, 508800n]);
    expect(outcome.version.inputFingerprint).toBe(before.expectedInputFingerprint);
    // The next read sees the new allocation, so the recorded years compare as changed.
    expect(await fingerprintOf(assetId, 2027)).not.toBe(before.expectedInputFingerprint);
  });

  it.each([
    ['the same run: the second is the no-op', 2027, 'UNCHANGED', 1],
    ['a later run: the second supersedes the first', 2026, 'RECORDED', 2],
  ] as const)(
    'two records of one asset, %s; the second waits on the PropertyReference row, never two CURRENT versions',
    async (_name, firstThrough, secondKind, versions) => {
      const { assetId } = await acc8();
      const g = gate();
      const first = recordWith(repositoryWith(g.seam), assetId, await request(assetId, firstThrough));
      await g.reached;
      const secondRequest = await request(assetId, 2027);
      const plain = repositoryWith();
      const second = recordWith(plain, assetId, secondRequest);
      await waitForLocks(ctx.pool);
      // The waiting point: the second waits on its no-op write of the PropertyReference, not on the asset.
      expect((await waitingQuery()).map((q) => /UPDATE property_reference/.test(q))).toEqual([true]);
      g.open();
      expect((await first).kind).toBe('RECORDED');
      // REPEATABLE READ: the row changed after its snapshot, so the second fails to serialise; the use case retries.
      expect(await second).toEqual({ kind: 'SERIALIZATION_FAILURE' });
      const retried = await recordWith(plain, assetId, secondRequest);
      expect(retried.kind).toBe(secondKind);
      expect(await currentCount(assetId)).toBe(1);
      expect(Number((await ctx.pool.query(`SELECT count(*) AS n FROM depreciation_schedule_version WHERE asset_id = $1`, [assetId])).rows[0].n)).toBe(versions);
    },
  );

  it('the asset FOR UPDATE: while another transaction holds the asset row the record waits before its derivation, then records', async () => {
    const { assetId } = await acc8();
    const holder = await ctx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM depreciation_asset WHERE id = $1 FOR UPDATE`, [assetId]);
      const g = gate();
      const recording = recordWith(repositoryWith(g.seam), assetId, await request(assetId, 2027));
      await waitForLocks(ctx.pool);
      expect(await waitingQuery()).toEqual([expect.stringMatching(/FROM depreciation_asset .*FOR UPDATE/s)]);
      // Not yet derived: the seam after the asset's read was never reached.
      expect(g.calls()).toBe(0);
      g.open();
      await holder.query('ROLLBACK');
      expect((await recording).kind).toBe('RECORDED');
      expect(g.calls()).toBe(1);
    } finally {
      holder.release();
    }
  });

  it('a record against an amend of the completion year, both orders: the amend waits for the record; or the record fails to serialise and answers 412', async () => {
    // The record first: the amend waits on the PropertyReference row, the version has the old year.
    const first = await acc8();
    const g = gate();
    const recording = recordWith(repositoryWith(g.seam), first.assetId, await request(first.assetId, 2027));
    await g.reached;
    const amending = ctx.assets.amend(first.assetId, REALM, { buildingCompletionYear: 1920 }, actor);
    await waitForLocks(ctx.pool);
    g.open();
    const recorded = await recording;
    expect(recorded.kind).toBe('RECORDED');
    if (recorded.kind === 'RECORDED') expect(recorded.version.inputs.asset.buildingCompletionYear).toBe(1995);
    expect((await amending).kind).toBe('AMENDED');

    // The amend first (held open): the record waits, fails to serialise, and on retry its fingerprint is stale (412).
    const second = await acc8();
    const stale = await request(second.assetId, 2027);
    const holder = await ctx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE depreciation_asset SET building_completion_year = 1920, version = version + 1 WHERE id = $1`, [second.assetId]);
      const blocked = recordWith(repositoryWith(), second.assetId, stale);
      await waitForLocks(ctx.pool);
      await holder.query('COMMIT');
      expect(await blocked).toEqual({ kind: 'SERIALIZATION_FAILURE' });
    } finally {
      holder.release();
    }
    expect(await recordWith(repositoryWith(), second.assetId, stale)).toMatchObject({ kind: 'REFUSED', refusal: { kind: 'SCHEDULE_CHANGED' } });
    expect(await currentCount(second.assetId)).toBe(0);
  });
});

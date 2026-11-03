import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import { depreciationCommands } from './depreciation-commands.test-support.js';
import type { RecordingStage } from './domains/depreciation/index.js';
import { createDatabase } from './infrastructure/postgres/index.js';
import {
  NOW,
  OTHER_REALM,
  REALM,
  VERSION_TABLES,
  databaseUrl,
  useScheduleVersionDatabase,
} from './infrastructure/postgres/depreciation-schedule-version.test-support.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import type { BusinessDate } from './shared/index.js';
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-X-45 end to end (api-design.md §60A), wired as in main.ts with both switches stated by the test (test-only
 * construction, no environment variable): ACC8 (stage 1, its anschaffungsnahe check read from the database) records at
 * released stage 1; ACC8 with a shorter-life entry (stage 3) is refused for the whole run at 1 and 2 with every year
 * named, nothing written, the key reusable, and records at 3; a missing fact refuses first at every stage; a recorded
 * version is untouched by a refusal; the read reports `recordingStage` (also while recording is off, A6) and flags the
 * years above it; the figures are the same at every stage; Realm isolation. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('release stages for recording (VC-X-45) end to end', () => {
  const { ctx, acc8, counts } = useScheduleVersionDatabase('recording_stage_e2e_test');
  let mre: FakeMre;
  const servers: Server[] = [];
  const bases = new Map<string, string>();
  const base = (on: boolean, stage: RecordingStage) => bases.get(`${on}:${stage}`) as string;

  beforeAll(async () => {
    const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
    mre = await startFakeMre([
      { _id: REALM, name: 'A', members: member, applications: [], tenants: [] },
      { _id: OTHER_REALM, name: 'B', members: member, applications: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    for (const [recordingEnabled, releasedStage] of [
      [false, 3],
      [true, 1],
      [true, 2],
      [true, 3],
    ] as const) {
      const app = createApp({
        isReady: async () => true,
        verifyPrincipal: mrePrincipalVerifier(client),
        ...commandsWith({ depreciationAssets: depreciationCommands(createDatabase(ctx.pool), { recordingEnabled, releasedStage, now: () => NOW }) }),
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      servers.push(server);
      bases.set(`${recordingEnabled}:${releasedStage}`, `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`);
    }
  });
  afterAll(async () => {
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre?.close();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 300);
  const call = async (url: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}, realm = REALM) => {
    const headers = { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json', ...extra };
    const res = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const schedule = (url: string, assetId: string, realm = REALM) =>
    call(url, 'GET', `/depreciation-assets/${assetId}/schedule?from=2026&to=2027`, undefined, {}, realm);
  const bodyOf = async (assetId: string, throughYear = 2027) => ({
    throughYear,
    reason: `AfA laut Einkommensteuererklärung ${throughYear} (synthetisch)`,
    expectedInputFingerprint: (await schedule(base(true, 3), assetId)).body['years'].find((y: { year: number }) => y.year === throughYear).inputFingerprint,
  });
  const post = (url: string, assetId: string, body: unknown, key?: string, realm = REALM) =>
    call(url, 'POST', `/depreciation-assets/${assetId}/schedule-versions`, body, key === undefined ? {} : { 'idempotency-key': key }, realm);
  const life = (reviewState: 'CONFIRMED' | 'UNREVIEWED') => (acquisitionId: string) => [
    {
      acquisitionId,
      usefulLifeYears: 30,
      evidence: {
        source: 'Gutachten zur Restnutzungsdauer (synthetisch)',
        date: '2026-06-15' as BusinessDate,
        valuationDate: '2026-06-15' as BusinessDate,
        documentReference: null,
      },
      reviewState,
      advisorPartyId: null,
      releaseNote: null,
      declaredAfa: [],
    },
  ];
  const stageThree = (componentId: string) => ({ componentId, kind: 'ACQUISITION', stage: 3, criteria: ['PURCHASE', 'SHORTER_USEFUL_LIFE_ENTRY'] });

  it('ACC8 is stage 1 (its check read from the database, A1): it records at released 1; the read shows stage 1 and no stage flag', async () => {
    const s = await acc8();
    // The snapshot's A1 facts, from Taxation's check (`effectsOf`) in the same transaction.
    expect((await ctx.source.read(s.assetId, REALM, null))?.purchaseChecks).toEqual([
      { acquisitionId: s.w, status: 'NOT_ABOVE_THRESHOLD', wegHausgeldMaintenanceNotCounted: false, summedSources: [] },
    ]);
    const read = await schedule(base(true, 1), s.assetId);
    expect(read.body['recordingStage']).toEqual({ released: 1, rules: 'DE_RECORDING_STAGES@1' });
    expect(read.body['years'].map((y: { stage: { stage: number } }) => y.stage.stage)).toEqual([1, 1]);
    expect(read.body['review'].open.map((o: { code: string }) => o.code)).not.toContain('DEPRECIATION_STAGE_NOT_RELEASED');
    expect((await post(base(true, 1), s.assetId, await bodyOf(s.assetId))).status).toBe(201);
  });

  it('a shorter-life purchase (stage 3): the whole run refused at 1 and 2, every year named, nothing written; the key is reusable at 3', async () => {
    const s = await acc8(REALM, 'CONFIRMED', { shorterUsefulLives: life('CONFIRMED') });
    const body = await bodyOf(s.assetId);
    const before = await counts();
    for (const stage of [1, 2] as const) {
      const res = await post(base(true, stage), s.assetId, body, 'stage-key');
      expect([res.status, res.body['error']]).toEqual([
        409,
        {
          code: 'CONFLICT',
          message: 'The schedule contains years of a release stage that is not released in this installation.',
          details: {
            reason: 'STAGE_NOT_RELEASED',
            assetId: s.assetId,
            releasedStage: stage,
            years: [2026, 2027].map((year) => ({ year, stage: 3, components: [stageThree(`ACQUISITION:${s.w}`)] })),
          },
        },
      ]);
    }
    // Nothing written: no version row, no AuditRecord, no Idempotency-Key.
    expect(await counts()).toEqual(before);
    const recorded = await post(base(true, 3), s.assetId, body, 'stage-key');
    expect(recorded.status).toBe(201);
    const after = await counts();
    expect([after['depreciation_schedule_version'], after['idempotency_key']]).toEqual([
      (before['depreciation_schedule_version'] as number) + 1,
      (before['idempotency_key'] as number) + 1,
    ]);
    // The RECORDED AuditRecord carries the stages (§60A "Recorded versions"); the version does not.
    const audit = await ctx.pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'RECORDED'`, [recorded.body['versionId']]);
    expect(audit.rows[0].metadata).toMatchObject({
      releasedStage: 3,
      stageRules: 'DE_RECORDING_STAGES@1',
      stageYears: [
        { year: 2026, stage: 3 },
        { year: 2027, stage: 3 },
      ],
    });
  });

  it('a missing fact refuses first at every stage (SCHEDULE_NOT_COMPLETE), not the stage', async () => {
    const s = await acc8(REALM, 'CONFIRMED', { shorterUsefulLives: life('UNREVIEWED') });
    const body = { throughYear: 2027, reason: 'AfA (synthetisch)', expectedInputFingerprint: '0'.repeat(64) };
    for (const stage of [1, 2, 3] as const) {
      const res = await post(base(true, stage), s.assetId, body);
      expect([res.status, res.body['error'].details.reason]).toEqual([409, 'SCHEDULE_NOT_COMPLETE']);
    }
    // The read still marks both years, unconfirmed or not („auch unbestätigt“).
    const read = await schedule(base(true, 1), s.assetId);
    expect(read.body['years'].map((y: { stage: { stage: number } }) => y.stage.stage)).toEqual([3, 3]);
  });

  it('history: a refusal leaves the recorded version as it was (CURRENT, every row unchanged)', async () => {
    const s = await acc8(REALM, 'CONFIRMED', { shorterUsefulLives: life('CONFIRMED') });
    const v1 = await post(base(true, 3), s.assetId, await bodyOf(s.assetId, 2026));
    expect(v1.status).toBe(201);
    const rows = async () =>
      (await ctx.pool.query(`SELECT to_jsonb(v)::text AS row FROM depreciation_schedule_version v WHERE asset_id = $1 ORDER BY 1`, [s.assetId])).rows;
    const before = [await rows(), await counts()];
    const refused = await post(base(true, 1), s.assetId, await bodyOf(s.assetId, 2027));
    expect([refused.status, refused.body['error'].details.reason]).toEqual([409, 'STAGE_NOT_RELEASED']);
    expect([await rows(), await counts()]).toEqual(before);
    const list = await call(base(true, 1), 'GET', `/depreciation-assets/${s.assetId}/schedule-versions`);
    expect(list.body['items'].map((v: { status: string; throughYear: number }) => [v.status, v.throughYear])).toEqual([['CURRENT', 2026]]);
  });

  it('the read: recordingStage while recording is off too (A6, POST refused by the switch); the flag on each year above; the same figures at every stage', async () => {
    const s = await acc8(REALM, 'CONFIRMED', { shorterUsefulLives: life('CONFIRMED') });
    const off = await schedule(base(false, 3), s.assetId);
    expect([off.body['recordingEnabled'], off.body['recordingStage']]).toEqual([false, { released: 3, rules: 'DE_RECORDING_STAGES@1' }]);
    expect((await post(base(false, 3), s.assetId, await bodyOf(s.assetId))).body['error'].details.reason).toBe('RECORDING_NOT_ENABLED');
    const reads = await Promise.all(([1, 2, 3] as const).map((stage) => schedule(base(true, stage), s.assetId)));
    const flagged = reads.map((r) =>
      r.body['years'].map((y: { flags: { code: string }[] }) => y.flags.some((f) => f.code === 'DEPRECIATION_STAGE_NOT_RELEASED')),
    );
    expect(flagged).toEqual([
      [true, true],
      [true, true],
      [false, false],
    ]);
    const flag = reads[0]?.body['years'][0].flags.find((f: { code: string }) => f.code === 'DEPRECIATION_STAGE_NOT_RELEASED');
    expect(flag.details).toEqual({ stage: 3, releasedStage: 1, components: [stageThree(`ACQUISITION:${s.w}`)] });
    // Money unchanged: every figure of the read is the same at each stage (and while off).
    const figures = (
      r: { body: Record<string, any> }, // eslint-disable-line @typescript-eslint/no-explicit-any
    ) => [r.body['components'], r.body['years'].map((y: Record<string, unknown>) => [y['amount'], y['residualValue'], y['owners'], y['status'], y['reasons']])];
    for (const r of [off, ...reads]) expect(figures(r)).toEqual(figures(reads[2] as { body: Record<string, unknown> }));
  });

  it('Realm isolation: another Realm’s id is 404 at every stage, and another Realm’s stage-3 asset does not raise this one', async () => {
    const theirs = await acc8(OTHER_REALM, 'CONFIRMED', { shorterUsefulLives: life('CONFIRMED') });
    const mine = await acc8();
    for (const stage of [1, 3] as const) {
      const res = await post(base(true, stage), theirs.assetId, { throughYear: 2027, reason: 'x', expectedInputFingerprint: '0'.repeat(64) });
      expect(res.status).toBe(404);
      expect((await schedule(base(true, stage), theirs.assetId)).status).toBe(404);
    }
    expect((await schedule(base(true, 1), mine.assetId)).body['years'].map((y: { stage: { stage: number } }) => y.stage.stage)).toEqual([1, 1]);
    expect((await post(base(true, 1), mine.assetId, await bodyOf(mine.assetId))).status).toBe(201);
    // Their asset as their Realm sees it: stage 3, untouched by our records.
    expect((await schedule(base(true, 1), theirs.assetId, OTHER_REALM)).body['years'].map((y: { stage: { stage: number } }) => y.stage.stage)).toEqual([3, 3]);
    expect(VERSION_TABLES.length).toBe(8);
  });
});

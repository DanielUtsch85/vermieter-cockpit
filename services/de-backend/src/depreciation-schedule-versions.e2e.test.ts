import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import { depreciationCommands } from './depreciation-commands.test-support.js';
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
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-8-04 end to end (api-design.md §60 "The recording switch", "Tests while it is off, and with it on"), wired as in
 * main.ts with the switch stated by the test (no environment variable): while off, `POST …/schedule-versions` answers
 * `409 RECORDING_NOT_ENABLED` for an existing, an unknown, a foreign and a `VOID` asset, and nothing is written (0052's
 * tables, `audit_record`, `idempotency_key`, no cash); the reads answer as without versions; the schedule read reports
 * `recordingEnabled: false` with the same figures as with it on. With it on: ACC8's version 1 through 2027, the key
 * refused while off processed as new, a stale fingerprint `412`; a version recorded while on stays readable while off.
 */
const CASH_TABLES = [
  'ledger_transaction',
  'transaction_split',
  'tax_classification',
  'acquisition',
  'acquisition_cost',
  'land_building_allocation',
  'ownership',
];
const STATE_TABLES = ['property_reference', 'depreciation_asset', 'depreciation_asset_useful_life', 'depreciation_asset_item'];

describe.skipIf(databaseUrl === undefined)('recorded schedule versions (VC-8-04) end to end', () => {
  const { ctx, acc8, counts } = useScheduleVersionDatabase('schedule_versions_e2e_test');
  let mre: FakeMre;
  const servers: Server[] = [];
  const bases: { off: string; on: string } = { off: '', on: '' };

  beforeAll(async () => {
    const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
    mre = await startFakeMre([
      { _id: REALM, name: 'A', members: member, applications: [], tenants: [] },
      { _id: OTHER_REALM, name: 'B', members: member, applications: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    for (const recordingEnabled of [false, true]) {
      const app = createApp({
        isReady: async () => true,
        verifyPrincipal: mrePrincipalVerifier(client),
        ...commandsWith({ depreciationAssets: depreciationCommands(createDatabase(ctx.pool), { recordingEnabled, now: () => NOW }) }),
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      servers.push(server);
      bases[recordingEnabled ? 'on' : 'off'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    }
  });
  afterAll(async () => {
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 300);
  const headers = (realm = REALM, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    organizationid: realm,
    'content-type': 'application/json',
    ...extra,
  });
  const call = async (base: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}, realm = REALM) => {
    const res = await fetch(`${base}${path}`, { method, headers: headers(realm, extra), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const schedule = (base: string, assetId: string) => call(base, 'GET', `/depreciation-assets/${assetId}/schedule?from=2026&to=2028`);
  const recordBody = async (assetId: string, throughYear = 2027) => ({
    throughYear,
    reason: 'AfA laut Einkommensteuererklärung 2027 (synthetisch)',
    expectedInputFingerprint: (await schedule(bases.on, assetId)).body['years'].find((y: { year: number }) => y.year === throughYear).inputFingerprint,
  });
  const rowsOf = async () => {
    const snapshot: Record<string, unknown> = await counts();
    for (const table of [...CASH_TABLES, ...STATE_TABLES]) {
      snapshot[table] = (await ctx.pool.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY 1`)).rows.map((r: { row: string }) => r.row);
    }
    return snapshot;
  };

  it('off: 409 RECORDING_NOT_ENABLED for an existing, an unknown, a foreign and a VOID asset; nothing written, no cash mutated; same key after on records', async () => {
    const mine = await acc8();
    const theirs = await acc8(OTHER_REALM);
    const voided = await acc8();
    expect((await ctx.assets.void(voided.assetId, REALM, 'falsch angelegt', NOW, { actorType: 'USER', actorId: 'x' })).kind).toBe('VOIDED');
    const body = await recordBody(mine.assetId);
    const before = await rowsOf();
    for (const assetId of [mine.assetId, '00000000-0000-4000-8000-0000000000ff', theirs.assetId, voided.assetId]) {
      const res = await call(bases.off, 'POST', `/depreciation-assets/${assetId}/schedule-versions`, body, { 'idempotency-key': 'key-while-off' });
      expect([res.status, res.body['error']]).toEqual([
        409,
        {
          code: 'CONFLICT',
          message: 'Recording depreciation schedule versions is not enabled in this installation.',
          details: { reason: 'RECORDING_NOT_ENABLED' },
        },
      ]);
    }
    expect(await rowsOf()).toEqual(before);
    // The reads answer as without versions.
    expect((await call(bases.off, 'GET', `/depreciation-assets/${mine.assetId}/schedule-versions`)).body).toEqual({ items: [] });
    expect((await call(bases.off, 'GET', `/depreciation-assets/${mine.assetId}/schedule-versions/00000000-0000-4000-8000-0000000000ee`)).status).toBe(404);
    // Counter-check: the same request with the switch on writes exactly one version, under the key refused while off.
    const on = await call(bases.on, 'POST', `/depreciation-assets/${mine.assetId}/schedule-versions`, body, { 'idempotency-key': 'key-while-off' });
    expect([on.status, on.headers.get('idempotent-replayed'), on.headers.get('etag')]).toEqual([201, null, '"1"']);
    expect(on.headers.get('location')).toBe(`/api/v1/depreciation-assets/${mine.assetId}/schedule-versions/${on.body['versionId']}`);
    const after = await counts();
    // One header, one rule, one component, two parts with one fraction each, two years, four entries; the flags that stood.
    expect(VERSION_TABLES.map((t) => (after[t] as number) - (before[t] as number))).toEqual([1, 1, 1, 2, 2, 2, 4, 2]);
    expect([
      (after['idempotency_key'] as number) - (before['idempotency_key'] as number),
      (after['audit_record'] as number) - (before['audit_record'] as number),
    ]).toEqual([1, 1]);
    expect([on.body['reproduction'], on.body['comparison']]).toEqual([null, null]);
    expect(on.body['years'].map((y: { year: number; amount: { amount: string } }) => [y.year, y.amount.amount])).toEqual([
      [2026, '2544.00'],
      [2027, '5088.00'],
    ]);
    // A key recorded while on is not replayed while off: the switch comes first.
    expect((await call(bases.off, 'POST', `/depreciation-assets/${mine.assetId}/schedule-versions`, body, { 'idempotency-key': 'key-while-off' })).status).toBe(
      409,
    );
  });

  it('the schedule read off and on: the same figures, flags and reasons; recordingEnabled reports the switch; NOT_RECORDED on each year with AfA', async () => {
    const { assetId } = await acc8();
    const off = await schedule(bases.off, assetId);
    const on = await schedule(bases.on, assetId);
    expect([off.body['recordingEnabled'], on.body['recordingEnabled'], off.body['recordedVersion']]).toEqual([false, true, null]);
    const { recordingEnabled: _off, ...offRest } = off.body;
    const { recordingEnabled: _on, ...onRest } = on.body;
    expect(offRest).toEqual(onRest);
    expect(
      off.body['years'].map((y: { year: number; recording: string; flags: { code: string }[] }) => [y.year, y.recording, y.flags.map((f) => f.code)]),
    ).toEqual([
      [2026, 'NOT_RECORDED', ['ACQUISITION_COST_UNPAID', 'DEPRECIATION_SCHEDULE_NOT_RECORDED']],
      [2027, 'NOT_RECORDED', ['ACQUISITION_COST_UNPAID', 'DEPRECIATION_SCHEDULE_NOT_RECORDED']],
      [2028, 'NOT_RECORDED', ['ACQUISITION_COST_UNPAID', 'DEPRECIATION_SCHEDULE_NOT_RECORDED']],
    ]);
    expect(off.body['years'][0].flags[1].details).toEqual({ assetId, assetType: 'BUILDING', currentVersionId: null, currentThroughYear: null });
  });

  it('with it on: a stale fingerprint is 412; the version read back while off: listed, readable, reproducible, 2026–2027 UNCHANGED, 2028 not recorded', async () => {
    const { assetId } = await acc8();
    const stale = { ...(await recordBody(assetId)), expectedInputFingerprint: 'f'.repeat(64) };
    const refused = await call(bases.on, 'POST', `/depreciation-assets/${assetId}/schedule-versions`, stale);
    expect([refused.status, refused.body['error'].code, refused.body['error'].details.expectedInputFingerprint]).toEqual([
      412,
      'SCHEDULE_CHANGED',
      'f'.repeat(64),
    ]);
    const created = await call(bases.on, 'POST', `/depreciation-assets/${assetId}/schedule-versions`, await recordBody(assetId));
    expect(created.status).toBe(201);
    const versionId = created.body['versionId'] as string;
    const list = await call(bases.off, 'GET', `/depreciation-assets/${assetId}/schedule-versions?status=CURRENT`);
    expect(list.body['items'].map((v: { versionId: string; versionNumber: number }) => [v.versionId, v.versionNumber])).toEqual([[versionId, 1]]);
    const one = await call(bases.off, 'GET', `/depreciation-assets/${assetId}/schedule-versions/${versionId}`);
    expect([one.status, one.headers.get('etag'), one.body['reproduction']]).toEqual([200, '"1"', { reproducible: true, causes: [], years: [] }]);
    expect(one.body['comparison']).toEqual({
      computedOn: '2028-01-20',
      years: [
        { year: 2026, state: 'UNCHANGED' },
        { year: 2027, state: 'UNCHANGED' },
      ],
      notRecordedYears: [2028],
    });
    const read = await schedule(bases.off, assetId);
    expect(read.body['recordedVersion']).toMatchObject({ versionId, versionNumber: 1, throughYear: 2027, reproducible: true });
    expect(read.body['years'].map((y: { recording: string }) => y.recording)).toEqual(['UNCHANGED', 'UNCHANGED', 'NOT_RECORDED']);
    // Another Realm sees neither the version nor the asset.
    expect((await call(bases.off, 'GET', `/depreciation-assets/${assetId}/schedule-versions/${versionId}`, undefined, {}, OTHER_REALM)).status).toBe(404);
    expect((await call(bases.off, 'GET', `/depreciation-assets/${assetId}/schedule-versions`, undefined, {}, OTHER_REALM)).status).toBe(404);
  });
});

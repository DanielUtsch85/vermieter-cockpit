import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConcurrentUpdateError,
  ScheduleVersionNotFoundError,
  ScheduleVersionRefusedError,
  getScheduleVersion,
  listScheduleVersions,
  recordScheduleVersion,
  type PrincipalVerifier,
} from '../application/index.js';
import type { ScheduleVersionRepository } from '../application/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/**
 * The API of recorded schedule versions (api-design.md §60): every `400` with its field code, also while the switch is
 * off (the body's contract does not change when it is turned on); a well-formed request answers `409
 * RECORDING_NOT_ENABLED` whatever the asset id; the reads answer while off; the error answers of §60's table.
 */
const REALM = '64b0c0ffee000000000008f2';
const ASSET = '6f1c2a9e-0000-4000-8000-000000000010';
const VERSION = '6f1c2a9e-0000-4000-8000-000000000101';
const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });
const fingerprinter = { sha256Hex: (text: string) => text.length.toString(16).padStart(64, '0') };
const now = () => new Date('2026-10-30T10:00:00Z');
let server: Server | undefined;

async function start(commands: CommandOverrides): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith(commands) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** The real use cases over a repository stub that counts its calls. */
function commands(recordingEnabled: boolean) {
  const calls: string[] = [];
  const repository: ScheduleVersionRepository = {
    record: async () => {
      calls.push('record');
      return { kind: 'NOT_FOUND' };
    },
    list: async () => {
      calls.push('list');
      return [];
    },
    find: async () => {
      calls.push('find');
      return undefined;
    },
    storedRuleVersionHashes: async () => [],
  };
  return {
    calls,
    overrides: {
      depreciationAssets: {
        recordVersion: recordScheduleVersion({ repository, recordingEnabled, fingerprinter, now }),
        listVersions: listScheduleVersions({ repository }),
        getVersion: getScheduleVersion({ repository, fingerprinter, now }),
      },
    } satisfies CommandOverrides,
  };
}

const headers = { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json' };
const body = { throughYear: 2026, reason: 'AfA 2026 (synthetisch)', expectedInputFingerprint: 'a'.repeat(64) };
const post = (base: string, assetId: string, payload: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/depreciation-assets/${assetId}/schedule-versions`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(payload) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; details?: Record<string, unknown> } }).error;

describe('POST …/schedule-versions: 400 first, then the switch (§60, decided 2026-10-31, third set)', () => {
  it.each([false, true])('every field error with its code, all at once, with the switch %s', async (enabled) => {
    const { calls, overrides } = commands(enabled);
    const base = await start(overrides);
    const res = await post(base, 'not-a-uuid', {
      throughYear: 1999.5,
      reason: '  ',
      expectedInputFingerprint: 'A'.repeat(64),
      acceptChangedYears: [2026, 2026],
      extra: 1,
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).details?.['fields']).toEqual(
      expect.arrayContaining([
        { field: 'assetId', code: 'INVALID_FORMAT' },
        { field: 'throughYear', code: 'INVALID_FORMAT' },
        { field: 'reason', code: 'INVALID_FORMAT' },
        { field: 'expectedInputFingerprint', code: 'INVALID_FORMAT' },
        { field: 'acceptChangedYears.1', code: 'DUPLICATE' },
      ]),
    );
    const missing = await post(base, ASSET, {});
    expect((await errorOf(missing)).details?.['fields']).toEqual([
      { field: 'throughYear', code: 'REQUIRED' },
      { field: 'reason', code: 'REQUIRED' },
      { field: 'expectedInputFingerprint', code: 'REQUIRED' },
    ]);
    expect((await errorOf(await post(base, ASSET, { ...body, throughYear: 2101 }))).details?.['fields']).toEqual([
      { field: 'throughYear', code: 'OUT_OF_RANGE' },
    ]);
    expect(await errorOf(await post(base, ASSET, { ...body, throughYear: 2027 }))).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fields: [{ field: 'throughYear', code: 'OUT_OF_RANGE' }], max: 2026 },
    });
    expect((await post(base, ASSET, body, { 'idempotency-key': 'bad key' })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('off: a well-formed request answers 409 RECORDING_NOT_ENABLED for any asset id, with or without a key; nothing reaches the repository', async () => {
    const { calls, overrides } = commands(false);
    const base = await start(overrides);
    for (const assetId of [ASSET, '00000000-0000-4000-8000-000000000001', ASSET.toUpperCase()]) {
      for (const extra of [{}, { 'idempotency-key': 'k-1' }]) {
        const res = await post(base, assetId, body, extra);
        expect(res.status).toBe(409);
        expect(await errorOf(res)).toEqual({
          code: 'CONFLICT',
          message: 'Recording depreciation schedule versions is not enabled in this installation.',
          details: { reason: 'RECORDING_NOT_ENABLED' },
        });
      }
    }
    expect(calls).toEqual([]);
  });

  it('off: the reads answer as without versions (an empty list; a version id 404); counter-check: on, the unknown asset is 404', async () => {
    const off = commands(false);
    const base = await start(off.overrides);
    const list = await fetch(`${base}/depreciation-assets/${ASSET}/schedule-versions?status=CURRENT,SUPERSEDED`, { headers });
    expect([list.status, await list.json()]).toEqual([200, { items: [] }]);
    const one = await fetch(`${base}/depreciation-assets/${ASSET}/schedule-versions/${VERSION}`, { headers });
    expect([one.status, await errorOf(one)]).toEqual([404, { code: 'NOT_FOUND', message: 'Schedule version not found.', details: { versionId: VERSION } }]);
    expect((await fetch(`${base}/depreciation-assets/${ASSET}/schedule-versions?status=VOID`, { headers })).status).toBe(400);
    expect(off.calls).toEqual(['list', 'find']);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const on = commands(true);
    const onBase = await start(on.overrides);
    expect((await post(onBase, ASSET, body)).status).toBe(404);
  });
});

describe('the error answers of §60', () => {
  const failing = (error: Error): CommandOverrides => ({
    depreciationAssets: {
      recordVersion: async () => {
        throw error;
      },
    },
  });
  it.each([
    [
      new ScheduleVersionRefusedError(ASSET, { kind: 'SCHEDULE_NOT_COMPLETE', details: { reasons: ['ASSET_NOT_CONFIRMED'], years: [] } }),
      409,
      'CONFLICT',
      'SCHEDULE_NOT_COMPLETE',
    ],
    [new ScheduleVersionRefusedError(ASSET, { kind: 'NOTHING_TO_RECORD', throughYear: 2026, firstYear: null }), 409, 'CONFLICT', 'NOTHING_TO_RECORD'],
    [
      new ScheduleVersionRefusedError(ASSET, { kind: 'THROUGH_YEAR_BEFORE_CURRENT', currentVersionId: VERSION, currentThroughYear: 2027 }),
      409,
      'CONFLICT',
      'THROUGH_YEAR_BEFORE_CURRENT',
    ],
    [
      new ScheduleVersionRefusedError(ASSET, {
        kind: 'RECORDED_YEARS_WOULD_CHANGE',
        currentVersionId: VERSION,
        changedYears: [{ year: 2027, recorded: 508800n, derived: 580200n, causes: ['INPUTS'] }],
        acceptChangedYears: [],
      }),
      409,
      'CONFLICT',
      'RECORDED_YEARS_WOULD_CHANGE',
    ],
    [
      new ScheduleVersionRefusedError(ASSET, { kind: 'SCHEDULE_CHANGED', throughYear: 2026, expectedInputFingerprint: 'a', currentInputFingerprint: 'b' }),
      412,
      'SCHEDULE_CHANGED',
      undefined,
    ],
    [new ScheduleVersionNotFoundError(VERSION), 404, 'NOT_FOUND', undefined],
    [new ConcurrentUpdateError('x'), 503, 'CONCURRENT_UPDATE', undefined],
  ] as const)('%s → %i %s', async (error, status, code, reason) => {
    const base = await start(failing(error));
    const res = await post(base, ASSET, body);
    expect(res.status).toBe(status);
    const answer = await errorOf(res);
    expect(answer.code).toBe(code);
    if (reason !== undefined) expect(answer.details).toMatchObject({ reason, assetId: ASSET });
    if (reason === 'RECORDED_YEARS_WOULD_CHANGE') {
      expect(answer.details?.['changedYears']).toEqual([
        { year: 2027, recorded: { amount: '5088.00', currency: 'EUR' }, derived: { amount: '5802.00', currency: 'EUR' }, causes: ['INPUTS'] },
      ]);
    }
    if (status === 503) expect(res.headers.get('retry-after')).toBe('1');
  });
});

import { describe, expect, it } from 'vitest';
import type { RecordOutcome, ScheduleVersionRepository } from '../domains/depreciation/index.js';
import { ConcurrentUpdateError } from './errors.js';
import {
  RecordingNotEnabledError,
  ThroughYearInFutureError,
  getScheduleVersion,
  listScheduleVersions,
  recordScheduleVersion,
} from './depreciation-schedule-versions.js';

/**
 * The record use case and the reads (api-design.md §60) against a stub repository that records every call: the switch
 * is the command's first check after the request's own (no transaction, no key, no read while off), the reads never
 * look at it, and three serialisation failures in a row give up with `ConcurrentUpdateError` (503).
 */
const principal = { email: 'anna@example.com', mreRealmId: '64b0c0ffee000000000008f1', mreRole: 'administrator' } as const;
const ASSET = '6f1c2a9e-0000-4000-8000-000000000010';
const request = {
  principal,
  assetId: ASSET,
  throughYear: 2026,
  reason: 'AfA 2026 (synthetisch)',
  expectedInputFingerprint: '0'.repeat(64),
  acceptChangedYears: [],
  idempotencyKey: 'key-1',
};
const fingerprinter = { sha256Hex: (text: string) => text };
const now = () => new Date('2026-10-30T10:00:00Z');

function stub(outcomes: RecordOutcome[] = []) {
  const calls: string[] = [];
  const repository: ScheduleVersionRepository = {
    record: async () => {
      calls.push('record');
      return outcomes.shift() ?? { kind: 'NOT_FOUND' };
    },
    list: async () => {
      calls.push('list');
      return [];
    },
    find: async () => {
      calls.push('find');
      return undefined;
    },
    storedRuleVersionHashes: async () => {
      calls.push('storedRuleVersionHashes');
      return [];
    },
  };
  return { calls, repository };
}

describe('the recording switch in the use case (§60 "The recording switch")', () => {
  it('off: RecordingNotEnabledError, and the repository records no call at all (no transaction, no key claim, no read)', async () => {
    const { calls, repository } = stub();
    const record = recordScheduleVersion({ repository, recordingEnabled: false, fingerprinter, now });
    await expect(record(request)).rejects.toBeInstanceOf(RecordingNotEnabledError);
    await expect(record({ ...request, assetId: 'not-even-a-uuid', idempotencyKey: 'x' })).rejects.toBeInstanceOf(RecordingNotEnabledError);
    expect(calls).toEqual([]);
  });

  it('counter-check: on, the same request reaches the repository (the stub’s unknown asset answers 404)', async () => {
    const { calls, repository } = stub();
    const record = recordScheduleVersion({ repository, recordingEnabled: true, fingerprinter, now });
    await expect(record(request)).rejects.toMatchObject({ name: 'DepreciationAssetNotFoundError' });
    expect(calls).toEqual(['record']);
  });

  it('a throughYear after today’s year is a 400 before the switch, off and on alike', async () => {
    for (const recordingEnabled of [false, true]) {
      const { calls, repository } = stub();
      await expect(recordScheduleVersion({ repository, recordingEnabled, fingerprinter, now })({ ...request, throughYear: 2027 })).rejects.toEqual(
        new ThroughYearInFutureError(2026),
      );
      expect(calls).toEqual([]);
    }
  });

  it('the reads never look at the switch: the list and the single read ask the repository', async () => {
    const { calls, repository } = stub();
    expect(await listScheduleVersions({ repository })({ principal, assetId: ASSET, statuses: null })).toEqual([]);
    await expect(getScheduleVersion({ repository, fingerprinter })({ principal, assetId: ASSET, versionId: ASSET })).rejects.toMatchObject({
      name: 'ScheduleVersionNotFoundError',
    });
    expect(calls).toEqual(['list', 'find']);
  });
});

describe('serialisation failures (§60 "Concurrency")', () => {
  it('three in a row give up: ConcurrentUpdateError (503 CONCURRENT_UPDATE), each attempt a fresh transaction', async () => {
    const { calls, repository } = stub([{ kind: 'SERIALIZATION_FAILURE' }, { kind: 'SERIALIZATION_FAILURE' }, { kind: 'SERIALIZATION_FAILURE' }]);
    await expect(recordScheduleVersion({ repository, recordingEnabled: true, fingerprinter, now })(request)).rejects.toBeInstanceOf(ConcurrentUpdateError);
    expect(calls).toEqual(['record', 'record', 'record']);
  });

  it('counter-check: a failure followed by an answer retries once and answers it', async () => {
    const { calls, repository } = stub([{ kind: 'SERIALIZATION_FAILURE' }, { kind: 'NOT_FOUND' }]);
    await expect(recordScheduleVersion({ repository, recordingEnabled: true, fingerprinter, now })(request)).rejects.toMatchObject({
      name: 'DepreciationAssetNotFoundError',
    });
    expect(calls).toEqual(['record', 'record']);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IDEMPOTENCY_CLEANUP_INTERVAL_MS,
  IDEMPOTENCY_RETENTION_MS,
  idempotencyRetentionCutoff,
  isIdempotencyKeyExpired,
  startIdempotencyKeyCleanup,
  type CleanupTimers,
} from './idempotency-retention.js';

/**
 * VC-X-12 (api-design.md §15 "Retention"; Entscheidung des Projektinhabers, 2026-11-06): the seven-day rule on an
 * injected clock, at the boundary to the millisecond, and the cleanup's schedule: one run on start, one a day, the
 * interval unref()'d and cleared by stop(). No database.
 */
const DAY = 24 * 60 * 60 * 1000;
const CREATED = new Date('2026-11-06T10:15:30.250Z');
const at = (ms: number) => new Date(CREATED.getTime() + ms);

describe('the seven-day rule', () => {
  it('the retention is seven days and the cleanup runs daily', () => {
    expect(IDEMPOTENCY_RETENTION_MS).toBe(7 * DAY);
    expect(IDEMPOTENCY_CLEANUP_INTERVAL_MS).toBe(DAY);
  });

  it('exactly seven days after creation the key is expired', () => {
    expect(isIdempotencyKeyExpired(CREATED, at(7 * DAY))).toBe(true);
  });

  it('seven days minus one millisecond: the key still replays', () => {
    expect(isIdempotencyKeyExpired(CREATED, at(7 * DAY - 1))).toBe(false);
  });

  it('seven days plus one millisecond: the key is expired', () => {
    expect(isIdempotencyKeyExpired(CREATED, at(7 * DAY + 1))).toBe(true);
  });

  it('a fresh key and one six days old are kept; counter-check: eight days old is expired', () => {
    expect(isIdempotencyKeyExpired(CREATED, CREATED)).toBe(false);
    expect(isIdempotencyKeyExpired(CREATED, at(6 * DAY))).toBe(false);
    expect(isIdempotencyKeyExpired(CREATED, at(8 * DAY))).toBe(true);
  });

  it('the cutoff is now minus seven days to the millisecond, across a daylight-saving change in Berlin', () => {
    // 2026-10-25 is the end of summer time in Europe/Berlin: the rule counts milliseconds, not calendar days.
    expect(idempotencyRetentionCutoff(new Date('2026-10-30T12:00:00.000Z')).toISOString()).toBe('2026-10-23T12:00:00.000Z');
    expect(idempotencyRetentionCutoff(at(7 * DAY)).getTime()).toBe(CREATED.getTime());
  });
});

/** Fake timers that record what the cleanup does with its handle. */
function recordingTimers() {
  const handle = { unrefs: 0, cleared: false, run: undefined as (() => void) | undefined, ms: 0, unref: () => handle.unrefs++ };
  const timers: CleanupTimers<typeof handle> = {
    setInterval: (run, ms) => {
      handle.run = run;
      handle.ms = ms;
      return handle;
    },
    clearInterval: (h) => {
      h.cleared = true;
    },
  };
  return { handle, timers };
}

describe('startIdempotencyKeyCleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once on start with the injected clock, logs the deleted count, and schedules a daily unrefd interval', async () => {
    const { handle, timers } = recordingTimers();
    const purge = vi.fn(async () => 3);
    const log = vi.fn();
    const now = new Date('2026-11-06T03:00:00Z');
    const cleanup = startIdempotencyKeyCleanup({ purge, log, logError: vi.fn(), now: () => now, timers });
    await cleanup.firstRun;
    expect(purge.mock.calls).toEqual([[now]]);
    expect(log.mock.calls).toEqual([['idempotency key cleanup: 3 expired key(s) deleted (retention 7 days)']]);
    expect([handle.ms, handle.unrefs, handle.cleared]).toEqual([DAY, 1, false]);
  });

  it('each interval tick runs the purge again and logs its own count', async () => {
    const { handle, timers } = recordingTimers();
    const counts = [0, 5];
    const purge = vi.fn(async () => counts.shift() ?? 0);
    const log = vi.fn();
    const cleanup = startIdempotencyKeyCleanup({ purge, log, logError: vi.fn(), timers });
    await cleanup.firstRun;
    handle.run?.();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      'idempotency key cleanup: 0 expired key(s) deleted (retention 7 days)',
      'idempotency key cleanup: 5 expired key(s) deleted (retention 7 days)',
    ]);
  });

  it('stop clears the interval it scheduled', async () => {
    const { handle, timers } = recordingTimers();
    const cleanup = startIdempotencyKeyCleanup({ purge: async () => 0, log: vi.fn(), logError: vi.fn(), timers });
    await cleanup.firstRun;
    expect(handle.cleared).toBe(false);
    cleanup.stop();
    expect(handle.cleared).toBe(true);
  });

  it('a failed run is logged and does not reject; the next run tries again', async () => {
    const { handle, timers } = recordingTimers();
    const purge = vi.fn().mockRejectedValueOnce(new Error('connection refused (synthetisch)')).mockResolvedValueOnce(2);
    const log = vi.fn();
    const logError = vi.fn();
    const cleanup = startIdempotencyKeyCleanup({ purge, log, logError, timers });
    await expect(cleanup.firstRun).resolves.toBeUndefined();
    expect(logError.mock.calls).toEqual([['idempotency key cleanup failed: Error: connection refused (synthetisch)']]);
    handle.run?.();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(log.mock.calls[0]?.[0]).toBe('idempotency key cleanup: 2 expired key(s) deleted (retention 7 days)');
  });

  it('with Node timers: one run per day, none after stop, and the interval does not keep the process alive', async () => {
    vi.useFakeTimers();
    const purge = vi.fn(async () => 0);
    let handle: NodeJS.Timeout | undefined;
    const timers: CleanupTimers<NodeJS.Timeout> = {
      setInterval: (run, ms) => (handle = setInterval(run, ms)),
      clearInterval: (h) => clearInterval(h),
    };
    const cleanup = startIdempotencyKeyCleanup({ purge, log: vi.fn(), logError: vi.fn(), timers });
    await cleanup.firstRun;
    expect(handle?.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(purge).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(purge).toHaveBeenCalledTimes(3);
    cleanup.stop();
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(purge).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the default timers (as main.ts uses them): a real daily interval, unrefd, cleared by stop', async () => {
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    try {
      const cleanup = startIdempotencyKeyCleanup({ purge: async () => 0, log: vi.fn(), logError: vi.fn() });
      await cleanup.firstRun;
      expect(set).toHaveBeenCalledTimes(1);
      expect(set.mock.calls[0]?.[1]).toBe(DAY);
      const handle = set.mock.results[0]?.value as NodeJS.Timeout;
      expect(handle.hasRef()).toBe(false);
      expect(clear).not.toHaveBeenCalled();
      cleanup.stop();
      expect(clear.mock.calls).toEqual([[handle]]);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });
});

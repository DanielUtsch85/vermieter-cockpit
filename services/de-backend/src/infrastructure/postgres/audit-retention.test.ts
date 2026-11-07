import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_PSEUDONYMISATION_BATCH, AUDIT_PSEUDONYMISATION_INTERVAL_MS, pseudonymisationLogLine, startAuditPseudonymisation } from './audit-retention.js';
import type { CleanupTimers } from './idempotency-retention.js';

/**
 * VC-X-24 (api-design.md §58U rule 4; decision 6): the schedule of the pseudonymisation, as VC-X-12's cleanup: one run on
 * start with the injected clock, one a day, the interval unref()'d and cleared by stop(), one log line per run with the
 * count, a failed run logged without stopping the start. No database.
 */
const DAY = 24 * 60 * 60 * 1000;

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

describe('startAuditPseudonymisation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches of 500, a daily interval; the log line names the count and the cutoff in Europe/Berlin', () => {
    expect([AUDIT_PSEUDONYMISATION_BATCH, AUDIT_PSEUDONYMISATION_INTERVAL_MS]).toEqual([500, DAY]);
    expect(pseudonymisationLogLine(3, new Date('2037-01-01T00:00:00+01:00'))).toBe(
      'audit pseudonymisation: 3 record(s) pseudonymised (retention 10 years, created before 2027-01-01)',
    );
    // 31.12.2036 23:30 UTC is 2037 in Berlin: the cutoff already moved.
    expect(pseudonymisationLogLine(0, new Date('2036-12-31T23:30:00Z'))).toBe(
      'audit pseudonymisation: 0 record(s) pseudonymised (retention 10 years, created before 2027-01-01)',
    );
    expect(pseudonymisationLogLine(0, new Date('2036-12-31T22:59:59.999Z'))).toBe(
      'audit pseudonymisation: 0 record(s) pseudonymised (retention 10 years, created before 2026-01-01)',
    );
  });

  it('runs once on start with the injected clock, logs the count, and schedules a daily unrefd interval', async () => {
    const { handle, timers } = recordingTimers();
    const pseudonymise = vi.fn(async () => 2);
    const log = vi.fn();
    const now = new Date('2037-01-01T03:00:00Z');
    const job = startAuditPseudonymisation({ pseudonymise, log, logError: vi.fn(), now: () => now, timers });
    await job.firstRun;
    expect(pseudonymise.mock.calls).toEqual([[now]]);
    expect(log.mock.calls).toEqual([['audit pseudonymisation: 2 record(s) pseudonymised (retention 10 years, created before 2027-01-01)']]);
    expect([handle.ms, handle.unrefs, handle.cleared]).toEqual([DAY, 1, false]);
    handle.run?.();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    job.stop();
    expect(handle.cleared).toBe(true);
  });

  it('a failed run is logged and does not reject; the next run tries again', async () => {
    const { handle, timers } = recordingTimers();
    const pseudonymise = vi.fn().mockRejectedValueOnce(new Error('connection refused (synthetisch)')).mockResolvedValueOnce(1);
    const log = vi.fn();
    const logError = vi.fn();
    const job = startAuditPseudonymisation({ pseudonymise, log, logError, now: () => new Date('2037-01-02T00:00:00Z'), timers });
    await expect(job.firstRun).resolves.toBeUndefined();
    expect(logError.mock.calls).toEqual([['audit pseudonymisation failed: Error: connection refused (synthetisch)']]);
    handle.run?.();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(log.mock.calls[0]?.[0]).toMatch(/^audit pseudonymisation: 1 record\(s\) pseudonymised/);
  });

  it('with Node timers: one run per day, none after stop, and the interval does not keep the process alive', async () => {
    vi.useFakeTimers();
    const pseudonymise = vi.fn(async () => 0);
    let handle: NodeJS.Timeout | undefined;
    const timers: CleanupTimers<NodeJS.Timeout> = {
      setInterval: (run, ms) => (handle = setInterval(run, ms)),
      clearInterval: (h) => clearInterval(h),
    };
    const job = startAuditPseudonymisation({ pseudonymise, log: vi.fn(), logError: vi.fn(), timers });
    await job.firstRun;
    expect(handle?.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(pseudonymise).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pseudonymise).toHaveBeenCalledTimes(2);
    job.stop();
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(pseudonymise).toHaveBeenCalledTimes(2);
  });
});

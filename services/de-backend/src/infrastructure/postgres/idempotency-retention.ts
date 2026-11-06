import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

/**
 * VC-X-12: retention of the `Idempotency-Key` store (api-design.md §15 "Retention"; Entscheidung des Projektinhabers,
 * 2026-11-06): a key is kept seven days from its creation (`idempotency_key.created_at`), its result snapshot goes with
 * it, and a request with an expired key is a new request. Two places apply the rule:
 *
 * - the claim (`idempotency.ts`), at request time, on the database's transaction clock (the clock that stamped
 *   `created_at`), so an expired key still in the table is never replayed;
 * - the cleanup below, once on start and once a day from `main.ts`, on the injected clock; it only frees the rows.
 *
 * Both read the same rule: expired once `created_at <= now − 7 days`. A few seconds' skew between the two clocks moves
 * only the instant at which an expired key's row disappears; the answer to a request is the same either way.
 */
export const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The cleanup's interval: once a day. */
export const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The newest `created_at` that is expired at `now`. */
export function idempotencyRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - IDEMPOTENCY_RETENTION_MS);
}

/** Exactly seven days after its creation a key is expired; one millisecond before, it still replays. */
export function isIdempotencyKeyExpired(createdAt: Date, now: Date): boolean {
  return createdAt.getTime() <= idempotencyRetentionCutoff(now).getTime();
}

/**
 * Deletes every expired key with its result snapshot, in all Realms and scopes, and answers how many. The resources the
 * keys created are untouched, and no AuditRecord is written (a key is not an entity). Uses `idempotency_key_created_at_idx`
 * (migration 0074). A claim racing with it on the same row waits on the row lock; whichever deletes first, the request
 * is new (idempotency.ts).
 */
export async function purgeExpiredIdempotencyKeys(db: Kysely<Database>, now: Date): Promise<number> {
  const result = await db.deleteFrom('idempotency_key').where('created_at', '<=', idempotencyRetentionCutoff(now)).executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** The part of Node's timers the cleanup uses; injectable for tests. */
export interface CleanupTimers<H extends { unref(): unknown }> {
  setInterval(run: () => void, ms: number): H;
  clearInterval(handle: H): void;
}

export interface IdempotencyKeyCleanup {
  /** The run on start; settles after its log line, never rejects (a failure is logged). */
  readonly firstRun: Promise<void>;
  /** Clears the daily interval (on shutdown). */
  stop(): void;
}

const nodeTimers: CleanupTimers<NodeJS.Timeout> = {
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle),
};

/**
 * Runs `purge` once now and then once a day. The interval is `unref()`'d, so it never keeps the process alive (a test,
 * a shutdown); `stop()` clears it. Each run logs one line with the deleted count; a failed run logs the error and the
 * next one tries again.
 */
export function startIdempotencyKeyCleanup<H extends { unref(): unknown } = NodeJS.Timeout>(deps: {
  readonly purge: (now: Date) => Promise<number>;
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
  readonly now?: () => Date;
  readonly timers?: CleanupTimers<H>;
}): IdempotencyKeyCleanup {
  const now = deps.now ?? (() => new Date());
  const timers = deps.timers ?? (nodeTimers as unknown as CleanupTimers<H>);
  const run = async (): Promise<void> => {
    try {
      const deleted = await deps.purge(now());
      deps.log(`idempotency key cleanup: ${deleted} expired key(s) deleted (retention 7 days)`);
    } catch (error) {
      deps.logError(`idempotency key cleanup failed: ${String(error)}`);
    }
  };
  const firstRun = run();
  const handle = timers.setInterval(() => void run(), IDEMPOTENCY_CLEANUP_INTERVAL_MS);
  handle.unref();
  return { firstRun, stop: () => timers.clearInterval(handle) };
}

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl, waitForLocks } from './rent-reconciliation.test-support.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * `waitForLocks` counts only the sessions of its own pool (review on #187): every test file shares the database, so a
 * count over `pg_stat_activity` of the whole database is met early by another file's waiting session under full-suite
 * load. The pools name themselves by their schema (`application_name`), and the count filters on it.
 */
describe.skipIf(databaseUrl === undefined)('waitForLocks counts its own pool only', () => {
  const ours = testSchemaName('wait_for_locks_test');
  const theirs = testSchemaName('wait_for_locks_other_test');
  const key = Math.floor(Math.random() * 1_000_000_000);
  let own: pg.Pool;
  let other: pg.Pool;

  beforeAll(() => {
    own = new pg.Pool({ connectionString: databaseUrl, options: `-c application_name=${ours}`, max: 2 });
    other = new pg.Pool({ connectionString: databaseUrl, options: `-c application_name=${theirs}`, max: 3 });
  });

  afterAll(async () => {
    await own.end();
    await other.end();
  });

  it('a pool without an application_name is refused, never counted database-wide', async () => {
    const unnamed = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await expect(waitForLocks(unnamed, 1)).rejects.toThrow('waitForLocks needs a pool with an application_name');
    } finally {
      await unnamed.end();
    }
  });

  it('a session of another pool waiting on a lock does not satisfy the count; one of its own does', { timeout: 20_000 }, async () => {
    const holder = await other.connect();
    const waiter = await other.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [key]);
      const waiting = waiter.query('SELECT pg_advisory_lock($1)', [key]);
      await waitForLocks(other, 1);
      // Counter-check: the database-wide count (the old query) is met here by the other pool's waiter.
      const databaseWide = await own.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      expect(Number(databaseWide.rows[0].count)).toBeGreaterThanOrEqual(1);
      await expect(waitForLocks(own, 1, 300)).rejects.toThrow('fewer than 1 sessions wait on a lock');
      await holder.query('SELECT pg_advisory_unlock($1)', [key]);
      await waiting;
      await waiter.query('SELECT pg_advisory_unlock($1)', [key]);
    } finally {
      holder.release();
      waiter.release();
    }
  });
});

import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createPool, isDatabaseReachable } from './pool.js';

const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

describe('isDatabaseReachable', () => {
  it.skipIf(databaseUrl === undefined)('is true for a reachable database', async () => {
    const pool = createPool(databaseUrl ?? '');
    try {
      expect(await isDatabaseReachable(pool)).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('is false (not throwing) for an unreachable database', async () => {
    const pool = createPool('postgres://nobody:nothing@127.0.0.1:9/none');
    try {
      expect(await isDatabaseReachable(pool)).toBe(false);
    } finally {
      await pool.end();
    }
  });

  // Regression (PR #5 review): a server-side termination of an idle pooled
  // connection (PostgreSQL restart, failover) must not crash the process.
  it.skipIf(databaseUrl === undefined)('survives termination of idle connections and recovers', async () => {
    const pool = createPool(databaseUrl ?? '');
    const admin = new pg.Client({ connectionString: databaseUrl });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      await admin.connect();
      const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = rows[0]?.pid;
      expect(pool.idleCount).toBe(1);

      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      // Give the pool time to observe the dropped idle connection.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(uncaught).toEqual([]);
      expect(await isDatabaseReachable(pool)).toBe(true);
      const after = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(after.rows[0]?.pid).not.toBe(pid);
    } finally {
      process.off('uncaughtException', onUncaught);
      await admin.end();
      await pool.end();
    }
  });
});

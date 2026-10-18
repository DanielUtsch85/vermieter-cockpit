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
});

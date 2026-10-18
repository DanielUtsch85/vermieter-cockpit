import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';

/**
 * Phase-0 exit "migrations run": a fresh database migrates to latest, and a
 * second run is a no-op. Runs in an isolated schema so it does not depend on
 * (or disturb) the state of the shared test database.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

describe.skipIf(databaseUrl === undefined)('migrateToLatest', () => {
  const schema = `migrate_test_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });

  it('applies every migration on a fresh database, in order', async () => {
    const results = await migrateToLatest(pool);
    expect(results.map((r) => [r.migrationName, r.status])).toEqual(
      Object.keys(migrations).map((name) => [name, 'Success']),
    );
    const applied = await pool.query<{ name: string }>('SELECT name FROM kysely_migration ORDER BY name');
    expect(applied.rows.map((r) => r.name)).toEqual(Object.keys(migrations));
  });

  it('is idempotent: a second run applies nothing', async () => {
    expect(await migrateToLatest(pool)).toEqual([]);
  });

  it('a failing migration throws (startup aborts) and is not recorded as applied', async () => {
    const failing = {
      ...migrations,
      '9999_failing': {
        up: async () => {
          throw new Error('boom');
        },
      },
    };
    await expect(migrateToLatest(pool, failing)).rejects.toThrow('Database migration failed at 9999_failing');
    const applied = await pool.query<{ name: string }>('SELECT name FROM kysely_migration');
    expect(applied.rows.map((r) => r.name)).not.toContain('9999_failing');
  });

  it('migration names are ordered and never reuse a number', () => {
    const names = Object.keys(migrations);
    expect(names).toEqual([...names].sort());
    const numbers = names.map((n) => n.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const name of names) expect(name).toMatch(/^\d{4}_[a-z0-9_]+$/);
  });
});

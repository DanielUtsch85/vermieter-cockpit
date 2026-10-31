import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * Phase-0 exit "migrations run": a fresh database migrates to latest, and a
 * second run is a no-op. Runs in an isolated schema so it does not depend on
 * (or disturb) the state of the shared test database.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

describe.skipIf(databaseUrl === undefined)('migrateToLatest', () => {
  const schema = testSchemaName('migrate_test');
  let pool: pg.Pool;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies every migration on a fresh database, in order', { timeout: 30_000 }, async () => {
    const results = await migrateToLatest(pool, { migrationTableSchema: schema });
    expect(results.map((r) => [r.migrationName, r.status])).toEqual(Object.keys(migrations).map((name) => [name, 'Success']));
    const applied = await pool.query<{ name: string }>(`SELECT name FROM "${schema}".kysely_migration ORDER BY name`);
    expect(applied.rows.map((r) => r.name)).toEqual(Object.keys(migrations));
  });

  it('is idempotent: a second run applies nothing', { timeout: 30_000 }, async () => {
    expect(await migrateToLatest(pool, { migrationTableSchema: schema })).toEqual([]);
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
    await expect(migrateToLatest(pool, { migrations: failing, migrationTableSchema: schema })).rejects.toThrow('Database migration failed at 9999_failing');
    const applied = await pool.query<{ name: string }>(`SELECT name FROM "${schema}".kysely_migration`);
    expect(applied.rows.map((r) => r.name)).not.toContain('9999_failing');
  });
});

describe.skipIf(databaseUrl === undefined)('migrateToLatest with a single-connection pool', () => {
  const schema = testSchemaName('migrate_single_test');

  it('does not deadlock: the advisory lock uses its own connection, not one of the pool', async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1, connectionTimeoutMillis: 5_000 });
    try {
      const results = await migrateToLatest(pool, { migrationTableSchema: schema });
      expect(results).toHaveLength(Object.keys(migrations).length);
    } finally {
      await pool.end();
    }
  });
});

describe('migration registry (no database needed)', () => {
  it('every migration file is registered, and nothing else', () => {
    // The list in migrations/index.ts is static; a file that is not registered
    // would silently never run. This keeps directory and registry in sync.
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.(c|m)?ts$/.test(f) && !f.endsWith('.d.ts'))
      .map((f) => f.replace(/\.(c|m)?ts$/, ''))
      .sort();
    expect(Object.keys(migrations)).toEqual(files);
  });

  it('migration names are ordered and never reuse a number', () => {
    const names = Object.keys(migrations);
    expect(names).toEqual([...names].sort());
    const numbers = names.map((n) => n.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const name of names) expect(name).toMatch(/^\d{4}_[a-z0-9_]+$/);
  });
});

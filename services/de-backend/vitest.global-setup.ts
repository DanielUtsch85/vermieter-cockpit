import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { GlobalSetupContext } from 'vitest/node';
import { MIGRATION_ADVISORY_LOCK } from './src/infrastructure/postgres/migrate.js';

/**
 * Test schemas are dropped once, after every test file has finished — never by
 * one file while others still run. Kysely's Migrator introspects *all* schemas
 * (`getTables` evaluates catalog functions per schema), so a schema dropped by
 * one file while another migrates makes that migration fail with "schema … does
 * not exist".
 *
 * Every database test names its schema with `testSchemaName`, which appends
 * this run's id; the teardown drops exactly those, so a second test run against
 * the same database keeps its schemas. While dropping it holds the migration
 * advisory lock, so no migration (of either run) introspects meanwhile.
 */
export default function setup({ provide }: GlobalSetupContext): () => Promise<void> {
  const runId = randomBytes(4).toString('hex');
  provide('testRunId', runId);
  const ownSchema = new RegExp(`^[a-z0-9_]+_(?:test|e2e)_${runId}$`);
  return async () => {
    const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
    if (databaseUrl === undefined) return;
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      // Waits for migrations in progress (also of another run) and holds them off while dropping.
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
      const { rows } = await client.query<{ nspname: string }>('SELECT nspname FROM pg_namespace');
      for (const { nspname } of rows) {
        if (ownSchema.test(nspname)) await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  };
}

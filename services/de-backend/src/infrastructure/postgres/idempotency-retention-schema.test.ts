import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { withMigrationLock } from './tax-year.test-support.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * Migration 0074 (VC-X-12, api-design.md §15 "Retention") past the repository: the index on 0004's creation date
 * `idempotency_key.created_at`, used by the cleanup's DELETE (counter-check: without the index the same plan scans the
 * table); `down` drops exactly that index and touches no row, `up` restores it verbatim, a second `up` fails. The column
 * name is the one 0004 created (checked here, not assumed). Synthetic rows only.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const INDEX = 'idempotency_key_created_at_idx';
const CLEANUP = `DELETE FROM idempotency_key WHERE created_at <= now() - interval '7 days'`;

describe.skipIf(databaseUrl === undefined)('the schema of 0074', () => {
  const schema = testSchemaName('idempotency_retention_schema_test');
  let pool: pg.Pool;

  const createSchema = async (name: string) => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${name}"`);
    await admin.end();
  };
  const indexesOf = async (p: pg.Pool, name: string) =>
    (await p.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'idempotency_key' ORDER BY indexname`, [name])).rows;
  /** The cleanup's plan with sequential scans priced out, rolled back (EXPLAIN without ANALYZE deletes nothing anyway). */
  const planOf = async (client: pg.PoolClient) => {
    await client.query('SET LOCAL enable_seqscan = off');
    return (await client.query(`EXPLAIN ${CLEANUP}`)).rows.map((r) => r['QUERY PLAN'] as string).join('\n');
  };

  beforeAll(async () => {
    await createSchema(schema);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('0004 named the creation date created_at: timestamptz, NOT NULL, DEFAULT now()', async () => {
    const { rows } = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'idempotency_key' AND column_name = 'created_at'`,
      [schema],
    );
    expect(rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' }]);
  });

  it('the index is a btree on created_at alone, next to the primary key', async () => {
    expect(await indexesOf(pool, schema)).toEqual([
      { indexname: INDEX, indexdef: `CREATE INDEX ${INDEX} ON ${schema}.idempotency_key USING btree (created_at)` },
      {
        indexname: 'idempotency_key_pkey',
        indexdef: `CREATE UNIQUE INDEX idempotency_key_pkey ON ${schema}.idempotency_key USING btree (mre_realm_id, scope, key)`,
      },
    ]);
  });

  it('the cleanup uses the index; counter-check: with the index dropped (rolled back) the same plan scans the table', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const withIndex = await planOf(client);
      expect(withIndex).toContain(INDEX);
      await client.query(`DROP INDEX ${INDEX}`);
      const without = await planOf(client);
      expect(without).not.toContain(INDEX);
      expect(without).toMatch(/Seq Scan on idempotency_key/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await indexesOf(pool, schema)).map((r) => r.indexname)).toContain(INDEX);
  });

  it('down drops exactly the index and keeps every row; up restores it verbatim; a second up fails', { timeout: 60_000 }, async () => {
    const downSchema = testSchemaName('idempotency_retention_down_test');
    await createSchema(downSchema);
    const down = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
    try {
      await migrateToLatest(down, { migrationTableSchema: downSchema });
      await down.query(
        `INSERT INTO idempotency_key (mre_realm_id, scope, key, request_fingerprint, resource_id, result, created_at)
         VALUES ('64b0c0ffee0000000000000a', 'retention.down', 'k-old', 'fp', 'r1', '{"n": 1}', now() - interval '30 days'),
                ('64b0c0ffee0000000000000a', 'retention.down', 'k-new', 'fp', 'r2', '{"n": 2}', now())`,
      );
      const rows = async () => (await down.query(`SELECT to_jsonb(k) AS r FROM idempotency_key k ORDER BY key`)).rows;
      const [before, indexesBefore] = [await rows(), await indexesOf(down, downSchema)];
      const migration = migrations['0074_idempotency_key_retention'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
      await withMigrationLock(() => migration.down(createDatabase(down) as never));
      expect(await indexesOf(down, downSchema)).toEqual(indexesBefore.filter((r) => r.indexname !== INDEX));
      expect(await rows()).toEqual(before);
      await withMigrationLock(() => migration.up(createDatabase(down) as never));
      expect(await indexesOf(down, downSchema)).toEqual(indexesBefore);
      expect(await rows()).toEqual(before);
      let again: unknown;
      await withMigrationLock(async () => {
        again = await migration.up(createDatabase(down) as never).catch((e: unknown) => e);
      });
      expect(String(again)).toMatch(/already exists/);
      expect(await indexesOf(down, downSchema)).toEqual(indexesBefore);
    } finally {
      await down.end();
    }
  });
});

import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresImportBatchQueries } from './import-batch-queries.js';
import { migrateToLatest } from './migrate.js';
import type { Database } from './schema.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-X-74 (api-design.md §32.6, migration 0078): the plan of `GET /imports`, read with `EXPLAIN` from the statement the
 * repository actually sends, as VC-X-19's plan test does for §30.1. The page's ids are read in order from
 * `import_batch_realm_imported_idx` and the scan stops at offset + limit; the account filter runs on the same index.
 * Counter-check: without the index (dropped in a rolled-back transaction) the same statement is a sequential scan.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const REALMS = 50;
const BATCHES_PER_REALM = 400;
const PAGE_SIZE = 20;

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Actual Rows': number;
  readonly Plans?: readonly PlanNode[];
}
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

describe.skipIf(databaseUrl === undefined)('the plan of the import list (§32.6, VC-X-74)', () => {
  const schema = testSchemaName('import_batch_list_plan_test');
  let pool: pg.Pool;
  let queries: PostgresImportBatchQueries;
  let giro: string;
  const sent: CompiledQuery[] = [];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === 'query') sent.push(event.query);
      },
    });
    queries = new PostgresImportBatchQueries(db);

    // Many Realms of the same size, two accounts each, so one Realm is a small part of the table, as in production.
    await pool.query(
      `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by)
       SELECT CASE WHEN r = 1 THEN $1 ELSE 'realm-' || r END, 'BANK', 'Konto ' || k, 'EUR', 'OPEN', 'x'
       FROM generate_series(1, $2::int) r, generate_series(1, 2) k`,
      [REALM, REALMS],
    );
    await pool.query(
      `INSERT INTO import_batch (id, mre_realm_id, financial_account_id, adapter_id, adapter_version, content_hash, provenance, status,
         transaction_count, duplicate_count, needs_review_count, error_count, skipped_count, rows, imported_at, imported_by)
       SELECT gen_random_uuid(), a.mre_realm_id, a.id, 'generic-csv', '2', md5(a.id::text || g), 'BANK_CSV',
         CASE WHEN g % 10 = 0 THEN 'NEEDS_REVIEW' ELSE 'COMPLETED' END, 1, 0, CASE WHEN g % 10 = 0 THEN 1 ELSE 0 END, 0, 0,
         '[]', timestamptz '2026-01-01' + g * interval '1 hour', 'x'
       FROM financial_account a, generate_series(1, $1::int / 2) g`,
      [BATCHES_PER_REALM],
    );
    await pool.query(`ANALYZE import_batch`);
    giro = (await pool.query(`SELECT id FROM financial_account WHERE mre_realm_id = $1 ORDER BY id LIMIT 1`, [REALM])).rows[0].id as string;
  });

  afterAll(async () => {
    await pool.end();
  });

  /** The page statement the repository sent for `filter` on page 2 (the one reading the rows by the page's ids). */
  const pageQuery = async (filter: Parameters<PostgresImportBatchQueries['list']>[1]) => {
    sent.length = 0;
    const page = await queries.list(REALM, filter, { page: 2, pageSize: PAGE_SIZE });
    expect(page.items).toHaveLength(PAGE_SIZE);
    const query = sent.find((q) => q.sql.includes('"content_hash"'));
    if (query === undefined) throw new Error('the page query was not sent');
    return query;
  };
  const planOf = async (client: pg.Pool | pg.PoolClient, query: CompiledQuery) => {
    const { rows } = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`, [...query.parameters]);
    return nodes(rows[0]['QUERY PLAN'][0].Plan as PlanNode);
  };

  it('reads a page of a Realm in index order and stops at offset + limit; no sequential scan, at most the page sorted', async () => {
    const plan = await planOf(pool, await pageQuery({}));
    expect(plan.map((n) => n['Node Type'])).not.toContain('Seq Scan');
    const scan = plan.find((n) => n['Index Name'] === 'import_batch_realm_imported_idx');
    expect(scan?.['Actual Rows']).toBe(2 * PAGE_SIZE);
    for (const sort of plan.filter((n) => n['Node Type'] === 'Sort')) expect(sort['Actual Rows']).toBeLessThanOrEqual(PAGE_SIZE);
  });

  it('the account and status filters run on the same index', async () => {
    for (const filter of [{ financialAccountId: giro }, { financialAccountId: giro, statuses: ['COMPLETED' as const] }]) {
      const plan = await planOf(pool, await pageQuery(filter));
      expect(plan.map((n) => n['Node Type'])).not.toContain('Seq Scan');
      expect(plan.map((n) => n['Index Name'])).toContain('import_batch_realm_imported_idx');
    }
  });

  it('counter-check: without the index the same statement scans the whole table', async () => {
    const query = await pageQuery({});
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP INDEX import_batch_realm_imported_idx');
      const plan = await planOf(client, query);
      expect(plan).toContainEqual(expect.objectContaining({ 'Node Type': 'Seq Scan', 'Relation Name': 'import_batch' }));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'import_batch_realm_imported_idx'`, [schema])).rowCount).toBe(1);
  });
});

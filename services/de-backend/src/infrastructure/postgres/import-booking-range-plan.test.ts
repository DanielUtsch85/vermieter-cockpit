import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresImportBatchQueries } from './import-batch-queries.js';
import { migrateToLatest } from './migrate.js';
import type { Database } from './schema.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-X-75 (api-design.md §32.6): the plan of the booking-range statement a list page sends, read with `EXPLAIN` from
 * the statement actually sent. It needs no index of its own: the Transactions are read by their primary key (the ids
 * the batch's `created` rows name; the planner may take `UNIQUE (id, mre_realm_id)` instead), the review items through `import_review_item_batch_idx` (0006): exactly the page's
 * items are read, no table is scanned whole. Counter-check: without that index (dropped in a rolled-back transaction)
 * the same statement reads at least every review item of the Realm.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const REALMS = 20;
const BATCHES_PER_REALM = 100;
const ROWS_PER_BATCH = 20;
const PAGE_SIZE = 20;

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Actual Rows': number;
  readonly 'Actual Loops'?: number;
  readonly 'Rows Removed by Filter'?: number;
  readonly Plans?: readonly PlanNode[];
}
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

describe.skipIf(databaseUrl === undefined)('the plan of the booking range (§32.6, VC-X-75)', () => {
  const schema = testSchemaName('import_booking_range_plan_test');
  let pool: pg.Pool;
  let queries: PostgresImportBatchQueries;
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

    // Many Realms of the same size, so one page is a small part of every table, as in production.
    await pool.query(
      `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by)
       SELECT CASE WHEN r = 1 THEN $1 ELSE 'realm-' || r END, 'BANK', 'Konto', 'EUR', 'OPEN', 'x' FROM generate_series(1, $2::int) r`,
      [REALM, REALMS],
    );
    await pool.query(
      `INSERT INTO import_batch (id, mre_realm_id, financial_account_id, adapter_id, adapter_version, content_hash, provenance, status,
         transaction_count, duplicate_count, needs_review_count, error_count, skipped_count, rows, imported_at, imported_by)
       SELECT gen_random_uuid(), a.mre_realm_id, a.id, 'generic-csv', '1', md5(a.id::text || g), 'BANK_CSV', 'COMPLETED', $2, 0, 0, 0, 0,
         '[]', timestamptz '2026-01-01' + g * interval '1 hour', 'x'
       FROM financial_account a, generate_series(1, $1::int) g`,
      [BATCHES_PER_REALM, ROWS_PER_BATCH],
    );
    await pool.query(
      `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by,
         import_batch_id, adapter_id, adapter_version, source_statement_key, source_row_key, content_fingerprint)
       SELECT b.mre_realm_id, b.financial_account_id, 10, 'EUR', 'INFLOW', date '2026-01-01' + g, 'BANK_CSV', 'IMPORTED', 'x',
         b.id, 'generic-csv', '1', 'sha256:' || b.content_hash, 'pos:' || g, md5(b.id::text || g)
       FROM import_batch b, generate_series(1, $1::int) g`,
      [ROWS_PER_BATCH],
    );
    await pool.query(
      `UPDATE import_batch b SET rows = (
         SELECT jsonb_agg(jsonb_build_object('outcome', 'created', 'position', substr(t.source_row_key, 5)::int, 'transactionId', t.id))
         FROM ledger_transaction t WHERE t.import_batch_id = b.id)`,
    );
    await pool.query(
      `INSERT INTO import_review_item (id, import_batch_id, mre_realm_id, financial_account_id, adapter_id, adapter_version, source_statement_key,
         source_row_key, content_fingerprint, normalized_row, ambiguity_reason, conflicting_transaction_ids, prior_review_item_ids, status,
         resolution, resolved_by, resolved_at)
       SELECT gen_random_uuid(), b.id, b.mre_realm_id, b.financial_account_id, 'generic-csv', '1', 'sha256:' || b.content_hash, 'pos:' || (100 + g),
         md5(b.id::text || 'r' || g), jsonb_build_object('bookingDate', (date '2025-12-01' + g)::text), 'AMBIGUOUS_CROSS_FILE_MATCH', '{}', '{}',
         'RESOLVED', 'SKIP', 'x', now()
       FROM import_batch b, generate_series(1, 2) g`,
    );
    await pool.query(`ANALYZE`);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  /** The booking-range statement the list sent for page 2. */
  const rangeQuery = async () => {
    sent.length = 0;
    const page = await queries.list(REALM, {}, { page: 2, pageSize: PAGE_SIZE });
    expect(page.items).toHaveLength(PAGE_SIZE);
    expect(page.items.every((b) => b.firstBookingDate === '2025-12-02' && b.lastBookingDate === '2026-01-21')).toBe(true);
    const query = sent.find((q) => q.sql.includes('jsonb_array_elements'));
    if (query === undefined) throw new Error('the range query was not sent');
    return query;
  };
  const planOf = async (client: pg.Pool | pg.PoolClient, query: CompiledQuery) => {
    const { rows } = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`, [...query.parameters]);
    return nodes(rows[0]['QUERY PLAN'][0].Plan as PlanNode);
  };
  const seqScans = (plan: readonly PlanNode[]) => plan.filter((n) => n['Node Type'] === 'Seq Scan').map((n) => n['Relation Name']);
  /** The review-item rows the statement looked at: those it kept and those its filter dropped, over all loops. */
  const itemRowsRead = (plan: readonly PlanNode[]) =>
    plan
      .filter((n) => n['Relation Name'] === 'import_review_item')
      .reduce((sum, n) => sum + (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0)) * (n['Actual Loops'] ?? 1), 0);

  it('reads the page s Transactions by primary key and its review items by their batch; no table is scanned whole', async () => {
    const plan = await planOf(pool, await rangeQuery());
    expect(seqScans(plan)).toEqual([]);
    // The Transactions by their id: the primary key, or `UNIQUE (id, mre_realm_id)` whose first column is the id too.
    const transactionScans = plan.filter((n) => n['Relation Name'] === 'ledger_transaction');
    expect(transactionScans.length).toBeGreaterThan(0);
    for (const scan of transactionScans) {
      expect(scan['Node Type']).toBe('Index Scan');
      expect(['ledger_transaction_pkey', 'ledger_transaction_realm_key']).toContain(scan['Index Name']);
      expect(scan['Actual Rows']).toBe(1);
    }
    expect(plan.map((n) => n['Index Name'])).toContain('import_review_item_batch_idx');
    // Exactly the page's items: two per batch.
    expect(itemRowsRead(plan)).toBe(2 * PAGE_SIZE);
  });

  it('counter-check: without the review-item index the same statement reads every item of the Realm (or the table)', async () => {
    const query = await rangeQuery();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP INDEX import_review_item_batch_idx');
      const plan = await planOf(client, query);
      expect(plan.map((n) => n['Index Name'])).not.toContain('import_review_item_batch_idx');
      expect(itemRowsRead(plan)).toBeGreaterThanOrEqual(2 * BATCHES_PER_REALM);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'import_review_item_batch_idx'`, [schema])).rowCount).toBe(1);
  });
});

import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest } from './migrate.js';
import type { Database } from './schema.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionQueries } from './transaction-query-repository.js';

/**
 * VC-X-19: the plan of `GET /transactions` (api-design.md §30.1), read with `EXPLAIN` from the statement the
 * repository actually sends. The page's ids are read in order from `ledger_transaction_realm_page_idx` and the
 * scan stops at offset + limit; the two link subqueries of the Transaction DTO then run once per row of the page,
 * each an index probe of `ledger_transaction_correction_key`, never for the rows the offset skips.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const REALMS = 50;
const ROWS_PER_REALM = 1000;
// Small against the Realm, so the wanted plan is clearly the cheapest. Page 2 of 200 read 400 of the Realm's 1000
// rows, and that plan cost only about 2 % less than a bitmap scan of all 1000 rows plus a sort. Which of the two the
// planner chose then depended on the sampled statistics, and it flipped under load. At 50 the margin is about 55 %.
const PAGE_SIZE = 50;

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Parent Relationship'?: string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Actual Rows': number;
  readonly 'Actual Loops': number;
  readonly Plans?: readonly PlanNode[];
}
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

describe.skipIf(databaseUrl === undefined)('the plan of the Transaction list (VC-X-19)', () => {
  const schema = testSchemaName('transaction_query_plan_test');
  let pool: pg.Pool;
  let queries: PostgresTransactionQueries;
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
    queries = new PostgresTransactionQueries(db);

    // Many Realms of the same size, so one Realm is a small part of the table, as in production.
    await pool.query(
      `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by)
       SELECT CASE WHEN r = 1 THEN $1 ELSE 'realm-' || r END, 'BANK', 'Giro', 'EUR', 'OPEN', 'x' FROM generate_series(1, $2::int) r`,
      [REALM, REALMS],
    );
    await pool.query(
      `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by)
       SELECT a.mre_realm_id, a.id, 10, 'EUR', 'INFLOW', date '2026-01-01' + (g % 300), 'MANUAL', 'UNREVIEWED', 'x'
       FROM financial_account a, generate_series(1, $1::int) g`,
      [ROWS_PER_REALM],
    );
    await pool.query(`ANALYZE ledger_transaction`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('reads a page of a Realm in index order, and the link subqueries only for its rows, not for the skipped ones', async () => {
    sent.length = 0;
    const page = await queries.list(REALM, {}, { page: 2, pageSize: PAGE_SIZE });
    expect(page.total).toBe(ROWS_PER_REALM);
    expect(page.items).toHaveLength(PAGE_SIZE);

    const pageQuery = sent.find((q) => q.sql.includes('reversal_transaction_id'));
    if (pageQuery === undefined) throw new Error('the page query was not sent');
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${pageQuery.sql}`, [...pageQuery.parameters]);
    const plan = nodes(rows[0]['QUERY PLAN'][0].Plan as PlanNode);

    // The page's ids: read in index order, stopping at offset + limit; no full scan, and at most the page is sorted.
    expect(plan.map((n) => n['Node Type'])).not.toContain('Seq Scan');
    const pageScan = plan.find((n) => n['Index Name'] === 'ledger_transaction_realm_page_idx');
    expect(pageScan?.['Actual Rows']).toBe(2 * PAGE_SIZE);
    for (const sort of plan.filter((n) => n['Node Type'] === 'Sort')) expect(sort['Actual Rows']).toBeLessThanOrEqual(PAGE_SIZE);

    // The two link subqueries: an index probe each, once per row of the page.
    const subPlans = plan.filter((n) => n['Parent Relationship'] === 'SubPlan');
    expect(subPlans).toHaveLength(2);
    for (const sub of subPlans) {
      expect(sub).toMatchObject({ 'Index Name': 'ledger_transaction_correction_key', 'Actual Loops': PAGE_SIZE });
    }
  });
});

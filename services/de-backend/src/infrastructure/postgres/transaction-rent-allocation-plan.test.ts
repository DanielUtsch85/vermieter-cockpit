import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest } from './migrate.js';
import type { Database } from './schema.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionQueries } from './transaction-query-repository.js';

/**
 * §30.1A (VC-X-81): the plan of the list's rent sums, read with `EXPLAIN` from the statements the repository actually
 * sends. No migration: the page aggregate and the filter probe the existing indexes, the rent sum
 * `transaction_split_position_key (transaction_id, position)` (0008), the allocated sum the partial index
 * `rent_payment_reconciliation_confirmed_key … WHERE status = 'CONFIRMED'` (0030); neither table is scanned
 * sequentially, and the aggregate runs once per row of the page, never for the rows the offset skips. Counter-check:
 * without the partial index (dropped in a rolled-back transaction) the allocated sum no longer probes it and reads more
 * than the page's reconciliations.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const REALMS = 20;
const ROWS_PER_REALM = 500;
const PAGE_SIZE = 50;

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Parent Relationship'?: string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Actual Rows': number;
  readonly 'Actual Loops': number;
  readonly 'Rows Removed by Filter'?: number;
  readonly Plans?: readonly PlanNode[];
}
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

describe.skipIf(databaseUrl === undefined)('the plan of the list s rent allocation (§30.1A, VC-X-81)', () => {
  const schema = testSchemaName('transaction_rent_allocation_plan_test');
  let pool: pg.Pool;
  let queries: PostgresTransactionQueries;
  const sent: CompiledQuery[] = [];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === 'query') sent.push(event.query);
      },
    });
    queries = new PostgresTransactionQueries(db);

    // Seeding only, in this test's own schema: the guards of confirmed rows (frozen splits, the cash guard) are off
    // while the rows are written and on again before any plan is read; the plans do not depend on them.
    for (const table of ['ledger_transaction', 'transaction_split', 'rent_payment_reconciliation']) {
      await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    }
    await pool.query(
      `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by)
       SELECT CASE WHEN r = 1 THEN $1 ELSE 'realm-' || r END, 'BANK', 'Giro', 'EUR', 'OPEN', 'x' FROM generate_series(1, $2::int) r`,
      [REALM, REALMS],
    );
    // Every Transaction a confirmed rent payment of 10.00: one RENT_BASE split and one BANK_FEES split.
    await pool.query(
      `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status,
         confirmed_at, confirmed_by, created_by)
       SELECT a.mre_realm_id, a.id, 10, 'EUR', 'INFLOW', date '2026-01-01' + (g % 300), 'MANUAL', 'CONFIRMED', now(), 'x', 'x'
       FROM financial_account a, generate_series(1, $1::int) g`,
      [ROWS_PER_REALM],
    );
    await pool.query(
      `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, created_by)
       SELECT t.id, t.mre_realm_id, p, 5, 'EUR', c.id, 'x'
       FROM ledger_transaction t, generate_series(1, 2) p
       JOIN financial_category c ON c.code = CASE WHEN p = 1 THEN 'RENT_BASE' ELSE 'BANK_FEES' END`,
    );
    // Every other Transaction one CONFIRMED match of 2.00 and one RELEASED of 1.00.
    await pool.query(
      `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency,
         confirmed_at, confirmed_by, released_at, released_by, release_reason, created_by)
       SELECT t.mre_realm_id, s.status, t.id, '6512f0c2a1b2c3d4e5f60a01', s.term, s.amount, 'EUR', now(), 'x',
         CASE WHEN s.status = 'RELEASED' THEN now() END, CASE WHEN s.status = 'RELEASED' THEN 'x' END, CASE WHEN s.status = 'RELEASED' THEN 'x' END, 'x'
       FROM (SELECT t.*, row_number() OVER (PARTITION BY t.mre_realm_id ORDER BY t.id) AS n FROM ledger_transaction t) t,
         (VALUES ('CONFIRMED', '2026010100', 2), ('RELEASED', '2026020100', 1)) AS s(status, term, amount)
       WHERE t.n % 2 = 0`,
    );
    for (const table of ['ledger_transaction', 'transaction_split', 'rent_payment_reconciliation']) {
      await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
    await pool.query(`ANALYZE`);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  const planOf = async (client: pg.Pool | pg.PoolClient, query: CompiledQuery) => {
    const { rows } = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`, [...query.parameters]);
    return nodes(rows[0]['QUERY PLAN'][0].Plan as PlanNode);
  };
  const sumsSent = () => sent.filter((q) => q.sql.includes('AS rent_cash'));
  /** The page aggregate the list sent for page 2. */
  const pageAggregate = async () => {
    sent.length = 0;
    const page = await queries.list(REALM, {}, { page: 2, pageSize: PAGE_SIZE });
    expect(page.items).toHaveLength(PAGE_SIZE);
    expect(page.rentSums.size).toBe(PAGE_SIZE);
    // Exactly one statement reads the sums, whatever the page size (never one per row).
    const statements = sumsSent();
    expect(statements).toHaveLength(1);
    return statements[0] as CompiledQuery;
  };
  const scansOf = (plan: readonly PlanNode[], relation: string) => plan.filter((n) => n['Relation Name'] === relation);
  /** The indexes a relation is read through: an Index (Only) Scan's own, or a Bitmap Heap Scan's Bitmap Index Scans. */
  const indexesOf = (plan: readonly PlanNode[], relation: string) =>
    scansOf(plan, relation).flatMap((n) =>
      n['Node Type'] === 'Bitmap Heap Scan' ? (n.Plans ?? []).flatMap(nodes).map((c) => c['Index Name']) : [n['Index Name']],
    );
  /** The rows a scan looked at over all its loops, kept and dropped (per-loop averages, so approximate). */
  const rowsRead = (scans: readonly PlanNode[]) =>
    scans.reduce((sum, n) => sum + (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0)) * n['Actual Loops'], 0);

  it('the page aggregate: one statement, both sums an index probe once per row of the page, no sequential scan of either table', async () => {
    const plan = await planOf(pool, await pageAggregate());
    for (const relation of ['transaction_split', 'rent_payment_reconciliation']) {
      expect(
        scansOf(plan, relation).map((n) => n['Node Type']),
        relation,
      ).not.toContain('Seq Scan');
    }
    expect(indexesOf(plan, 'transaction_split')).toEqual(['transaction_split_position_key']);
    expect(indexesOf(plan, 'rent_payment_reconciliation')).toEqual(['rent_payment_reconciliation_confirmed_key']);
    // Once per row of the page: the offset's rows are never summed.
    for (const relation of ['transaction_split', 'rent_payment_reconciliation']) {
      expect(
        scansOf(plan, relation).map((n) => n['Actual Loops']),
        relation,
      ).toEqual([PAGE_SIZE]);
    }
    // At most one CONFIRMED match per row of the page (every other row has one); the RELEASED ones are not in the index.
    // EXPLAIN gives rows per loop as a rounded average, so the bound is one per loop, not the exact half.
    expect(rowsRead(scansOf(plan, 'rent_payment_reconciliation'))).toBeLessThanOrEqual(PAGE_SIZE);
  });

  it('the filter: the count and the page probe the same two indexes, no sequential scan of either table', async () => {
    sent.length = 0;
    const page = await queries.list(REALM, { rentAllocation: ['PARTIAL'] }, { page: 2, pageSize: PAGE_SIZE });
    expect(page.total).toBe(ROWS_PER_REALM / 2);
    expect(page.items).toHaveLength(PAGE_SIZE);
    const filteredStatements = sent.filter((q) => q.sql.includes("'PARTIAL'") || q.parameters.includes('PARTIAL'));
    expect(filteredStatements.length).toBeGreaterThanOrEqual(2);
    for (const statement of filteredStatements) {
      const plan = await planOf(pool, statement);
      for (const relation of ['transaction_split', 'rent_payment_reconciliation']) {
        const scans = scansOf(plan, relation);
        expect(scans.length, relation).toBeGreaterThan(0);
        expect(
          scans.map((n) => n['Node Type']),
          relation,
        ).not.toContain('Seq Scan');
      }
      expect(new Set(indexesOf(plan, 'transaction_split'))).toEqual(new Set(['transaction_split_position_key']));
      expect(new Set(indexesOf(plan, 'rent_payment_reconciliation'))).toEqual(new Set(['rent_payment_reconciliation_confirmed_key']));
    }
  });

  it('counter-check: without the partial index the allocated sum no longer probes it and reads more than the page s matches', async () => {
    const query = await pageAggregate();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP INDEX rent_payment_reconciliation_confirmed_key');
      const plan = await planOf(client, query);
      expect(indexesOf(plan, 'rent_payment_reconciliation')).not.toContain('rent_payment_reconciliation_confirmed_key');
      // The RELEASED ones, and with a Realm-wide scan the Realm's other matches, are read and dropped too.
      expect(rowsRead(scansOf(plan, 'rent_payment_reconciliation'))).toBeGreaterThan(PAGE_SIZE);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(
      (await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'rent_payment_reconciliation_confirmed_key'`, [schema])).rowCount,
    ).toBe(1);
  });
});

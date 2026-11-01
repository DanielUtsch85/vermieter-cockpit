import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { planRecord, type RecordRequest } from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { sha256Fingerprinter } from '../hashing/index.js';
import { PostgresScheduleVersionRepository } from './depreciation-schedule-version-repository.js';
import { NOW, REALM, TODAY, VERSION_TABLES, actor, databaseUrl, useScheduleVersionDatabase } from './depreciation-schedule-version.test-support.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';

/**
 * VC-X-35 (api-design.md §60 "As implemented (VC-8-04)" 13): the plans of the `CURRENT` version lookup and of the entry
 * query, read with `EXPLAIN (ANALYZE, FORMAT JSON)` from the statements `PostgresScheduleVersionRepository.record`
 * actually sends (captured with Kysely's `log`). The lookup reads one row of `depreciation_schedule_version_current`
 * (the lock and the whole-version read alike), the whole-version read's predecessor probe at most one row; the entry
 * query reads the version's own entries from `depreciation_schedule_entry_key` and nothing else. No sequential scan.
 *
 * The data set is realistic rather than forced (no `enable_seqscan = off`): ASSETS buildings recorded once a year for a
 * decade (VERSIONS each: one `CURRENT`, the rest `SUPERSEDED`), every version with COMPONENTS components over YEARS
 * years, so the entry table holds ASSETS × VERSIONS × COMPONENTS × YEARS = 270 000 rows. Loaded with SQL, 0052's row
 * guards disabled for the load only (they check single records, which this load is not); the foreign keys stay on.
 * The test's own versions are then recorded through the repository with the guards on.
 *
 * Margins (planner cost of the wanted plan against the best plan without the wanted index, the index dropped in a
 * rolled-back transaction, and against a sequential scan), measured on PostgreSQL 16 with this set: the lock 8.30 vs
 * 36.79 (4.4×) and 196.31 (24×); the whole-version read 16.60 vs 45.10 (2.7×; the predecessor probe's 8.30 is in both)
 * and 400.16 (24×); the entry query 170.81 vs 6431.39 (38×). The test requires 2× and 10×. The version table (3 000
 * rows) is sampled whole by `ANALYZE`, so its estimates do not vary between runs; #214's plan flipped at a 2 % margin.
 */

const ASSETS = 300;
const VERSIONS = 10;
const COMPONENTS = 3;
const YEARS = 30;

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Total Cost': number;
  readonly 'Actual Rows': number;
  readonly 'Actual Loops': number;
  readonly 'Rows Removed by Filter'?: number;
  readonly 'Rows Removed by Index Recheck'?: number;
  readonly Plans?: readonly PlanNode[];
}
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

describe.skipIf(databaseUrl === undefined)('the plans of the CURRENT version lookup and the entry query (§60, VC-X-35)', () => {
  const { ctx, acc8, fingerprintOf } = useScheduleVersionDatabase('schedule_version_plan_test');

  beforeAll(async () => {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      for (const table of ['depreciation_asset', ...VERSION_TABLES]) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      await client.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by)
         SELECT $1, lpad(to_hex(g), 24, '0'), 'ACTIVE', 'bulk' FROM generate_series(1, $2::int) g`,
        [REALM, ASSETS],
      );
      await client.query(
        `INSERT INTO depreciation_asset (mre_realm_id, property_reference_id, asset_type, status, building_completion_year, depreciation_method, review_state, created_by)
         SELECT mre_realm_id, id, 'BUILDING', 'ACTIVE', 1995, 'LINEAR_7_4', 'CONFIRMED', 'bulk' FROM property_reference WHERE created_by = 'bulk'`,
      );
      // Version n of an asset: id md5(asset || n); every one but the last superseded by the next.
      await client.query(
        `INSERT INTO depreciation_schedule_version (id, mre_realm_id, asset_id, property_reference_id, version_number, status, superseded_by_id, superseded_at,
           from_year, through_year, computed_on, calculation_version, currency, asset_type, depreciation_method, building_completion_year, asset_review_state,
           asset_version, input_fingerprint, output_fingerprint, reason, recorded_by)
         SELECT md5(a.id::text || n)::uuid, a.mre_realm_id, a.id, a.property_reference_id, n, CASE WHEN n = $1 THEN 'CURRENT' ELSE 'SUPERSEDED' END,
           CASE WHEN n < $1 THEN md5(a.id::text || (n + 1))::uuid END, CASE WHEN n < $1 THEN now() END,
           2000, 2000 + $2 - 1, '2028-01-20', 1, 'EUR', 'BUILDING', 'LINEAR_7_4', 1995, 'CONFIRMED', 1, repeat('a', 64), repeat('b', 64), 'synthetisch', 'bulk'
         FROM depreciation_asset a, generate_series(1, $1::int) n WHERE a.created_by = 'bulk'`,
        [VERSIONS, YEARS],
      );
      await client.query(
        `INSERT INTO depreciation_schedule_version_component (version_id, mre_realm_id, property_reference_id, component_id, kind, position, basis_amount,
           start_date, start_date_source, start_method, start_month, rate_kind, source_type, source_id, classification_review_state, tax_category,
           item_date, item_date_source, item_tax_year)
         SELECT v.id, v.mre_realm_id, v.property_reference_id, 'ITEM:' || k, 'CAPITALIZED_ITEM', k, 1000, '2000-01-01', 'BOOKING_DATE', 'MONTH_OF_DATE',
           '2000-01-01', 'BAND', 'TRANSACTION_SPLIT', gen_random_uuid(), 'CONFIRMED', 'SYNTHETIC', '2000-01-01', 'BOOKING_DATE', 2000
         FROM depreciation_schedule_version v, generate_series(1, $1::int) k WHERE v.recorded_by = 'bulk'`,
        [COMPONENTS],
      );
      await client.query(
        `INSERT INTO depreciation_schedule_version_part (version_id, mre_realm_id, component_id, part_key, ownership_ids, share_numerator, share_denominator,
           weight_numerator, weight_denominator, basis_amount, first_month, rate_kind)
         SELECT version_id, mre_realm_id, component_id, 'NOT_OWNED', '{}', 1, 1, 1, 1, 1000, '2000-01-01', 'BAND' FROM depreciation_schedule_version_component`,
      );
      await client.query(
        `INSERT INTO depreciation_schedule_version_year (version_id, mre_realm_id, year, amount, residual_value, input_fingerprint, output_fingerprint)
         SELECT v.id, v.mre_realm_id, y, 30, 0, repeat('a', 64), repeat('b', 64)
         FROM depreciation_schedule_version v, generate_series(2000, 2000 + $1::int - 1) y WHERE v.recorded_by = 'bulk'`,
        [YEARS],
      );
      await client.query(
        `INSERT INTO depreciation_schedule_entry (version_id, mre_realm_id, year, component_id, part_key, months, amount, cumulative, residual_value)
         SELECT y.version_id, y.mre_realm_id, y.year, c.component_id, 'NOT_OWNED', 12, 10, 10 * (y.year - 1999), 1000 - 10 * (y.year - 1999)
         FROM depreciation_schedule_version_year y JOIN depreciation_schedule_version_component c USING (version_id)`,
      );
      // The successor key is deferred: checked now, so the guards can be enabled again in this transaction.
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      for (const table of ['depreciation_asset', ...VERSION_TABLES]) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      await client.query('COMMIT');
      for (const table of ['depreciation_asset', ...VERSION_TABLES]) await client.query(`ANALYZE ${table}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const entries = Number((await ctx.pool.query(`SELECT count(*) AS n FROM depreciation_schedule_entry`)).rows[0].n);
    expect(entries).toBe(ASSETS * VERSIONS * COMPONENTS * YEARS);
  });

  /** The plan of `query` (`ANALYZE`: run, so the actual rows are known). */
  const planOf = async (query: CompiledQuery) => {
    const { rows } = await ctx.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`, [...query.parameters]);
    return rows[0]['QUERY PLAN'][0].Plan as PlanNode;
  };
  /** The planner's total cost of `query` after `setup` (in a transaction rolled back after). */
  const costOf = async (query: CompiledQuery, setup: readonly string[] = []) => {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of setup) await client.query(statement);
      const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${query.sql}`, [...query.parameters]);
      return (rows[0]['QUERY PLAN'][0].Plan as PlanNode)['Total Cost'];
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };
  const NO_INDEX_SCANS = ['SET LOCAL enable_indexscan = off', 'SET LOCAL enable_bitmapscan = off', 'SET LOCAL enable_indexonlyscan = off'];

  /** Two records of ACC8's asset through a repository whose statements are captured: the second reads version 1 whole. */
  const capturedRecords = async () => {
    const sent: CompiledQuery[] = [];
    const logged = new Kysely<Database>({ dialect: new PostgresDialect({ pool: ctx.pool }), log: (e) => void (e.level === 'query' && sent.push(e.query)) });
    const versions = new PostgresScheduleVersionRepository(logged, new PostgresTaxClassificationRepository(logged).capitalizedSources, () => NOW);
    const { assetId } = await acc8();
    for (const throughYear of [2026, 2027]) {
      const request: RecordRequest = {
        reason: 'AfA laut Einkommensteuererklärung (synthetisch)',
        expectedInputFingerprint: await fingerprintOf(assetId, throughYear),
        acceptChangedYears: [],
        throughYear,
      };
      const outcome = await versions.record({
        assetId,
        mreRealmId: REALM,
        actor,
        decide: (read) => planRecord(read, request, { registry: TAX_RULES, fingerprinter: sha256Fingerprinter, today: TODAY, recordedBy: actor.actorId }),
      });
      expect(outcome.kind).toBe('RECORDED');
    }
    return sent;
  };

  it('the CURRENT lookup (the lock and the whole-version read) reads one row of depreciation_schedule_version_current, its predecessor probe at most one row; counter-check: the margin over the next-best plans', async () => {
    const sent = await capturedRecords();
    const lookups = sent.filter((q) => /status = 'CURRENT'/.test(q.sql));
    // Per record: the lock (FOR UPDATE) and the whole-version read; the second record finds version 1.
    expect(lookups.map((q) => q.sql.includes('FOR UPDATE'))).toEqual([true, false, true, false]);
    for (const query of lookups.slice(2)) {
      const plan = nodes(await planOf(query));
      expect(plan.map((n) => n['Node Type'])).not.toContain('Seq Scan');
      const [lookup, ...probes] = plan.filter((n) => n['Relation Name'] === 'depreciation_schedule_version');
      expect(lookup).toMatchObject({ 'Node Type': 'Index Scan', 'Index Name': 'depreciation_schedule_version_current', 'Actual Rows': 1, 'Actual Loops': 1 });
      // The whole-version read's predecessor (`supersedes_id`): one probe of an (asset_id, version_number) index.
      expect(probes).toHaveLength(query.sql.includes('FOR UPDATE') ? 0 : 1);
      for (const probe of probes) {
        expect(probe['Index Name']).toMatch(/^depreciation_schedule_version_(number_key|asset_idx)$/);
        expect(probe['Actual Rows'] * probe['Actual Loops']).toBeLessThanOrEqual(1);
      }
      for (const node of plan) expect(node['Rows Removed by Filter'] ?? 0).toBe(0);
    }
    // The margins (see the header): the wanted plan against the best one without the partial index, and a sequential scan.
    const margins = [];
    for (const query of lookups.slice(2)) {
      const wanted = await costOf(query);
      const withoutIndex = await costOf(query, ['DROP INDEX depreciation_schedule_version_current']);
      const sequential = await costOf(query, NO_INDEX_SCANS);
      margins.push({ withoutIndex: withoutIndex / wanted, sequential: sequential / wanted });
      console.info(`CURRENT lookup cost ${wanted}, without the partial index ${withoutIndex}, sequential ${sequential}`);
    }
    for (const margin of margins) {
      expect(margin.withoutIndex).toBeGreaterThanOrEqual(2);
      expect(margin.sequential).toBeGreaterThanOrEqual(10);
    }
  });

  it('the entry query reads exactly the version’s own entries from depreciation_schedule_entry_key; counter-check: the margin over the plan without it', async () => {
    const sent = await capturedRecords();
    const entryQueries = sent.filter((q) => q.sql.includes('FROM depreciation_schedule_entry'));
    expect(entryQueries.length).toBeGreaterThanOrEqual(2);
    for (const query of entryQueries) {
      const [ids] = query.parameters as [readonly string[]];
      const own = Number((await ctx.pool.query(`SELECT count(*) AS n FROM depreciation_schedule_entry WHERE version_id = ANY($1::uuid[])`, [ids])).rows[0].n);
      expect(own).toBeGreaterThan(0);
      const plan = nodes(await planOf(query));
      expect(plan.map((n) => n['Node Type'])).not.toContain('Seq Scan');
      const scans = plan.filter((n) => n['Relation Name'] === 'depreciation_schedule_entry' || n['Index Name'] === 'depreciation_schedule_entry_key');
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) {
        expect(['Index Scan', 'Bitmap Index Scan', 'Bitmap Heap Scan']).toContain(scan['Node Type']);
        if (scan['Node Type'] !== 'Bitmap Heap Scan') expect(scan['Index Name']).toBe('depreciation_schedule_entry_key');
        expect(scan['Actual Rows'] * scan['Actual Loops']).toBe(own);
        expect(scan['Rows Removed by Filter'] ?? 0).toBe(0);
        expect(scan['Rows Removed by Index Recheck'] ?? 0).toBe(0);
      }
    }
    // The margin (see the header): the wanted plan against the best one without the key.
    const read = entryQueries[0] as CompiledQuery;
    const wanted = await costOf(read);
    const withoutKey = await costOf(read, ['ALTER TABLE depreciation_schedule_entry DROP CONSTRAINT depreciation_schedule_entry_key']);
    console.info(`entry query cost ${wanted}, without depreciation_schedule_entry_key ${withoutKey}`);
    expect(withoutKey / wanted).toBeGreaterThanOrEqual(10);
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { withMigrationLock } from './depreciation-asset.test-support.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import {
  COMPARISON,
  COMPARISON_COLUMNS,
  REASON,
  createSchema,
  databaseUrl,
  rawRow,
  usePlausibilityDatabase,
} from './land-building-plausibility.test-support.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * Migration 0075 (VC-X-44, api-design.md §58T) past the repository: each CHECK 1–5 refuses its case, each with a
 * counter-check (the CHECK dropped in a rolled-back transaction, the same row accepted); the frozen trigger refuses a
 * change of each new column (counter-check: 0023's function, which does not list them, lets the change through); `down`
 * is refused while a row carries a comparison, then restores 0023's function verbatim (compared as text with 0023's
 * source) and drops the columns; `up` again. Synthetic rows only.
 */
const migration = migrations['0075_land_building_allocation_plausibility'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
const here = dirname(fileURLToPath(import.meta.url));
/** 0023's `land_building_allocation_frozen` body as its source writes it (the text between `AS $$` and `$$`). */
const body0023 = (() => {
  const source = readFileSync(join(here, 'migrations', '0023_land_building_allocation.ts'), 'utf8');
  const start = source.indexOf('CREATE FUNCTION land_building_allocation_frozen()');
  const open = source.indexOf('$$', start) + 2;
  return source.slice(open, source.indexOf('$$', open));
})();

describe.skipIf(databaseUrl === undefined)('the schema of 0075 (§58T)', () => {
  const { ctx, acquisition, entered, created } = usePlausibilityDatabase('allocation_plausibility_schema_test');

  /** The statement in a rolled-back transaction after `setup`: `accepted`, else the violated constraint or the SQLSTATE. */
  async function attempt(statement: string, setup: readonly string[] = []): Promise<string> {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of setup) await client.query(s);
      await client.query(statement);
      return 'accepted';
    } catch (error) {
      const e = error as { constraint?: string; code?: string };
      return e.constraint ?? e.code ?? 'unknown';
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  const drop = (constraint: string) => `ALTER TABLE land_building_allocation DROP CONSTRAINT ${constraint}`;

  it('the five columns are nullable and a row without them is accepted (no backfill: 0023 rows stay valid)', async () => {
    const { rows } = await ctx.pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'land_building_allocation' AND (column_name LIKE 'comparison%' OR column_name = 'deviation_reason')
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'comparison_building_value', data_type: 'numeric', is_nullable: 'YES' },
      { column_name: 'comparison_land_value', data_type: 'numeric', is_nullable: 'YES' },
      { column_name: 'comparison_method', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'comparison_source_references', data_type: 'ARRAY', is_nullable: 'YES' },
      { column_name: 'deviation_reason', data_type: 'text', is_nullable: 'YES' },
    ]);
    const a = await acquisition();
    expect(await attempt(rawRow(a))).toBe('accepted');
    expect(await attempt(rawRow(a, COMPARISON_COLUMNS))).toBe('accepted');
    expect(await attempt(rawRow(a, { ...COMPARISON_COLUMNS, deviation_reason: `'${REASON}'` }))).toBe('accepted');
  });

  it('CHECK 1 refuses an incomplete comparison (each column missing once); counter-check: dropped, accepted', async () => {
    const a = await acquisition();
    for (const missing of Object.keys(COMPARISON_COLUMNS)) {
      const row = rawRow(a, { ...COMPARISON_COLUMNS, [missing]: 'NULL' });
      expect(await attempt(row), missing).toBe('land_building_allocation_comparison_complete');
    }
    const only = rawRow(a, { comparison_method: `'BMF_TOOL'` });
    expect(await attempt(only)).toBe('land_building_allocation_comparison_complete');
    expect(await attempt(only, [drop('land_building_allocation_comparison_complete')])).toBe('accepted');
  });

  it('CHECK 2 refuses an unknown method; counter-check: dropped, accepted', async () => {
    const a = await acquisition();
    const row = rawRow(a, { ...COMPARISON_COLUMNS, comparison_method: `'PURCHASE_CONTRACT'` });
    expect(await attempt(row)).toBe('land_building_allocation_comparison_method');
    expect(await attempt(row, [drop('land_building_allocation_comparison_method')])).toBe('accepted');
    for (const method of ['BMF_TOOL', 'APPRAISAL', 'MARKET_VALUE', 'OTHER']) {
      expect(await attempt(rawRow(a, { ...COMPARISON_COLUMNS, comparison_method: `'${method}'` }))).toBe('accepted');
    }
  });

  it('CHECK 3 refuses a negative value, a third decimal, 1e18 and a zero sum; counter-check: dropped, accepted', async () => {
    const a = await acquisition();
    const cases = [
      { comparison_land_value: '-0.01' },
      { comparison_building_value: '-0.01' },
      { comparison_land_value: '0.001' },
      { comparison_building_value: '1e18' },
      { comparison_land_value: '0.00', comparison_building_value: '0.00' },
    ];
    for (const values of cases) {
      const row = rawRow(a, { ...COMPARISON_COLUMNS, ...values });
      expect(await attempt(row), JSON.stringify(values)).toBe('land_building_allocation_comparison_values');
      expect(await attempt(row, [drop('land_building_allocation_comparison_values')]), JSON.stringify(values)).toBe('accepted');
    }
    expect(await attempt(rawRow(a, { ...COMPARISON_COLUMNS, comparison_land_value: '0.00' }))).toBe('accepted');
  });

  it('CHECK 4 refuses no source and eleven sources; ten are accepted; counter-check: dropped, accepted', async () => {
    const a = await acquisition();
    const sources = (n: number) => (n === 0 ? `ARRAY[]::text[]` : `ARRAY[${Array.from({ length: n }, (_, i) => `'Quelle ${i + 1}'`).join(', ')}]`);
    for (const n of [0, 11]) {
      const row = rawRow(a, { ...COMPARISON_COLUMNS, comparison_source_references: sources(n) });
      expect(await attempt(row), String(n)).toBe('land_building_allocation_comparison_sources');
      expect(await attempt(row, [drop('land_building_allocation_comparison_sources')])).toBe('accepted');
    }
    expect(await attempt(rawRow(a, { ...COMPARISON_COLUMNS, comparison_source_references: sources(10) }))).toBe('accepted');
  });

  it('CHECK 5 refuses an empty reason, 2001 characters and a reason without comparison; counter-check: dropped, accepted', async () => {
    const a = await acquisition();
    const cases = [
      rawRow(a, { ...COMPARISON_COLUMNS, deviation_reason: `''` }),
      rawRow(a, { ...COMPARISON_COLUMNS, deviation_reason: `repeat('x', 2001)` }),
      rawRow(a, { deviation_reason: `'${REASON}'` }),
    ];
    for (const row of cases) {
      expect(await attempt(row)).toBe('land_building_allocation_deviation_reason');
      expect(await attempt(row, [drop('land_building_allocation_deviation_reason')])).toBe('accepted');
    }
    expect(await attempt(rawRow(a, { ...COMPARISON_COLUMNS, deviation_reason: `repeat('x', 2000)` }))).toBe('accepted');
  });

  it('the frozen trigger refuses a change of each new column; counter-check: under 0023 function the same update is accepted', async () => {
    const a = await acquisition();
    const row = await created(entered(a, null, { comparison: COMPARISON, deviationReason: REASON }));
    const updates = [
      `comparison_method = 'APPRAISAL'`,
      `comparison_land_value = 120000.01`,
      `comparison_building_value = 279999.99`,
      `comparison_source_references = ARRAY['andere Quelle']`,
      `deviation_reason = 'anders'`,
    ];
    const older = `CREATE OR REPLACE FUNCTION land_building_allocation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${body0023}$$`;
    for (const set of updates) {
      const update = `UPDATE land_building_allocation SET ${set} WHERE id = '${row.id}'`;
      expect(await attempt(update), set).toBe('23000');
      expect(await attempt(update, [older]), set).toBe('accepted');
    }
    // superseded_at stays the one step a row takes.
    expect(await attempt(`UPDATE land_building_allocation SET superseded_at = now() WHERE id = '${row.id}'`)).not.toBe('23000');
  });
});

describe.skipIf(databaseUrl === undefined)('the down of 0075 (§58T)', () => {
  it('refused while a row carries a comparison; then restores 0023 function verbatim and drops the columns; up again', { timeout: 120_000 }, async () => {
    const downSchema = testSchemaName('allocation_plausibility_down_test');
    await createSchema(downSchema);
    const down = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
    try {
      await migrateToLatest(down, { migrationTableSchema: downSchema });
      const db = () => createDatabase(down) as never;
      const prosrc = async () =>
        (
          await down.query(
            `SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1 AND proname = 'land_building_allocation_frozen'`,
            [downSchema],
          )
        ).rows[0].prosrc as string;
      const columns = async () =>
        Number(
          (
            await down.query(
              `SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'land_building_allocation' AND (column_name LIKE 'comparison%' OR column_name = 'deviation_reason')`,
              [downSchema],
            )
          ).rows[0].n,
        );
      // Counter-check of the text comparison: under 0075 the function differs from 0023's.
      expect(await prosrc()).not.toBe(body0023);
      // A row with a comparison, raw (a DRAFT Acquisition of its own).
      const pr = (
        await down.query(
          `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ('64b0c0ffee0000000000440a', '6512f0c2a1b2c3d4e5f44d01', 'ACTIVE', 'x') RETURNING id`,
        )
      ).rows[0].id as string;
      const acq = (
        await down.query(
          `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, economic_transfer_date, created_by)
           VALUES ('64b0c0ffee0000000000440a', $1, 'DRAFT', 400000, 'EUR', 1, 1, '2026-05-15', '2026-07-01', 'x') RETURNING id`,
          [pr],
        )
      ).rows[0].id as string;
      await down.query(rawRow(acq, COMPARISON_COLUMNS));
      let refused: unknown;
      await withMigrationLock(async () => {
        refused = await migration.down(db()).catch((e: unknown) => e);
      });
      expect(refused).toMatchObject({ code: '23514' });
      expect(await columns()).toBe(5);
      // Counter-check: the comparison removed (triggers off), down runs.
      await down.query(`ALTER TABLE land_building_allocation DISABLE TRIGGER USER`);
      await down.query(
        `UPDATE land_building_allocation SET comparison_method = NULL, comparison_land_value = NULL, comparison_building_value = NULL, comparison_source_references = NULL`,
      );
      await down.query(`ALTER TABLE land_building_allocation ENABLE TRIGGER USER`);
      await withMigrationLock(() => migration.down(db()));
      expect(await prosrc()).toBe(body0023);
      expect(await columns()).toBe(0);
      const constraints = await down.query(
        `SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE nspname = $1 AND (conname LIKE '%comparison%' OR conname LIKE '%deviation%')`,
        [downSchema],
      );
      expect(constraints.rows).toEqual([]);
      // The row of before is untouched by down.
      expect((await down.query(`SELECT land_amount::text AS land, building_amount::text AS building FROM land_building_allocation`)).rows).toEqual([
        { land: '40000.00', building: '360000.00' },
      ]);
      await withMigrationLock(() => migration.up(db()));
      expect(await columns()).toBe(5);
      expect(await prosrc()).not.toBe(body0023);
    } finally {
      await down.end();
    }
  });
});

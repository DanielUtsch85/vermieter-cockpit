import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { testSchemaName } from './test-schema.test-support.js';
import { databaseUrl, reasonOf, REALM, useTaxWegDatabase, withMigrationLock } from './tax-weg.test-support.js';

/**
 * Migration 0058 (VC-X-38, api-design.md §59F "In the database") past the repository, each guard with its counter-check:
 * the period both set and ordered, allowed only where §59F allows it, the points checked at commit (inside the period,
 * strictly ascending, the estimate flag exactly with points), inserted only by their classification's transaction and
 * never changed, the new columns frozen, the anschaffungsnahe link only with a performance in the window, `up` refused
 * with a recorded version and `down` with a stated performance. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('migration 0058: the period of performance on a classification (§59F)', () => {
  const { ctx, split, booked, propertyReference, acquisition } = useTaxWegDatabase('classification_performance_schema_test');
  const splitOf = async (date = '2027-05-14', code = 'MAINTENANCE') => {
    const pr = await propertyReference();
    const { splitIds } = await booked([split('1000.00', code, pr)], date);
    return { pr, splitId: splitIds[0] as string };
  };
  const columnsOf = (values: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      mre_realm_id: REALM,
      source_type: 'TRANSACTION_SPLIT',
      tax_category: 'MAINTENANCE',
      treatment: 'DEDUCTIBLE',
      review_state: 'USER_CONFIRMED',
      rule_code: 'DE_CATEGORY_DEFAULTS',
      rule_version: 1,
      created_by: 'x',
      ...values,
    };
    return { columns: Object.keys(row), values: Object.values(row) };
  };
  const insertSql = (columns: string[]) =>
    `INSERT INTO tax_classification (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`;
  /** One transaction: the classification and its points, committed; the id, or the refusal's reason. */
  const classify = async (values: Record<string, unknown>, points: readonly [string, string][] = []): Promise<string> => {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const { columns, values: params } = columnsOf(values);
      const id = (await client.query(insertSql(columns), params)).rows[0].id as string;
      for (const [i, [through, amount]] of points.entries()) {
        await client.query(`INSERT INTO tax_classification_performance_progress (classification_id, position, through, amount) VALUES ($1, $2, $3, $4)`, [
          id,
          i + 1,
          through,
          amount,
        ]);
      }
      await client.query('COMMIT');
      return id;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return reasonOf(error as { message?: string });
    } finally {
      client.release();
    }
  };
  const UUID = /^[0-9a-f-]{36}$/;
  /** The CHECKs alone: the guards (triggers) disabled inside a transaction that is rolled back. */
  const checkOnly = async (values: Record<string, unknown>): Promise<string> => {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE tax_classification DISABLE TRIGGER USER');
      const { columns, values: params } = columnsOf(values);
      await client.query(insertSql(columns), params);
      return 'accepted';
    } catch (error) {
      return reasonOf(error as { message?: string });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };

  it('the period: both set or both null, from not after until (23514); counter-check: a one-day period and none are accepted', async () => {
    const at = async (from: string | null, until: string | null) =>
      classify({ transaction_split_id: (await splitOf()).splitId, performed_from: from, performed_until: until });
    expect(await at('2027-05-01', null)).toBe('tax_classification_performance');
    expect(await at(null, '2027-05-01')).toBe('tax_classification_performance');
    expect(await at('2027-05-02', '2027-05-01')).toBe('tax_classification_performance');
    expect(await at('2027-05-01', '2027-05-01')).toMatch(UUID);
    expect(await at(null, null)).toMatch(UUID);
  });

  it('allowed only on MAINTENANCE/WEG_SPENDING or CAPITALIZED, never NOT_RELEVANT, interest or a deposit; counter-checks accepted', async () => {
    const at = async (taxCategory: string, treatment: string) =>
      classify({
        transaction_split_id: (await splitOf()).splitId,
        tax_category: taxCategory,
        treatment,
        performed_from: '2027-05-01',
        performed_until: '2027-05-10',
      });
    expect(await at('INSURANCE', 'DEDUCTIBLE')).toBe('tax_classification_performance_allowed');
    // Interest: §59E's guard refuses a CAPITALIZED interest line without a record first; the CHECK alone refuses it too.
    expect(await at('LOAN_INTEREST', 'CAPITALIZED')).not.toMatch(UUID);
    const period = { performed_from: '2027-05-01', performed_until: '2027-05-10', treatment: 'CAPITALIZED' };
    for (const taxCategory of ['LOAN_INTEREST', 'FINANCING_COSTS']) {
      expect(await checkOnly({ transaction_split_id: (await splitOf()).splitId, tax_category: taxCategory, ...period }), taxCategory).toBe(
        'tax_classification_performance_allowed',
      );
    }
    expect(await checkOnly({ transaction_split_id: (await splitOf()).splitId, tax_category: 'OTHER_EXPENSE', ...period })).toBe('accepted');
    expect(await at('NOT_RELEVANT', 'NOT_RELEVANT')).toBe('tax_classification_performance_allowed');
    expect(await at('INSURANCE', 'CAPITALIZED')).toMatch(UUID);
    expect(await at('MAINTENANCE', 'DEDUCTIBLE')).toMatch(UUID);
  });

  it('the points at commit: inside [from, until), ascending in date and amount, the estimate flag exactly with points; counter-check accepted', async () => {
    const at = async (points: [string, string][], estimated: boolean | null) =>
      classify(
        {
          transaction_split_id: (await splitOf()).splitId,
          performed_from: '2027-05-01',
          performed_until: '2027-05-31',
          performance_progress_estimated: estimated,
        },
        points,
      );
    const refused = '23000';
    expect(await at([['2027-04-30', '100.00']], false)).toBe(refused);
    expect(await at([['2027-05-31', '100.00']], false)).toBe(refused);
    expect(
      await at(
        [
          ['2027-05-10', '200.00'],
          ['2027-05-09', '300.00'],
        ],
        false,
      ),
    ).toBe(refused);
    expect(
      await at(
        [
          ['2027-05-10', '200.00'],
          ['2027-05-20', '200.00'],
        ],
        false,
      ),
    ).toBe(refused);
    expect(await at([], false)).toBe(refused);
    expect(await at([['2027-05-10', '200.00']], null)).toBe(refused);
    expect(await at([['2027-05-10', '0.00']], false)).toBe('tax_classification_performance_progress_amount_check');
    expect(
      await at(
        [
          ['2027-05-01', '200.00'],
          ['2027-05-30', '900.00'],
        ],
        true,
      ),
    ).toMatch(UUID);
  });

  it('a point added later, changed or deleted is refused; the new columns never change; created_txid never given; counter-check: a review step still writes', async () => {
    const { splitId } = await splitOf();
    const id = await classify(
      { transaction_split_id: splitId, performed_from: '2027-05-01', performed_until: '2027-05-31', performance_progress_estimated: false },
      [['2027-05-10', '100.00']],
    );
    expect(id).toMatch(UUID);
    const run = (sql: string, params: unknown[]) =>
      ctx.pool.query(sql, params).then(
        () => 'accepted',
        (e) => (e as { code: string }).code,
      );
    expect(
      await run(`INSERT INTO tax_classification_performance_progress (classification_id, position, through, amount) VALUES ($1, 2, '2027-05-20', 200)`, [id]),
    ).toBe('23000');
    expect(await run(`UPDATE tax_classification_performance_progress SET amount = 101 WHERE classification_id = $1`, [id])).toBe('23000');
    expect(await run(`DELETE FROM tax_classification_performance_progress WHERE classification_id = $1`, [id])).toBe('23000');
    for (const set of [
      `performed_until = '2027-06-30'`,
      `performed_from = NULL, performed_until = NULL`,
      `performance_progress_estimated = true`,
      `created_txid = 1`,
    ]) {
      expect(await run(`UPDATE tax_classification SET ${set} WHERE id = $1`, [id]), set).toBe('23000');
    }
    const { columns, values } = columnsOf({ transaction_split_id: (await splitOf()).splitId, created_txid: 1 });
    expect(await run(insertSql(columns), values)).toBe('23000');
    // Counter-check: the classification still takes its supersession (the frozen list leaves superseded_at alone).
    expect(await run(`UPDATE tax_classification SET review_state = 'NEEDS_REVIEW', version = version + 1 WHERE id = $1`, [id])).toBe('accepted');
  });

  it('the anschaffungsnahe link needs the performance wholly in the window; the booking date is never compared', async () => {
    const pr = await propertyReference();
    const acq = await acquisition(pr);
    const linked = async (date: string, from: string | null, until: string | null) => {
      const { splitIds } = await booked([split('100.00', 'MAINTENANCE', pr)], date);
      return classify({
        transaction_split_id: splitIds[0],
        treatment: 'CAPITALIZED',
        anschaffungsnahe_acquisition_id: acq,
        treatment_rule_code: 'DE_ANSCHAFFUNGSNAHE',
        treatment_rule_version: 1,
        performed_from: from,
        performed_until: until,
      });
    };
    expect(await linked('2027-05-14', null, null)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
    expect(await linked('2029-04-30', '2029-02-01', '2029-04-15')).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
    expect(await linked('2026-03-20', '2026-03-01', '2026-03-20')).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
    expect(await linked('2029-07-10', '2028-11-02', '2028-12-20')).toMatch(UUID);
    expect(await linked('2026-03-02', '2026-03-15', '2029-03-15')).toMatch(UUID);
  });

  it('up refused with a recorded version; down refused with a stated performance; counter-checks: both pass without', { timeout: 60_000 }, async () => {
    const schema = testSchemaName('classification_performance_down_test');
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
    const migration = migrations['0058_classification_performance'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
    const failure = async (step: 'up' | 'down') => {
      let error: unknown;
      await withMigrationLock(async () => {
        error = await migration[step](createDatabase(pool) as never).then(
          () => undefined,
          (e: unknown) => e,
        );
      });
      return (error as { code?: string } | undefined)?.code ?? 'accepted';
    };
    try {
      await migrateToLatest(pool, { migrationTableSchema: schema });
      // A stated performance on a classification row (written past the guards: they are not what is checked here).
      await pool.query(`ALTER TABLE tax_classification DISABLE TRIGGER USER`);
      await pool.query(`ALTER TABLE tax_classification DROP CONSTRAINT tax_classification_one_source`);
      await pool.query(
        `INSERT INTO tax_classification (mre_realm_id, source_type, tax_category, treatment, review_state, rule_code, rule_version, created_by, performed_from, performed_until)
         VALUES ($1, 'TRANSACTION_SPLIT', 'MAINTENANCE', 'DEDUCTIBLE', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x', '2027-05-01', '2027-05-10')`,
        [REALM],
      );
      expect(await failure('down')).toBe('23514');
      expect((await pool.query(`SELECT count(*)::int AS n FROM tax_classification WHERE performed_from IS NOT NULL`)).rows[0].n).toBe(1);
      await pool.query(`DELETE FROM tax_classification`);
      await pool.query(`ALTER TABLE tax_classification ENABLE TRIGGER USER`);
      expect(await failure('down')).toBe('accepted');
      const gone = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ('tax_classification', 'depreciation_schedule_version_component')
           AND column_name IN ('performed_from', 'item_performed_until', 'created_txid')`,
        [schema],
      );
      expect(gone.rows).toEqual([]);
      await pool.query(`ALTER TABLE depreciation_schedule_version DISABLE TRIGGER USER`);
      await pool.query(`ALTER TABLE depreciation_schedule_version DROP CONSTRAINT depreciation_schedule_version_asset_fk`);
      await pool.query(
        `INSERT INTO depreciation_schedule_version (mre_realm_id, asset_id, property_reference_id, version_number, status, from_year, through_year, computed_on,
           calculation_version, currency, asset_type, depreciation_method, asset_review_state, asset_version, input_fingerprint, output_fingerprint, reason, recorded_by)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), 1, 'CURRENT', 2026, 2026, '2028-01-20', 1, 'EUR', 'BUILDING', 'LINEAR_7_4', 'CONFIRMED', 1, repeat('a', 64), repeat('b', 64), 'x', 'x')`,
        [REALM],
      );
      expect(await failure('up')).toBe('23514');
      await pool.query(`DELETE FROM depreciation_schedule_version`);
      expect(await failure('up')).toBe('accepted');
    } finally {
      await pool.end();
    }
  });
});

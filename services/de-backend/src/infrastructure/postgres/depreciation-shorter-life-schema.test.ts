import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { PostgresDepreciationAssetRepository } from './depreciation-asset-repository.js';
import { REALM, codeOf, databaseUrl, useDepreciationAssetDatabase, withMigrationLock } from './depreciation-asset.test-support.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * Migration 0056 (VC-X-41 Part 1, api-design.md §59G "In the database") past the repository, each rule with its
 * counter-check: the Stichtag (`valuation_date`) stated by every row written from 0056 on (insert and update), the
 * release note 1–500; `up` leaving the rows stored before it `NULL` (never filled from `evidence_date`), read as "not
 * stated"; `up` refused with a recorded version, `down` refused with a stated Stichtag or release note. The recorded
 * component's CHECK is in `depreciation-schedule-version-schema.test.ts`. Synthetic.
 */
describe.skipIf(databaseUrl === undefined)('migration 0056: the Stichtag and the release note of a shorter useful life (§59G)', () => {
  const { ctx, propertyReference, acquisition, insertAsset, insertLife } = useDepreciationAssetDatabase('shorter_life_schema_test');
  const fixture = async () => {
    const pr = await propertyReference();
    const acquisitionId = await acquisition(pr);
    const assetId = (await insertAsset({ property_reference_id: pr })).rows[0].id as string;
    return { pr, acquisitionId, assetId };
  };

  it('an insert without a Stichtag is refused (23000); counter-check: with one it is accepted', async () => {
    const { pr, acquisitionId, assetId } = await fixture();
    expect(await codeOf(insertLife({ asset_id: assetId, property_reference_id: pr, acquisition_id: acquisitionId, valuation_date: null }))).toBe('23000');
    expect(await codeOf(insertLife({ asset_id: assetId, property_reference_id: pr, acquisition_id: acquisitionId }))).toBe('accepted');
  });

  it('an update clearing the Stichtag, or keeping a row without one, is refused (23000); counter-check: an update stating one is accepted', async () => {
    const { pr, acquisitionId, assetId } = await fixture();
    await insertLife({ asset_id: assetId, property_reference_id: pr, acquisition_id: acquisitionId });
    const update = (set: string) => codeOf(ctx.pool.query(`UPDATE depreciation_asset_useful_life SET ${set} WHERE asset_id = $1`, [assetId]));
    expect(await update('valuation_date = NULL')).toBe('23000');
    expect(await update(`valuation_date = '2026-05-20'`)).toBe('accepted');
    expect(await update(`useful_life_years = 31`)).toBe('accepted');
  });

  it('a release note of 0 or 501 characters is refused (23514); counter-check: 1 and 500 are accepted, NULL too', async () => {
    const { pr, acquisitionId, assetId } = await fixture();
    await insertLife({ asset_id: assetId, property_reference_id: pr, acquisition_id: acquisitionId });
    const note = (value: string | null) =>
      codeOf(ctx.pool.query(`UPDATE depreciation_asset_useful_life SET release_note = $2 WHERE asset_id = $1`, [assetId, value]));
    expect(await note('')).toBe('23514');
    expect(await note('x'.repeat(501))).toBe('23514');
    expect(await note('x')).toBe('accepted');
    expect(await note('x'.repeat(500))).toBe('accepted');
    expect(await note(null)).toBe('accepted');
  });

  it(
    'up keeps the rows stored before it without a Stichtag (never their document date), read as null; up refused with a recorded version, down with a stated row',
    { timeout: 60_000 },
    async () => {
      const schema = testSchemaName('shorter_life_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.end();
      const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
      const migration = migrations['0056_shorter_life_valuation_date'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
      const run = (step: 'up' | 'down') => withMigrationLock(() => migration[step](createDatabase(pool) as never));
      const failure = async (step: 'up' | 'down') => {
        let error: unknown;
        await withMigrationLock(async () => {
          error = await migration[step](createDatabase(pool) as never).then(
            () => undefined,
            (e: unknown) => e,
          );
        });
        return (error as { code?: string } | undefined)?.code;
      };
      try {
        await migrateToLatest(pool, { migrationTableSchema: schema });
        await run('down');
        // An entry as stored before 0056: its document date only.
        const { rows } = await pool.query(
          `WITH pr AS (INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by)
                        VALUES ($1, 'aaaaaaaaaaaaaaaaaaaa0056', 'ACTIVE', 'x') RETURNING id),
                acq AS (INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator,
                          acquired_share_denominator, contract_date, created_by)
                        SELECT $1, id, 'DRAFT', 1000, 'EUR', 1, 1, '2024-02-10', 'x' FROM pr RETURNING id, property_reference_id),
                asset AS (INSERT INTO depreciation_asset (mre_realm_id, property_reference_id, asset_type, status, depreciation_method, review_state,
                          building_completion_year, created_by)
                        SELECT $1, property_reference_id, 'BUILDING', 'ACTIVE', 'LINEAR_7_4', 'CONFIRMED', 1965, 'x' FROM acq RETURNING id, property_reference_id)
           INSERT INTO depreciation_asset_useful_life (asset_id, mre_realm_id, property_reference_id, acquisition_id, useful_life_years, evidence_source,
             evidence_date, evidence_document_reference, review_state)
           SELECT asset.id, $1, asset.property_reference_id, acq.id, 33, 'Gutachten (synthetisch)', '2024-06-01', NULL, 'CONFIRMED' FROM asset, acq
           RETURNING asset_id`,
          [REALM],
        );
        const assetId = rows[0].asset_id as string;
        await run('up');
        const stored = await pool.query(`SELECT valuation_date, release_note, to_char(evidence_date, 'YYYY-MM-DD') AS d FROM depreciation_asset_useful_life`);
        expect(stored.rows).toEqual([{ valuation_date: null, release_note: null, d: '2024-06-01' }]);
        const read = await new PostgresDepreciationAssetRepository(createDatabase(pool)).find(assetId, REALM);
        expect(read?.asset.shorterUsefulLives.map((e) => [e.evidence.date, e.evidence.valuationDate, e.releaseNote])).toEqual([['2024-06-01', null, null]]);

        // down refused while a row states a Stichtag (a person's statement is never dropped silently); the columns stay.
        await pool.query(`UPDATE depreciation_asset_useful_life SET valuation_date = '2024-05-01'`);
        expect(await failure('down')).toBe('23514');
        expect((await pool.query(`SELECT count(*)::int AS n FROM depreciation_asset_useful_life WHERE valuation_date IS NOT NULL`)).rows[0].n).toBe(1);
        // Counter-check: without a stated row, down passes; with a recorded version, up is refused.
        await pool.query(`DELETE FROM depreciation_asset_useful_life`);
        await run('down');
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
        await run('up');
        const columns = await pool.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name IN ('valuation_date', 'release_note', 'shorter_life_valuation_date') ORDER BY 1`,
          [schema],
        );
        expect(columns.rows.map((r) => r.column_name)).toEqual(['release_note', 'shorter_life_valuation_date', 'valuation_date']);
      } finally {
        await pool.end();
      }
    },
  );
});

/**
 * Migration 0059 (§59G, Entscheidung des Projektinhabers, 2026-11-02, 238-5) past the repository: a Stichtag never lies
 * after its evidence's date (equal is allowed, `NULL` is not judged); `up` refused while a row already states one after
 * it, `down` drops the constraint. Synthetic.
 */
describe.skipIf(databaseUrl === undefined)('migration 0059: the Stichtag not after the evidence date (§59G, 238-5)', () => {
  const { ctx, propertyReference, acquisition, insertAsset, insertLife } = useDepreciationAssetDatabase('shorter_life_not_after_test');
  const fixture = async () => {
    const pr = await propertyReference();
    const acquisitionId = await acquisition(pr);
    const assetId = (await insertAsset({ property_reference_id: pr })).rows[0].id as string;
    return { pr, acquisitionId, assetId };
  };

  it('an insert with a Stichtag one day after the evidence date is refused (23514); counter-check: the same day and the day before are accepted', async () => {
    const life = async (valuationDate: string) => {
      const { pr, acquisitionId, assetId } = await fixture();
      return codeOf(
        insertLife({ asset_id: assetId, property_reference_id: pr, acquisition_id: acquisitionId, evidence_date: '2026-06-15', valuation_date: valuationDate }),
      );
    };
    expect(await life('2026-06-16')).toBe('23514');
    expect(await life('2026-06-15')).toBe('accepted');
    expect(await life('2026-06-14')).toBe('accepted');
  });

  it('an update moving the Stichtag after the evidence date, or the evidence date before it, is refused (23514); counter-check: a move to the same day is accepted', async () => {
    const { pr, acquisitionId, assetId } = await fixture();
    await insertLife({
      asset_id: assetId,
      property_reference_id: pr,
      acquisition_id: acquisitionId,
      evidence_date: '2026-06-15',
      valuation_date: '2026-05-01',
    });
    const update = (set: string) => codeOf(ctx.pool.query(`UPDATE depreciation_asset_useful_life SET ${set} WHERE asset_id = $1`, [assetId]));
    expect(await update(`valuation_date = '2026-06-16'`)).toBe('23514');
    expect(await update(`evidence_date = '2026-04-30'`)).toBe('23514');
    expect(await update(`valuation_date = '2026-06-15'`)).toBe('accepted');
    expect(await update(`evidence_date = '2026-06-15', valuation_date = '2026-06-15'`)).toBe('accepted');
  });

  it(
    'a row without a Stichtag (stored before 0056) is not judged; up refused while a row states one after its date; down drops the constraint',
    { timeout: 60_000 },
    async () => {
      const schema = testSchemaName('shorter_life_not_after_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.end();
      const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
      const migration = migrations['0059_shorter_life_valuation_not_after_evidence'] as {
        up: (db: never) => Promise<void>;
        down: (db: never) => Promise<void>;
      };
      const run = (step: 'up' | 'down') => withMigrationLock(() => migration[step](createDatabase(pool) as never));
      const upFailure = async () => {
        let error: unknown;
        await withMigrationLock(async () => {
          error = await migration.up(createDatabase(pool) as never).then(
            () => undefined,
            (e: unknown) => e,
          );
        });
        const e = error as { code?: string; message?: string } | undefined;
        return [e?.code, e?.message?.includes('needs it amended first') ?? false];
      };
      const constraint = async () =>
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
            WHERE nspname = $1 AND conname = 'depreciation_asset_useful_life_valuation_not_after_evidence'`,
            [schema],
          )
        ).rows[0].n as number;
      try {
        await migrateToLatest(pool, { migrationTableSchema: schema });
        expect(await constraint()).toBe(1);
        await run('down');
        expect(await constraint()).toBe(0);
        const { rows } = await pool.query(
          `WITH pr AS (INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by)
                      VALUES ($1, 'aaaaaaaaaaaaaaaaaaaa0059', 'ACTIVE', 'x') RETURNING id),
              acq AS (INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator,
                        acquired_share_denominator, contract_date, created_by)
                      SELECT $1, id, 'DRAFT', 1000, 'EUR', 1, 1, '2024-02-10', 'x' FROM pr RETURNING id, property_reference_id),
              asset AS (INSERT INTO depreciation_asset (mre_realm_id, property_reference_id, asset_type, status, depreciation_method, review_state,
                        building_completion_year, created_by)
                      SELECT $1, property_reference_id, 'BUILDING', 'ACTIVE', 'LINEAR_7_4', 'CONFIRMED', 1965, 'x' FROM acq RETURNING id, property_reference_id)
         INSERT INTO depreciation_asset_useful_life (asset_id, mre_realm_id, property_reference_id, acquisition_id, useful_life_years, evidence_source,
           evidence_date, valuation_date, evidence_document_reference, review_state)
         SELECT asset.id, $1, asset.property_reference_id, acq.id, 33, 'Gutachten (synthetisch)', '2024-06-01', '2024-06-02', NULL, 'CONFIRMED' FROM asset, acq
         RETURNING asset_id`,
          [REALM],
        );
        const assetId = rows[0].asset_id as string;
        // A Stichtag after its date, written while the constraint was down: up refuses, the row unchanged, no constraint.
        expect(await upFailure()).toEqual(['23514', true]);
        expect(await constraint()).toBe(0);
        const stored = await pool.query(`SELECT to_char(valuation_date, 'YYYY-MM-DD') AS v FROM depreciation_asset_useful_life WHERE asset_id = $1`, [assetId]);
        expect(stored.rows).toEqual([{ v: '2024-06-02' }]);
        // Counter-check: amended to the same day, up passes; a row without a Stichtag (as stored before 0056) is not judged.
        await pool.query(`UPDATE depreciation_asset_useful_life SET valuation_date = '2024-06-01' WHERE asset_id = $1`, [assetId]);
        await run('up');
        expect(await constraint()).toBe(1);
        await pool.query(`ALTER TABLE depreciation_asset_useful_life DISABLE TRIGGER depreciation_asset_useful_life_valuation_date`);
        expect(await codeOf(pool.query(`UPDATE depreciation_asset_useful_life SET valuation_date = NULL WHERE asset_id = $1`, [assetId]))).toBe('accepted');
        await pool.query(`ALTER TABLE depreciation_asset_useful_life ENABLE TRIGGER depreciation_asset_useful_life_valuation_date`);
      } finally {
        await pool.end();
      }
    },
  );
});

import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import {
  OTHER_REALM,
  codeOf,
  databaseUrl,
  messageOf,
  useDepreciationAssetDatabase,
  withMigrationLock,
  type Queryable,
} from './depreciation-asset.test-support.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-8-01's schema (api-design.md §59, migration 0049) past the repository, each rule with its counter-check, and
 * `up`/`down`. The commands, reads and concurrency are in `depreciation-asset-repository.test.ts`, the setup in
 * `depreciation-asset.test-support.ts`. Figures, names and texts are synthetic.
 */
describe.skipIf(databaseUrl === undefined)('PostgresDepreciationAssetRepository: the schema (0049)', () => {
  const { ctx, schema, propertyReference, party, acquisition, cancel, insertAsset, insertLife } = useDepreciationAssetDatabase('depreciation_schema_test');
  let pool: pg.Pool;
  beforeAll(() => {
    ({ pool } = ctx);
  });

  describe('the schema past the repository (0049), each with its counter-check', () => {
    it('a second ACTIVE building for one PropertyReference is 23505; after a void a new one is allowed', async () => {
      const pr = await propertyReference();
      const { rows } = await insertAsset({ property_reference_id: pr });
      expect(await codeOf(insertAsset({ property_reference_id: pr }))).toBe('23505');
      await pool.query(`UPDATE depreciation_asset SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [
        rows[0].id,
      ]);
      expect(await codeOf(insertAsset({ property_reference_id: pr }))).toBe('accepted');
    });

    it('a foreign PropertyReference, advisor or Acquisition (composite keys) is 23503; the same of this Realm is accepted', async () => {
      const pr = await propertyReference();
      const foreignPr = await propertyReference(OTHER_REALM);
      const foreignParty = await party('Fremd', OTHER_REALM);
      const ownParty = await party();
      expect(await codeOf(insertAsset({ property_reference_id: foreignPr }))).toBe('23503');
      expect(
        await codeOf(
          insertAsset({ property_reference_id: pr, review_state: 'ADVISOR_CONFIRMED', building_completion_year: 1995, advisor_party_id: foreignParty }),
        ),
      ).toBe('23503');
      const { rows } = await insertAsset({
        property_reference_id: pr,
        review_state: 'ADVISOR_CONFIRMED',
        building_completion_year: 1995,
        advisor_party_id: ownParty,
      });
      const asset = rows[0].id as string;
      const foreignAcquisition = await acquisition(foreignPr, OTHER_REALM);
      expect(await codeOf(insertLife({ asset_id: asset, property_reference_id: pr, acquisition_id: foreignAcquisition }))).toBe('23503');
      expect(
        await codeOf(
          insertLife({
            asset_id: asset,
            property_reference_id: pr,
            acquisition_id: await acquisition(pr),
            review_state: 'ADVISOR_CONFIRMED',
            advisor_party_id: foreignParty,
          }),
        ),
      ).toBe('23503');
      expect(await codeOf(insertLife({ asset_id: asset, property_reference_id: pr, acquisition_id: await acquisition(pr) }))).toBe('accepted');
    });

    it("an entry naming another property's Acquisition is 23503, past the repository too", async () => {
      const pr = await propertyReference();
      const otherPr = await propertyReference();
      const asset = (await insertAsset({ property_reference_id: pr })).rows[0].id as string;
      const elsewhere = await acquisition(otherPr);
      expect(await codeOf(insertLife({ asset_id: asset, property_reference_id: pr, acquisition_id: elsewhere }))).toBe('23503');
      // Nor by naming the other PropertyReference on the row: the asset's key holds it.
      expect(await codeOf(insertLife({ asset_id: asset, property_reference_id: otherPr, acquisition_id: elsewhere }))).toBe('23503');
    });

    it('CONFIRMED without a year, an advisor without ADVISOR_CONFIRMED (asset and entry) are 23514; with the year, or the state, accepted', async () => {
      const pr = await propertyReference();
      const advisor = await party();
      expect(await codeOf(insertAsset({ property_reference_id: pr, review_state: 'CONFIRMED' }))).toBe('23514');
      expect(await codeOf(insertAsset({ property_reference_id: pr, review_state: 'ADVISOR_CONFIRMED' }))).toBe('23514');
      expect(
        await codeOf(insertAsset({ property_reference_id: pr, review_state: 'CONFIRMED', building_completion_year: 1995, advisor_party_id: advisor })),
      ).toBe('23514');
      const asset = (await insertAsset({ property_reference_id: pr, review_state: 'CONFIRMED', building_completion_year: 1995 })).rows[0].id as string;
      expect(
        await codeOf(
          insertLife({
            asset_id: asset,
            property_reference_id: pr,
            acquisition_id: await acquisition(pr),
            review_state: 'CONFIRMED',
            advisor_party_id: advisor,
          }),
        ),
      ).toBe('23514');
      expect(
        await codeOf(
          insertLife({
            asset_id: asset,
            property_reference_id: pr,
            acquisition_id: await acquisition(pr),
            review_state: 'ADVISOR_CONFIRMED',
            advisor_party_id: advisor,
          }),
        ),
      ).toBe('accepted');
      expect(await codeOf(insertAsset({ property_reference_id: await propertyReference(), building_completion_year: 999 }))).toBe('23514');
      expect(await codeOf(insertLife({ asset_id: asset, property_reference_id: pr, acquisition_id: await acquisition(pr), useful_life_years: 100 }))).toBe(
        '23514',
      );
    });

    it('a fixed field, a VOID row, a missing version step, a delete are refused; a change with version + 1 is accepted', async () => {
      const pr = await propertyReference();
      const asset = (await insertAsset({ property_reference_id: pr })).rows[0].id as string;
      expect(
        await codeOf(
          pool.query(`UPDATE depreciation_asset SET property_reference_id = $2, version = version + 1 WHERE id = $1`, [asset, await propertyReference()]),
        ),
      ).toBe('23000');
      expect(
        await codeOf(pool.query(`UPDATE depreciation_asset SET created_at = now() - interval '1 day', version = version + 1 WHERE id = $1`, [asset])),
      ).toBe('23000');
      expect(await codeOf(pool.query(`UPDATE depreciation_asset SET notes = 'x' WHERE id = $1`, [asset]))).toBe('23000');
      expect(await codeOf(pool.query(`UPDATE depreciation_asset SET notes = 'x', version = version + 2 WHERE id = $1`, [asset]))).toBe('23000');
      expect(await codeOf(pool.query(`UPDATE depreciation_asset SET notes = 'x', version = version + 1 WHERE id = $1`, [asset]))).toBe('accepted');
      // The no-op write passes.
      expect(await codeOf(pool.query(`UPDATE depreciation_asset SET version = version WHERE id = $1`, [asset]))).toBe('accepted');
      expect(await codeOf(pool.query(`DELETE FROM depreciation_asset WHERE id = $1`, [asset]))).toBe('23000');
      expect(
        await codeOf(
          pool.query(`UPDATE depreciation_asset SET status = 'VOID', voided_at = now(), void_reason = 'x', notes = 'y', version = version + 1 WHERE id = $1`, [
            asset,
          ]),
        ),
      ).toBe('23000');
      expect(
        await codeOf(
          pool.query(`UPDATE depreciation_asset SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [asset]),
        ),
      ).toBe('accepted');
      expect(await codeOf(pool.query(`UPDATE depreciation_asset SET notes = 'z', version = version + 1 WHERE id = $1`, [asset]))).toBe('23000');
      expect(
        await codeOf(
          pool.query(`UPDATE depreciation_asset SET status = 'ACTIVE', voided_at = NULL, void_reason = NULL, version = version + 1 WHERE id = $1`, [asset]),
        ),
      ).toBe('23000');
      // Only inserted ACTIVE with version 1.
      expect(await codeOf(insertAsset({ property_reference_id: await propertyReference(), version: 2 }))).toBe('23000');
      expect(await codeOf(insertAsset({ property_reference_id: await propertyReference(), status: 'VOID', voided_at: new Date(), void_reason: 'x' }))).toBe(
        '23000',
      );
    });

    it('an entry on a VOID asset, or a new one for a CANCELLED Acquisition, is refused; on an ACTIVE asset for a DRAFT accepted', async () => {
      const pr = await propertyReference();
      const asset = (await insertAsset({ property_reference_id: pr })).rows[0].id as string;
      const draft = await acquisition(pr);
      const cancelled = await acquisition(pr);
      await cancel(cancelled);
      expect(await messageOf(insertLife({ asset_id: asset, property_reference_id: pr, acquisition_id: cancelled }))).toContain('ACQUISITION_CANCELLED');
      expect(await codeOf(insertLife({ asset_id: asset, property_reference_id: pr, acquisition_id: draft }))).toBe('accepted');
      // An existing entry may still change once its Acquisition is cancelled (the amend's difference), and never move.
      await cancel(draft);
      expect(await codeOf(pool.query(`UPDATE depreciation_asset_useful_life SET review_state = 'NEEDS_REVIEW' WHERE asset_id = $1`, [asset]))).toBe('accepted');
      expect(await codeOf(pool.query(`UPDATE depreciation_asset_useful_life SET acquisition_id = $2 WHERE asset_id = $1`, [asset, cancelled]))).toBe('23000');
      await pool.query(`UPDATE depreciation_asset SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [asset]);
      expect(await messageOf(insertLife({ asset_id: asset, property_reference_id: pr, acquisition_id: await acquisition(pr) }))).toContain('ASSET_NOT_ACTIVE');
      expect(await messageOf(pool.query(`UPDATE depreciation_asset_useful_life SET review_state = 'UNREVIEWED' WHERE asset_id = $1`, [asset]))).toContain(
        'ASSET_NOT_ACTIVE',
      );
      expect(await messageOf(pool.query(`DELETE FROM depreciation_asset_useful_life WHERE asset_id = $1`, [asset]))).toContain('ASSET_NOT_ACTIVE');
    });

    it('the table has no basis, rate, start or amount column (information_schema); counter-check: one added is seen', async () => {
      // 0051 (§59B) adds `useful_life_basis`, the legal or factual basis of a useful life (a text), and `acquired_on`, the
      // date of a separate asset's acquisition (a fact): neither is a derived figure. Every other match stays forbidden.
      const forbidden = async (q: Queryable) =>
        (
          await q.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'depreciation_asset' AND column_name ~ '(basis|rate|start|amount|allocation|rule|acquisition|cost)'
                AND column_name <> 'useful_life_basis'
              ORDER BY column_name`,
            [schema],
          )
        ).rows.map((r) => r.column_name as string);
      expect(await forbidden(pool)).toEqual([]);
      const columns = (
        await pool.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'depreciation_asset' ORDER BY ordinal_position`,
          [schema],
        )
      ).rows.map((r) => r.column_name as string);
      expect(columns).toEqual([
        'id',
        'mre_realm_id',
        'property_reference_id',
        'asset_type',
        'status',
        'building_completion_year',
        'source_references',
        'depreciation_method',
        'review_state',
        'advisor_party_id',
        'notes',
        'voided_at',
        'void_reason',
        'created_at',
        'created_by',
        'version',
        // 0051 (§59B): a separate asset's facts.
        'description',
        'useful_life_years',
        'useful_life_basis',
        'acquired_on',
      ]);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE depreciation_asset ADD COLUMN basis_amount numeric`);
        expect(await forbidden(client)).toEqual(['basis_amount']);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  it('0049: up creates both tables; down drops them and their functions, nothing else (under MIGRATION_ADVISORY_LOCK)', { timeout: 30_000 }, async () => {
    const downSchema = testSchemaName('depreciation_down_test');
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${downSchema}"`);
    await admin.end();
    const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
    try {
      // Up to 0050: 0051 (§59B) adds a table with a foreign key to `depreciation_asset`, so its own `down` runs first.
      await migrateToLatest(downPool, {
        migrations: Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0051')),
        migrationTableSchema: downSchema,
      });
      const tablesOf = async () =>
        (
          await downPool.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'depreciation_asset%' ORDER BY table_name`,
            [downSchema],
          )
        ).rows.map((r) => r.table_name as string);
      const functionsOf = async () =>
        (
          await downPool.query(
            `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname LIKE 'depreciation_asset%' ORDER BY p.proname`,
            [downSchema],
          )
        ).rows.map((r) => r.proname as string);
      const columnsOf = async (table: string) =>
        (await downPool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [downSchema, table]))
          .rows[0].n as number;
      expect(await tablesOf()).toEqual(['depreciation_asset', 'depreciation_asset_useful_life']);
      expect(await functionsOf()).toEqual([
        'depreciation_asset_frozen',
        'depreciation_asset_initial',
        'depreciation_asset_texts_valid',
        'depreciation_asset_touch',
        'depreciation_asset_useful_life_open',
      ]);
      const untouched = ['acquisition', 'property_reference', 'land_building_allocation', 'ledger_transaction', 'transaction_split'];
      const before = await Promise.all(untouched.map(columnsOf));
      const migration = await import('./migrations/0049_depreciation_asset.js');
      await withMigrationLock(() => migration.down(createDatabase(downPool) as never));
      expect(await tablesOf()).toEqual([]);
      expect(await functionsOf()).toEqual([]);
      expect(await Promise.all(untouched.map(columnsOf))).toEqual(before);
      await withMigrationLock(() => migration.up(createDatabase(downPool) as never));
      expect(await tablesOf()).toEqual(['depreciation_asset', 'depreciation_asset_useful_life']);
    } finally {
      await downPool.end();
    }
  });
});

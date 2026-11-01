import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { codeOf, withMigrationLock } from './depreciation-asset.test-support.js';
import { OTHER_REALM, REALM, VERSION_TABLES, actor, databaseUrl, useScheduleVersionDatabase } from './depreciation-schedule-version.test-support.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/** §59C (0053): a purchase component's method entry, a confirmed STANDARD one (its CHECK). */
const METHOD_COLUMNS = `method_consideration, method, method_special_depreciation, method_subsidies_received, method_new_building_by_conversion,
             method_other_special_case, method_review_state`;
const METHOD_VALUES = `'PAID', 'LINEAR_7_4', '{}', false, false, false, 'CONFIRMED'`;

/**
 * Migration 0052 past the repository (api-design.md §60 "In the database"), each with a counter-check: every child row
 * append-only, a version changed only by the supersede step, never deleted; one `CURRENT` per asset; child rows only from
 * the version's own transaction (never `xmin`: an append to the version just superseded is refused); `created_txid`
 * never given; a version only on an `ACTIVE`, confirmed asset with the next number; the chain checked at commit; the
 * composite keys (another Realm's asset, party, allocation and classification, another PropertyReference's purchase);
 * `up` and `down` under `MIGRATION_ADVISORY_LOCK`, `down` refused with a version present.
 */
describe.skipIf(databaseUrl === undefined)('migration 0052 past the repository (§60)', () => {
  const { ctx, acc8, record, party } = useScheduleVersionDatabase('schedule_version_schema_test');
  const versionOf = async (throughYear = 2026) => {
    const fixture = await acc8();
    const outcome = await record(fixture.assetId, { throughYear });
    if (outcome.kind !== 'RECORDED') throw new Error(outcome.kind);
    return { ...fixture, version: outcome.version };
  };
  /** Runs `statements` in one transaction on one client; the SQLSTATE of the first failure, or `accepted`. */
  const inTransaction = async (statements: (client: pg.PoolClient) => Promise<unknown>) => {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await statements(client);
      await client.query('COMMIT');
      return 'accepted';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return (error as { code?: string }).code;
    } finally {
      client.release();
    }
  };

  it('every child row is append-only: an UPDATE or DELETE of each refused; counter-check: the header’s supersede step passes the guard', async () => {
    const { version } = await versionOf();
    for (const table of VERSION_TABLES.slice(1)) {
      expect([table, await codeOf(ctx.pool.query(`UPDATE ${table} SET version_id = version_id WHERE version_id = $1`, [version.versionId]))]).toEqual([
        table,
        '23000',
      ]);
      expect([table, await codeOf(ctx.pool.query(`DELETE FROM ${table} WHERE version_id = $1`, [version.versionId]))]).toEqual([table, '23000']);
    }
    expect(await codeOf(ctx.pool.query(`DELETE FROM depreciation_schedule_version WHERE id = $1`, [version.versionId]))).toBe('23000');
    expect(await codeOf(ctx.pool.query(`UPDATE depreciation_schedule_version SET reason = 'anders' WHERE id = $1`, [version.versionId]))).toBe('23000');
    expect(await codeOf(ctx.pool.query(`UPDATE depreciation_schedule_version SET created_txid = created_txid + 1 WHERE id = $1`, [version.versionId]))).toBe(
      '23000',
    );
  });

  it('child rows only in the version’s own transaction: a later insert refused, and an append to the version superseded in the same transaction refused (not xmin)', async () => {
    const { version, assetId, pr } = await versionOf();
    const later = ctx.pool.query(`INSERT INTO depreciation_schedule_version_year VALUES ($1, $2, 2030, 0, 0, repeat('a', 64), repeat('b', 64))`, [
      version.versionId,
      REALM,
    ]);
    expect(await codeOf(later)).toBe('23000');
    const supersedeAndAppend = (appendTo: 'OLD' | 'NEW') =>
      inTransaction(async (client) => {
        const next = (await client.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
        await client.query(
          `UPDATE depreciation_schedule_version SET status = 'SUPERSEDED', superseded_by_id = $1, superseded_at = now(), version = 2 WHERE id = $2`,
          [next, version.versionId],
        );
        await client.query(
          `INSERT INTO depreciation_schedule_version (id, mre_realm_id, asset_id, property_reference_id, version_number, status, from_year, through_year, computed_on,
             calculation_version, currency, asset_type, depreciation_method, building_completion_year, asset_review_state, asset_version, input_fingerprint, output_fingerprint, reason, recorded_by)
           VALUES ($1, $2, $3, $4, 2, 'CURRENT', 2026, 2026, '2028-01-20', 1, 'EUR', 'BUILDING', 'LINEAR_7_4', 1995, 'CONFIRMED', 1, repeat('a', 64), repeat('b', 64), 'x', 'x')`,
          [next, REALM, assetId, pr],
        );
        await client.query(`INSERT INTO depreciation_schedule_version_year VALUES ($1, $2, 2031, 0, 0, repeat('a', 64), repeat('b', 64))`, [
          appendTo === 'OLD' ? version.versionId : next,
          REALM,
        ]);
        await client.query('ROLLBACK');
        throw Object.assign(new Error('rolled back on purpose'), { code: 'accepted' });
      });
    expect(await supersedeAndAppend('OLD')).toBe('23000');
    // Counter-check: the new version's own rows in the same transaction are accepted.
    expect(await supersedeAndAppend('NEW')).toBe('accepted');
  });

  it('one CURRENT version per asset (23505); a gap in version_number, a VOID or unconfirmed asset, a given created_txid refused; a supersede without its successor fails at commit', async () => {
    const { version, assetId, pr } = await versionOf();
    const insert = (client: Pick<pg.PoolClient, 'query'>, extra: { number?: number; txid?: string } = {}) =>
      client.query(
        `INSERT INTO depreciation_schedule_version (mre_realm_id, asset_id, property_reference_id, version_number, status, from_year, through_year, computed_on,
           calculation_version, currency, asset_type, depreciation_method, building_completion_year, asset_review_state, asset_version, input_fingerprint, output_fingerprint, reason, recorded_by
           ${extra.txid === undefined ? '' : ', created_txid'})
         VALUES ($1, $2, $3, $4, 'CURRENT', 2026, 2026, '2028-01-20', 1, 'EUR', 'BUILDING', 'LINEAR_7_4', 1995, 'CONFIRMED', 1, repeat('a', 64), repeat('b', 64), 'x', 'x'
           ${extra.txid === undefined ? '' : `, ${extra.txid}`})`,
        [REALM, assetId, pr, extra.number ?? version.versionNumber + 1],
      );
    expect(await codeOf(insert(ctx.pool))).toBe('23505');
    expect(await codeOf(insert(ctx.pool, { number: 3 }))).toBe('23000');
    expect(await inTransaction(async (client) => insert(client, { number: 2, txid: '1' }))).toBe('23000');
    expect(
      await inTransaction((client) =>
        client.query(
          `UPDATE depreciation_schedule_version SET status = 'SUPERSEDED', superseded_by_id = gen_random_uuid(), superseded_at = now(), version = 2 WHERE id = $1`,
          [version.versionId],
        ),
      ),
    ).toBe('23503');
    const unconfirmed = await acc8(REALM, 'UNREVIEWED');
    expect(
      await codeOf(
        ctx.pool.query(
          `INSERT INTO depreciation_schedule_version (mre_realm_id, asset_id, property_reference_id, version_number, status, from_year, through_year, computed_on,
             calculation_version, currency, asset_type, depreciation_method, building_completion_year, asset_review_state, asset_version, input_fingerprint, output_fingerprint, reason, recorded_by)
           VALUES ($1, $2, $3, 1, 'CURRENT', 2026, 2026, '2028-01-20', 1, 'EUR', 'BUILDING', 'LINEAR_7_4', 1995, 'CONFIRMED', 1, repeat('a', 64), repeat('b', 64), 'x', 'x')`,
          [REALM, unconfirmed.assetId, unconfirmed.pr],
        ),
      ),
    ).toBe('23000');
  });

  it('the composite keys: another Realm’s asset, and a component naming another PropertyReference’s purchase, are refused', async () => {
    const mine = await versionOf();
    const theirs = await acc8(OTHER_REALM);
    expect(
      await codeOf(
        ctx.pool.query(
          `INSERT INTO depreciation_schedule_version (mre_realm_id, asset_id, property_reference_id, version_number, status, from_year, through_year, computed_on,
             calculation_version, currency, asset_type, depreciation_method, building_completion_year, asset_review_state, asset_version, input_fingerprint, output_fingerprint, reason, recorded_by)
           VALUES ($1, $2, $3, 1, 'CURRENT', 2026, 2026, '2028-01-20', 1, 'EUR', 'BUILDING', 'LINEAR_7_4', 1995, 'CONFIRMED', 1, repeat('a', 64), repeat('b', 64), 'x', 'x')`,
          [REALM, theirs.assetId, theirs.pr],
        ),
      ),
    ).toBe('23503');
    const other = await acc8();
    // A component whose property_reference_id differs from the header's, and one equal to it naming another property's purchase.
    const component = (pr: string, acquisitionId: string) =>
      inTransaction(async (client) => {
        await client.query(`ALTER TABLE depreciation_schedule_version_component DISABLE TRIGGER depreciation_schedule_version_component_append_only`);
        await client.query(
          `INSERT INTO depreciation_schedule_version_component (version_id, mre_realm_id, property_reference_id, component_id, kind, position, basis_amount, start_date,
             start_date_source, start_method, start_month, rate_kind, acquisition_id, purchase_price, counted_cost_ids, counted_costs_total, excluded_cost_ids,
             excluded_costs_total, allocation_id, allocation_review_state, total_allocable_amount, building_amount, ${METHOD_COLUMNS})
           VALUES ($1, $2, $3, 'ACQUISITION:x', 'ACQUISITION', 9, 1, '2026-07-01', 'ECONOMIC_TRANSFER_DATE', 'TRANSFER_DATE', '2026-07-01', 'BAND', $4, 1, '{}', 0, '{}', 0, $5, 'CONFIRMED', 1, 1, ${METHOD_VALUES})`,
          [mine.version.versionId, REALM, pr, acquisitionId, acquisitionId === mine.w ? mine.allocation : other.allocation],
        );
        await client.query('ROLLBACK');
        throw Object.assign(new Error('rolled back on purpose'), { code: 'accepted' });
      });
    expect(await component(other.pr, other.w)).toBe('23503');
    expect(await component(mine.pr, other.w)).toBe('23503');
    // Counter-check: its own purchase is accepted (the append-only guard disabled for the probe only).
    expect(await component(mine.pr, mine.w)).toBe('accepted');
  });

  /** A confirmed maintenance split of `pr` in `realm`, classified (synthetic); the classification's id. */
  const classification = async (realm: string, pr: string): Promise<string> => {
    const db = createDatabase(ctx.pool);
    const eur = Money.of('4800.00', 'EUR');
    const account = await new PostgresFinancialAccountRepository(db).create(
      { mreRealmId: realm, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null },
      actor,
    );
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const transactions = new PostgresTransactionRepository(db);
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: account.account.id,
        amount: eur,
        direction: 'OUTFLOW',
        bookingDate: '2027-03-15' as BusinessDate,
        valueDate: null,
        description: 'Dachreparatur (synthetisch)',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const split = { amount: eur, financialCategoryCode: 'MAINTENANCE', propertyReferenceId: pr, loanId: null, securityDepositId: null, description: null };
    const replaced = await new PostgresTransactionSplitRepository(db).replaceSplits(created.transaction.id, realm, [split], actor);
    if (replaced.kind !== 'REPLACED') throw new Error(replaced.kind);
    if ((await transactions.confirm(created.transaction.id, realm, actor)).kind !== 'CONFIRMED') throw new Error('confirm');
    const splitId = (await ctx.pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1`, [created.transaction.id])).rows[0].id as string;
    const { rows } = await ctx.pool.query(
      `INSERT INTO tax_classification (mre_realm_id, source_type, transaction_split_id, tax_category, treatment, review_state, rule_code, rule_version, created_by)
       VALUES ($1, 'TRANSACTION_SPLIT', $2, 'MAINTENANCE', 'DEDUCTIBLE', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x') RETURNING id`,
      [realm, splitId],
    );
    return rows[0].id as string;
  };
  /**
   * Runs `statements` with the append-only guards of `tables` disabled (for the probe only), rolled back: the SQLSTATE and
   * the violated constraint of the first failure, or `accepted`.
   */
  const probe = async (tables: readonly string[], statements: (client: pg.PoolClient) => Promise<unknown>) => {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      for (const table of tables) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_append_only`);
      await statements(client);
      return 'accepted';
    } catch (error) {
      const { code, constraint } = error as { code?: string; constraint?: string };
      return `${code} ${constraint}`;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };

  it('the composite keys: an owner part naming another Realm’s party, and an entry of it, are refused; so is the part in the other Realm’s name', async () => {
    const mine = await versionOf();
    const theirs = await acc8(OTHER_REALM);
    const third = await party('Käuferin C', REALM);
    const component = (
      await ctx.pool.query(`SELECT component_id FROM depreciation_schedule_version_component WHERE version_id = $1 AND kind = 'ACQUISITION'`, [
        mine.version.versionId,
      ])
    ).rows[0].component_id as string;
    const part = (client: pg.PoolClient, realm: string, owner: string) =>
      client.query(
        `INSERT INTO depreciation_schedule_version_part (version_id, mre_realm_id, component_id, part_key, owner_party_id, ownership_ids, share_numerator,
           share_denominator, weight_numerator, weight_denominator, basis_amount, first_month, rate_kind)
         VALUES ($1, $2, $3, 'OWNER:' || $4::text, $4::uuid, '{}', 1, 5, 1, 5, 1, '2026-07-01', 'BAND')`,
        [mine.version.versionId, realm, component, owner],
      );
    const entry = (client: pg.PoolClient, owner: string) =>
      client.query(
        `INSERT INTO depreciation_schedule_entry (version_id, mre_realm_id, year, component_id, part_key, months, amount, cumulative, residual_value)
         VALUES ($1, $2, 2026, $3, 'OWNER:' || $4::text, 6, 1, 1, 0)`,
        [mine.version.versionId, REALM, component, owner],
      );
    const tables = ['depreciation_schedule_version_part', 'depreciation_schedule_entry'];
    // Another Realm's party in this Realm's name (the party key), and in the other Realm's name (the version key).
    expect(await probe(tables, (client) => part(client, REALM, theirs.a))).toBe('23503 depreciation_schedule_version_part_party_fk');
    expect(await probe(tables, (client) => part(client, OTHER_REALM, theirs.a))).toBe('23503 depreciation_schedule_version_part_version_fk');
    // An entry of another Realm's party (its part cannot exist).
    expect(await probe(tables, (client) => entry(client, theirs.a))).toBe('23503 depreciation_schedule_entry_part_fk');
    // Counter-check: a party of this Realm, its part and its entry, are accepted.
    expect(await probe(tables, async (client) => [await part(client, REALM, third), await entry(client, third)])).toBe('accepted');
  });

  it('the composite keys: a purchase component with another Realm’s allocation, and an item component with another Realm’s classification, are refused', async () => {
    const mine = await versionOf();
    const theirs = await acc8(OTHER_REALM);
    const [ownClassification, theirClassification] = [await classification(REALM, mine.pr), await classification(OTHER_REALM, theirs.pr)];
    const purchase = (client: pg.PoolClient, allocationId: string) =>
      client.query(
        `INSERT INTO depreciation_schedule_version_component (version_id, mre_realm_id, property_reference_id, component_id, kind, position, basis_amount, start_date,
           start_date_source, start_method, start_month, rate_kind, acquisition_id, purchase_price, counted_cost_ids, counted_costs_total, excluded_cost_ids,
           excluded_costs_total, allocation_id, allocation_review_state, total_allocable_amount, building_amount, ${METHOD_COLUMNS})
         VALUES ($1, $2, $3, 'ACQUISITION:x', 'ACQUISITION', 9, 1, '2026-07-01', 'ECONOMIC_TRANSFER_DATE', 'TRANSFER_DATE', '2026-07-01', 'BAND', $4, 1, '{}', 0, '{}', 0, $5, 'CONFIRMED', 1, 1, ${METHOD_VALUES})`,
        [mine.version.versionId, REALM, mine.pr, mine.w, allocationId],
      );
    const item = (client: pg.PoolClient, realm: string, pr: string, classificationId: string) =>
      client.query(
        `INSERT INTO depreciation_schedule_version_component (version_id, mre_realm_id, property_reference_id, component_id, kind, position, basis_amount, start_date,
           start_date_source, start_method, start_month, rate_kind, source_type, source_id, classification_id, classification_review_state, tax_category,
           item_date, item_date_source, item_tax_year)
         VALUES ($1, $2, $3, 'ITEM:x', 'CAPITALIZED_ITEM', 9, 1, '2027-03-15', 'BOOKING_DATE', 'MONTH_OF_DATE', '2027-03-01', 'BAND', 'TRANSACTION_SPLIT',
           gen_random_uuid(), $4, 'USER_CONFIRMED', 'MAINTENANCE', '2027-03-15', 'BOOKING_DATE', 2027)`,
        [mine.version.versionId, realm, pr, classificationId],
      );
    const tables = ['depreciation_schedule_version_component'];
    // Another Realm's allocation beside this version's own purchase (the allocation key binds it to the purchase).
    expect(await probe(tables, (client) => purchase(client, theirs.allocation))).toBe('23503 depreciation_schedule_version_component_allocation_fk');
    // Another Realm's classification in this Realm's name (the classification key), and in the other Realm's name (the version key).
    expect(await probe(tables, (client) => item(client, REALM, mine.pr, theirClassification))).toBe(
      '23503 depreciation_schedule_version_component_classification_fk',
    );
    expect(await probe(tables, (client) => item(client, OTHER_REALM, mine.pr, theirClassification))).toBe(
      '23503 depreciation_schedule_version_component_version_fk',
    );
    expect(await probe(tables, (client) => item(client, OTHER_REALM, theirs.pr, theirClassification))).toBe(
      '23503 depreciation_schedule_version_component_version_fk',
    );
    // Counter-check: this Realm's allocation and classification are accepted.
    expect(await probe(tables, (client) => purchase(client, mine.allocation))).toBe('accepted');
    expect(await probe(tables, (client) => item(client, REALM, mine.pr, ownClassification))).toBe('accepted');
  });

  it(
    'up and down under MIGRATION_ADVISORY_LOCK: down refused with a version present, else drops the eight tables and their functions',
    { timeout: 30_000 },
    async () => {
      const downSchema = testSchemaName('schedule_version_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        const migration = migrations['0052_depreciation_schedule_version'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
        const tables = async () =>
          Number(
            (
              await downPool.query(
                `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'depreciation_schedule_%'`,
                [downSchema],
              )
            ).rows[0].n,
          );
        expect(await tables()).toBe(8);
        // A version present: the header alone (its guards disabled for the fixture only) is enough for the refusal.
        await downPool.query(`ALTER TABLE depreciation_schedule_version DISABLE TRIGGER USER`);
        await downPool.query(`ALTER TABLE depreciation_schedule_version DROP CONSTRAINT depreciation_schedule_version_asset_fk`);
        await downPool.query(
          `INSERT INTO depreciation_schedule_version (mre_realm_id, asset_id, property_reference_id, version_number, status, from_year, through_year, computed_on,
           calculation_version, currency, asset_type, depreciation_method, asset_review_state, asset_version, input_fingerprint, output_fingerprint, reason, recorded_by)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), 1, 'CURRENT', 2026, 2026, '2028-01-20', 1, 'EUR', 'BUILDING', 'LINEAR_7_4', 'CONFIRMED', 1, repeat('a', 64), repeat('b', 64), 'x', 'x')`,
          [REALM],
        );
        let refused: unknown;
        await withMigrationLock(async () => {
          refused = await migration.down(createDatabase(downPool) as never).catch((e: unknown) => e);
        });
        expect(refused).toMatchObject({ code: '23514' });
        expect(await tables()).toBe(8);
        await downPool.query(`DELETE FROM depreciation_schedule_version`);
        await withMigrationLock(() => migration.down(createDatabase(downPool) as never));
        expect(await tables()).toBe(0);
        const functions = await downPool.query(
          `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1 AND proname LIKE 'depreciation_schedule_%'`,
          [downSchema],
        );
        expect(functions.rows).toEqual([]);
        await withMigrationLock(() => migration.up(createDatabase(downPool) as never));
        expect(await tables()).toBe(8);
      } finally {
        await downPool.end();
      }
    },
  );
});

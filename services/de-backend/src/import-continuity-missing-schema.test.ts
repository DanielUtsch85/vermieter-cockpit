import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportBatch, ParsedStatement } from './domains/ledger/index.js';
import { genericCsvAdapter, genericCsvAdapterV2 } from './integrations/bank-import/index.js';
import { createDatabase } from './infrastructure/postgres/database.js';
import { PostgresFinancialAccountRepository } from './infrastructure/postgres/financial-account-repository.js';
import { PostgresImportRepository } from './infrastructure/postgres/import-repository.js';
import { migrateToLatest } from './infrastructure/postgres/migrate.js';
import { migrations } from './infrastructure/postgres/migrations/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { withMigrationLock } from './infrastructure/postgres/tax-year.test-support.js';

/**
 * VC-X-77 (api-design.md §32.1a, migration 0079; Entscheidung des Projektinhabers, 2026-11-16): why a batch has no
 * continuity report, past the repository. Files go through the real `generic-csv` adapters, so `balanceColumn` is the
 * adapter's. The two CHECKs refuse what the repository never writes (counter-checks: what it writes passes), and the
 * backfill names only version 1 batches. Synthetic data only.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const v1 = { columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag', description: 'Verwendungszweck' } };
const v2 = { columnMapping: { ...v1.columnMapping, balanceAfter: 'Saldo nach Buchung' } };
const header = 'Buchungstag;Verwendungszweck;Betrag;Saldo nach Buchung';
const REPORT = '{"order":"OLDEST_FIRST","breaks":[],"previousExport":"NO_EARLIER_BALANCE"}';

function parsed(adapter: typeof genericCsvAdapter, lines: readonly string[], options: unknown): ParsedStatement {
  const result = adapter.parse(new TextEncoder().encode([header, ...lines].join('\n')), options, 'EUR');
  if ('error' in result) throw new Error(result.error.code);
  return result.statement;
}

describe.skipIf(databaseUrl === undefined)('the reason for a missing continuity report (0079, VC-X-77)', () => {
  const schema = testSchemaName('import_continuity_missing_test');
  let pool: pg.Pool;
  let imports: PostgresImportRepository;
  let accountId: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    imports = new PostgresImportRepository(db);
    const created = await new PostgresFinancialAccountRepository(db).create(
      { mreRealmId: REALM, accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR', iban: null },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    accountId = created.account.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function run(statement: ParsedStatement): Promise<ImportBatch> {
    const outcome = await imports.importStatement(
      { mreRealmId: REALM, financialAccountId: accountId, statement, provenance: 'BANK_CSV', sourceFilename: 'umsatz.csv' },
      actor,
    );
    if (outcome.kind !== 'IMPORTED') throw new Error(outcome.kind);
    return outcome.batch;
  }
  const stored = async (id: string) =>
    (await pool.query(`SELECT continuity IS NOT NULL AS report, continuity_missing FROM import_batch WHERE id = $1`, [id])).rows[0];

  it('stores and reads the reason: no column (v1, and v2 without the mapping), no row with a balance, none with a report', async () => {
    const cases: [ParsedStatement, ImportBatch['continuityMissing'], boolean][] = [
      [parsed(genericCsvAdapter, ['01.03.2026;Miete März;1.250,00;'], v1), 'NO_BALANCE_COLUMN', false],
      [parsed(genericCsvAdapterV2, ['02.03.2026;Miete März 2;1.250,00;'], v1), 'NO_BALANCE_COLUMN', false],
      // The column is there, but empty in every valid row; the row with a broken balance is an error and has none.
      [parsed(genericCsvAdapterV2, ['03.03.2026;Miete März 3;1.250,00;', '04.03.2026;kaputt;5,00;abc'], v2), 'NO_ROW_WITH_BALANCE', false],
      // Only a zero-amount line with a balance: skipped, so no valid row has one.
      [parsed(genericCsvAdapterV2, ['31.03.2026;Abschluss;0,00;1.250,00'], v2), 'NO_ROW_WITH_BALANCE', false],
      [parsed(genericCsvAdapterV2, ['05.03.2026;Miete März 5;1.250,00;2.500,00'], v2), null, true],
    ];
    for (const [statement, reason, report] of cases) {
      const batch = await run(statement);
      expect([batch.continuityMissing, batch.continuity !== null], statement.contentHash).toEqual([reason, report]);
      expect((await imports.findBatch(batch.id, REALM))?.continuityMissing).toBe(reason);
      expect(await stored(batch.id)).toEqual({ report, continuity_missing: reason });
    }
  });

  it('CHECK import_batch_continuity_missing_value: another value is refused; counter-check: both values pass', async () => {
    const [{ id }] = (await pool.query(`SELECT id FROM import_batch WHERE continuity IS NULL LIMIT 1`)).rows;
    await expect(pool.query(`UPDATE import_batch SET continuity_missing = 'NO_BALANCE' WHERE id = $1`, [id])).rejects.toThrow(
      /import_batch_continuity_missing_value/,
    );
    for (const value of ['NO_BALANCE_COLUMN', 'NO_ROW_WITH_BALANCE', null]) {
      await pool.query(`UPDATE import_batch SET continuity_missing = $2 WHERE id = $1`, [id, value]);
    }
  });

  it('CHECK import_batch_continuity_or_missing: a report and a reason never together; counter-check: each alone passes', async () => {
    const [{ id }] = (await pool.query(`SELECT id FROM import_batch WHERE continuity IS NOT NULL LIMIT 1`)).rows;
    await expect(pool.query(`UPDATE import_batch SET continuity_missing = 'NO_ROW_WITH_BALANCE' WHERE id = $1`, [id])).rejects.toThrow(
      /import_batch_continuity_or_missing/,
    );
    await pool.query(`UPDATE import_batch SET continuity = NULL, continuity_missing = 'NO_ROW_WITH_BALANCE' WHERE id = $1`, [id]);
    await pool.query(`UPDATE import_batch SET continuity = $2, continuity_missing = NULL WHERE id = $1`, [id, REPORT]);
    await pool.query(`UPDATE import_batch SET continuity = NULL WHERE id = $1`, [id]);
  });

  it('the backfill names version 1 batches without a report only; down drops the column and nothing else', async () => {
    const downSchema = testSchemaName('import_continuity_missing_down_test');
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${downSchema}"`);
    await admin.end();
    const down = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
    try {
      const before = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0079'));
      await migrateToLatest(down, { migrationTableSchema: downSchema, migrations: before });
      const [{ id: account }] = (
        await down.query(
          `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by) VALUES ($1, 'BANK', 'Giro', 'EUR', 'OPEN', 'x') RETURNING id`,
          [REALM],
        )
      ).rows;
      const batch = (n: number, version: string, continuity: string | null) =>
        down.query(
          `INSERT INTO import_batch (id, mre_realm_id, financial_account_id, adapter_id, adapter_version, content_hash, provenance, status,
             transaction_count, duplicate_count, needs_review_count, error_count, skipped_count, rows, imported_by, continuity)
           VALUES ($1, $2, $3, 'generic-csv', $4, $5, 'BANK_CSV', 'COMPLETED', 0, 0, 0, 0, 0, '[]', 'x', $6)`,
          [`00000000-0000-4000-8000-00000000000${n}`, REALM, account, version, `h${n}`, continuity],
        );
      await batch(1, '1', null);
      await batch(2, '2', null);
      await batch(3, '2', REPORT);
      const rows = async () => (await down.query(`SELECT id, md5(b::text) AS h FROM import_batch b ORDER BY id`)).rows;
      const original = await rows();

      await migrateToLatest(down, { migrationTableSchema: downSchema });
      expect((await down.query(`SELECT adapter_version, continuity IS NOT NULL AS report, continuity_missing FROM import_batch ORDER BY id`)).rows).toEqual([
        { adapter_version: '1', report: false, continuity_missing: 'NO_BALANCE_COLUMN' },
        // A version 2 batch before 0079: its reason was never recorded.
        { adapter_version: '2', report: false, continuity_missing: null },
        { adapter_version: '2', report: true, continuity_missing: null },
      ]);

      await withMigrationLock(() =>
        (migrations['0079_import_batch_continuity_missing'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never),
      );
      expect(await rows()).toEqual(original);
      expect(
        (
          await down.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'continuity_missing'`, [
            downSchema,
          ])
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await down.end();
    }
  }, 120_000);
});

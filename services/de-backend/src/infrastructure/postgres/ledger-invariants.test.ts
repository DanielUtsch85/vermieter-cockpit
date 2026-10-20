import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';

/**
 * VC-1-09, schema level: the ledger invariants hold in the database itself, so
 * no code path — present or future, nor a hand-written statement — can break
 * them. Each test writes straight SQL past the repositories. See
 * docs/development/invariant-suite.md for where each invariant is tested.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;

describe.skipIf(databaseUrl === undefined)('ledger invariants in the schema', () => {
  const schema = testSchemaName('ledger_invariants_test');
  let pool: pg.Pool;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let properties: PostgresPropertyReferenceRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    properties = new PostgresPropertyReferenceRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function account(mreRealmId = REALM): Promise<string> {
    const outcome = await accounts.create({ mreRealmId, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }
  async function transaction(mreRealmId = REALM, amount = '1200.00'): Promise<string> {
    const created = await transactions.createManual(
      {
        mreRealmId,
        financialAccountId: await account(mreRealmId),
        amount: Money.of(amount, 'EUR'),
        direction: 'OUTFLOW',
        bookingDate: '2026-09-30' as BusinessDate,
        valueDate: null,
        description: null,
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  async function property(mreRealmId: string, mrePropertyId: string): Promise<string> {
    const linked = await properties.linkOnce(
      { mreRealmId, mrePropertyId, displayName: null, cachedAddress: null, cachedSurface: null, refreshedAt: new Date() },
      actor,
    );
    return linked.reference.id;
  }
  const category = async (code: string) =>
    (await pool.query(`SELECT id FROM financial_category WHERE code = $1`, [code])).rows[0].id as string;
  const addSplit = async (transactionId: string, position: number, amount: string) =>
    pool.query(
      `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, created_by)
       VALUES ($1, $2, $3, $4, 'EUR', $5, 'x')`,
      [transactionId, REALM, position, amount, await category('OTHER')],
    );
  const confirmBySql = (id: string) =>
    pool.query(`UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x' WHERE id = $1`, [id]);

  describe('split totals: a confirmed Transaction is covered exactly by its splits (§18, §24)', () => {
    it('no confirmation without splits, or with a sum one cent off in either direction', async () => {
      const unsplit = await transaction();
      await expect(confirmBySql(unsplit)).rejects.toThrow(/cannot be confirmed/);

      const short = await transaction();
      await addSplit(short, 1, '600.00');
      await addSplit(short, 2, '599.99');
      await expect(confirmBySql(short)).rejects.toThrow(/cannot be confirmed/);

      const over = await transaction();
      await addSplit(over, 1, '1200.01');
      await expect(confirmBySql(over)).rejects.toThrow(/cannot be confirmed/);
    });

    it('an exact split set can be confirmed, and stays exact: its splits are frozen', async () => {
      const id = await transaction();
      await addSplit(id, 1, '600.00');
      await addSplit(id, 2, '600');
      await confirmBySql(id);
      await expect(
        pool.query(`UPDATE transaction_split SET amount = 599.99 WHERE transaction_id = $1 AND position = 2`, [id]),
      ).rejects.toThrow(/ADR-037/);
    });

    it('no Transaction is inserted already confirmed', async () => {
      const accountId = await account();
      await expect(
        pool.query(
          `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status,
             created_by, confirmed_at, confirmed_by)
           VALUES ($1, $2, 1, 'EUR', 'INFLOW', '2026-09-01', 'MANUAL', 'CONFIRMED', 'x', now(), 'x')`,
          [REALM, accountId],
        ),
      ).rejects.toThrow(/not inserted confirmed/);
    });
  });

  describe('non-negative amount, sign only in direction, supported currency and scale (§17.4)', () => {
    const insert = async (amount: string, currency: string, direction: string) =>
      pool.query(
        `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by)
         VALUES ($1, $2, $3, $4, $5, '2026-09-01', 'MANUAL', 'UNREVIEWED', 'x')`,
        [REALM, await account(), amount, currency, direction],
      );

    it.each([
      ['a negative amount', '-1.00', 'EUR', 'OUTFLOW', /ledger_transaction_amount_check/],
      ['more decimals than EUR allows', '1.005', 'EUR', 'INFLOW', /ledger_transaction_amount_check/],
      ['an unsupported currency', '1.00', 'USD', 'INFLOW', /ledger_transaction_currency_check/],
      ['a direction other than INFLOW/OUTFLOW', '1.00', 'EUR', 'REFUND', /ledger_transaction_direction_check/],
    ])('refuses %s', async (_case, amount, currency, direction, error) => {
      await expect(insert(amount, currency, direction)).rejects.toThrow(error);
    });
  });

  describe('Realm isolation: nothing references another Realm’s rows (composite foreign keys)', () => {
    it('a Transaction cannot point at another Realm’s PropertyReference', async () => {
      const foreign = await property(OTHER_REALM, '6512f0c2a1b2c3d4e5f60801');
      const id = await transaction();
      await expect(pool.query(`UPDATE ledger_transaction SET property_reference_id = $2 WHERE id = $1`, [id, foreign])).rejects.toThrow(
        /ledger_transaction_property_reference_fk/,
      );
    });

    it('a split cannot point at another Realm’s PropertyReference', async () => {
      const foreign = await property(OTHER_REALM, '6512f0c2a1b2c3d4e5f60802');
      const id = await transaction();
      await addSplit(id, 1, '1200.00');
      await expect(
        pool.query(`UPDATE transaction_split SET property_reference_id = $2 WHERE transaction_id = $1`, [id, foreign]),
      ).rejects.toThrow(/transaction_split_property_reference_fk/);
    });

    it('import batches, imported Transactions and review items stay in their Realm', async () => {
      const foreignAccount = await account(OTHER_REALM);
      const batchInsert = (realm: string, accountId: string) =>
        pool.query(
          `INSERT INTO import_batch (id, mre_realm_id, financial_account_id, adapter_id, adapter_version, content_hash, provenance, status,
             transaction_count, duplicate_count, needs_review_count, error_count, skipped_count, rows, imported_by)
           VALUES (gen_random_uuid(), $1, $2, 'generic-csv', '1', 'h', 'BANK_CSV', 'COMPLETED', 0, 0, 0, 0, 0, '[]', 'x') RETURNING id`,
          [realm, accountId],
        );
      await expect(batchInsert(REALM, foreignAccount)).rejects.toThrow(/import_batch_account_fk/);

      const foreignBatch = (await batchInsert(OTHER_REALM, foreignAccount)).rows[0].id as string;
      const id = await transaction();
      await expect(
        pool.query(
          `UPDATE ledger_transaction SET import_batch_id = $2, adapter_id = 'generic-csv', adapter_version = '1',
             source_statement_key = 's', source_row_key = 'pos:1', content_fingerprint = 'f' WHERE id = $1`,
          [id, foreignBatch],
        ),
      ).rejects.toThrow(/ledger_transaction_import_batch_fk/);

      const ownAccount = await account();
      await expect(
        pool.query(
          `INSERT INTO import_review_item (id, import_batch_id, mre_realm_id, financial_account_id, adapter_id, adapter_version,
             source_statement_key, source_row_key, content_fingerprint, normalized_row, ambiguity_reason, conflicting_transaction_ids,
             prior_review_item_ids, status)
           VALUES (gen_random_uuid(), $1, $2, $3, 'generic-csv', '1', 's', 'pos:1', 'f', '{}', 'AMBIGUOUS_CROSS_FILE_MATCH', '{}', '{}', 'PENDING')`,
          [foreignBatch, REALM, ownAccount],
        ),
      ).rejects.toThrow(/import_review_item_batch_fk/);
    });
  });
});

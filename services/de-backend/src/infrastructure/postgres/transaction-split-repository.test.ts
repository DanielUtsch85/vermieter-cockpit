import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate, SplitInput } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresFinancialCategoryRepository } from './financial-category-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-1-07 persistence: exact sum, atomic replacement, CLASSIFIED status and
 * version, the no-op repeat, frozen Transactions, categories and
 * PropertyReferences within the Realm, schema-level Realm and currency binding,
 * and serialized concurrent replacements.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const split = (amount: string, financialCategoryCode = 'LOAN_INTEREST', extra: Partial<SplitInput> = {}): SplitInput => ({
  amount: Money.of(amount, 'EUR'),
  financialCategoryCode,
  propertyReferenceId: null,
  loanId: null,
  securityDepositId: null,
  description: null,
  ...extra,
});
const loanSplits = [split('600.00'), split('600.00', 'LOAN_PRINCIPAL')];

describe.skipIf(databaseUrl === undefined)('PostgresTransactionSplitRepository', () => {
  const schema = testSchemaName('split_test');
  let pool: pg.Pool;
  let splits: PostgresTransactionSplitRepository;
  let transactions: PostgresTransactionRepository;
  let accounts: PostgresFinancialAccountRepository;
  let properties: PostgresPropertyReferenceRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    splits = new PostgresTransactionSplitRepository(db);
    transactions = new PostgresTransactionRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    properties = new PostgresPropertyReferenceRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function loanPayment(mreRealmId = REALM, amount = '1200.00'): Promise<string> {
    const account = await accounts.create({ mreRealmId, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const created = await transactions.createManual(
      {
        mreRealmId,
        financialAccountId: account.account.id,
        amount: Money.of(amount, 'EUR'),
        direction: 'OUTFLOW',
        bookingDate: '2026-09-30' as BusinessDate,
        valueDate: null,
        description: 'Darlehensrate',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  const stored = async (transactionId: string) =>
    (
      await pool.query(
        `SELECT s.position, s.amount::text, c.code FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id
          WHERE s.transaction_id = $1 ORDER BY s.position`,
        [transactionId],
      )
    ).rows;
  const audits = async (transactionId: string) =>
    (
      await pool.query(`SELECT action FROM audit_record WHERE entity_type = 'Transaction' AND entity_id = $1 ORDER BY occurred_at, new_version`, [
        transactionId,
      ])
    ).rows.map((r: { action: string }) => r.action);

  it('stores an exact split set, classifies the Transaction, bumps its version and audits', async () => {
    const id = await loanPayment();
    const outcome = await splits.replaceSplits(id, REALM, loanSplits, actor);
    expect(outcome).toMatchObject({
      kind: 'REPLACED',
      changed: true,
      transaction: { id, status: 'CLASSIFIED', version: 2, direction: 'OUTFLOW' },
    });
    if (outcome.kind !== 'REPLACED') throw new Error(outcome.kind);
    expect(outcome.splits.map((s) => [s.position, s.amount.amount, s.financialCategoryCode])).toEqual([
      [1, '600.00', 'LOAN_INTEREST'],
      [2, '600.00', 'LOAN_PRINCIPAL'],
    ]);
    expect(await stored(id)).toEqual([
      { position: 1, amount: '600.00', code: 'LOAN_INTEREST' },
      { position: 2, amount: '600.00', code: 'LOAN_PRINCIPAL' },
    ]);
    expect(await audits(id)).toEqual(['CREATED', 'SPLITS_REPLACED']);
  });

  it('replaces the whole set atomically; repeating the current set changes nothing', async () => {
    const id = await loanPayment();
    await splits.replaceSplits(id, REALM, loanSplits, actor);
    const replaced = await splits.replaceSplits(id, REALM, [split('612.40'), split('587.60', 'LOAN_PRINCIPAL'), split('0', 'BANK_FEES')], actor);
    expect(replaced).toMatchObject({ kind: 'REPLACED', changed: true, transaction: { version: 3 } });
    expect((await stored(id)).map((r: { code: string }) => r.code)).toEqual(['LOAN_INTEREST', 'LOAN_PRINCIPAL', 'BANK_FEES']);

    const repeated = await splits.replaceSplits(id, REALM, [split('612.4'), split('587.6', 'LOAN_PRINCIPAL'), split('0.00', 'BANK_FEES')], actor);
    expect(repeated).toMatchObject({ kind: 'REPLACED', changed: false, transaction: { version: 3 } });
    expect(await audits(id)).toEqual(['CREATED', 'SPLITS_REPLACED', 'SPLITS_REPLACED']);
  });

  it('refuses a sum one cent off and keeps the previous set', async () => {
    const id = await loanPayment();
    await splits.replaceSplits(id, REALM, loanSplits, actor);
    expect(await splits.replaceSplits(id, REALM, [split('600.00'), split('599.99', 'LOAN_PRINCIPAL')], actor)).toEqual({
      kind: 'SUM_MISMATCH',
      expected: Money.of('1200.00', 'EUR'),
      actual: Money.of('1199.99', 'EUR'),
    });
    expect(await stored(id)).toHaveLength(2);
  });

  it('a CONFIRMED Transaction is frozen; only the identical repeat is answered as a no-op', async () => {
    const id = await loanPayment();
    await splits.replaceSplits(id, REALM, loanSplits, actor);
    await pool.query(`UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x' WHERE id = $1`, [id]);
    expect(await splits.replaceSplits(id, REALM, [split('1200.00')], actor)).toEqual({ kind: 'FROZEN', status: 'CONFIRMED' });
    expect(await splits.replaceSplits(id, REALM, loanSplits, actor)).toMatchObject({ kind: 'REPLACED', changed: false });
    const ignored = await loanPayment();
    await pool.query(`UPDATE ledger_transaction SET status = 'IGNORED' WHERE id = $1`, [ignored]);
    expect(await splits.replaceSplits(ignored, REALM, loanSplits, actor)).toEqual({ kind: 'FROZEN', status: 'IGNORED' });
  });

  it('refuses unknown and inactive categories', async () => {
    const id = await loanPayment();
    await pool.query(`INSERT INTO financial_category (code, name, category_type, active) VALUES ('RETIRED_CODE', 'Alt', 'OTHER', false)`);
    expect(await splits.replaceSplits(id, REALM, [split('600'), split('600', 'NO_SUCH_CODE')], actor)).toEqual({
      kind: 'UNKNOWN_CATEGORY',
      codes: ['NO_SUCH_CODE'],
    });
    expect(await splits.replaceSplits(id, REALM, [split('1200', 'RETIRED_CODE')], actor)).toEqual({
      kind: 'UNKNOWN_CATEGORY',
      codes: ['RETIRED_CODE'],
    });
  });

  it('PropertyReferences must be in the Realm; another Realm’s Transaction is not found', async () => {
    const link = (mreRealmId: string, mrePropertyId: string) =>
      properties.linkOnce({ mreRealmId, mrePropertyId, displayName: null, cachedAddress: null, cachedSurface: null, refreshedAt: new Date() }, actor);
    const own = await link(REALM, '6512f0c2a1b2c3d4e5f60720');
    const foreign = await link(OTHER_REALM, '6512f0c2a1b2c3d4e5f60721');
    const id = await loanPayment();
    expect(await splits.replaceSplits(id, REALM, [split('1200', 'LOAN_INTEREST', { propertyReferenceId: foreign.reference.id })], actor)).toEqual({
      kind: 'PROPERTY_REFERENCE_NOT_FOUND',
      propertyReferenceIds: [foreign.reference.id],
    });
    expect(
      await splits.replaceSplits(
        id,
        REALM,
        [split('1200', 'LOAN_INTEREST', { propertyReferenceId: own.reference.id, loanId: null, securityDepositId: null, description: 'Whg 1' })],
        actor,
      ),
    ).toMatchObject({ kind: 'REPLACED', splits: [{ propertyReferenceId: own.reference.id, loanId: null, securityDepositId: null, description: 'Whg 1' }] });

    const elsewhere = await loanPayment(OTHER_REALM);
    expect(await splits.replaceSplits(elsewhere, REALM, loanSplits, actor)).toEqual({ kind: 'NOT_FOUND' });
    expect(await splits.replaceSplits('not-a-uuid', REALM, loanSplits, actor)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('the schema binds a split to its Transaction’s Realm and currency and refuses negative amounts', async () => {
    const id = await loanPayment();
    const category = (await pool.query(`SELECT id FROM financial_category WHERE code = 'OTHER'`)).rows[0].id as string;
    const insert = (realm: string, amount: string, currency = 'EUR') =>
      pool.query(
        `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, created_by)
         VALUES ($1, $2, 9, $3, $4, $5, 'x')`,
        [id, realm, amount, currency, category],
      );
    await expect(insert(OTHER_REALM, '1.00')).rejects.toThrow(/transaction_split_transaction_fk/);
    await expect(insert(REALM, '-1.00')).rejects.toThrow(/transaction_split_amount_check/);
    await expect(insert(REALM, '1.005')).rejects.toThrow(/transaction_split_amount_check/);
  });

  it('a replacement waits for the Transaction row lock and then works on the committed state', async () => {
    const id = await loanPayment();
    const holder = await pool.connect();
    try {
      // Another writer (a replacement or a confirm) holds the row and changes it ...
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM ledger_transaction WHERE id = $1 FOR UPDATE', [id]);
      const pending = splits.replaceSplits(id, REALM, loanSplits, actor);
      await waitUntil(
        async () =>
          (
            await pool.query(
              `SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%ledger_transaction%for update%'`,
            )
          ).rowCount !== 0,
      );
      await holder.query(`UPDATE ledger_transaction SET version = version + 1 WHERE id = $1`, [id]);
      await holder.query('COMMIT');
      // ... so the waiting replacement builds on version 2, not on what it would have read without the lock.
      expect(await pending).toMatchObject({ kind: 'REPLACED', transaction: { version: 3 } });
      const audit = await pool.query(`SELECT previous_version, new_version FROM audit_record WHERE entity_id = $1 AND action = 'SPLITS_REPLACED'`, [id]);
      expect(audit.rows).toEqual([{ previous_version: 2, new_version: 3 }]);
    } finally {
      holder.release();
    }
  });

  it('a replacement waiting on a confirm in progress finds the Transaction frozen', async () => {
    const id = await loanPayment();
    await splits.replaceSplits(id, REALM, loanSplits, actor);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM ledger_transaction WHERE id = $1 FOR UPDATE', [id]);
      const pending = splits.replaceSplits(id, REALM, [split('1200.00', 'OTHER')], actor);
      await waitUntil(
        async () =>
          (
            await pool.query(
              `SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%ledger_transaction%for update%'`,
            )
          ).rowCount !== 0,
      );
      await holder.query(`UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x' WHERE id = $1`, [id]);
      await holder.query('COMMIT');
      expect(await pending).toEqual({ kind: 'FROZEN', status: 'CONFIRMED' });
      expect((await stored(id)).map((r: { code: string }) => r.code)).toEqual(['LOAN_INTEREST', 'LOAN_PRINCIPAL']);
    } finally {
      holder.release();
    }
  });
});

describe.skipIf(databaseUrl === undefined)('PostgresFinancialCategoryRepository', () => {
  const schema = testSchemaName('category_test');
  let pool: pg.Pool;
  let categories: PostgresFinancialCategoryRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    categories = new PostgresFinancialCategoryRepository(createDatabase(pool));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('serves the seeded catalog (data-model.md §19 examples included) and finds by code', async () => {
    const codes = (await categories.list()).map((c) => c.code);
    for (const code of [
      'RENT_BASE',
      'RENT_OPERATING_COST_ADVANCE',
      'LOAN_INTEREST',
      'LOAN_PRINCIPAL',
      'WEG_RECOVERABLE',
      'WEG_NON_RECOVERABLE',
      'WEG_RESERVE_CONTRIBUTION',
      'MAINTENANCE',
      'ADMINISTRATION',
    ]) {
      expect(codes).toContain(code);
    }
    expect(await categories.findByCode('LOAN_INTEREST')).toEqual({
      code: 'LOAN_INTEREST',
      name: 'Darlehenszinsen',
      categoryType: 'FINANCING',
      active: true,
    });
    expect(await categories.findByCode('NOPE')).toBeUndefined();
  });
});

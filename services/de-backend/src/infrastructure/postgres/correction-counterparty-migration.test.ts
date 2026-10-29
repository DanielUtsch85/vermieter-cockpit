import pg from 'pg';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import * as m0035 from './migrations/0035_correction_counterparty.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * Migration 0035 (#111): corrections written before it get their original's counterparty, along the chain, also
 * when confirmed; `down` clears it again.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000001d';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');

describe.skipIf(databaseUrl === undefined)('migration 0035: counterparty of corrections', () => {
  const schema = testSchemaName('correction_counterparty_test');
  let pool: pg.Pool;
  let db: ReturnType<typeof createDatabase>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    db = createDatabase(pool);
    const accounts = new PostgresFinancialAccountRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const splits = new PostgresTransactionSplitRepository(db);
    const corrections = new PostgresCorrectionRepository(db);

    const account = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: account.account.id,
        amount: eur('800.00'),
        direction: 'INFLOW',
        bookingDate: '2026-09-01' as BusinessDate,
        valueDate: null,
        description: 'Miete',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const original = created.transaction.id;
    const split = { amount: eur('800.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: null, loanId: null, description: null };
    await splits.replaceSplits(original, REALM, [split], actor);
    await transactions.confirm(original, REALM, actor);
    await pool.query(`UPDATE ledger_transaction SET counterparty_name_raw = 'Erika Mieterin', counterparty_iban_raw = 'DE89370400440532013000' WHERE id = $1`, [
      original,
    ]);
    const first = await corrections.correct(original, REALM, { reason: 'x', replacement: { description: 'Miete 09' } }, actor);
    if (first.kind !== 'CORRECTED' || first.result.replacement === null) throw new Error('first');
    const second = await corrections.correct(first.result.replacement.id, REALM, { reason: 'y', replacement: { description: 'Miete 09/2026' } }, actor);
    if (second.kind !== 'CORRECTED' || second.result.replacement === null) throw new Error('second');
    Object.assign(ids, {
      original,
      reversal1: first.result.reversal.id,
      replacement1: first.result.replacement.id,
      reversal2: second.result.reversal.id,
      replacement2: second.result.replacement.id,
    });
    // As written before 0035: corrections without a counterparty.
    await pool.query(`UPDATE ledger_transaction SET counterparty_name_raw = NULL, counterparty_iban_raw = NULL WHERE correction_of_transaction_id IS NOT NULL`);
  });

  afterAll(async () => {
    await pool.end();
  });

  const counterparties = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(ids).map(async ([name, id]) => {
          const { rows } = await pool.query(`SELECT counterparty_iban_raw AS iban FROM ledger_transaction WHERE id = $1`, [id]);
          return [name, rows[0]?.iban ?? null] as const;
        }),
      ),
    );

  it('up copies the original’s counterparty to every correction of the chain; down clears the corrections only', async () => {
    await m0035.up(db as unknown as Kysely<unknown>);
    const iban = 'DE89370400440532013000';
    expect(await counterparties()).toEqual({ original: iban, reversal1: iban, replacement1: iban, reversal2: iban, replacement2: iban });
    const { rows } = await pool.query(`SELECT counterparty_name_raw AS name FROM ledger_transaction WHERE id = $1`, [ids['replacement2']]);
    expect(rows[0]).toEqual({ name: 'Erika Mieterin' });

    await m0035.down(db as unknown as Kysely<unknown>);
    expect(await counterparties()).toEqual({ original: iban, reversal1: null, replacement1: null, reversal2: null, replacement2: null });
  });
});

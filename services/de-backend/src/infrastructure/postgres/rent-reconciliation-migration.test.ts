import pg from 'pg';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import * as m0033 from './migrations/0033_rent_reconciliation_removal.js';
import { PostgresRentReconciliationRepository } from './rent-reconciliation-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * Migration 0033's backfill (api-design.md §37.5, review on #84): rows written back or failed under 0032 get their
 * last lease end from the last known time + 2 minutes, `released_at` included, so a removal right after a release of a
 * failed write-back waits.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM = '64b0c0ffee00000000000020';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');

describe.skipIf(databaseUrl === undefined)('migration 0033: the backfill of mre_last_lease_until', () => {
  const schema = testSchemaName('rent_reconciliation_migration_test');
  let pool: pg.Pool;
  let db: ReturnType<typeof createDatabase>;
  let repository: PostgresRentReconciliationRepository;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    db = createDatabase(pool);
    repository = new PostgresRentReconciliationRepository(db);
    const accounts = new PostgresFinancialAccountRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const splits = new PostgresTransactionSplitRepository(db);
    const account = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    for (const [name, tenant] of [
      ['failed', '6512f0c2a1b2c3d4e5f6e001'],
      ['written', '6512f0c2a1b2c3d4e5f6e002'],
      ['plain', '6512f0c2a1b2c3d4e5f6e003'],
    ] as const) {
      const tx = await transactions.createManual(
        { mreRealmId: REALM, financialAccountId: account.account.id, amount: eur('800.00'), direction: 'INFLOW', bookingDate: '2027-01-03' as BusinessDate, valueDate: null, description: 'Miete', propertyReferenceId: null },
        actor,
      );
      if (tx.kind !== 'CREATED') throw new Error(tx.kind);
      await splits.replaceSplits(tx.transaction.id, REALM, [{ amount: eur('800.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: null, loanId: null, description: null }], actor);
      await transactions.confirm(tx.transaction.id, REALM, actor);
      const created = await repository.create({ mreRealmId: REALM, transactionId: tx.transaction.id, mreTenantId: tenant, mreRentTerm: '2027010100', matchedAmount: eur('800.00'), notes: null }, actor);
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      ids[name] = created.reconciliation.id;
    }
    // Back to 0032, and the rows' history there with 0032's own steps.
    await m0033.down(db as unknown as Kysely<unknown>);
    const step = (id: string | undefined, assignment: string) => pool.query(`UPDATE rent_payment_reconciliation SET ${assignment}, version = version + 1 WHERE id = $1`, [id]);
    const claim = `mre_write_back_state = 'PENDING', mre_write_back_attempt_id = gen_random_uuid(), mre_write_back_lease_until = now() + interval '1 second'`;
    const cleared = `mre_write_back_attempt_id = NULL, mre_write_back_lease_until = NULL`;
    await step(ids['failed'], claim);
    await step(ids['failed'], `mre_write_back_state = 'FAILED', mre_write_back_error = 'MRE_UNAVAILABLE', mre_write_back_failed_at = now(), ${cleared}`);
    // 0032's release clears the failure: the lease, the failure time and the written time are all NULL here.
    await step(
      ids['failed'],
      `status = 'RELEASED', released_at = now() + interval '5 seconds', released_by = 'x', release_reason = 'x', mre_write_back_state = 'REMOVAL_REQUIRED', mre_write_back_error = NULL, mre_write_back_failed_at = NULL`,
    );
    await step(ids['written'], claim);
    await step(
      ids['written'],
      `mre_write_back_state = 'WRITTEN', mre_written_back_at = now() + interval '3 seconds', mre_written_back_by = 'x', ${cleared},
       mre_payment = '{"date":"03/01/2027","amount":{"amount":"800.00","currency":"EUR"},"type":"transfer","reference":"DE-RPR-x"}'`,
    );
    await m0033.up(db as unknown as Kysely<unknown>);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('a REMOVAL_REQUIRED from FAILED gets released_at + 2 minutes; a WRITTEN its written time + 2 minutes; NOT_WRITTEN stays NULL', async () => {
    const { rows } = await pool.query(
      `SELECT id, mre_last_lease_until - released_at AS after_release, mre_last_lease_until - mre_written_back_at AS after_write, mre_last_lease_until FROM rent_payment_reconciliation`,
    );
    const by = (id: string | undefined) => rows.find((r) => r.id === id);
    expect(by(ids['failed'])?.after_release).toMatchObject({ minutes: 2 });
    expect(by(ids['written'])?.after_write).toMatchObject({ minutes: 2 });
    expect(by(ids['plain'])?.mre_last_lease_until).toBeNull();
  });

  it('a removal of the released failed write-back before that is REMOVAL_TOO_EARLY', async () => {
    const released = await repository.findById(ids['failed'] ?? '', REALM);
    const outcome = await repository.claimRemoval(ids['failed'] ?? '', REALM, 60_000, 0, actor);
    expect(outcome).toEqual({ kind: 'REMOVAL_TOO_EARLY', notBefore: released?.mreLastLeaseUntil });
  });
});

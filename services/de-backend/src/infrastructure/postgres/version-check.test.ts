import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate, SplitInput } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresUnconfirmedTransactionRepository } from './unconfirmed-transaction-repository.js';

/**
 * VC-X-20 (api-design.md §16): every command that changes a Transaction refuses a stale `If-Match` version with
 * VERSION_CONFLICT and writes nothing; the current version passes; a no-op stays a no-op whatever the version.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, financialCategoryCode = 'RENT_BASE'): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId: null,
  loanId: null,
  description: null,
});

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('version check (If-Match) on Transaction commands', () => {
  const schema = testSchemaName('version_test');
  let pool: pg.Pool;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let unconfirmed: PostgresUnconfirmedTransactionRepository;
  let corrections: PostgresCorrectionRepository;
  let accounts: PostgresFinancialAccountRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    unconfirmed = new PostgresUnconfirmedTransactionRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** An UNREVIEWED manual Transaction of 100.00 at version 1. */
  async function draft(): Promise<string> {
    const account = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: account.account.id,
        amount: eur('100.00'),
        direction: 'OUTFLOW',
        bookingDate: '2026-09-01' as BusinessDate,
        valueDate: null,
        description: 'Hausmeister',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  const state = async (id: string) =>
    (await pool.query(`SELECT status, version, description FROM ledger_transaction WHERE id = $1`, [id])).rows[0] as {
      status: string;
      version: number;
      description: string | null;
    };
  const auditCount = async (id: string) => Number((await pool.query(`SELECT count(*) FROM audit_record WHERE entity_id = $1`, [id])).rows[0].count);
  const conflict = (expected: number, currentVersion: number) => ({ kind: 'VERSION_CONFLICT', expectedVersions: [expected], currentVersion });

  it('amend, splits, confirm: a stale version is refused and nothing is written; the current one passes', async () => {
    const id = await draft();
    expect(await unconfirmed.amend(id, REALM, { description: 'x' }, actor, [2])).toEqual(conflict(2, 1));
    expect(await state(id)).toEqual({ status: 'UNREVIEWED', version: 1, description: 'Hausmeister' });
    expect(await unconfirmed.amend(id, REALM, { description: 'Hausmeister Okt.' }, actor, [1])).toMatchObject({ kind: 'AMENDED', transaction: { version: 2 } });

    expect(await splits.replaceSplits(id, REALM, [split('100.00')], actor, [1])).toEqual(conflict(1, 2));
    expect(await state(id)).toMatchObject({ status: 'UNREVIEWED', version: 2 });
    expect(await splits.replaceSplits(id, REALM, [split('100.00')], actor, [2])).toMatchObject({ kind: 'REPLACED', transaction: { version: 3 } });

    expect(await transactions.confirm(id, REALM, actor, [2])).toEqual(conflict(2, 3));
    expect(await state(id)).toMatchObject({ status: 'CLASSIFIED', version: 3 });
    expect(await transactions.confirm(id, REALM, actor, [3])).toMatchObject({ kind: 'CONFIRMED', replayed: false, transaction: { version: 4 } });
  });

  it('ignore, restore, correct: a stale version is refused; the current one passes', async () => {
    const id = await draft();
    expect(await unconfirmed.ignore(id, REALM, 'doppelt', actor, [7])).toEqual(conflict(7, 1));
    expect(await state(id)).toMatchObject({ status: 'UNREVIEWED', version: 1 });
    expect(await unconfirmed.ignore(id, REALM, 'doppelt', actor, [1])).toMatchObject({ kind: 'IGNORED', transaction: { version: 2 } });
    expect(await unconfirmed.restore(id, REALM, actor, [1])).toEqual(conflict(1, 2));
    expect(await unconfirmed.restore(id, REALM, actor, [2])).toMatchObject({ kind: 'RESTORED', transaction: { version: 3 } });

    await splits.replaceSplits(id, REALM, [split('100.00')], actor);
    await transactions.confirm(id, REALM, actor);
    const before = await auditCount(id);
    const request = { reason: 'Datum', replacement: { bookingDate: '2026-09-02' as BusinessDate } };
    expect(await corrections.correct(id, REALM, request, actor, undefined, [4])).toEqual(conflict(4, 5));
    expect(await state(id)).toMatchObject({ status: 'CONFIRMED', version: 5 });
    expect(await auditCount(id)).toBe(before);
    expect(await corrections.correct(id, REALM, request, actor, undefined, [5])).toMatchObject({ kind: 'CORRECTED' });
  });

  it('any version of the list matches; an empty list (only weak tags) never does', async () => {
    const id = await draft();
    expect(await unconfirmed.amend(id, REALM, { description: 'a' }, actor, [7, 1])).toMatchObject({ kind: 'AMENDED', transaction: { version: 2 } });
    expect(await unconfirmed.amend(id, REALM, { description: 'b' }, actor, [])).toEqual({
      kind: 'VERSION_CONFLICT',
      expectedVersions: [],
      currentVersion: 2,
    });
  });

  it('a no-op is answered whatever the version: a retry stays a retry', async () => {
    const id = await draft();
    expect(await unconfirmed.amend(id, REALM, { description: 'Hausmeister' }, actor, [99])).toMatchObject({ kind: 'AMENDED', changed: false });
    await unconfirmed.ignore(id, REALM, 'doppelt', actor, [1]);
    expect(await unconfirmed.ignore(id, REALM, 'doppelt', actor, [1])).toMatchObject({ kind: 'IGNORED', replayed: true });
    await unconfirmed.restore(id, REALM, actor);
    await splits.replaceSplits(id, REALM, [split('100.00')], actor);
    expect(await splits.replaceSplits(id, REALM, [split('100.00')], actor, [1])).toMatchObject({ kind: 'REPLACED', changed: false });
    await transactions.confirm(id, REALM, actor, [4]);
    expect(await transactions.confirm(id, REALM, actor, [4])).toMatchObject({ kind: 'CONFIRMED', replayed: true });
    // Domain refusals come first: a stale version on a confirmed Transaction still says why it cannot be amended.
    expect(await unconfirmed.amend(id, REALM, { description: 'x' }, actor, [1])).toEqual({ kind: 'NOT_AMENDABLE', status: 'CONFIRMED' });
  });

  it('two people amend the same version at once: one wins, the other gets VERSION_CONFLICT (lost update prevented)', async () => {
    const id = await draft();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM ledger_transaction WHERE id = $1 FOR UPDATE`, [id]);
      const both = Promise.all([
        unconfirmed.amend(id, REALM, { description: 'Anna' }, actor, [1]),
        unconfirmed.amend(id, REALM, { description: 'Ben' }, actor, [1]),
      ]);
      await waitUntil(
        async () =>
          Number(
            (
              await pool.query(
                `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query LIKE '%from "ledger_transaction"%for update%'`,
              )
            ).rows[0].count,
          ) === 2,
      );
      await holder.query('COMMIT');
      const outcomes = await both;
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['AMENDED', 'VERSION_CONFLICT']);
      expect(outcomes.find((o) => o.kind === 'VERSION_CONFLICT')).toEqual(conflict(1, 2));
    } finally {
      holder.release();
    }
    expect((await state(id)).version).toBe(2);
  });
});

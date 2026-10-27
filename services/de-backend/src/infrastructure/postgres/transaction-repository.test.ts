import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  manualTransactionFingerprint,
  type BusinessDate,
  type FinancialAccountId,
  type NewManualTransaction,
} from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-1-04 persistence: exact Money and business dates, AuditRecord,
 * Idempotency-Key replay (also after close), rejections that roll back the key
 * claim, Realm isolation in the schema, and close-vs-create serialization.
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

describe.skipIf(databaseUrl === undefined)('PostgresTransactionRepository', () => {
  const schema = testSchemaName('transaction_test');
  let pool: pg.Pool;
  let transactions: PostgresTransactionRepository;
  let corrections: PostgresCorrectionRepository;
  let accounts: PostgresFinancialAccountRepository;
  let propertyReferences: PostgresPropertyReferenceRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    transactions = new PostgresTransactionRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    propertyReferences = new PostgresPropertyReferenceRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function openAccount(mreRealmId = REALM): Promise<FinancialAccountId> {
    const outcome = await accounts.create(
      { mreRealmId, accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR', iban: null },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }

  const rent = (financialAccountId: string, overrides: Partial<NewManualTransaction> = {}): NewManualTransaction => ({
    mreRealmId: REALM,
    financialAccountId,
    amount: Money.of('1250.00', 'EUR'),
    direction: 'INFLOW',
    bookingDate: '2026-09-01' as BusinessDate,
    valueDate: '2026-09-02' as BusinessDate,
    description: 'Miete September',
    propertyReferenceId: null,
    ...overrides,
  });
  const keyed = (key: string, transaction: NewManualTransaction) => ({ key, fingerprint: manualTransactionFingerprint(transaction) });
  const countFor = async (accountId: string) =>
    Number((await pool.query('SELECT count(*) FROM ledger_transaction WHERE financial_account_id = $1', [accountId])).rows[0].count);

  it('creates a MANUAL / UNREVIEWED Transaction with exact Money, text business dates and one AuditRecord', async () => {
    const accountId = await openAccount();
    const outcome = await transactions.createManual(rent(accountId, { amount: Money.of('0.10', 'EUR') }), actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    expect(outcome.transaction).toMatchObject({
      mreRealmId: REALM,
      financialAccountId: accountId,
      direction: 'INFLOW',
      bookingDate: '2026-09-01',
      valueDate: '2026-09-02',
      description: 'Miete September',
      provenance: 'MANUAL',
      status: 'UNREVIEWED',
      version: 1,
    });
    expect(outcome.transaction.amount.toJSON()).toEqual({ amount: '0.10', currency: 'EUR' });
    const row = await pool.query<{ amount: string; booking_date: string }>(
      `SELECT amount::text, booking_date::text FROM ledger_transaction WHERE id = $1`,
      [outcome.transaction.id],
    );
    expect(row.rows[0]).toEqual({ amount: '0.10', booking_date: '2026-09-01' });
    const audits = await pool.query(`SELECT action FROM audit_record WHERE entity_type = 'Transaction' AND entity_id = $1`, [
      outcome.transaction.id,
    ]);
    expect(audits.rows).toEqual([{ action: 'CREATED' }]);
  });

  it('links a PropertyReference of the same Realm; an unknown or foreign one is rejected', async () => {
    const accountId = await openAccount();
    const { reference } = await propertyReferences.linkOnce(
      {
        mreRealmId: REALM,
        mrePropertyId: '6512f0c2a1b2c3d4e5f60718',
        displayName: 'Wohnung 1',
        cachedAddress: null,
        cachedSurface: null,
        refreshedAt: new Date(),
      },
      actor,
    );
    const linked = await transactions.createManual(rent(accountId, { propertyReferenceId: reference.id }), actor);
    expect(linked).toMatchObject({ kind: 'CREATED', transaction: { propertyReferenceId: reference.id } });

    const foreign = await propertyReferences.linkOnce(
      {
        mreRealmId: OTHER_REALM,
        mrePropertyId: '6512f0c2a1b2c3d4e5f60719',
        displayName: null,
        cachedAddress: null,
        cachedSurface: null,
        refreshedAt: new Date(),
      },
      actor,
    );
    for (const propertyReferenceId of [foreign.reference.id, '00000000-0000-4000-8000-000000000000']) {
      expect(await transactions.createManual(rent(accountId, { propertyReferenceId }), actor)).toEqual({
        kind: 'REJECTED',
        reason: 'PROPERTY_REFERENCE_NOT_FOUND',
      });
    }
  });

  it.each([
    ['unknown account', async () => '00000000-0000-4000-8000-000000000000', 'ACCOUNT_NOT_FOUND'],
    ["another Realm's account", async () => openAccount(OTHER_REALM), 'ACCOUNT_NOT_FOUND'],
    ['not a UUID', async () => 'not-a-uuid', 'ACCOUNT_NOT_FOUND'],
  ])('rejects a Transaction on %s', async (_label, account, reason) => {
    const accountId = await account();
    expect(await transactions.createManual(rent(accountId), actor)).toEqual({ kind: 'REJECTED', reason });
  });

  it('rejects new Transactions on a closed account; earlier ones stay', async () => {
    const accountId = await openAccount();
    await transactions.createManual(rent(accountId), actor);
    await accounts.close(accountId, REALM, new Date(), actor);
    expect(await transactions.createManual(rent(accountId), actor)).toEqual({ kind: 'REJECTED', reason: 'ACCOUNT_CLOSED' });
    expect(await countFor(accountId)).toBe(1);
  });

  it('same key and payload replays the Transaction as created, also after the account was closed', async () => {
    const accountId = await openAccount();
    const transaction = rent(accountId);
    const first = await transactions.createManual(transaction, actor, keyed('tx-replay-1', transaction));
    if (first.kind !== 'CREATED') throw new Error(first.kind);
    await accounts.close(accountId, REALM, new Date(), actor);
    const replay = await transactions.createManual(transaction, actor, keyed('tx-replay-1', transaction));
    expect(replay).toEqual({ kind: 'REPLAYED', transaction: first.transaction });
    expect(await countFor(accountId)).toBe(1);
  });

  it('same key, different payload is a conflict', async () => {
    const accountId = await openAccount();
    const transaction = rent(accountId);
    await transactions.createManual(transaction, actor, keyed('tx-conflict-1', transaction));
    const changed = rent(accountId, { amount: Money.of('1250.01', 'EUR') });
    expect(await transactions.createManual(changed, actor, keyed('tx-conflict-1', changed))).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    expect(await countFor(accountId)).toBe(1);
  });

  it('a rejected request does not consume its key', async () => {
    const closedId = await openAccount();
    await accounts.close(closedId, REALM, new Date(), actor);
    const rejected = rent(closedId);
    expect(await transactions.createManual(rejected, actor, keyed('tx-retry-1', rejected))).toMatchObject({ kind: 'REJECTED' });

    // The client fixes the request and retries with the same key: a new request, not a conflict.
    const openId = await openAccount();
    const fixed = rent(openId);
    expect(await transactions.createManual(fixed, actor, keyed('tx-retry-1', fixed))).toMatchObject({ kind: 'CREATED' });
  });

  it('concurrent requests with the same key create exactly one Transaction', async () => {
    const accountId = await openAccount();
    const transaction = rent(accountId);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => transactions.createManual(transaction, actor, keyed('tx-race-1', transaction))),
    );
    expect(outcomes.filter((o) => o.kind === 'CREATED')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'REPLAYED')).toHaveLength(7);
    expect(await countFor(accountId)).toBe(1);
  });

  it('a create waiting on a close in progress sees the account closed (FOR SHARE vs FOR UPDATE)', async () => {
    const accountId = await openAccount();
    const closer = await pool.connect();
    try {
      // A close holds the row lock but has not committed yet ...
      await closer.query('BEGIN');
      await closer.query('SELECT 1 FROM financial_account WHERE id = $1 FOR UPDATE', [accountId]);
      const pending = transactions.createManual(rent(accountId), actor);
      await waitUntil(
        async () =>
          (
            await pool.query(
              `SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%financial_account%for share%'`,
            )
          ).rowCount !== 0,
      );
      // ... then commits: the waiting create re-reads the row and must refuse.
      await closer.query(`UPDATE financial_account SET status = 'CLOSED', closed_at = now() WHERE id = $1`, [accountId]);
      await closer.query('COMMIT');
      expect(await pending).toEqual({ kind: 'REJECTED', reason: 'ACCOUNT_CLOSED' });
      expect(await countFor(accountId)).toBe(0);
    } finally {
      closer.release();
    }
  });

  describe('confirm (VC-1-08)', () => {
    const eurSplit = (amount: string, financialCategoryCode: string) => ({
      amount: Money.of(amount, 'EUR'),
      financialCategoryCode,
      propertyReferenceId: null,
      loanId: null,
      description: null,
    });
    async function classified(): Promise<string> {
      const created = await transactions.createManual(rent(await openAccount()), actor);
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      const splits = new PostgresTransactionSplitRepository(createDatabase(pool));
      const outcome = await splits.replaceSplits(
        created.transaction.id,
        REALM,
        [eurSplit('1000.00', 'RENT_BASE'), eurSplit('250.00', 'RENT_OPERATING_COST_ADVANCE')],
        actor,
      );
      if (outcome.kind !== 'REPLACED') throw new Error(outcome.kind);
      return created.transaction.id;
    }
    const auditActions = async (id: string) =>
      (await pool.query(`SELECT action FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, new_version`, [id])).rows.map(
        (r: { action: string }) => r.action,
      );

    it('confirms a classified Transaction with who and when, bumps the version and audits; a repeat is a no-op', async () => {
      const id = await classified();
      const outcome = await transactions.confirm(id, REALM, actor);
      expect(outcome).toMatchObject({
        kind: 'CONFIRMED',
        replayed: false,
        transaction: { status: 'CONFIRMED', version: 3, confirmedBy: 'anna@example.com' },
      });
      if (outcome.kind !== 'CONFIRMED') throw new Error(outcome.kind);
      expect(outcome.transaction.confirmedAt).toBeInstanceOf(Date);

      const again = await transactions.confirm(id, REALM, actor);
      expect(again).toEqual({ kind: 'CONFIRMED', replayed: true, transaction: outcome.transaction });
      expect(await auditActions(id)).toEqual(['CREATED', 'SPLITS_REPLACED', 'CONFIRMED']);
    });

    it('refuses without splits, with a sum off, with an inactive category, and when CORRECTED or IGNORED', async () => {
      const unsplit = await transactions.createManual(rent(await openAccount()), actor);
      if (unsplit.kind !== 'CREATED') throw new Error(unsplit.kind);
      expect(await transactions.confirm(unsplit.transaction.id, REALM, actor)).toEqual({ kind: 'SPLITS_MISSING' });

      // The stored set was valid; a confirmation still re-checks the sum.
      const tampered = await classified();
      await pool.query(`UPDATE transaction_split SET amount = 249.99 WHERE transaction_id = $1 AND position = 2`, [tampered]);
      expect(await transactions.confirm(tampered, REALM, actor)).toMatchObject({
        kind: 'SUM_MISMATCH',
        actual: Money.of('1249.99', 'EUR'),
      });

      const retired = await classified();
      await pool.query(`UPDATE financial_category SET active = false WHERE code = 'RENT_OPERATING_COST_ADVANCE'`);
      try {
        expect(await transactions.confirm(retired, REALM, actor)).toEqual({
          kind: 'INACTIVE_CATEGORY',
          codes: ['RENT_OPERATING_COST_ADVANCE'],
        });
      } finally {
        await pool.query(`UPDATE financial_category SET active = true WHERE code = 'RENT_OPERATING_COST_ADVANCE'`);
      }

      const ignored = await classified();
      await pool.query(`UPDATE ledger_transaction SET status = 'IGNORED' WHERE id = $1`, [ignored]);
      expect(await transactions.confirm(ignored, REALM, actor)).toEqual({ kind: 'NOT_CONFIRMABLE', status: 'IGNORED' });
      const corrected = await classified();
      await transactions.confirm(corrected, REALM, actor);
      await corrections.correct(corrected, REALM, { reason: 'Datum', replacement: { bookingDate: '2026-09-02' as BusinessDate } }, actor);
      expect(await transactions.confirm(corrected, REALM, actor)).toEqual({ kind: 'NOT_CONFIRMABLE', status: 'CORRECTED' });
    });

    it('another Realm’s Transaction is not found', async () => {
      const id = await classified();
      expect(await transactions.confirm(id, OTHER_REALM, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await transactions.confirm('nope', REALM, actor)).toEqual({ kind: 'NOT_FOUND' });
    });

    it('two concurrent confirms: one confirms, the other is the no-op', async () => {
      const id = await classified();
      const outcomes = await Promise.all([transactions.confirm(id, REALM, actor), transactions.confirm(id, REALM, actor)]);
      expect(outcomes.map((o) => o.kind === 'CONFIRMED' && o.replayed).sort()).toEqual([false, true]);
      expect((await auditActions(id)).filter((a) => a === 'CONFIRMED')).toHaveLength(1);
    });

    it('the database keeps a confirmed Transaction and its splits immutable (ADR-037)', async () => {
      const id = await classified();
      await transactions.confirm(id, REALM, actor);
      const refused = [
        `UPDATE ledger_transaction SET amount = 1 WHERE id = $1`,
        `UPDATE ledger_transaction SET direction = 'OUTFLOW' WHERE id = $1`,
        `UPDATE ledger_transaction SET booking_date = '2026-09-02' WHERE id = $1`,
        `UPDATE ledger_transaction SET status = 'CLASSIFIED', confirmed_at = NULL, confirmed_by = NULL WHERE id = $1`,
        `UPDATE ledger_transaction SET confirmed_by = 'someone else' WHERE id = $1`,
        `DELETE FROM ledger_transaction WHERE id = $1`,
        `UPDATE transaction_split SET description = 'x' WHERE transaction_id = $1`,
        `DELETE FROM transaction_split WHERE transaction_id = $1`,
      ];
      for (const statement of refused) {
        await expect(pool.query(statement, [id]), statement).rejects.toThrow(/ADR-037/);
      }
      // Provenance and import identity are frozen too: a re-import must still find the confirmed payment.
      for (const statement of [
        `UPDATE ledger_transaction SET provenance = 'MIGRATION' WHERE id = $1`,
        `UPDATE ledger_transaction SET external_transaction_id = 'E-OTHER' WHERE id = $1`,
        `UPDATE ledger_transaction SET content_fingerprint = 'x' WHERE id = $1`,
      ]) {
        await expect(pool.query(statement, [id]), statement).rejects.toThrow(/ADR-037/);
      }
      // VC-1-11: description and PropertyReference too; every change goes through a correction (api-design §35.6).
      for (const statement of [
        `UPDATE ledger_transaction SET description = 'Miete Sept.' WHERE id = $1`,
        `UPDATE ledger_transaction SET property_reference_id = gen_random_uuid() WHERE id = $1`,
      ]) {
        await expect(pool.query(statement, [id]), statement).rejects.toThrow(/ADR-037/);
      }
      // Non-cash bookkeeping stays possible: the later states.
      await pool.query(`UPDATE ledger_transaction SET status = 'RECONCILED', version = version + 1 WHERE id = $1`, [id]);
      // confirmed_at and confirmed_by exist exactly for confirmed states.
      const unconfirmed = await classified();
      await expect(pool.query(`UPDATE ledger_transaction SET status = 'CONFIRMED' WHERE id = $1`, [unconfirmed])).rejects.toThrow(
        /ledger_transaction_confirmed/,
      );
    });
    it('the status of a confirmed Transaction only moves forward; CORRECTED is terminal', async () => {
      const setStatus = (id: string, status: string) => pool.query(`UPDATE ledger_transaction SET status = $2, version = version + 1 WHERE id = $1`, [id, status]);
      const confirmedOne = async () => {
        const id = await classified();
        await transactions.confirm(id, REALM, actor);
        return id;
      };

      const reconciled = await confirmedOne();
      await setStatus(reconciled, 'RECONCILED');
      await expect(setStatus(reconciled, 'CONFIRMED')).rejects.toThrow(/ADR-037/);
      // RECONCILED → CORRECTED is a forward step, but only with its reversal and replacement (0011, checked at commit).
      await expect(setStatus(reconciled, 'CORRECTED')).rejects.toThrow(/without its reversal/);

      const corrected = await confirmedOne();
      const outcome = await corrections.correct(corrected, REALM, { reason: 'Datum', replacement: { bookingDate: '2026-09-02' as BusinessDate } }, actor);
      expect(outcome.kind).toBe('CORRECTED');
      for (const back of ['CONFIRMED', 'RECONCILED', 'CLASSIFIED', 'IGNORED']) {
        await expect(setStatus(corrected, back), back).rejects.toThrow(/ADR-037|ledger_transaction_confirmed/);
      }
      await expect(setStatus(await confirmedOne(), 'IGNORED')).rejects.toThrow(/ADR-037|ledger_transaction_confirmed/);
    });
  });

  it('the schema itself refuses foreign-Realm references, negative or over-scaled amounts', async () => {
    const foreignAccount = await openAccount(OTHER_REALM);
    const insert = (realm: string, account: string, amount: string) =>
      pool.query(
        `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by)
         VALUES ($1, $2, $3, 'EUR', 'INFLOW', '2026-09-01', 'MANUAL', 'UNREVIEWED', 'a')`,
        [realm, account, amount],
      );
    await expect(insert(REALM, foreignAccount, '1.00')).rejects.toThrow(/foreign key/);
    const accountId = await openAccount();
    await expect(insert(REALM, accountId, '-1.00')).rejects.toThrow(/check constraint/);
    await expect(insert(REALM, accountId, '1.005')).rejects.toThrow(/check constraint/);
  });
});

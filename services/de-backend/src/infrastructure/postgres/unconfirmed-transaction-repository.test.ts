import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate, FinancialAccountId } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresUnconfirmedTransactionRepository } from './unconfirmed-transaction-repository.js';

/** VC-X-16 persistence (api-design.md §31.3–31.4): amend, ignore and restore an unconfirmed Transaction. */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
const date = (value: string) => value as BusinessDate;

describe.skipIf(databaseUrl === undefined)('PostgresUnconfirmedTransactionRepository', () => {
  const schema = testSchemaName('unconfirmed_test');
  let pool: pg.Pool;
  let unconfirmed: PostgresUnconfirmedTransactionRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
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
    unconfirmed = new PostgresUnconfirmedTransactionRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    properties = new PostgresPropertyReferenceRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function openAccount(mreRealmId = REALM): Promise<string> {
    const outcome = await accounts.create({ mreRealmId, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }
  async function manual(accountId?: string): Promise<string> {
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: accountId ?? (await openAccount()),
        amount: eur('1250.00'),
        direction: 'INFLOW',
        bookingDate: date('2026-09-01'),
        valueDate: date('2026-09-02'),
        description: 'Miete September',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  async function classified(accountId?: string): Promise<string> {
    const id = await manual(accountId);
    const outcome = await splits.replaceSplits(
      id,
      REALM,
      [
        { amount: eur('1000.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: null, loanId: null, securityDepositId: null, description: null },
        {
          amount: eur('250.00'),
          financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE',
          propertyReferenceId: null,
          loanId: null,
          securityDepositId: null,
          description: null,
        },
      ],
      actor,
    );
    if (outcome.kind !== 'REPLACED') throw new Error(outcome.kind);
    return id;
  }
  const splitCount = async (id: string) => Number((await pool.query(`SELECT count(*) FROM transaction_split WHERE transaction_id = $1`, [id])).rows[0].count);
  const audits = async (id: string) =>
    (await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, new_version`, [id])).rows as {
      action: string;
      metadata: Record<string, unknown>;
    }[];

  describe('amend', () => {
    it('changes the given fields, bumps the version and audits old and new values', async () => {
      const id = await manual();
      const reference = (
        await properties.linkOnce(
          {
            mreRealmId: REALM,
            mrePropertyId: '64b0c0ffee00000000000d01',
            displayName: null,
            cachedAddress: null,
            cachedSurface: null,
            refreshedAt: new Date(),
          },
          actor,
        )
      ).reference.id;
      const outcome = await unconfirmed.amend(
        id,
        REALM,
        { amount: eur('1200.00'), bookingDate: date('2026-09-03'), valueDate: null, propertyReferenceId: reference },
        actor,
      );
      expect(outcome).toMatchObject({
        kind: 'AMENDED',
        changed: true,
        transaction: { bookingDate: '2026-09-03', valueDate: null, propertyReferenceId: reference, status: 'UNREVIEWED', version: 2 },
      });
      expect((await audits(id)).at(-1)).toEqual({
        action: 'AMENDED',
        metadata: {
          changes: {
            amount: { from: { amount: '1250.00', currency: 'EUR' }, to: { amount: '1200.00', currency: 'EUR' } },
            bookingDate: { from: '2026-09-01', to: '2026-09-03' },
            valueDate: { from: '2026-09-02', to: null },
            propertyReferenceId: { from: null, to: reference },
          },
        },
      });
    });

    it('the same values again are a no-op without a new version or AuditRecord', async () => {
      const id = await manual();
      const outcome = await unconfirmed.amend(id, REALM, { amount: eur('1250'), description: 'Miete September' }, actor);
      expect(outcome).toMatchObject({ kind: 'AMENDED', changed: false, transaction: { version: 1 } });
      expect((await audits(id)).map((a) => a.action)).toEqual(['CREATED']);
    });

    it('a changed amount drops the split set and returns a CLASSIFIED Transaction to UNREVIEWED; other changes keep it', async () => {
      const kept = await classified();
      expect(await unconfirmed.amend(kept, REALM, { description: 'Kaltmiete + NK' }, actor)).toMatchObject({
        splitsDropped: false,
        transaction: { status: 'CLASSIFIED' },
      });
      expect(await splitCount(kept)).toBe(2);

      const dropped = await classified();
      expect(await unconfirmed.amend(dropped, REALM, { amount: eur('1200.00') }, actor)).toMatchObject({
        splitsDropped: true,
        transaction: { status: 'UNREVIEWED' },
      });
      expect(await splitCount(dropped)).toBe(0);
      expect((await audits(dropped)).at(-1)?.metadata).toMatchObject({ splitsDropped: true, previousStatus: 'CLASSIFIED', status: 'UNREVIEWED' });
      // It can be split again for the new amount and confirmed.
      const resplit = await splits.replaceSplits(
        dropped,
        REALM,
        [{ amount: eur('1200.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: null, loanId: null, securityDepositId: null, description: null }],
        actor,
      );
      expect(resplit.kind).toBe('REPLACED');
      expect((await transactions.confirm(dropped, REALM, actor)).kind).toBe('CONFIRMED');
    });

    it('an imported Transaction keeps the values of its bank row, the Verwendungszweck included (review on #23)', async () => {
      const id = await manual();
      await pool.query(`UPDATE ledger_transaction SET provenance = 'BANK_CSV', status = 'IMPORTED' WHERE id = $1`, [id]);
      expect(await unconfirmed.amend(id, REALM, { amount: eur('1.00'), direction: 'OUTFLOW' }, actor)).toEqual({
        kind: 'IMPORTED_FIELDS_FIXED',
        fields: ['amount', 'direction'],
      });
      expect(await unconfirmed.amend(id, REALM, { description: 'Miete Whg. 3' }, actor)).toEqual({
        kind: 'IMPORTED_FIELDS_FIXED',
        fields: ['description'],
      });
      const reference = (
        await properties.linkOnce(
          {
            mreRealmId: REALM,
            mrePropertyId: '64b0c0ffee00000000000d02',
            displayName: null,
            cachedAddress: null,
            cachedSurface: null,
            refreshedAt: new Date(),
          },
          actor,
        )
      ).reference.id;
      expect(await unconfirmed.amend(id, REALM, { propertyReferenceId: reference }, actor)).toMatchObject({
        kind: 'AMENDED',
        transaction: { propertyReferenceId: reference, status: 'IMPORTED', provenance: 'BANK_CSV' },
      });
      // The bank text is untouched.
      expect((await pool.query(`SELECT description FROM ledger_transaction WHERE id = $1`, [id])).rows).toEqual([{ description: 'Miete September' }]);
    });

    it('moves to another open account of the Realm; refuses a different closed one, a foreign one and a confirmed Transaction', async () => {
      const own = await openAccount();
      const id = await manual(own);
      const closed = await openAccount();
      await accounts.close(closed as FinancialAccountId, REALM, new Date(), actor);
      expect(await unconfirmed.amend(id, REALM, { financialAccountId: closed }, actor)).toEqual({ kind: 'ACCOUNT_CLOSED', financialAccountId: closed });
      const foreign = await openAccount(OTHER_REALM);
      expect(await unconfirmed.amend(id, REALM, { financialAccountId: foreign }, actor)).toEqual({ kind: 'ACCOUNT_NOT_FOUND', financialAccountId: foreign });
      const other = await openAccount();
      expect(await unconfirmed.amend(id, REALM, { financialAccountId: other }, actor)).toMatchObject({ transaction: { financialAccountId: other } });

      // Its own account closed since: amending the other fields still works.
      const onClosed = await manual(own);
      await accounts.close(own as FinancialAccountId, REALM, new Date(), actor);
      expect(await unconfirmed.amend(onClosed, REALM, { amount: eur('99.00') }, actor)).toMatchObject({ kind: 'AMENDED', changed: true });

      const confirmed = await classified();
      await transactions.confirm(confirmed, REALM, actor);
      expect(await unconfirmed.amend(confirmed, REALM, { description: 'x' }, actor)).toEqual({ kind: 'NOT_AMENDABLE', status: 'CONFIRMED' });
      expect(await unconfirmed.amend(id, OTHER_REALM, { description: 'x' }, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await unconfirmed.amend(id, REALM, { propertyReferenceId: '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b' }, actor)).toEqual({
        kind: 'PROPERTY_REFERENCE_NOT_FOUND',
        propertyReferenceId: '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b',
      });
    });
  });

  describe('ignore / restore', () => {
    it('ignores with a reason, keeps the splits frozen meanwhile, and restores to CLASSIFIED', async () => {
      const id = await classified();
      const ignored = await unconfirmed.ignore(id, REALM, 'Doppelt erfasst', actor);
      expect(ignored).toMatchObject({ kind: 'IGNORED', replayed: false, transaction: { status: 'IGNORED', version: 3 } });
      expect(await unconfirmed.ignore(id, REALM, 'nochmal', actor)).toMatchObject({ kind: 'IGNORED', replayed: true, transaction: { version: 3 } });
      expect((await audits(id)).filter((a) => a.action === 'IGNORED')).toEqual([
        { action: 'IGNORED', metadata: { reason: 'Doppelt erfasst', previousStatus: 'CLASSIFIED' } },
      ]);
      // Out of the ledger: not confirmable, not amendable, splits frozen.
      expect(await transactions.confirm(id, REALM, actor)).toEqual({ kind: 'NOT_CONFIRMABLE', status: 'IGNORED' });
      expect(await unconfirmed.amend(id, REALM, { description: 'x' }, actor)).toEqual({ kind: 'NOT_AMENDABLE', status: 'IGNORED' });
      expect(
        await splits.replaceSplits(
          id,
          REALM,
          [{ amount: eur('1250.00'), financialCategoryCode: 'OTHER', propertyReferenceId: null, loanId: null, securityDepositId: null, description: null }],
          actor,
        ),
      ).toEqual({ kind: 'FROZEN', status: 'IGNORED' });

      expect(await unconfirmed.restore(id, REALM, actor)).toMatchObject({ kind: 'RESTORED', transaction: { status: 'CLASSIFIED', version: 4 } });
      expect(await splitCount(id)).toBe(2);
      expect((await transactions.confirm(id, REALM, actor)).kind).toBe('CONFIRMED');
      expect(await unconfirmed.restore(id, REALM, actor)).toEqual({ kind: 'NOT_IGNORED', status: 'CONFIRMED' });
    });

    it('restores to the entry status without splits; a confirmed Transaction cannot be ignored', async () => {
      const id = await manual();
      await unconfirmed.ignore(id, REALM, 'Test', actor);
      expect(await unconfirmed.restore(id, REALM, actor)).toMatchObject({ transaction: { status: 'UNREVIEWED' } });

      const confirmed = await classified();
      await transactions.confirm(confirmed, REALM, actor);
      expect(await unconfirmed.ignore(confirmed, REALM, 'x', actor)).toEqual({ kind: 'NOT_IGNORABLE', status: 'CONFIRMED' });
      expect(await unconfirmed.ignore(confirmed, OTHER_REALM, 'x', actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await unconfirmed.restore('nope', REALM, actor)).toEqual({ kind: 'NOT_FOUND' });
    });
  });
});

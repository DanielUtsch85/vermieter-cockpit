import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate, FinancialAccountId } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionQueries } from './transaction-query-repository.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/** VC-X-21 (api-design.md §30.1): reading one Transaction with its splits, and a filtered page, Realm-scoped. */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');

describe.skipIf(databaseUrl === undefined)('PostgresTransactionQueries', () => {
  const schema = testSchemaName('transaction_query_test');
  let pool: pg.Pool;
  let queries: PostgresTransactionQueries;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let accounts: PostgresFinancialAccountRepository;
  let properties: PostgresPropertyReferenceRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    queries = new PostgresTransactionQueries(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    properties = new PostgresPropertyReferenceRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function openAccount(mreRealmId = REALM): Promise<FinancialAccountId> {
    const outcome = await accounts.create({ mreRealmId, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }
  async function book(financialAccountId: string, bookingDate: string, amount = '10.00', propertyReferenceId: string | null = null, mreRealmId = REALM) {
    const created = await transactions.createManual(
      {
        mreRealmId,
        financialAccountId,
        amount: eur(amount),
        direction: 'OUTFLOW',
        bookingDate: bookingDate as BusinessDate,
        valueDate: null,
        description: null,
        propertyReferenceId,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  const property = async (mrePropertyId: string) =>
    (
      await properties.linkOnce(
        { mreRealmId: REALM, mrePropertyId, displayName: null, cachedAddress: null, cachedSurface: null, refreshedAt: new Date() },
        actor,
      )
    ).reference.id;

  it('get: the Transaction with its splits in position order; unknown and foreign ones are undefined', async () => {
    const account = await openAccount();
    const id = await book(account, '2026-09-01', '1250.00');
    await splits.replaceSplits(
      id,
      REALM,
      [
        { amount: eur('1000.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: null, description: 'Kalt' },
        { amount: eur('250.00'), financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', propertyReferenceId: null, description: null },
      ],
      actor,
    );
    const found = await queries.get(id, REALM);
    expect(found?.transaction).toMatchObject({ id, status: 'CLASSIFIED', version: 2, bookingDate: '2026-09-01' });
    expect(found?.splits.map((s) => [s.position, s.amount.toJSON().amount, s.financialCategoryCode, s.description])).toEqual([
      [1, '1000.00', 'RENT_BASE', 'Kalt'],
      [2, '250.00', 'RENT_OPERATING_COST_ADVANCE', null],
    ]);
    expect(await queries.get(id, OTHER_REALM)).toBeUndefined();
    expect(await queries.get('nope', REALM)).toBeUndefined();
    expect(await queries.get('0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b', REALM)).toBeUndefined();
  });

  it('list: newest booking first, paged with a total; filters by account, status, dates and PropertyReference', async () => {
    const account = await openAccount();
    const other = await openAccount();
    const ids = [];
    for (const day of ['01', '02', '03', '04', '05']) ids.push(await book(account, `2026-08-${day}`));
    await book(other, '2026-08-03');
    await book(await openAccount(OTHER_REALM), '2026-08-03', '10.00', null, OTHER_REALM);

    const first = await queries.list(REALM, { financialAccountId: account }, { page: 1, pageSize: 2 });
    expect(first.total).toBe(5);
    expect(first.items.map((t) => t.bookingDate)).toEqual(['2026-08-05', '2026-08-04']);
    const last = await queries.list(REALM, { financialAccountId: account }, { page: 3, pageSize: 2 });
    expect(last.items.map((t) => t.id)).toEqual([ids[0]]);
    expect((await queries.list(REALM, { financialAccountId: account }, { page: 4, pageSize: 2 })).items).toEqual([]);

    const range = await queries.list(
      REALM,
      { financialAccountId: account, bookingDateFrom: '2026-08-02' as BusinessDate, bookingDateTo: '2026-08-03' as BusinessDate },
      { page: 1, pageSize: 50 },
    );
    expect(range.items.map((t) => t.bookingDate)).toEqual(['2026-08-03', '2026-08-02']);

    await pool.query(`UPDATE ledger_transaction SET status = 'IGNORED' WHERE id = $1`, [ids[1]]);
    const ignored = await queries.list(REALM, { financialAccountId: account, statuses: ['IGNORED'] }, { page: 1, pageSize: 50 });
    expect(ignored.items.map((t) => t.id)).toEqual([ids[1]]);
    expect((await queries.list(REALM, { financialAccountId: account, statuses: ['UNREVIEWED', 'IMPORTED'] }, { page: 1, pageSize: 50 })).total).toBe(4);
    // No status can match: an empty page, not `IN ()` (review on #26).
    expect(await queries.list(REALM, { statuses: [] }, { page: 2, pageSize: 10 })).toEqual({ items: [], page: 2, pageSize: 10, total: 0 });

    // The other Realm's Transaction on 2026-08-03 never shows; another account's only without the account filter.
    expect((await queries.list(REALM, { bookingDateFrom: '2026-08-03' as BusinessDate, bookingDateTo: '2026-08-03' as BusinessDate }, { page: 1, pageSize: 50 })).items.every((t) => t.mreRealmId === REALM)).toBe(true);
    expect((await queries.list(REALM, { financialAccountId: '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b' }, { page: 1, pageSize: 50 })).total).toBe(0);
  });

  it('list by PropertyReference: the Transaction’s own or one of its splits', async () => {
    const account = await openAccount();
    const reference = await property('64b0c0ffee00000000000e01');
    const own = await book(account, '2026-07-01', '10.00', reference);
    const viaSplit = await book(account, '2026-07-02', '10.00');
    await splits.replaceSplits(viaSplit, REALM, [{ amount: eur('10.00'), financialCategoryCode: 'OTHER', propertyReferenceId: reference, description: null }], actor);
    await book(account, '2026-07-03');
    const page = await queries.list(REALM, { propertyReferenceId: reference }, { page: 1, pageSize: 50 });
    expect(page.items.map((t) => t.id)).toEqual([viaSplit, own]);
    expect(page.total).toBe(2);
  });
});

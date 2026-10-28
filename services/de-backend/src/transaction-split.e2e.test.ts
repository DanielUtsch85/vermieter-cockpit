import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  confirmTransaction,
  createFinancialAccount,
  createManualTransaction,
  getFinancialCategory,
  listFinancialCategories,
  setTransactionSplits,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresFinancialCategoryRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';

/** VC-1-07/08 end to end, wired as in main.ts, against a fake MRE and PostgreSQL. */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000000a';
const REALM_B = '64b0c0ffee0000000000000b';

describe.skipIf(databaseUrl === undefined)('transaction splits end to end', () => {
  const schema = testSchemaName('split_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });

    const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
    mre = await startFakeMre([
      { _id: REALM_A, name: 'A', members: member, applications: [] },
      { _id: REALM_B, name: 'B', members: member, applications: [] },
    ]);
    const db = createDatabase(pool);
    const categories = new PostgresFinancialCategoryRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    server = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 })),
      ...commandsWith({
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          confirm: confirmTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
        },
        financialCategories: { list: listFinancialCategories({ categories }), get: getFinancialCategory({ categories }) },
      }),
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.end();
  });

  const call = (realm: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${signJwt({ account: { email: 'anna@example.com' } })}`,
        organizationid: realm,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function loanPayment(realm = REALM_A): Promise<string> {
    const account = (await (await call(realm, 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' })).json()) as {
      financialAccountId: string;
    };
    const tx = (await (
      await call(realm, 'POST', '/transactions', {
        financialAccountId: account.financialAccountId,
        amount: { amount: '1200.00', currency: 'EUR' },
        direction: 'OUTFLOW',
        bookingDate: '2026-09-30',
      })
    ).json()) as { transactionId: string };
    return tx.transactionId;
  }
  const eur = (amount: string) => ({ amount, currency: 'EUR' });

  it('splits a loan payment, refuses a cent off, repeats idempotently and freezes once confirmed', async () => {
    const id = await loanPayment();
    const body = {
      splits: [
        { amount: eur('612.40'), financialCategoryCode: 'LOAN_INTEREST' },
        { amount: eur('587.60'), financialCategoryCode: 'LOAN_PRINCIPAL' },
      ],
    };
    const first = await call(REALM_A, 'PUT', `/transactions/${id}/splits`, body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: 'CLASSIFIED',
      version: 2,
      direction: 'OUTFLOW',
      splits: [{ position: 1 }, { position: 2 }],
    });

    const off = await call(REALM_A, 'PUT', `/transactions/${id}/splits`, {
      splits: [
        { amount: eur('612.40'), financialCategoryCode: 'LOAN_INTEREST' },
        { amount: eur('587.59'), financialCategoryCode: 'LOAN_PRINCIPAL' },
      ],
    });
    expect(off.status).toBe(409);
    expect(await off.json()).toMatchObject({ error: { code: 'INVARIANT_VIOLATION', details: { difference: eur('0.01') } } });

    const again = await call(REALM_A, 'PUT', `/transactions/${id}/splits`, body);
    expect(await again.json()).toMatchObject({ version: 2 });

    // Confirm through the API; a split change afterwards is frozen, a repeated confirm a no-op.
    const unsplit = await loanPayment();
    const notYet = await call(REALM_A, 'POST', `/transactions/${unsplit}/confirm`);
    expect(notYet.status).toBe(409);
    expect(await notYet.json()).toMatchObject({ error: { details: { reason: 'SPLITS_MISSING' } } });
    const confirmed = await call(REALM_A, 'POST', `/transactions/${id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ status: 'CONFIRMED', version: 3, confirmedBy: 'anna@example.com' });
    const repeated = await call(REALM_A, 'POST', `/transactions/${id}/confirm`);
    expect(repeated.headers.get('idempotent-replayed')).toBe('true');
    expect((await call(REALM_B, 'POST', `/transactions/${id}/confirm`)).status).toBe(404);
    const frozen = await call(REALM_A, 'PUT', `/transactions/${id}/splits`, {
      splits: [{ amount: eur('1200'), financialCategoryCode: 'OTHER' }],
    });
    expect(frozen.status).toBe(409);
    expect(await frozen.json()).toMatchObject({ error: { details: { reason: 'TRANSACTION_FROZEN', status: 'CONFIRMED' } } });

    const rows = await pool.query('SELECT amount::text FROM transaction_split WHERE transaction_id = $1 ORDER BY position', [id]);
    expect(rows.rows).toEqual([{ amount: '612.40' }, { amount: '587.60' }]);
  });

  it("another Realm's Transaction is 404; an unknown category is 400", async () => {
    const foreign = await loanPayment(REALM_B);
    expect((await call(REALM_A, 'PUT', `/transactions/${foreign}/splits`, { splits: [{ amount: eur('1200'), financialCategoryCode: 'OTHER' }] })).status).toBe(
      404,
    );
    const id = await loanPayment();
    const unknown = await call(REALM_A, 'PUT', `/transactions/${id}/splits`, {
      splits: [{ amount: eur('1200'), financialCategoryCode: 'NOT_A_CATEGORY' }],
    });
    expect(unknown.status).toBe(400);
  });

  it('serves the category catalog', async () => {
    const list = (await (await call(REALM_A, 'GET', '/financial-categories')).json()) as { items: { code: string }[] };
    expect(list.items.map((c) => c.code)).toEqual(expect.arrayContaining(['LOAN_INTEREST', 'LOAN_PRINCIPAL', 'RENT_BASE']));
    expect(await (await call(REALM_A, 'GET', '/financial-categories/RENT_BASE')).json()).toMatchObject({
      name: 'Kaltmiete',
      categoryType: 'INCOME',
    });
  });
});

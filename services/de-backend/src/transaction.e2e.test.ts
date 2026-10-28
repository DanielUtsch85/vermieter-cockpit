import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import { closeFinancialAccount, createFinancialAccount, createManualTransaction } from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresTransactionRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';

/** VC-1-04 end to end, wired as in main.ts, against a fake MRE and PostgreSQL. */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000000a';
const REALM_B = '64b0c0ffee0000000000000b';

describe.skipIf(databaseUrl === undefined)('manual Transactions end to end', () => {
  const schema = testSchemaName('transaction_e2e');
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
    const accounts = new PostgresFinancialAccountRepository(db);
    server = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 })),
      ...commandsWith({
        financialAccounts: { create: createFinancialAccount({ repository: accounts }), close: closeFinancialAccount({ repository: accounts }) },
        transactions: { createManual: createManualTransaction({ repository: new PostgresTransactionRepository(db) }) },
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

  const call = (realm: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/v1${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signJwt({ account: { email: 'anna@example.com' } })}`,
        organizationid: realm,
        'content-type': 'application/json',
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const newAccount = async (realm = REALM_A) =>
    ((await (await call(realm, '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' })).json()) as {
      financialAccountId: string;
    }).financialAccountId;
  const rent = (financialAccountId: string) => ({
    financialAccountId,
    amount: { amount: '1250.00', currency: 'EUR' },
    direction: 'INFLOW',
    bookingDate: '2026-09-01',
    description: 'Miete September',
  });

  it('books, replays with the same key, refuses a changed payload, and refuses a closed account', async () => {
    const accountId = await newAccount();
    const first = await call(REALM_A, '/transactions', rent(accountId), { 'idempotency-key': 'e2e-tx-1' });
    expect(first.status).toBe(201);
    const created = (await first.json()) as Record<string, unknown>;
    expect(created).toMatchObject({ amount: { amount: '1250.00', currency: 'EUR' }, provenance: 'MANUAL', status: 'UNREVIEWED' });

    const replay = await call(REALM_A, '/transactions', { ...rent(accountId), amount: { amount: '1250', currency: 'EUR' } }, {
      'idempotency-key': 'e2e-tx-1',
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);

    const conflict = await call(REALM_A, '/transactions', { ...rent(accountId), direction: 'OUTFLOW' }, { 'idempotency-key': 'e2e-tx-1' });
    expect(conflict.status).toBe(409);

    expect((await call(REALM_A, `/financial-accounts/${accountId}/close`)).status).toBe(200);
    const closed = await call(REALM_A, '/transactions', rent(accountId));
    expect(closed.status).toBe(409);
    expect(await closed.json()).toMatchObject({ error: { details: { reason: 'ACCOUNT_CLOSED' } } });

    const count = await pool.query('SELECT count(*) FROM ledger_transaction WHERE financial_account_id = $1', [accountId]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("another Realm's account is 404", async () => {
    const foreign = await newAccount(REALM_B);
    expect((await call(REALM_A, '/transactions', rent(foreign))).status).toBe(404);
  });
});

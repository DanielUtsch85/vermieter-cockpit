import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { unusedCommands } from './api/app.test-support.js';
import { closeFinancialAccount, createFinancialAccount } from './application/index.js';
import { PostgresFinancialAccountRepository, createDatabase, migrateToLatest } from './infrastructure/postgres/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-1-03 end to end, wired as in main.ts: real HTTP app, MRE-verified access
 * and the PostgreSQL repository, against a fake MRE.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000000a';
const REALM_B = '64b0c0ffee0000000000000b';

describe.skipIf(databaseUrl === undefined)('financial-accounts create + close end to end', () => {
  const schema = `financial_account_e2e_${process.pid}_${Date.now()}`;
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
    const repository = new PostgresFinancialAccountRepository(createDatabase(pool));
    server = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 })),
      ...unusedCommands,
      createFinancialAccount: createFinancialAccount({ repository }),
      closeFinancialAccount: closeFinancialAccount({ repository }),
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
    fetch(`${base}/api/v1/financial-accounts${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signJwt({ account: { email: 'anna@example.com' } })}`,
        organizationid: realm,
        'content-type': 'application/json',
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const count = async () => Number((await pool.query('SELECT count(*) FROM financial_account')).rows[0].count);
  const girokonto = { accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR', iban: 'DE89 3704 0044 0532 0130 00' };

  it('creates once per Idempotency-Key: replay returns the same account, a changed payload is 409', async () => {
    const first = await call(REALM_A, '', girokonto, { 'idempotency-key': 'e2e-1' });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { financialAccountId: string; iban: string; status: string };
    expect(created).toMatchObject({ iban: 'DE89370400440532013000', status: 'OPEN' });

    const replay = await call(REALM_A, '', { ...girokonto, iban: 'DE89370400440532013000' }, { 'idempotency-key': 'e2e-1' });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(((await replay.json()) as { financialAccountId: string }).financialAccountId).toBe(created.financialAccountId);

    const conflict = await call(REALM_A, '', { ...girokonto, displayName: 'Anders' }, { 'idempotency-key': 'e2e-1' });
    expect(conflict.status).toBe(409);
    expect(await count()).toBe(1);
  });

  it('a replay after close repeats the original 201 body (OPEN, v1), not the current state', async () => {
    const body = { accountType: 'BANK', displayName: 'Replay nach Close', currency: 'EUR' };
    const first = await call(REALM_A, '', body, { 'idempotency-key': 'e2e-close-1' });
    const original = (await first.json()) as { financialAccountId: string };
    expect((await call(REALM_A, `/${original.financialAccountId}/close`)).status).toBe(200);

    const replay = await call(REALM_A, '', body, { 'idempotency-key': 'e2e-close-1' });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual(original);
    expect(original).toMatchObject({ status: 'OPEN', closedAt: null, version: 1 });
  });

  it("closes an account of the caller's Realm; another Realm's account is 404", async () => {
    const created = (await (await call(REALM_A, '', { accountType: 'CASH', displayName: 'Kasse', currency: 'EUR' })).json()) as {
      financialAccountId: string;
    };
    expect((await call(REALM_B, `/${created.financialAccountId}/close`)).status).toBe(404);
    const closed = await call(REALM_A, `/${created.financialAccountId}/close`);
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ status: 'CLOSED', version: 2 });
    const again = await call(REALM_A, `/${created.financialAccountId}/close`);
    expect(await again.json()).toMatchObject({ status: 'CLOSED', version: 2 });
  });
});

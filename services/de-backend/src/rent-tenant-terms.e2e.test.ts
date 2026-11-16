import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import { confirmTransaction, createFinancialAccount, createManualTransaction, createReconciliation, setTransactionSplits } from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresRentReconciliationRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre, type FakeRealm } from './integrations/mre/fake-mre.test-support.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { rentTenantTermCommands } from './rent-tenant-terms.test-support.js';
import { mrePrincipalVerifier, mreRentTermLookup } from './wiring.js';

/**
 * §37.7 end to end (#364, VC-X-72), wired as in main.ts, against a fake MRE and PostgreSQL: the Tenants from DE alone,
 * a Tenant's terms from MRE's Tenant list and month reads beside DE's matches, `NOT_RETURNED` and `UNAVAILABLE` with
 * DE's side, the window's edges, Realm isolation, and no name in an answer. Synthetic data only.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee00000000000030';
const REALM_B = '64b0c0ffee00000000000031';
const REALM_EMPTY = '64b0c0ffee00000000000032';
const TENANT = '6512f0c2a1b2c3d4e5f61a01';
const NEIGHBOUR = '6512f0c2a1b2c3d4e5f61a02';
const TENANT_B = '6512f0c2a1b2c3d4e5f61b01';
const UNKNOWN = '6512f0c2a1b2c3d4e5f61aff';
const NAME = 'Mieterin Synthetisch';
const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
const realmA: FakeRealm = {
  _id: REALM_A,
  name: 'A',
  members: member,
  applications: [],
  tenants: [
    { _id: TENANT, name: NAME, contacts: [{ email: 'mieterin@example.com' }] },
    { _id: NEIGHBOUR, name: 'Nachbar' },
  ],
  rents: { [TENANT]: [2026120100, 2027010100, 2027020100, 2027030100, 2027040100], [NEIGHBOUR]: [2027020100] },
  // February: MRE's float, rounded half-up to the cent (§37.2).
  rentTerms: { [`${TENANT}/2027020100`]: { totalWithoutBalanceAmount: 799.9999999999999 }, [`${NEIGHBOUR}/2027020100`]: { totalWithoutBalanceAmount: 650 } },
};
const realmB: FakeRealm = { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [{ _id: TENANT_B }], rents: { [TENANT_B]: [2027020100] } };
const realmEmpty: FakeRealm = { _id: REALM_EMPTY, name: 'E', members: member, applications: [], tenants: [] };

describe.skipIf(databaseUrl === undefined)('choosing the Tenant and the term end to end (§37.7)', () => {
  const schema = testSchemaName('rent_tenant_terms_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let downServer: Server;
  let base: string;
  let downBase: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    mre = await startFakeMre([realmA, realmB, realmEmpty]);
    const db = createDatabase(pool);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const transactions = new PostgresTransactionRepository(db);
    const commands = (readClient: HttpMreClient) => ({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        rentReconciliations: {
          create: createReconciliation({ repository: new PostgresRentReconciliationRepository(db), lookupMreRentTerm: mreRentTermLookup(client) }),
          ...rentTenantTermCommands(db, readClient),
        },
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          confirm: confirmTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
        },
      }),
    });
    server = createApp(commands(client)).listen(0, '127.0.0.1');
    // The same app, but the term list asks an MRE that is down (nothing listens on port 1).
    downServer = createApp(commands(new HttpMreClient({ apiBaseUrl: 'http://127.0.0.1:1/api/v2', timeoutMs: 500 }))).listen(0, '127.0.0.1');
    await Promise.all([server, downServer].map((s) => new Promise<void>((resolve) => s.once('listening', () => resolve()))));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    downBase = `http://127.0.0.1:${(downServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all([server, downServer].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    await mre.close();
    await pool.end();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 300);
  const call = (realm: string, method: string, path: string, body?: unknown, at = base) =>
    fetch(`${at}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  const audits = async () => Number((await pool.query(`SELECT count(*) FROM audit_record`)).rows[0].count);
  const reconciliationRows = async () => Number((await pool.query(`SELECT count(*) FROM rent_payment_reconciliation`)).rows[0].count);

  /** A confirmed rent inflow of `amount`, matched in DE to the Tenant's term with `matched`. */
  async function matched(realm: string, tenant: string, term: string, matchedAmount: string, amount = '800.00') {
    const account = (await (await call(realm, 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' })).json()) as {
      financialAccountId: string;
    };
    const tx = (await (
      await call(realm, 'POST', '/transactions', {
        financialAccountId: account.financialAccountId,
        amount: eur(amount),
        direction: 'INFLOW',
        bookingDate: '2027-02-03',
      })
    ).json()) as { transactionId: string };
    expect(
      (await call(realm, 'PUT', `/transactions/${tx.transactionId}/splits`, { splits: [{ amount: eur(amount), financialCategoryCode: 'RENT_BASE' }] })).status,
    ).toBe(200);
    expect((await call(realm, 'POST', `/transactions/${tx.transactionId}/confirm`)).status).toBe(200);
    const created = await call(realm, 'POST', '/rent-reconciliations', {
      transactionId: tx.transactionId,
      mreTenantId: tenant,
      mreRentTerm: term,
      matchedAmount: eur(matchedAmount),
    });
    expect(created.status).toBe(201);
  }

  it('the Tenants: an empty Realm is an empty page; then each Tenant once, newest first; no MRE call, no write', async () => {
    expect(await (await call(REALM_A, 'GET', '/rent-reconciliations/tenants')).json()).toEqual({ items: [], page: 1, pageSize: 50, total: 0 });
    await matched(REALM_A, TENANT, '2027010100', '800.00');
    await matched(REALM_A, TENANT, '2027040100', '100.00');
    await matched(REALM_A, NEIGHBOUR, '2027020100', '650.00');
    await matched(REALM_B, TENANT_B, '2027020100', '800.00');
    const [requests, writes, rows] = [mre.requests.length, await audits(), await reconciliationRows()];
    const page = (await (await call(REALM_A, 'GET', '/rent-reconciliations/tenants')).json()) as { items: { mreTenantId: string }[]; total: number };
    expect(page).toMatchObject({
      items: [
        { mreTenantId: NEIGHBOUR, latestMreRentTerm: '2027020100', reconciliationCount: 1 },
        { mreTenantId: TENANT, latestMreRentTerm: '2027040100', reconciliationCount: 2 },
      ],
      page: 1,
      pageSize: 50,
      total: 2,
    });
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(['latestCreatedAt', 'latestMreRentTerm', 'mreTenantId', 'reconciliationCount']);
    expect(await (await call(REALM_B, 'GET', '/rent-reconciliations/tenants')).json()).toMatchObject({ items: [{ mreTenantId: TENANT_B }], total: 1 });
    // Only the principal check asks MRE (GET /realms); the list itself is DE's.
    expect(mre.requests.slice(requests).every((r) => r.path === '/api/v2/realms')).toBe(true);
    expect([await audits(), await reconciliationRows()]).toEqual([writes, rows]);
  });

  it('the terms: MRE and DE side by side in the window, newest first; the months asked with the caller token and Realm', async () => {
    // February matched 300.00 of MRE's 800.00.
    await matched(REALM_A, TENANT, '2027020100', '300.00');
    const requests = mre.requests.length;
    const writes = await audits();
    const res = await call(REALM_A, 'GET', `/rent-reconciliations/terms/${TENANT}?from=2027-01&to=2027-03`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      mreTenantId: TENANT,
      from: '2027-01',
      to: '2027-03',
      mreStatus: 'AVAILABLE',
      items: [
        {
          mreRentTerm: '2027030100',
          month: '2027-03',
          inMre: true,
          amountDue: eur('800.00'),
          matchedTotal: eur('0.00'),
          reconciliationCount: 0,
          coverage: 'UNMATCHED',
          openAmount: eur('800.00'),
        },
        {
          mreRentTerm: '2027020100',
          month: '2027-02',
          inMre: true,
          amountDue: eur('800.00'),
          matchedTotal: eur('300.00'),
          reconciliationCount: 1,
          coverage: 'PARTIALLY_MATCHED',
          openAmount: eur('500.00'),
        },
        {
          mreRentTerm: '2027010100',
          month: '2027-01',
          inMre: true,
          amountDue: eur('800.00'),
          matchedTotal: eur('800.00'),
          reconciliationCount: 1,
          coverage: 'MATCHED',
          openAmount: eur('0.00'),
        },
      ],
    });
    // No name and no contact of a Tenant in the answer (mre-integration §20.1).
    for (const leak of [NAME, 'Nachbar', 'example.com', 'not read by DE', NEIGHBOUR]) expect(text).not.toContain(leak);
    expect(mre.requests.slice(requests).filter((r) => r.path !== '/api/v2/realms')).toEqual(
      ['/api/v2/tenants', '/api/v2/rents/2027/01', '/api/v2/rents/2027/02', '/api/v2/rents/2027/03'].map((path) => ({
        path,
        authorization: `Bearer ${token}`,
        organizationid: REALM_A,
      })),
    );
    expect(await audits()).toBe(writes);
  });

  it('a term DE matched that MRE no longer lists stays, inMre false; the window edges leave out the months around it', async () => {
    const terms = realmA.rents?.[TENANT] ?? [];
    realmA.rents = { ...realmA.rents, [TENANT]: terms.filter((t) => t !== 2027010100) };
    try {
      const body = (await (await call(REALM_A, 'GET', `/rent-reconciliations/terms/${TENANT}?from=2027-01&to=2027-02`)).json()) as {
        items: { mreRentTerm: string; inMre: boolean; amountDue: unknown; coverage: unknown; matchedTotal: unknown }[];
      };
      expect(body.items.map((i) => [i.mreRentTerm, i.inMre, i.amountDue, i.coverage, i.matchedTotal])).toEqual([
        ['2027020100', true, eur('800.00'), 'PARTIALLY_MATCHED', eur('300.00')],
        ['2027010100', false, null, null, eur('800.00')],
      ]);
      // The DE match of April and MRE's December and April are outside 2027-01..2027-02.
    } finally {
      realmA.rents = { ...realmA.rents, [TENANT]: terms };
    }
  });

  it('NOT_RETURNED for an unknown Tenant and for one of another Realm, with the DE side; no month is read', async () => {
    for (const [realm, tenant] of [
      [REALM_A, UNKNOWN],
      [REALM_A, TENANT_B],
      [REALM_EMPTY, TENANT],
    ] as const) {
      const requests = mre.requests.length;
      const res = await call(realm, 'GET', `/rent-reconciliations/terms/${tenant}?from=2027-01&to=2027-12`);
      expect(res.status).toBe(200);
      expect(await res.json(), `${realm} ${tenant}`).toEqual({ mreTenantId: tenant, from: '2027-01', to: '2027-12', mreStatus: 'NOT_RETURNED', items: [] });
      expect(mre.requests.slice(requests).some((r) => r.path.startsWith('/api/v2/rents/'))).toBe(false);
    }
    // A Tenant MRE no longer lists keeps its DE matches visible.
    const tenants = realmA.tenants ?? [];
    realmA.tenants = tenants.filter((t) => t['_id'] !== TENANT);
    try {
      const body = (await (await call(REALM_A, 'GET', `/rent-reconciliations/terms/${TENANT}?from=2027-01&to=2027-04`)).json()) as {
        mreStatus: string;
        items: { mreRentTerm: string; inMre: unknown; matchedTotal: unknown }[];
      };
      expect(body.mreStatus).toBe('NOT_RETURNED');
      expect(body.items.map((i) => [i.mreRentTerm, i.inMre, i.matchedTotal])).toEqual([
        ['2027040100', null, eur('100.00')],
        ['2027020100', null, eur('300.00')],
        ['2027010100', null, eur('800.00')],
      ]);
    } finally {
      realmA.tenants = tenants;
    }
  });

  it('UNAVAILABLE when MRE is down, with the DE side; Realm B never sees the matches of Realm A', async () => {
    const down = (await (await call(REALM_A, 'GET', `/rent-reconciliations/terms/${TENANT}?from=2027-02&to=2027-02`, undefined, downBase)).json()) as {
      mreStatus: string;
      items: unknown[];
    };
    expect(down).toEqual({
      mreTenantId: TENANT,
      from: '2027-02',
      to: '2027-02',
      mreStatus: 'UNAVAILABLE',
      items: [
        {
          mreRentTerm: '2027020100',
          month: '2027-02',
          inMre: null,
          amountDue: null,
          matchedTotal: eur('300.00'),
          reconciliationCount: 1,
          coverage: null,
          openAmount: null,
        },
      ],
    });
    expect(await (await call(REALM_B, 'GET', `/rent-reconciliations/terms/${TENANT}?from=2027-01&to=2027-12`)).json()).toMatchObject({
      mreStatus: 'NOT_RETURNED',
      items: [],
    });
  });
});

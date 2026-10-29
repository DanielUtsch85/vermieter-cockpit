import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  amendDeposit,
  createDeposit,
  createFinancialAccount,
  createManualTransaction,
  getDeposit,
  getTransaction,
  listDeposits,
  setTransactionSplits,
  voidDeposit,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresSecurityDepositRepository,
  PostgresTransactionQueries,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier, mreTenantDepositReader } from './wiring.js';

/**
 * VC-5-01 end to end (api-design.md §47.1), wired as in main.ts against the fake MRE: the amount defaults to MRE's
 * `guaranty` (rounded once to the cent), an explicit amount wins, a Tenant without guaranty needs one; one deposit per
 * Tenant; the holding account must be a deposit account; amend, void and a new deposit after the void; Realm isolation;
 * MRE is never asked for a replay or a refusal DE can decide itself; and (VC-5-02, §47.2) a deposit split on a mixed transfer.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000005a';
const REALM_B = '64b0c0ffee0000000000005b';
const T_GUARANTY = '6512f0c2a1b2c3d4e5f65a01';
const T_NONE = '6512f0c2a1b2c3d4e5f65a02';
const T_OTHER = '6512f0c2a1b2c3d4e5f65a03';
const T_SPLIT = '6512f0c2a1b2c3d4e5f65a04';
const T_B = '6512f0c2a1b2c3d4e5f65b01';

describe.skipIf(databaseUrl === undefined)('SecurityDeposit (VC-5-01) end to end', () => {
  const schema = testSchemaName('security_deposit_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let base: string;
  let tenantReads = 0;
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });

    mre = await startFakeMre([
      {
        _id: REALM_A,
        name: 'A',
        members: member,
        applications: [],
        // MRE stores floats: 2999.995 is 3000.00 once rounded half-up to the cent; 0 is MRE's default for "none".
        tenants: [
          { _id: T_GUARANTY, name: 'Mieterin K', guaranty: 2999.995 },
          { _id: T_NONE, name: 'Mieter N', guaranty: 0 },
          { _id: T_OTHER, name: 'Mieter O' },
          { _id: T_SPLIT, name: 'Mieterin S', guaranty: 1500 },
        ],
      },
      { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [{ _id: T_B, name: 'Mieter B', guaranty: 900 }] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const reader = mreTenantDepositReader(client);
    const db = createDatabase(pool);
    const deposits = new PostgresSecurityDepositRepository(db);
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        securityDeposits: {
          create: createDeposit({
            repository: deposits,
            readMreTenant: async (...args) => {
              tenantReads += 1;
              return reader(...args);
            },
          }),
          get: getDeposit({ repository: deposits }),
          list: listDeposits({ repository: deposits }),
          amend: amendDeposit({ repository: deposits }),
          void: voidDeposit({ repository: deposits }),
        },
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: new PostgresTransactionRepository(db) }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          get: getTransaction({ queries: new PostgresTransactionQueries(db) }),
        },
      }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.end();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 300);
  const call = (realm: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const errorOf = async (res: Response, status: number) => (await json<{ error: { code: string; details?: Record<string, unknown> } }>(res, status)).error;
  type Deposit = {
    securityDepositId: string;
    status: string;
    expectedAmount: { amount: string; currency: string };
    expectedAmountSource: string;
    holdingFinancialAccountId: string | null;
    interestBearing: boolean;
    version: number;
  };
  const account = async (accountType: string, displayName: string) =>
    (await json<{ financialAccountId: string }>(await A('POST', '/financial-accounts', { accountType, displayName, currency: 'EUR' }), 201)).financialAccountId;
  const audits = async (id: string) =>
    (
      await pool.query<{ action: string }>(`SELECT action FROM audit_record WHERE entity_type = 'SecurityDeposit' AND entity_id = $1 ORDER BY new_version`, [
        id,
      ])
    ).rows.map((r) => r.action);

  it("creates from MRE's guaranty, then amends, voids and creates anew; refusals DE decides never ask MRE", async () => {
    const kaution = await account('SECURITY_DEPOSIT', 'Kautionskonto');
    const giro = await account('BANK', 'Girokonto');

    // A non-deposit holding account is refused before MRE is asked.
    const reads = tenantReads;
    expect(await errorOf(await A('POST', '/security-deposits', { mreTenantId: T_GUARANTY, holdingFinancialAccountId: giro }), 422)).toMatchObject({
      code: 'NOT_A_SECURITY_DEPOSIT_ACCOUNT',
      details: { accountType: 'BANK' },
    });
    expect(tenantReads).toBe(reads);

    const created = await A('POST', '/security-deposits', { mreTenantId: T_GUARANTY, holdingFinancialAccountId: kaution }, { 'idempotency-key': 'e2e-1' });
    const deposit = await json<Deposit>(created, 201);
    expect(created.headers.get('etag')).toBe('"1"');
    expect(deposit).toMatchObject({
      status: 'ACTIVE',
      expectedAmount: { amount: '3000.00', currency: 'EUR' },
      expectedAmountSource: 'MRE_GUARANTY',
      holdingFinancialAccountId: kaution,
      interestBearing: true,
      version: 1,
    });

    // A replay answers the same deposit without asking MRE again; a second deposit for the Tenant is refused before MRE too.
    const readsBefore = tenantReads;
    const replay = await A('POST', '/security-deposits', { mreTenantId: T_GUARANTY, holdingFinancialAccountId: kaution }, { 'idempotency-key': 'e2e-1' });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await json<Deposit>(replay, 201)).toEqual(deposit);
    expect(await errorOf(await A('POST', '/security-deposits', { mreTenantId: T_GUARANTY }), 409)).toMatchObject({
      details: { reason: 'DEPOSIT_EXISTS', securityDepositId: deposit.securityDepositId },
    });
    expect(tenantReads).toBe(readsBefore);

    // Amend with If-Match: the amount becomes the user's; a stale version is 412.
    const amended = await json<Deposit>(
      await A(
        'POST',
        `/security-deposits/${deposit.securityDepositId}/amend`,
        { expectedAmount: { amount: '3100.00', currency: 'EUR' } },
        { 'if-match': '"1"' },
      ),
      200,
    );
    expect(amended).toMatchObject({ expectedAmount: { amount: '3100.00' }, expectedAmountSource: 'REQUEST', version: 2 });
    expect((await A('POST', `/security-deposits/${deposit.securityDepositId}/amend`, { notes: 'x' }, { 'if-match': '"1"' })).status).toBe(412);
    expect(await errorOf(await A('POST', `/security-deposits/${deposit.securityDepositId}/amend`, { mreTenantId: T_OTHER }), 400)).toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    // Void; then the Tenant may get a new deposit, and the voided one is not amended.
    const voided = await json<Deposit>(await A('POST', `/security-deposits/${deposit.securityDepositId}/void`, { reason: 'Falscher Betrag' }), 200);
    expect(voided).toMatchObject({ status: 'VOID', version: 3 });
    expect(await errorOf(await A('POST', `/security-deposits/${deposit.securityDepositId}/amend`, { notes: 'x' }), 409)).toMatchObject({
      details: { reason: 'DEPOSIT_NOT_ACTIVE', status: 'VOID' },
    });
    const renewed = await json<Deposit>(
      await A('POST', '/security-deposits', { mreTenantId: T_GUARANTY, expectedAmount: { amount: '3100.00', currency: 'EUR' } }),
      201,
    );
    expect(renewed).toMatchObject({ status: 'ACTIVE', expectedAmountSource: 'REQUEST', holdingFinancialAccountId: null });

    // Every write leaves its AuditRecord; the list shows both deposits, newest first.
    expect(await audits(deposit.securityDepositId)).toEqual(['CREATED', 'AMENDED', 'VOIDED']);
    const listed = await json<{ items: Deposit[]; total: number }>(await A('GET', `/security-deposits?mreTenantId=${T_GUARANTY}`), 200);
    expect(listed.items.map((d) => d.securityDepositId)).toEqual([renewed.securityDepositId, deposit.securityDepositId]);
    expect((await json<{ total: number }>(await A('GET', `/security-deposits?status=VOID&holdingFinancialAccountId=${kaution}`), 200)).total).toBe(1);
  });

  it('a Tenant without guaranty (0 or missing) needs an amount; an unknown Tenant and one of another Realm are 404', async () => {
    for (const tenant of [T_NONE, T_OTHER]) {
      expect(await errorOf(await A('POST', '/security-deposits', { mreTenantId: tenant }), 422)).toMatchObject({ code: 'EXPECTED_AMOUNT_REQUIRED' });
    }
    expect(
      await json<Deposit>(
        await A('POST', '/security-deposits', { mreTenantId: T_NONE, expectedAmount: { amount: '1800', currency: 'EUR' }, interestBearing: false }),
        201,
      ),
    ).toMatchObject({
      expectedAmount: { amount: '1800.00' },
      expectedAmountSource: 'REQUEST',
      interestBearing: false,
    });
    for (const tenant of ['000000000000000000000000', T_B]) {
      expect(await errorOf(await A('POST', '/security-deposits', { mreTenantId: tenant }), 404)).toMatchObject({
        code: 'NOT_FOUND',
        details: { externalId: tenant },
      });
    }
    expect(Number((await pool.query(`SELECT count(*) FROM security_deposit WHERE mre_tenant_id IN ($1, $2)`, [T_OTHER, T_B])).rows[0].count)).toBe(0);
  });

  it("Realm isolation: another Realm's deposit is 404 and not listed; its own Tenant works there", async () => {
    const inA = await json<Deposit>(
      await A('POST', '/security-deposits', { mreTenantId: T_OTHER, expectedAmount: { amount: '500.00', currency: 'EUR' } }),
      201,
    );
    const B = (method: string, path: string, body?: unknown) => call(REALM_B, method, path, body);
    expect((await B('GET', `/security-deposits/${inA.securityDepositId}`)).status).toBe(404);
    expect((await B('POST', `/security-deposits/${inA.securityDepositId}/amend`, { notes: 'x' })).status).toBe(404);
    expect((await B('POST', `/security-deposits/${inA.securityDepositId}/void`, { reason: 'x' })).status).toBe(404);
    expect((await json<{ total: number }>(await B('GET', '/security-deposits'), 200)).total).toBe(0);
    expect(await json<Deposit>(await B('POST', '/security-deposits', { mreTenantId: T_B }), 201)).toMatchObject({ expectedAmount: { amount: '900.00' } });
    // A holding account of Realm A is unknown in Realm B.
    const kautionA = await account('SECURITY_DEPOSIT', 'Kaution A');
    expect((await B('POST', `/security-deposits`, { mreTenantId: T_B, holdingFinancialAccountId: kautionA })).status).toBe(404);
  });

  it('VC-5-02: a mixed first transfer links its deposit split; a void is then DEPOSIT_HAS_SPLITS; interest on an OUTFLOW is refused', async () => {
    const deposit = await json<Deposit>(await A('POST', '/security-deposits', { mreTenantId: T_SPLIT }), 201);
    const giro = await account('BANK', 'Giro Kaution');
    const transfer = async (direction: string, amount: string) =>
      (
        await json<{ transactionId: string }>(
          await A('POST', '/transactions', { financialAccountId: giro, amount: { amount, currency: 'EUR' }, direction, bookingDate: '2027-02-01' }),
          201,
        )
      ).transactionId;
    const first = await transfer('INFLOW', '2300.00');
    const set = await json<{ splits: { financialCategoryCode: string; securityDepositId: string | null }[] }>(
      await A('PUT', `/transactions/${first}/splits`, {
        splits: [
          { amount: { amount: '650.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE' },
          { amount: { amount: '150.00', currency: 'EUR' }, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' },
          { amount: { amount: '1500.00', currency: 'EUR' }, financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: deposit.securityDepositId },
        ],
      }),
      200,
    );
    expect(set.splits.map((s) => s.securityDepositId)).toEqual([null, null, deposit.securityDepositId]);
    const read = await json<{ splits: { securityDepositId: string | null }[] }>(await A('GET', `/transactions/${first}`), 200);
    expect(read.splits.map((s) => s.securityDepositId)).toEqual([null, null, deposit.securityDepositId]);
    expect(await errorOf(await A('POST', `/security-deposits/${deposit.securityDepositId}/void`, { reason: 'x' }), 409)).toMatchObject({
      details: { reason: 'DEPOSIT_HAS_SPLITS', transactionIds: [first] },
    });
    const outflow = await transfer('OUTFLOW', '1.00');
    expect(
      await errorOf(
        await A('PUT', `/transactions/${outflow}/splits`, {
          splits: [
            { amount: { amount: '1.00', currency: 'EUR' }, financialCategoryCode: 'SECURITY_DEPOSIT_INTEREST', securityDepositId: deposit.securityDepositId },
          ],
        }),
        422,
      ),
    ).toMatchObject({ code: 'INVALID_SECURITY_DEPOSIT_SPLIT', details: { position: 1, reason: 'DIRECTION' } });
  });
});

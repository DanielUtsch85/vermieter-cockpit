import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { unusedCommands } from './api/app.test-support.js';
import {
  confirmTransaction,
  createFinancialAccount,
  createManualTransaction,
  createReconciliation,
  getReconciliation,
  listReconciliations,
  releaseReconciliation,
  getTermCoverage,
  getTransactionCoverage,
  suggestReconciliations,
  confirmReconciliation,
  rejectReconciliation,
  reverseTransaction,
  setTransactionSplits,
} from './application/index.js';
import {
  PostgresCorrectionRepository,
  PostgresFinancialAccountRepository,
  PostgresRentReconciliationRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { mreMonthReader, mrePrincipalVerifier, mreRentTermLookup, mreRentTermReader } from './wiring.js';

/**
 * VC-4-01 end to end (api-design.md §37.1), wired as in main.ts, against a fake MRE and PostgreSQL: the MRE term read
 * between the two DE checks (nothing written when MRE does not return the term or is down, no MRE call on a replay or
 * a refusal), Realm isolation, and the correction rule over HTTP.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee00000000000018';
const REALM_B = '64b0c0ffee00000000000019';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
// Realm C for suggestions (§37.3): its own Tenants and months, apart from the other cases' Transactions.
const REALM_C = '64b0c0ffee0000000000001a';
const TENANT_C1 = '6512f0c2a1b2c3d4e5f60c01';
const TENANT_C2 = '6512f0c2a1b2c3d4e5f60c02';

describe.skipIf(databaseUrl === undefined)('rent reconciliation end to end', () => {
  const schema = testSchemaName('rent_reconciliation_e2e');
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

    const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
    mre = await startFakeMre([
      {
        _id: REALM_A,
        name: 'A',
        members: member,
        applications: [],
        rents: { [TENANT]: [2027010100, 2027020100] },
        // MRE's own settlement of February: a payment recorded in MRE, not cash in DE (BR-RENT-001).
        rentTerms: { [`${TENANT}/2027020100`]: { totalWithoutBalanceAmount: 799.9999999999999, payments: [{ date: '04/02/2027', amount: 800, type: 'transfer', reference: 'MRE-1' }] } },
      },
      { _id: REALM_B, name: 'B', members: member, applications: [] },
      {
        _id: REALM_C,
        name: 'C',
        members: member,
        applications: [],
        rents: { [TENANT_C1]: [2027050100, 2027060100, 2027070100], [TENANT_C2]: [2027050100] },
        rentTerms: { [`${TENANT_C2}/2027050100`]: { totalWithoutBalanceAmount: 650 } },
      },
    ]);
    const db = createDatabase(pool);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const transactions = new PostgresTransactionRepository(db);
    const reconciliations = new PostgresRentReconciliationRepository(db);
    const commands = (lookupClient: HttpMreClient) => ({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...unusedCommands,
      createFinancialAccount: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }),
      createManualTransaction: createManualTransaction({ repository: transactions }),
      confirmTransaction: confirmTransaction({ repository: transactions }),
      setTransactionSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
      reverseTransaction: reverseTransaction({ repository: new PostgresCorrectionRepository(db) }),
      createReconciliation: createReconciliation({ repository: reconciliations, lookupMreRentTerm: mreRentTermLookup(lookupClient) }),
      getReconciliation: getReconciliation({ repository: reconciliations }),
      listReconciliations: listReconciliations({ repository: reconciliations }),
      releaseReconciliation: releaseReconciliation({ repository: reconciliations }),
      getTermCoverage: getTermCoverage({ repository: reconciliations, readMreRentTerm: mreRentTermReader(lookupClient) }),
      getTransactionCoverage: getTransactionCoverage({ repository: reconciliations }),
      suggestReconciliations: suggestReconciliations({ repository: reconciliations, readMreMonth: mreMonthReader(lookupClient) }),
      confirmReconciliation: confirmReconciliation({ repository: reconciliations, readMreRentTerm: mreRentTermReader(lookupClient) }),
      rejectReconciliation: rejectReconciliation({ repository: reconciliations }),
    });
    server = createApp(commands(client)).listen(0, '127.0.0.1');
    // The same app, but the rent term read goes to an MRE that is down (nothing listens on port 1).
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
  const call = (realm: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}, at = base) =>
    fetch(`${at}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  const rentReads = () => mre.requests.filter((r) => r.path.startsWith('/api/v2/rents/')).length;
  const count = async (transactionId: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM rent_payment_reconciliation WHERE transaction_id = $1`, [transactionId])).rows[0].n as number;

  /** A confirmed INFLOW split as rent (800.00 by default). */
  async function rent(realm = REALM_A, amount = '800.00', bookingDate = '2027-01-03'): Promise<string> {
    const account = (await (await call(realm, 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' })).json()) as { financialAccountId: string };
    const tx = (await (
      await call(realm, 'POST', '/transactions', { financialAccountId: account.financialAccountId, amount: eur(amount), direction: 'INFLOW', bookingDate })
    ).json()) as { transactionId: string };
    expect((await call(realm, 'PUT', `/transactions/${tx.transactionId}/splits`, { splits: [{ amount: eur(amount), financialCategoryCode: 'RENT_BASE' }] })).status).toBe(200);
    expect((await call(realm, 'POST', `/transactions/${tx.transactionId}/confirm`)).status).toBe(200);
    return tx.transactionId;
  }
  const matchBody = (transactionId: string, term = '2027010100') => ({ transactionId, mreTenantId: TENANT, mreRentTerm: term, matchedAmount: eur('800.00') });

  it('a manual match reads the term in MRE with the caller\'s token and Realm; a replay answers without asking MRE again', async () => {
    const t = await rent();
    const before = rentReads();
    const first = await call(REALM_A, 'POST', '/rent-reconciliations', matchBody(t), { 'idempotency-key': `e2e-${t}` });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { reconciliationId: string; status: string; mreWriteBackState: string };
    expect(created).toMatchObject({ status: 'CONFIRMED', mreWriteBackState: 'NOT_WRITTEN' });
    expect(mre.requests.at(-1)).toEqual({ path: `/api/v2/rents/tenant/${TENANT}/2027010100`, authorization: `Bearer ${token}`, organizationid: REALM_A });
    const replay = await call(REALM_A, 'POST', '/rent-reconciliations', matchBody(t), { 'idempotency-key': `e2e-${t}` });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(((await replay.json()) as { reconciliationId: string }).reconciliationId).toBe(created.reconciliationId);
    expect(rentReads()).toBe(before + 1);
    // A refusal from DE never asks MRE either.
    expect((await call(REALM_A, 'POST', '/rent-reconciliations', matchBody(t, '2027020100'))).status).toBe(409);
    expect(rentReads()).toBe(before + 1);
  });

  it('a term MRE does not return is 422, MRE down is 503; nothing is written on either', async () => {
    const t = await rent();
    const unknown = await call(REALM_A, 'POST', '/rent-reconciliations', matchBody(t, '2027030100'));
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('MRE_RENT_TERM_NOT_FOUND');
    const down = await call(REALM_A, 'POST', '/rent-reconciliations', matchBody(t), {}, downBase);
    expect(down.status).toBe(503);
    expect(((await down.json()) as { error: { code: string } }).error.code).toBe('EXTERNAL_SYSTEM_ERROR');
    expect(await count(t)).toBe(0);
  });

  it('Realm isolation: Realm B neither reads nor releases A\'s reconciliation, nor matches A\'s Transaction; A\'s term is not B\'s', async () => {
    const t = await rent();
    const created = (await (await call(REALM_A, 'POST', '/rent-reconciliations', matchBody(t))).json()) as { reconciliationId: string };
    expect((await call(REALM_B, 'GET', `/rent-reconciliations/${created.reconciliationId}`)).status).toBe(404);
    expect((await call(REALM_B, 'POST', `/rent-reconciliations/${created.reconciliationId}/release`, { reason: 'x' })).status).toBe(404);
    expect((await call(REALM_B, 'POST', '/rent-reconciliations', matchBody(t))).status).toBe(404);
    expect(((await (await call(REALM_B, 'GET', `/rent-reconciliations?transactionId=${t}`)).json()) as { total: number }).total).toBe(0);
    const inB = await rent(REALM_B);
    expect((await call(REALM_B, 'POST', '/rent-reconciliations', matchBody(inB))).status).toBe(422);
  });

  it('a reversal of a matched Transaction is refused until the match is released', async () => {
    const t = await rent();
    const created = (await (await call(REALM_A, 'POST', '/rent-reconciliations', matchBody(t))).json()) as { reconciliationId: string };
    const refused = await call(REALM_A, 'POST', `/transactions/${t}/reverse`, { reason: 'Doppelt' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: unknown }).error).toMatchObject({ details: { reason: 'TRANSACTION_RENT_RECONCILED', reconciliationIds: [created.reconciliationId] } });
    const released = await call(REALM_A, 'POST', `/rent-reconciliations/${created.reconciliationId}/release`, { reason: 'Doppelt gebucht' }, { 'if-match': '"1"' });
    expect(released.status).toBe(200);
    expect(released.headers.get('etag')).toBe('"2"');
    expect((await call(REALM_A, 'POST', `/transactions/${t}/reverse`, { reason: 'Doppelt' })).status).toBe(201);
    // The released match stays as it was; the reversed cash is not counted any more.
    expect((await call(REALM_A, 'POST', '/rent-reconciliations', matchBody(t))).status).toBe(409);
  });

  it('coverage of a term (§37.2): DE\'s matches next to MRE\'s amount due and payments, never summed; MRE down keeps DE\'s side', async () => {
    const coverage = async (realm = REALM_A, at = base) => (await (await call(realm, 'GET', `/rent-reconciliations/terms/${TENANT}/2027020100`, undefined, {}, at)).json()) as Record<string, unknown>;
    const before = await coverage();
    expect(before).toMatchObject({
      mreStatus: 'AVAILABLE',
      reconciliations: [],
      matchedTotal: eur('0.00'),
      mre: { amountDue: eur('800.00'), payments: [{ date: '2027-02-04', amount: eur('800.00'), type: 'transfer', reference: 'MRE-1' }] },
      coverage: 'UNMATCHED',
      openAmount: eur('800.00'),
    });
    const [a, b, c] = [await rent(REALM_A, '400.00'), await rent(REALM_A, '400.00'), await rent(REALM_A, '100.00')];
    const post = async (t: string, amount: string) => expect((await call(REALM_A, 'POST', '/rent-reconciliations', { ...matchBody(t, '2027020100'), matchedAmount: eur(amount) })).status).toBe(201);
    await post(a, '400.00');
    expect(await coverage()).toMatchObject({ coverage: 'PARTIALLY_MATCHED', matchedTotal: eur('400.00'), openAmount: eur('400.00') });
    await post(b, '400.00');
    expect(await coverage()).toMatchObject({ coverage: 'MATCHED', matchedTotal: eur('800.00'), openAmount: eur('0.00') });
    await post(c, '100.00');
    const over = await coverage();
    // MRE's own 800.00 payment is shown, never added: DE's cash alone decides the coverage.
    expect(over).toMatchObject({ coverage: 'OVERPAID', matchedTotal: eur('900.00'), openAmount: eur('-100.00') });
    expect((over['reconciliations'] as unknown[]).length).toBe(3);
    // The per-Transaction view: all of c is matched, nothing available.
    expect(await (await call(REALM_A, 'GET', `/transactions/${c}/rent-reconciliations`)).json()).toMatchObject({ counted: true, rentCash: eur('100.00'), matchedTotal: eur('100.00'), available: eur('0.00') });
    const reads = rentReads();
    expect((await call(REALM_A, 'GET', `/transactions/${c}/rent-reconciliations`)).status).toBe(200);
    expect(rentReads()).toBe(reads);
    // MRE down: DE's side still answered.
    expect(await coverage(REALM_A, downBase)).toMatchObject({ mreStatus: 'UNAVAILABLE', mre: null, coverage: null, openAmount: null, matchedTotal: eur('900.00') });
    // Another Realm: MRE does not return A's Tenant there, and DE's side is empty.
    expect(await coverage(REALM_B)).toMatchObject({ mreStatus: 'NOT_RETURNED', mre: null, reconciliations: [], matchedTotal: eur('0.00') });
  });

  it('suggestions (§37.3): suggest over two months, never counted until confirmed; confirm (lowered, never raised), reject (never suggested again); MRE down writes nothing', async () => {
    const t1 = await rent(REALM_C, '800.00', '2027-05-03');
    const t2 = await rent(REALM_C, '650.00', '2027-05-05');
    const t3 = await rent(REALM_C, '800.00', '2027-06-02');
    const rows = async () => (await pool.query(`SELECT count(*)::int AS n FROM rent_payment_reconciliation WHERE mre_realm_id = $1`, [REALM_C])).rows[0].n as number;
    const down = await call(REALM_C, 'POST', '/rent-reconciliations/suggest', { from: '2027-05', to: '2027-06' }, {}, downBase);
    expect(down.status).toBe(503);
    expect(await rows()).toBe(0);

    const months = mre.requests.length;
    const res = await call(REALM_C, 'POST', '/rent-reconciliations/suggest', { from: '2027-05', to: '2027-06' });
    expect(res.status).toBe(200);
    // The window and its two neighbours, with the caller's token and Realm.
    expect(mre.requests.slice(months).filter((r) => r.path.startsWith('/api/v2/rents/'))).toEqual(
      ['2027/04', '2027/05', '2027/06', '2027/07'].map((m) => ({ path: `/api/v2/rents/${m}`, authorization: `Bearer ${token}`, organizationid: REALM_C })),
    );
    const { items } = (await res.json()) as { items: { reconciliationId: string; transactionId: string; mreTenantId: string; mreRentTerm: string; status: string; matchedAmount: unknown; confidence: string }[] };
    const by = (t: string) => items.find((i) => i.transactionId === t) ?? { reconciliationId: '' };
    expect(items.map((i) => [i.transactionId, i.mreTenantId, i.mreRentTerm, i.status, i.matchedAmount, i.confidence]).sort()).toEqual(
      [
        [t1, TENANT_C1, '2027050100', 'SUGGESTED', eur('800.00'), 'MEDIUM'],
        [t2, TENANT_C2, '2027050100', 'SUGGESTED', eur('650.00'), 'MEDIUM'],
        [t3, TENANT_C1, '2027060100', 'SUGGESTED', eur('800.00'), 'MEDIUM'],
      ].sort(),
    );
    // A suggestion consumes nothing: no matched total on either side.
    expect(await (await call(REALM_C, 'GET', `/transactions/${t1}/rent-reconciliations`)).json()).toMatchObject({ matchedTotal: eur('0.00'), available: eur('800.00') });
    const may = async () => (await (await call(REALM_C, 'GET', `/rent-reconciliations/terms/${TENANT_C1}/2027050100`)).json()) as Record<string, unknown>;
    expect(await may()).toMatchObject({ matchedTotal: eur('0.00'), coverage: 'UNMATCHED' });

    // Confirm reads the term in MRE live, then counts.
    const confirmed = await call(REALM_C, 'POST', `/rent-reconciliations/${by(t1).reconciliationId}/confirm`, undefined, { 'if-match': '"1"' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get('etag')).toBe('"2"');
    expect(mre.requests.at(-1)).toEqual({ path: `/api/v2/rents/tenant/${TENANT_C1}/2027050100`, authorization: `Bearer ${token}`, organizationid: REALM_C });
    expect(await may()).toMatchObject({ matchedTotal: eur('800.00'), coverage: 'MATCHED' });

    // Reject is final, and the pair is never suggested again; open suggestions are not written twice.
    const rejected = await call(REALM_C, 'POST', `/rent-reconciliations/${by(t2).reconciliationId}/reject`, { reason: 'anderer Mieter' });
    expect(await rejected.json()).toMatchObject({ status: 'REJECTED', rejectReason: 'anderer Mieter' });
    expect(((await (await call(REALM_C, 'POST', '/rent-reconciliations/suggest', { from: '2027-05', to: '2027-06' })).json()) as { items: unknown[] }).items).toEqual([]);
    expect(await rows()).toBe(3);

    // A confirm may lower the amount, never raise it.
    const raised = await call(REALM_C, 'POST', `/rent-reconciliations/${by(t3).reconciliationId}/confirm`, { matchedAmount: eur('800.01') });
    expect(raised.status).toBe(422);
    const lowered = await call(REALM_C, 'POST', `/rent-reconciliations/${by(t3).reconciliationId}/confirm`, { matchedAmount: eur('700.00') });
    expect(await lowered.json()).toMatchObject({ status: 'CONFIRMED', matchedAmount: eur('700.00') });
    expect(await (await call(REALM_C, 'GET', `/transactions/${t3}/rent-reconciliations`)).json()).toMatchObject({ matchedTotal: eur('700.00'), available: eur('100.00') });
    // Realm A cannot see or confirm C's suggestions.
    expect((await call(REALM_A, 'POST', `/rent-reconciliations/${by(t2).reconciliationId}/confirm`)).status).toBe(404);
  });
});

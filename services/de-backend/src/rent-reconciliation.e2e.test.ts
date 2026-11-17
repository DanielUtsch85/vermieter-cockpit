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
  createReconciliation,
  getReconciliation,
  listReconciliations,
  releaseReconciliation,
  getTermCoverage,
  getTransactionCoverage,
  getTransaction,
  listPropertyReferenceTransactions,
  listTransactions,
  suggestReconciliations,
  confirmReconciliation,
  rejectReconciliation,
  writeBackToMre,
  getReconciliationWithPresence,
  getRentSplitProposal,
  removeFromMre,
  reverseTransaction,
  setTransactionSplits,
} from './application/index.js';
import {
  PostgresCorrectionRepository,
  PostgresFinancialAccountRepository,
  PostgresRentReconciliationRepository,
  PostgresPropertyReferenceRepository,
  PostgresTransactionQueries,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre, type FakeRealm } from './integrations/mre/fake-mre.test-support.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import {
  mreMonthReader,
  mrePrincipalVerifier,
  mreRentTermLookup,
  mreRentTermReader,
  mreRentBreakdownReader,
  mreWriteBackTermReader,
  mreWriteBackTermWriter,
} from './wiring.js';

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
// Realm D for the write-back (§37.4): a Tenant whose June term already holds MRE's own cash payment.
const REALM_D = '64b0c0ffee0000000000001b';
const TENANT_D = '6512f0c2a1b2c3d4e5f60d01';
const MRE_CASH = { date: '02/06/2027', amount: 100, type: 'cash', reference: '', description: 'Bar' };
// Realm F for early payers (#125): two Tenants paying on the 28th of the month before, with and without the month in the text.
const REALM_F = '64b0c0ffee0000000000001d';
const TENANT_F1 = '6512f0c2a1b2c3d4e5f60f01';
const TENANT_F2 = '6512f0c2a1b2c3d4e5f60f02';
// Realm E for the removal (§37.5): MRE's own cash payment next to DE's.
const REALM_E = '64b0c0ffee0000000000001c';
const TENANT_E = '6512f0c2a1b2c3d4e5f60e01';
// Realm G for the split proposal (#126, §37.6): rent 650 and charges 150 stored on the Tenant, as MRE's list carries them.
const REALM_G = '64b0c0ffee0000000000001e';
const TENANT_G = '6512f0c2a1b2c3d4e5f60e71';
// #368: Tenant G's one flat, and Tenant G2 with a flat and a garage under one lease (in April, so suggest stays unambiguous).
const TENANT_G2 = '6512f0c2a1b2c3d4e5f60e72';
const FLAT_G = '6a0000000000000000000001';
const GARAGE_G = '6a0000000000000000000002';
const realmG: FakeRealm = {
  _id: REALM_G,
  name: 'G',
  members: [{ name: 'Anna', email: 'anna@example.com', role: 'administrator', registered: true }],
  applications: [],
  rents: { [TENANT_G]: [2028030100], [TENANT_G2]: [2028040100] },
  tenants: [
    {
      _id: TENANT_G2,
      properties: [
        { property: { _id: FLAT_G }, rent: 650, entryDate: '01/01/2028', exitDate: '31/12/2028', expenses: [{ title: 'Nebenkosten', amount: 100 }] },
        { property: { _id: GARAGE_G }, rent: 50, entryDate: '01/04/2028', exitDate: '31/12/2028', expenses: [] },
      ],
    },
    {
      _id: TENANT_G,
      name: 'Mieterin G',
      properties: [
        {
          property: { _id: FLAT_G, name: 'Wohnung G' },
          rent: 650,
          entryDate: '01/01/2028',
          exitDate: '31/12/2028',
          expenses: [{ title: 'Nebenkosten', amount: 150, beginDate: '01/01/2028', endDate: '31/12/2028' }],
        },
      ],
    },
  ],
};
const realmE: FakeRealm = {
  _id: REALM_E,
  name: 'E',
  members: [{ name: 'Anna', email: 'anna@example.com', role: 'administrator', registered: true }],
  applications: [],
  rents: { [TENANT_E]: [2027100100, 2027110100] },
  rentTerms: {
    [`${TENANT_E}/2027100100`]: { payments: [MRE_CASH], description: 'Oktober' },
    [`${TENANT_E}/2027110100`]: { payments: [MRE_CASH] },
  },
};
const realmD: FakeRealm = {
  _id: REALM_D,
  name: 'D',
  members: [{ name: 'Anna', email: 'anna@example.com', role: 'administrator', registered: true }],
  applications: [],
  rents: { [TENANT_D]: [2027060100, 2027070100, 2027080100, 2027090100] },
  rentTerms: { [`${TENANT_D}/2027060100`]: { payments: [MRE_CASH], description: 'Juni' } },
};

describe.skipIf(databaseUrl === undefined)('rent reconciliation end to end', () => {
  const schema = testSchemaName('rent_reconciliation_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let downServer: Server;
  let base: string;
  let downBase: string;
  let repositoryForCrash: PostgresRentReconciliationRepository;
  let clientForCrash: HttpMreClient;

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
        rentTerms: {
          [`${TENANT}/2027020100`]: {
            totalWithoutBalanceAmount: 799.9999999999999,
            payments: [{ date: '04/02/2027', amount: 800, type: 'transfer', reference: 'MRE-1' }],
          },
        },
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
      realmD,
      realmE,
      realmG,
      {
        _id: REALM_F,
        name: 'F',
        members: member,
        applications: [],
        rents: { [TENANT_F1]: [2027080100, 2027090100, 2027100100], [TENANT_F2]: [2027080100, 2027090100, 2027100100] },
        rentTerms: Object.fromEntries(['2027080100', '2027090100', '2027100100'].map((t) => [`${TENANT_F2}/${t}`, { totalWithoutBalanceAmount: 650 }])),
      },
    ]);
    const db = createDatabase(pool);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const transactions = new PostgresTransactionRepository(db);
    const reconciliations = new PostgresRentReconciliationRepository(db);
    repositoryForCrash = reconciliations;
    clientForCrash = client;
    const commands = (lookupClient: HttpMreClient) => ({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        rentReconciliations: {
          create: createReconciliation({ repository: reconciliations, lookupMreRentTerm: mreRentTermLookup(lookupClient) }),
          get: getReconciliation({ repository: reconciliations }),
          list: listReconciliations({ repository: reconciliations }),
          release: releaseReconciliation({ repository: reconciliations }),
          termCoverage: getTermCoverage({ repository: reconciliations, readMreRentTerm: mreRentTermReader(lookupClient) }),
          transactionCoverage: getTransactionCoverage({ repository: reconciliations }),
          suggest: suggestReconciliations({ repository: reconciliations, readMreMonth: mreMonthReader(lookupClient) }),
          confirm: confirmReconciliation({ repository: reconciliations, readMreRentTerm: mreRentTermReader(lookupClient) }),
          reject: rejectReconciliation({ repository: reconciliations }),
          writeBack: writeBackToMre({
            repository: reconciliations,
            readTerm: mreWriteBackTermReader(lookupClient),
            writeTerm: mreWriteBackTermWriter(lookupClient),
            leaseMs: 300,
          }),
          getWithPresence: getReconciliationWithPresence({ repository: reconciliations, readTerm: mreWriteBackTermReader(lookupClient) }),
          splitProposal: getRentSplitProposal({
            queries: new PostgresTransactionQueries(db),
            readBreakdown: mreRentBreakdownReader(lookupClient),
            findLinkedPropertyReference: (realm, ids) => new PostgresPropertyReferenceRepository(db).findLinkedIds(realm, ids),
          }),
          removeFromMre: removeFromMre({
            repository: reconciliations,
            readTerm: mreWriteBackTermReader(lookupClient),
            writeTerm: mreWriteBackTermWriter(lookupClient),
            leaseMs: 300,
            marginMs: 0,
          }),
        },
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          confirm: confirmTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          reverse: reverseTransaction({ repository: new PostgresCorrectionRepository(db) }),
          get: getTransaction({ queries: new PostgresTransactionQueries(db) }),
          list: listTransactions({ queries: new PostgresTransactionQueries(db) }),
          listForPropertyReference: listPropertyReferenceTransactions({
            queries: new PostgresTransactionQueries(db),
            propertyReferences: new PostgresPropertyReferenceRepository(db),
          }),
        },
      }),
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
  async function rent(realm = REALM_A, amount = '800.00', bookingDate = '2027-01-03', description?: string): Promise<string> {
    const account = (await (await call(realm, 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' })).json()) as {
      financialAccountId: string;
    };
    const tx = (await (
      await call(realm, 'POST', '/transactions', {
        financialAccountId: account.financialAccountId,
        amount: eur(amount),
        direction: 'INFLOW',
        bookingDate,
        ...(description === undefined ? {} : { description }),
      })
    ).json()) as { transactionId: string };
    expect(
      (await call(realm, 'PUT', `/transactions/${tx.transactionId}/splits`, { splits: [{ amount: eur(amount), financialCategoryCode: 'RENT_BASE' }] })).status,
    ).toBe(200);
    expect((await call(realm, 'POST', `/transactions/${tx.transactionId}/confirm`)).status).toBe(200);
    return tx.transactionId;
  }
  const matchBody = (transactionId: string, term = '2027010100') => ({ transactionId, mreTenantId: TENANT, mreRentTerm: term, matchedAmount: eur('800.00') });

  it("a manual match reads the term in MRE with the caller's token and Realm; a replay answers without asking MRE again", async () => {
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

  it("Realm isolation: Realm B neither reads nor releases A's reconciliation, nor matches A's Transaction; A's term is not B's", async () => {
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
    expect(((await refused.json()) as { error: unknown }).error).toMatchObject({
      details: { reason: 'TRANSACTION_RENT_RECONCILED', reconciliationIds: [created.reconciliationId] },
    });
    const released = await call(
      REALM_A,
      'POST',
      `/rent-reconciliations/${created.reconciliationId}/release`,
      { reason: 'Doppelt gebucht' },
      { 'if-match': '"1"' },
    );
    expect(released.status).toBe(200);
    expect(released.headers.get('etag')).toBe('"2"');
    expect((await call(REALM_A, 'POST', `/transactions/${t}/reverse`, { reason: 'Doppelt' })).status).toBe(201);
    // The released match stays as it was; the reversed cash is not counted any more.
    expect((await call(REALM_A, 'POST', '/rent-reconciliations', matchBody(t))).status).toBe(409);
  });

  it("coverage of a term (§37.2): DE's matches next to MRE's amount due and payments, never summed; MRE down keeps DE's side", async () => {
    const coverage = async (realm = REALM_A, at = base) =>
      (await (await call(realm, 'GET', `/rent-reconciliations/terms/${TENANT}/2027020100`, undefined, {}, at)).json()) as Record<string, unknown>;
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
    const post = async (t: string, amount: string) =>
      expect((await call(REALM_A, 'POST', '/rent-reconciliations', { ...matchBody(t, '2027020100'), matchedAmount: eur(amount) })).status).toBe(201);
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
    expect(await (await call(REALM_A, 'GET', `/transactions/${c}/rent-reconciliations`)).json()).toMatchObject({
      counted: true,
      rentCash: eur('100.00'),
      matchedTotal: eur('100.00'),
      available: eur('0.00'),
    });
    const reads = rentReads();
    expect((await call(REALM_A, 'GET', `/transactions/${c}/rent-reconciliations`)).status).toBe(200);
    expect(rentReads()).toBe(reads);
    // MRE down: DE's side still answered.
    expect(await coverage(REALM_A, downBase)).toMatchObject({
      mreStatus: 'UNAVAILABLE',
      mre: null,
      coverage: null,
      openAmount: null,
      matchedTotal: eur('900.00'),
    });
    // Another Realm: MRE does not return A's Tenant there, and DE's side is empty.
    expect(await coverage(REALM_B)).toMatchObject({ mreStatus: 'NOT_RETURNED', mre: null, reconciliations: [], matchedTotal: eur('0.00') });
  });

  it('suggestions (§37.3): suggest over two months, never counted until confirmed; confirm (lowered, never raised), reject (never suggested again); MRE down writes nothing', async () => {
    const t1 = await rent(REALM_C, '800.00', '2027-05-03');
    const t2 = await rent(REALM_C, '650.00', '2027-05-05');
    const t3 = await rent(REALM_C, '800.00', '2027-06-02');
    const rows = async () =>
      (await pool.query(`SELECT count(*)::int AS n FROM rent_payment_reconciliation WHERE mre_realm_id = $1`, [REALM_C])).rows[0].n as number;
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
    const { items } = (await res.json()) as {
      items: {
        reconciliationId: string;
        transactionId: string;
        mreTenantId: string;
        mreRentTerm: string;
        status: string;
        matchedAmount: unknown;
        confidence: string;
      }[];
    };
    const by = (t: string) => items.find((i) => i.transactionId === t) ?? { reconciliationId: '' };
    expect(items.map((i) => [i.transactionId, i.mreTenantId, i.mreRentTerm, i.status, i.matchedAmount, i.confidence]).sort()).toEqual(
      [
        [t1, TENANT_C1, '2027050100', 'SUGGESTED', eur('800.00'), 'MEDIUM'],
        [t2, TENANT_C2, '2027050100', 'SUGGESTED', eur('650.00'), 'MEDIUM'],
        [t3, TENANT_C1, '2027060100', 'SUGGESTED', eur('800.00'), 'MEDIUM'],
      ].sort(),
    );
    // A suggestion consumes nothing: no matched total on either side.
    expect(await (await call(REALM_C, 'GET', `/transactions/${t1}/rent-reconciliations`)).json()).toMatchObject({
      matchedTotal: eur('0.00'),
      available: eur('800.00'),
    });
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
    const rerun = (await (await call(REALM_C, 'POST', '/rent-reconciliations/suggest', { from: '2027-05', to: '2027-06' })).json()) as {
      items: unknown[];
      skipped: { decidedBefore: number };
    };
    expect(rerun.items).toEqual([]);
    // VC-X-78: the rejected pair still fits and is counted as left out, not suggested.
    expect(rerun.skipped.decidedBefore).toBe(1);
    expect(await rows()).toBe(3);

    // A confirm may lower the amount, never raise it.
    const raised = await call(REALM_C, 'POST', `/rent-reconciliations/${by(t3).reconciliationId}/confirm`, { matchedAmount: eur('800.01') });
    expect(raised.status).toBe(422);
    const lowered = await call(REALM_C, 'POST', `/rent-reconciliations/${by(t3).reconciliationId}/confirm`, { matchedAmount: eur('700.00') });
    expect(await lowered.json()).toMatchObject({ status: 'CONFIRMED', matchedAmount: eur('700.00') });
    expect(await (await call(REALM_C, 'GET', `/transactions/${t3}/rent-reconciliations`)).json()).toMatchObject({
      matchedTotal: eur('700.00'),
      available: eur('100.00'),
    });
    // Realm A cannot see or confirm C's suggestions.
    expect((await call(REALM_A, 'POST', `/rent-reconciliations/${by(t2).reconciliationId}/confirm`)).status).toBe(404);
  });

  it('early payers (#125): the month in the purpose text decides; without it, a confirmed month anchors the rest in order', async () => {
    const iban = async (t: string, value: string) => pool.query(`UPDATE ledger_transaction SET counterparty_iban_raw = $1 WHERE id = $2`, [value, t]);
    const f1 = [
      await rent(REALM_F, '800.00', '2027-07-28', 'Miete 08.2027'),
      await rent(REALM_F, '800.00', '2027-08-28', 'Miete 09.2027'),
      await rent(REALM_F, '800.00', '2027-09-28', 'Miete 10.2027'),
    ];
    const f2 = [await rent(REALM_F, '650.00', '2027-07-28'), await rent(REALM_F, '650.00', '2027-08-28'), await rent(REALM_F, '650.00', '2027-09-28')];
    for (const t of [...f1, ...f2]) await iban(t, 'DE02120300000000202051');
    type Item = { transactionId: string; mreTenantId: string; mreRentTerm: string; suggestionReason: string };
    const suggest = async () =>
      ((await (await call(REALM_F, 'POST', '/rent-reconciliations/suggest', { from: '2027-08', to: '2027-10' })).json()) as { items: Item[] }).items;
    const view = (items: Item[]) => items.map((i) => [i.transactionId, i.mreTenantId, i.mreRentTerm, i.suggestionReason]).sort();
    // F1: the text decides (August's payment fits August only); F2 without text: a chain with no anchor, nothing.
    expect(view(await suggest())).toEqual(
      [
        [f1[0], TENANT_F1, '2027080100', 'EXACT_AMOUNT'],
        [f1[1], TENANT_F1, '2027090100', 'EXACT_AMOUNT_PURPOSE_MONTH'],
        [f1[2], TENANT_F1, '2027100100', 'EXACT_AMOUNT_PURPOSE_MONTH'],
      ].sort(),
    );
    // F2's August matched by hand: September and October follow in order.
    const manual = await call(REALM_F, 'POST', '/rent-reconciliations', {
      transactionId: f2[0],
      mreTenantId: TENANT_F2,
      mreRentTerm: '2027080100',
      matchedAmount: eur('650.00'),
    });
    expect(manual.status).toBe(201);
    expect(view(await suggest())).toEqual(
      [
        [f2[1], TENANT_F2, '2027090100', 'EXACT_AMOUNT_IN_ORDER'],
        [f2[2], TENANT_F2, '2027100100', 'EXACT_AMOUNT_IN_ORDER'],
      ].sort(),
    );
    // Stored as such (0036), and a repeat writes nothing.
    const stored = await pool.query(`SELECT suggestion_reason FROM rent_payment_reconciliation WHERE mre_realm_id = $1 AND status = 'SUGGESTED' ORDER BY 1`, [
      REALM_F,
    ]);
    expect(stored.rows.map((r) => r.suggestion_reason)).toEqual([
      'EXACT_AMOUNT',
      'EXACT_AMOUNT_IN_ORDER',
      'EXACT_AMOUNT_IN_ORDER',
      'EXACT_AMOUNT_PURPOSE_MONTH',
      'EXACT_AMOUNT_PURPOSE_MONTH',
    ]);
    expect(await suggest()).toEqual([]);
  });

  it('write-back (§37.4): DE’s payment next to MRE’s own, once; coverage unchanged; presence; MRE down → FAILED, retry → WRITTEN; release → REMOVAL_REQUIRED; Realm isolation', async () => {
    const match = (t: string, term: string, amount = '700.00') => ({ transactionId: t, mreTenantId: TENANT_D, mreRentTerm: term, matchedAmount: eur(amount) });
    const t = await rent(REALM_D, '700.00', '2027-06-03');
    const r = (await (await call(REALM_D, 'POST', '/rent-reconciliations', match(t, '2027060100'))).json()) as { reconciliationId: string; version: number };
    const marker = `DE-RPR-${r.reconciliationId}`;
    const patches = mre.patches.length;
    const res = await call(REALM_D, 'POST', `/rent-reconciliations/${r.reconciliationId}/write-back-to-mre`, undefined, { 'if-match': '"1"' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'CONFIRMED',
      mreWriteBackState: 'WRITTEN',
      mrePayment: { date: '03/06/2027', amount: eur('700.00'), type: 'transfer', reference: marker },
      version: 3,
    });
    expect(mre.patches.length).toBe(patches + 1);
    expect(mre.patches.at(-1)).toMatchObject({
      _id: TENANT_D,
      description: 'Juni',
      payments: [MRE_CASH, { date: '03/06/2027', amount: 700, type: 'transfer', reference: marker, description: '' }],
    });
    // Two records: MRE's payments shown, DE's Transaction matched once; nothing summed.
    expect(await (await call(REALM_D, 'GET', `/rent-reconciliations/terms/${TENANT_D}/2027060100`)).json()).toMatchObject({
      matchedTotal: eur('700.00'),
      coverage: 'PARTIALLY_MATCHED',
      mre: {
        payments: [
          { amount: eur('100.00'), type: 'cash' },
          { amount: eur('700.00'), reference: marker },
        ],
      },
    });
    // A repeat adds nothing and asks MRE nothing.
    const reads = mre.requests.length;
    expect((await call(REALM_D, 'POST', `/rent-reconciliations/${r.reconciliationId}/write-back-to-mre`)).status).toBe(200);
    expect(mre.patches.length).toBe(patches + 1);
    expect(mre.requests.slice(reads).filter((q) => q.path.startsWith('/api/v2/rents/'))).toEqual([]);
    // The presence check; a payment deleted in MRE by hand is MISSING, and nothing changes in DE.
    const presence = async () =>
      (await (await call(REALM_D, 'GET', `/rent-reconciliations/${r.reconciliationId}?checkMre=true`)).json()) as { mrePresence: string; version: number };
    expect(await presence()).toMatchObject({ mrePresence: 'PRESENT', version: 3 });
    const june = realmD.rentTerms?.[`${TENANT_D}/2027060100`];
    if (june === undefined) throw new Error('term');
    june.payments = [MRE_CASH];
    expect(await presence()).toMatchObject({ mrePresence: 'MISSING', version: 3 });
    // MRE down: FAILED, the match kept; a retry against MRE writes it.
    const u = await rent(REALM_D, '800.00', '2027-07-02');
    const r2 = (await (await call(REALM_D, 'POST', '/rent-reconciliations', match(u, '2027070100', '800.00'))).json()) as { reconciliationId: string };
    const down = await call(REALM_D, 'POST', `/rent-reconciliations/${r2.reconciliationId}/write-back-to-mre`, {}, {}, downBase);
    expect(down.status).toBe(503);
    expect(((await down.json()) as { error: unknown }).error).toMatchObject({ details: { reason: 'MRE_UNAVAILABLE', mreWriteBackState: 'FAILED' } });
    expect(await (await call(REALM_D, 'GET', `/transactions/${u}/rent-reconciliations`)).json()).toMatchObject({ matchedTotal: eur('800.00') });
    expect(await (await call(REALM_D, 'POST', `/rent-reconciliations/${r2.reconciliationId}/write-back-to-mre`)).json()).toMatchObject({
      mreWriteBackState: 'WRITTEN',
      mreWriteBackError: null,
    });
    // Release of a written match: REMOVAL_REQUIRED, the payment snapshot kept.
    expect(await (await call(REALM_D, 'POST', `/rent-reconciliations/${r2.reconciliationId}/release`, { reason: 'falscher Monat' })).json()).toMatchObject({
      status: 'RELEASED',
      mreWriteBackState: 'REMOVAL_REQUIRED',
      mrePayment: { reference: `DE-RPR-${r2.reconciliationId}` },
    });
    // Realm isolation.
    expect((await call(REALM_A, 'POST', `/rent-reconciliations/${r.reconciliationId}/write-back-to-mre`)).status).toBe(404);
    expect((await call(REALM_A, 'GET', `/rent-reconciliations/${r.reconciliationId}?checkMre=true`)).status).toBe(404);
  });

  it('exactly once: a crash between PATCH and record, retried after the lease, adds no second payment; a lost PATCH answer is WRITTEN by the second read', async () => {
    const t = await rent(REALM_D, '800.00', '2027-08-03');
    const r = (await (
      await call(REALM_D, 'POST', '/rent-reconciliations', { transactionId: t, mreTenantId: TENANT_D, mreRentTerm: '2027080100', matchedAmount: eur('800.00') })
    ).json()) as {
      reconciliationId: string;
    };
    const principal = { email: 'anna@example.com', mreRealmId: REALM_D, mreRole: 'administrator' } as const;
    const crashing = Object.create(repositoryForCrash) as PostgresRentReconciliationRepository;
    crashing.recordWriteBack = async () => {
      throw new Error('the process died after the PATCH');
    };
    const use = (repository: PostgresRentReconciliationRepository) =>
      writeBackToMre({ repository, readTerm: mreWriteBackTermReader(clientForCrash), writeTerm: mreWriteBackTermWriter(clientForCrash), leaseMs: 50 })({
        principal,
        authorizationHeader: `Bearer ${token}`,
        reconciliationId: r.reconciliationId,
      });
    const patches = mre.patches.length;
    await expect(use(crashing)).rejects.toThrow('the process died');
    expect(mre.patches.length).toBe(patches + 1);
    const stuck = (await (await call(REALM_D, 'GET', `/rent-reconciliations/${r.reconciliationId}`)).json()) as { mreWriteBackState: string };
    expect(stuck.mreWriteBackState).toBe('PENDING');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await use(repositoryForCrash)).toMatchObject({ reconciliation: { mreWriteBackState: 'WRITTEN' } });
    expect(mre.patches.length).toBe(patches + 1);
    const marker = `DE-RPR-${r.reconciliationId}`;
    const august = realmD.rentTerms?.[`${TENANT_D}/2027080100`]?.payments as { reference: string }[];
    expect(august.filter((p) => p.reference === marker)).toHaveLength(1);
    const audit = await pool.query(
      `SELECT action, metadata->>'patched' AS patched FROM audit_record WHERE entity_id = $1 AND action LIKE 'WRITE_BACK_%' ORDER BY occurred_at`,
      [r.reconciliationId],
    );
    expect(audit.rows).toEqual([
      { action: 'WRITE_BACK_STARTED', patched: null },
      { action: 'WRITE_BACK_STARTED', patched: null },
      { action: 'WRITE_BACK_WRITTEN', patched: 'false' },
    ]);

    // MRE saves the PATCH but its answer is lost.
    const v = await rent(REALM_D, '800.00', '2027-09-03');
    const r2 = (await (
      await call(REALM_D, 'POST', '/rent-reconciliations', { transactionId: v, mreTenantId: TENANT_D, mreRentTerm: '2027090100', matchedAmount: eur('800.00') })
    ).json()) as {
      reconciliationId: string;
    };
    mre.faults.push('DROP_ANSWER');
    expect(await (await call(REALM_D, 'POST', `/rent-reconciliations/${r2.reconciliationId}/write-back-to-mre`)).json()).toMatchObject({
      mreWriteBackState: 'WRITTEN',
    });
    expect(mre.patches.length).toBe(patches + 2);
  });

  it('removal (§37.5): too early under the last lease, then only DE’s payment removed; a repeat adds nothing; a reappearing payment is PRESENT on REMOVED; Realm isolation', async () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const t = await rent(REALM_E, '700.00', '2027-10-03');
    const r = (await (
      await call(REALM_E, 'POST', '/rent-reconciliations', { transactionId: t, mreTenantId: TENANT_E, mreRentTerm: '2027100100', matchedAmount: eur('700.00') })
    ).json()) as {
      reconciliationId: string;
    };
    const marker = `DE-RPR-${r.reconciliationId}`;
    const october = () => realmE.rentTerms?.[`${TENANT_E}/2027100100`]?.payments as { reference: string }[];
    expect((await call(REALM_E, 'POST', `/rent-reconciliations/${r.reconciliationId}/write-back-to-mre`)).status).toBe(200);
    expect(october().map((p) => p.reference)).toEqual(['', marker]);
    expect(await (await call(REALM_E, 'POST', `/rent-reconciliations/${r.reconciliationId}/release`, { reason: 'falscher Monat' })).json()).toMatchObject({
      mreWriteBackState: 'REMOVAL_REQUIRED',
    });
    // The write-back's lease (300 ms here) has not ended yet: a late PATCH could still land.
    const early = await call(REALM_E, 'POST', `/rent-reconciliations/${r.reconciliationId}/remove-from-mre`);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: unknown }).error).toMatchObject({ details: { reason: 'REMOVAL_TOO_EARLY' } });
    await pause(350);
    const patches = mre.patches.length;
    const res = await call(REALM_E, 'POST', `/rent-reconciliations/${r.reconciliationId}/remove-from-mre`, {}, { 'if-match': '"4"' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'RELEASED',
      mreWriteBackState: 'REMOVED',
      mreRemovedBy: 'anna@example.com',
      mrePayment: { reference: marker },
    });
    expect(mre.patches.length).toBe(patches + 1);
    expect(mre.patches.at(-1)).toMatchObject({ _id: TENANT_E, description: 'Oktober', payments: [MRE_CASH] });
    expect(october()).toEqual([MRE_CASH]);
    // A repeat adds nothing and asks MRE nothing.
    const reads = mre.requests.length;
    expect((await call(REALM_E, 'POST', `/rent-reconciliations/${r.reconciliationId}/remove-from-mre`)).status).toBe(200);
    expect(mre.requests.slice(reads).filter((q) => q.path.startsWith('/api/v2/rents/'))).toEqual([]);
    // The presence check on REMOVED: MISSING, and PRESENT once the payment reappears in MRE.
    const presence = async () =>
      ((await (await call(REALM_E, 'GET', `/rent-reconciliations/${r.reconciliationId}?checkMre=true`)).json()) as { mrePresence: string }).mrePresence;
    expect(await presence()).toBe('MISSING');
    october().push({ date: '03/10/2027', amount: 700, type: 'transfer', reference: marker, description: '' } as never);
    expect(await presence()).toBe('PRESENT');
    // Realm isolation.
    expect((await call(REALM_A, 'POST', `/rent-reconciliations/${r.reconciliationId}/remove-from-mre`)).status).toBe(404);
  });

  it('removal exactly once: a crash between PATCH and record, retried after the lease, finds the marker gone and sends no second PATCH', async () => {
    const t = await rent(REALM_E, '800.00', '2027-11-03');
    const r = (await (
      await call(REALM_E, 'POST', '/rent-reconciliations', { transactionId: t, mreTenantId: TENANT_E, mreRentTerm: '2027110100', matchedAmount: eur('800.00') })
    ).json()) as {
      reconciliationId: string;
    };
    expect((await call(REALM_E, 'POST', `/rent-reconciliations/${r.reconciliationId}/write-back-to-mre`)).status).toBe(200);
    expect((await call(REALM_E, 'POST', `/rent-reconciliations/${r.reconciliationId}/release`, { reason: 'x' })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const principal = { email: 'anna@example.com', mreRealmId: REALM_E, mreRole: 'administrator' } as const;
    const crashing = Object.create(repositoryForCrash) as PostgresRentReconciliationRepository;
    crashing.recordRemoval = async () => {
      throw new Error('the process died after the PATCH');
    };
    const use = (repository: PostgresRentReconciliationRepository) =>
      removeFromMre({
        repository,
        readTerm: mreWriteBackTermReader(clientForCrash),
        writeTerm: mreWriteBackTermWriter(clientForCrash),
        leaseMs: 50,
        marginMs: 0,
      })({
        principal,
        authorizationHeader: `Bearer ${token}`,
        reconciliationId: r.reconciliationId,
      });
    const patches = mre.patches.length;
    await expect(use(crashing)).rejects.toThrow('the process died');
    expect(mre.patches.length).toBe(patches + 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await use(repositoryForCrash)).toMatchObject({ reconciliation: { mreWriteBackState: 'REMOVED' } });
    expect(mre.patches.length).toBe(patches + 1);
    const audit = await pool.query(
      `SELECT action, metadata->>'patched' AS patched FROM audit_record WHERE entity_id = $1 AND action IN ('REMOVAL_STARTED', 'REMOVED') ORDER BY occurred_at`,
      [r.reconciliationId],
    );
    expect(audit.rows).toEqual([
      { action: 'REMOVAL_STARTED', patched: null },
      { action: 'REMOVAL_STARTED', patched: null },
      { action: 'REMOVED', patched: 'false' },
    ]);
  });

  it('#126 and #368 (§37.6): suggest says why it found nothing; the split proposal with the linked property, applied and confirmed, is then suggested', async () => {
    const G = (method: string, path: string, body?: unknown) => call(REALM_G, method, path, body);
    const account = (await (await G('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro G', currency: 'EUR' })).json()) as {
      financialAccountId: string;
    };
    const tx = (await (
      await G('POST', '/transactions', {
        financialAccountId: account.financialAccountId,
        amount: eur('800.00'),
        direction: 'INFLOW',
        bookingDate: '2028-03-01',
      })
    ).json()) as { transactionId: string };
    const before = (await (await G('POST', '/rent-reconciliations/suggest', { from: '2028-03', to: '2028-03' })).json()) as {
      items: unknown[];
      skipped: { unconfirmed: number; noRentCash: number; decidedBefore: number };
    };
    expect(before).toMatchObject({ items: [], skipped: { unconfirmed: 1, noRentCash: 0, decidedBefore: 0 } });

    const propose = async (tenant: string, term = '2028030100') => {
      const res = await G('GET', `/rent-reconciliations/split-proposal?transactionId=${tx.transactionId}&mreTenantId=${tenant}&mreRentTerm=${term}`);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json()) as { splits: { financialCategoryCode: string; amount: { amount: string; currency: string } }[]; flags: unknown[] };
    };
    const splitsOf = (propertyReferenceId: string | null) => [
      { financialCategoryCode: 'RENT_BASE', amount: eur('650.00'), propertyReferenceId },
      { financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', amount: eur('150.00'), propertyReferenceId },
    ];
    const audits = async () => Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM audit_record')).rows[0]?.n);
    // #368: the flat linked in another Realm only is not this Realm's link; the proposal writes no AuditRecord.
    const links = new PostgresPropertyReferenceRepository(createDatabase(pool));
    const draft = { mrePropertyId: FLAT_G, displayName: 'Wohnung G', cachedAddress: null, cachedSurface: null, refreshedAt: new Date() };
    await links.linkOnce({ ...draft, mreRealmId: REALM_B }, { actorType: 'USER', actorId: 'anna@example.com' });
    const auditsBefore = await audits();
    expect(await propose(TENANT_G)).toMatchObject({
      property: { mrePropertyIds: [FLAT_G], propertyReferenceId: null, unlinkedMrePropertyIds: [FLAT_G] },
      splits: splitsOf(null),
      flags: [{ code: 'NO_PROPERTY_REFERENCE', details: { reason: 'PROPERTY_NOT_LINKED', mrePropertyIds: [FLAT_G], unlinkedMrePropertyIds: [FLAT_G] } }],
    });
    expect(await audits()).toBe(auditsBefore);
    const { reference } = await links.linkOnce({ ...draft, mreRealmId: REALM_G }, { actorType: 'USER', actorId: 'anna@example.com' });
    // A flat and a garage under one lease, only the flat linked: the flat is the reference of every split, the garage
    // named as unlinked (Entscheidung des Projektinhabers, 2026-11-16). The garage linked in another Realm changes nothing.
    const garage = { ...draft, mrePropertyId: GARAGE_G, displayName: 'Garage G' };
    await links.linkOnce({ ...garage, mreRealmId: REALM_B }, { actorType: 'USER', actorId: 'anna@example.com' });
    const flatOnly = {
      property: { mrePropertyIds: [FLAT_G, GARAGE_G], propertyReferenceId: reference.id, unlinkedMrePropertyIds: [GARAGE_G] },
      splits: [{ propertyReferenceId: reference.id }, { propertyReferenceId: reference.id }],
      flags: [],
    };
    expect(await propose(TENANT_G2, '2028040100')).toMatchObject(flatOnly);
    // Both linked in Realm G: two linked objects, no reference.
    await links.linkOnce({ ...garage, mreRealmId: REALM_G }, { actorType: 'USER', actorId: 'anna@example.com' });
    expect(await propose(TENANT_G2, '2028040100')).toMatchObject({
      property: { mrePropertyIds: [FLAT_G, GARAGE_G], propertyReferenceId: null, unlinkedMrePropertyIds: [] },
      splits: [{ propertyReferenceId: null }, { propertyReferenceId: null }],
      flags: [{ code: 'NO_PROPERTY_REFERENCE', details: { reason: 'SEVERAL_PROPERTIES', mrePropertyIds: [FLAT_G, GARAGE_G], unlinkedMrePropertyIds: [] } }],
    });
    const proposal = await propose(TENANT_G);
    expect(proposal).toMatchObject({
      property: { mrePropertyIds: [FLAT_G], propertyReferenceId: reference.id, unlinkedMrePropertyIds: [] },
      splits: splitsOf(reference.id),
      unallocated: eur('0.00'),
      flags: [],
    });
    // A term MRE does not hold is 422 MRE_RENT_TERM_NOT_FOUND.
    expect(
      (await G('GET', `/rent-reconciliations/split-proposal?transactionId=${tx.transactionId}&mreTenantId=${TENANT_G}&mreRentTerm=2028040100`)).status,
    ).toBe(422);
    const applied = await G('PUT', `/transactions/${tx.transactionId}/splits`, { splits: proposal.splits });
    expect(applied.status).toBe(200);
    // Applied unchanged, the property stays on every split.
    expect(((await applied.json()) as { splits: { propertyReferenceId: string | null }[] }).splits.map((x) => x.propertyReferenceId)).toEqual([
      reference.id,
      reference.id,
    ]);
    expect((await G('POST', `/transactions/${tx.transactionId}/confirm`)).status).toBe(200);
    // Confirmed now: no more proposal; and suggest finds the payment.
    expect(
      (await G('GET', `/rent-reconciliations/split-proposal?transactionId=${tx.transactionId}&mreTenantId=${TENANT_G}&mreRentTerm=2028030100`)).status,
    ).toBe(409);
    const after = (await (await G('POST', '/rent-reconciliations/suggest', { from: '2028-03', to: '2028-03' })).json()) as {
      items: { transactionId: string; mreRentTerm: string }[];
      skipped: { unconfirmed: number; noRentCash: number; decidedBefore: number };
    };
    expect(after.items.map((i) => [i.transactionId, i.mreRentTerm])).toEqual([[tx.transactionId, '2028030100']]);
    expect(after.skipped).toEqual({ unconfirmed: 0, noRentCash: 0, decidedBefore: 0 });
  });

  it('§30.1A: the list s rentAllocation agrees with §37.2 s per-Transaction read for every Transaction of every Realm; the filter with it', async () => {
    type Money = { amount: string; currency: string };
    type Item = {
      transactionId: string;
      direction: string;
      rentAllocation: { state: string; rentAmount: Money; allocatedAmount: Money; freeAmount: Money } | null;
    };
    type Side = { rentCash: Money | null; matchedTotal: Money; available: Money | null; direction: string };
    // Besides what the cases above left (matched, released, suggested, rejected, reversed, written back): an OUTFLOW with
    // a rent split, an unconfirmed rent payment and a confirmed non-rent payment.
    const account = (await (await call(REALM_A, 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro 2', currency: 'EUR' })).json()) as {
      financialAccountId: string;
    };
    const book = async (direction: string, code: string, confirm: boolean) => {
      const tx = (await (
        await call(REALM_A, 'POST', '/transactions', {
          financialAccountId: account.financialAccountId,
          amount: eur('50.00'),
          direction,
          bookingDate: '2027-01-20',
        })
      ).json()) as { transactionId: string };
      await call(REALM_A, 'PUT', `/transactions/${tx.transactionId}/splits`, { splits: [{ amount: eur('50.00'), financialCategoryCode: code }] });
      if (confirm) expect((await call(REALM_A, 'POST', `/transactions/${tx.transactionId}/confirm`)).status).toBe(200);
      return tx.transactionId;
    };
    const outflow = await book('OUTFLOW', 'RENT_BASE', true);
    const unconfirmed = await book('INFLOW', 'RENT_BASE', false);
    const notRent = await book('INFLOW', 'INSURANCE', true);

    const states = new Map<string, string | null>();
    let compared = 0;
    for (const realm of [REALM_A, REALM_B, REALM_C, REALM_D, REALM_E, REALM_F, REALM_G]) {
      const list = (await (await call(realm, 'GET', '/transactions?pageSize=200')).json()) as { items: Item[]; total: number };
      expect(list.items).toHaveLength(list.total);
      for (const item of list.items) {
        const side = (await (await call(realm, 'GET', `/transactions/${item.transactionId}/rent-reconciliations`)).json()) as Side;
        const allocatable = side.available !== null && side.direction === 'INFLOW' && side.rentCash !== null && Number(side.rentCash.amount) > 0;
        if (!allocatable) {
          expect(item.rentAllocation, item.transactionId).toBeNull();
        } else {
          expect(item.rentAllocation, item.transactionId).toMatchObject({
            rentAmount: side.rentCash,
            allocatedAmount: side.matchedTotal,
            freeAmount: side.available,
          });
        }
        states.set(item.transactionId, item.rentAllocation?.state ?? null);
        compared++;
      }
      // The filter lists exactly the items whose state is in it.
      for (const subset of [['NONE'], ['PARTIAL'], ['FULL'], ['NONE', 'PARTIAL']]) {
        const filtered = (await (await call(realm, 'GET', `/transactions?pageSize=200&rentAllocation=${subset.join(',')}`)).json()) as { items: Item[] };
        expect(filtered.items.map((i) => i.transactionId).sort(), `${realm} ${subset.join(',')}`).toEqual(
          list.items
            .filter((i) => i.rentAllocation !== null && subset.includes(i.rentAllocation.state))
            .map((i) => i.transactionId)
            .sort(),
        );
      }
    }
    expect(compared).toBeGreaterThan(20);
    expect(new Set(states.values())).toEqual(new Set([null, 'NONE', 'FULL', 'PARTIAL']));
    expect([states.get(outflow), states.get(unconfirmed), states.get(notRent)]).toEqual([null, null, null]);
    // Only the lists: the single read keeps its DTO (§30.1A, open question 6).
    expect(Object.keys((await (await call(REALM_A, 'GET', `/transactions/${outflow}`)).json()) as object)).not.toContain('rentAllocation');
    // Another Realm's ids match nothing: Realm B's filtered list holds none of Realm A's Transactions, and B has its own.
    const ofA = (await (await call(REALM_A, 'GET', '/transactions?pageSize=200&rentAllocation=NONE,PARTIAL,FULL')).json()) as { items: Item[] };
    const ofB = (await (await call(REALM_B, 'GET', '/transactions?pageSize=200&rentAllocation=NONE,PARTIAL,FULL')).json()) as { items: Item[] };
    expect(ofA.items.length).toBeGreaterThan(0);
    expect(ofB.items.length).toBeGreaterThan(0);
    const idsOfA = new Set(ofA.items.map((i) => i.transactionId));
    expect(ofB.items.filter((i) => idsOfA.has(i.transactionId))).toEqual([]);
  });
});

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  confirmReconciliation,
  confirmTransaction,
  createFinancialAccount,
  createReconciliation,
  getReconciliation,
  getReconciliationWithPresence,
  getRentSplitProposal,
  getTermCoverage,
  getTransaction,
  getTransactionCoverage,
  importBankStatement,
  listReconciliations,
  rejectReconciliation,
  releaseReconciliation,
  removeFromMre,
  reverseTransaction,
  setTransactionSplits,
  suggestReconciliations,
  writeBackToMre,
} from './application/index.js';
import {
  PostgresCorrectionRepository,
  PostgresFinancialAccountRepository,
  PostgresImportRepository,
  PostgresRentReconciliationRepository,
  PostgresTransactionQueries,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { findBankStatementAdapter } from './integrations/bank-import/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre, type FakeRealm } from './integrations/mre/fake-mre.test-support.js';
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
 * VC-4-06: the Phase-4 exit of `docs/roadmap.md` as one acceptance run through the HTTP API (ACC4,
 * invariant-suite.md §29), wired as in main.ts: a bank transaction is matched to an MRE rent obligation (suggested,
 * then by hand, partial and combined), confirmed by a human, and written back to MRE exactly once (a repeat, a crashed
 * earlier attempt, a lost answer); MRE's settlement and DE's cash stay distinct records; a correction waits for the
 * release, a written match is removed again; every Phase-4 route is Realm-isolated; every write leaves its AuditRecord.
 * The figures are hand-computed in §29 and checked literally.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000004a';
const REALM_B = '64b0c0ffee0000000000004b';
const T1 = '6512f0c2a1b2c3d4e5f64a01';
const T2 = '6512f0c2a1b2c3d4e5f64a02';
const MARCH = '2027030100';
const APRIL = '2027040100';
const IBAN_TINA = 'DE89370400440532013000';
const IBAN_TOM = 'DE02120300000000202051';
// MRE's own payment on T1's March term, recorded in MRE by hand: a settlement, not DE cash (BR-RENT-001).
const MRE_CASH = { date: '01/03/2027', amount: 100, type: 'cash', reference: '', description: 'Bar' };
// The write-back's lease in this wiring: short, so the removal can follow without waiting a real MRE timeout.
const LEASE_MS = 300;

/** The Phase-4 routes (api-design §37) under `/api/v1`, as `METHOD /path/:param`. */
const PHASE_4 = /^[A-Z]+ \/rent-reconciliations\b|^[A-Z]+ \/transactions\/:transactionId\/rent-reconciliations$/;

/**
 * Every route the app serves, from Express' router stack, relative to its mount point. This reads Express 4
 * internals (`app._router.stack`), as ACC2 and ACC3 do; on Express 5 it finds no routes and the comparison fails loudly.
 */
function routesOf(app: Express): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle: { stack?: Layer[] } };
  const walk = (stack: readonly Layer[]): string[] =>
    stack.flatMap((layer) => {
      if (layer.route !== undefined) return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route?.path}`);
      return layer.name === 'router' && layer.handle.stack !== undefined ? walk(layer.handle.stack) : [];
    });
  return walk((app as unknown as { _router: { stack: Layer[] } })._router.stack);
}

describe.skipIf(databaseUrl === undefined)('Phase 4 acceptance (roadmap exit)', () => {
  const schema = testSchemaName('phase_4_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let app: Express;
  let server: Server;
  let base: string;
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
  const realmA: FakeRealm = {
    _id: REALM_A,
    name: 'A',
    members: member,
    applications: [],
    rents: { [T1]: [Number(MARCH), Number(APRIL)], [T2]: [Number(MARCH), Number(APRIL)] },
    rentTerms: {
      [`${T1}/${MARCH}`]: { totalWithoutBalanceAmount: 800, payments: [MRE_CASH] },
      [`${T1}/${APRIL}`]: { totalWithoutBalanceAmount: 800 },
      [`${T2}/${MARCH}`]: { totalWithoutBalanceAmount: 650 },
      // 660.00 rent less a 10.00 settlement discount, as MRE answers it (no VAT).
      [`${T2}/${APRIL}`]: { totalWithoutBalanceAmount: 650, discounts: [{ amount: 10, description: 'Rabatt' }], description: 'April' },
    },
  };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });

    mre = await startFakeMre([realmA, { _id: REALM_B, name: 'B', members: member, applications: [] }]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const accounts = new PostgresFinancialAccountRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const reconciliations = new PostgresRentReconciliationRepository(db);
    const writeBack = { repository: reconciliations, readTerm: mreWriteBackTermReader(client), writeTerm: mreWriteBackTermWriter(client), leaseMs: LEASE_MS };
    app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        rentReconciliations: {
          create: createReconciliation({ repository: reconciliations, lookupMreRentTerm: mreRentTermLookup(client) }),
          get: getReconciliation({ repository: reconciliations }),
          list: listReconciliations({ repository: reconciliations }),
          release: releaseReconciliation({ repository: reconciliations }),
          termCoverage: getTermCoverage({ repository: reconciliations, readMreRentTerm: mreRentTermReader(client) }),
          transactionCoverage: getTransactionCoverage({ repository: reconciliations }),
          suggest: suggestReconciliations({ repository: reconciliations, readMreMonth: mreMonthReader(client) }),
          confirm: confirmReconciliation({ repository: reconciliations, readMreRentTerm: mreRentTermReader(client) }),
          reject: rejectReconciliation({ repository: reconciliations }),
          writeBack: writeBackToMre(writeBack),
          getWithPresence: getReconciliationWithPresence({ repository: reconciliations, readTerm: mreWriteBackTermReader(client) }),
          splitProposal: getRentSplitProposal({ queries: new PostgresTransactionQueries(db), readBreakdown: mreRentBreakdownReader(client) }),
          removeFromMre: removeFromMre({ ...writeBack, marginMs: 0 }),
        },
        financialAccounts: { create: createFinancialAccount({ repository: accounts }) },
        transactions: {
          confirm: confirmTransaction({ repository: transactions }),
          get: getTransaction({ queries: new PostgresTransactionQueries(db) }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          reverse: reverseTransaction({ repository: new PostgresCorrectionRepository(db) }),
        },
        imports: { importStatement: importBankStatement({ imports: new PostgresImportRepository(db), accounts, findAdapter: findBankStatementAdapter }) },
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
  const headers = (realm: string) => ({ authorization: `Bearer ${token}`, organizationid: realm });
  const call = (realm: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...headers(realm), 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const upload = (realm: string, financialAccountId: string, file: string) => {
    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({
        financialAccountId,
        adapterId: 'generic-csv',
        adapterVersion: '1',
        columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag', counterpartyIban: 'IBAN', description: 'Verwendungszweck' },
      }),
    );
    form.append('file', new Blob([file]), 'miete.csv');
    return fetch(`${base}/api/v1/imports/bank-transactions`, { method: 'POST', headers: headers(realm), body: form });
  };

  type Money = { amount: string; currency: string };
  type Reconciliation = { reconciliationId: string; status: string; version: number; mreWriteBackState: string; mrePayment: { reference: string } | null };
  type Term = {
    reconciliations: { reconciliationId: string }[];
    matchedTotal: Money;
    coverage: string | null;
    openAmount: Money | null;
    mreStatus: string;
    mre: { payments: unknown[] } | null;
  };
  const term = async (tenant: string, mreRentTerm: string) => json<Term>(await A('GET', `/rent-reconciliations/terms/${tenant}/${mreRentTerm}`), 200);
  const cash = async (transactionId: string) =>
    json<{ available: Money | null; matchedTotal: Money }>(await A('GET', `/transactions/${transactionId}/rent-reconciliations`), 200);
  const match = async (transactionId: string, tenant: string, mreRentTerm: string, amount: string) =>
    A('POST', '/rent-reconciliations', { transactionId, mreTenantId: tenant, mreRentTerm, matchedAmount: eur(amount) });
  const stored = (tenant: string, mreRentTerm: string) =>
    realmA.rentTerms?.[`${tenant}/${mreRentTerm}`]?.payments as { reference: string; amount: number; type: string }[];
  const rentReads = () => mre.requests.filter((r) => r.path.startsWith('/api/v2/rents/')).length;

  it('runs the Phase-4 exit end to end: suggested and manual matches, human confirmation, write-back exactly once, two records, correction rule, removal, isolation, audit', async () => {
    // Four INFLOW rows from a bank CSV, each split as RENT_BASE and confirmed.
    const { financialAccountId } = await json<{ financialAccountId: string }>(
      await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Mietkonto', currency: 'EUR' }),
      201,
    );
    const statement = [
      'Buchungstag;Betrag;IBAN;Verwendungszweck',
      `02.03.2027;800,00;${IBAN_TINA};Miete März Tina`,
      `05.03.2027;400,00;${IBAN_TOM};Miete März Teil 1`,
      `20.03.2027;250,00;${IBAN_TOM};Miete März Rest`,
      `03.04.2027;1.450,00;${IBAN_TOM};Miete April Tina und Tom`,
    ].join('\r\n');
    const imported = await json<{ transactionCount: number; rows: { transactionId?: string }[] }>(await upload(REALM_A, financialAccountId, statement), 201);
    expect(imported.transactionCount).toBe(4);
    const [r1, r2, r3, r4] = imported.rows.map((r) => r.transactionId ?? '') as [string, string, string, string];
    for (const [t, amount] of [
      [r1, '800.00'],
      [r2, '400.00'],
      [r3, '250.00'],
      [r4, '1450.00'],
    ] as const) {
      await json(await A('PUT', `/transactions/${t}/splits`, { splits: [{ amount: eur(amount), financialCategoryCode: 'RENT_BASE' }] }), 200);
      expect(await json(await A('POST', `/transactions/${t}/confirm`), 200)).toMatchObject({ status: 'CONFIRMED', direction: 'INFLOW' });
    }

    // Matched to an MRE rent obligation, suggested: exactly one suggestion, and it is not cash.
    const suggested = await json<{
      items: (Reconciliation & {
        transactionId: string;
        mreTenantId: string;
        mreRentTerm: string;
        matchedAmount: Money;
        confidence: string;
        suggestionReason: string;
      })[];
    }>(await A('POST', '/rent-reconciliations/suggest', { from: '2027-03', to: '2027-04' }), 200);
    expect(suggested.items.map((i) => [i.transactionId, i.mreTenantId, i.mreRentTerm, i.matchedAmount, i.status, i.confidence, i.suggestionReason])).toEqual([
      [r1, T1, MARCH, eur('800.00'), 'SUGGESTED', 'MEDIUM', 'EXACT_AMOUNT'],
    ]);
    const m1 = suggested.items[0]?.reconciliationId ?? '';
    expect(await cash(r1)).toMatchObject({ available: eur('800.00'), matchedTotal: eur('0.00') });
    expect(await term(T1, MARCH)).toMatchObject({ matchedTotal: eur('0.00'), coverage: 'UNMATCHED' });
    expect((await json<{ items: unknown[] }>(await A('POST', '/rent-reconciliations/suggest', { from: '2027-03', to: '2027-04' }), 200)).items).toEqual([]);

    // … confirmed by a human, with a live MRE read under the caller's token.
    const confirmed = await A('POST', `/rent-reconciliations/${m1}/confirm`, undefined, { 'if-match': '"1"' });
    expect(await json(confirmed, 200)).toMatchObject({ status: 'CONFIRMED', version: 2 });
    expect(mre.requests.at(-1)).toEqual({ path: `/api/v2/rents/tenant/${T1}/${MARCH}`, authorization: `Bearer ${token}`, organizationid: REALM_A });
    expect(await term(T1, MARCH)).toMatchObject({ matchedTotal: eur('800.00'), coverage: 'MATCHED', openAmount: eur('0.00') });

    // A partial and a combined payment, matched by hand.
    const m2 = (await json<Reconciliation>(await match(r2, T2, MARCH, '400.00'), 201)).reconciliationId;
    expect(await term(T2, MARCH)).toMatchObject({ coverage: 'PARTIALLY_MATCHED', openAmount: eur('250.00') });
    const m3 = (await json<Reconciliation>(await match(r3, T2, MARCH, '250.00'), 201)).reconciliationId;
    expect(await term(T2, MARCH)).toMatchObject({ coverage: 'MATCHED', openAmount: eur('0.00') });
    expect(await cash(r4)).toMatchObject({ available: eur('1450.00') });
    const m4a = (await json<Reconciliation>(await match(r4, T1, APRIL, '800.00'), 201)).reconciliationId;
    expect(await cash(r4)).toMatchObject({ available: eur('650.00') });
    const m4b = (await json<Reconciliation>(await match(r4, T2, APRIL, '650.00'), 201)).reconciliationId;
    expect(await cash(r4)).toMatchObject({ available: eur('0.00'), matchedTotal: eur('1450.00') });

    // Cash is never consumed twice.
    const conflict = async (res: Response) => (await json<{ error: { details: Record<string, unknown> } }>(res, 409)).error.details;
    expect(await conflict(await match(r4, T1, MARCH, '0.01'))).toMatchObject({ reason: 'RENT_CASH_EXCEEDED', available: eur('0.00') });
    expect(await conflict(await match(r1, T1, APRIL, '800.00'))).toMatchObject({ reason: 'RENT_CASH_EXCEEDED' });
    expect(await conflict(await match(r2, T2, MARCH, '400.00'))).toEqual({ reason: 'ALREADY_MATCHED', reconciliationId: m2 });

    // … written back to MRE exactly once: DE's payment next to MRE's own, with the marker.
    const writeBack = (id: string) => A('POST', `/rent-reconciliations/${id}/write-back-to-mre`);
    const patches = mre.patches.length;
    expect(await json(await writeBack(m1), 200)).toMatchObject({
      mreWriteBackState: 'WRITTEN',
      mrePayment: { date: '02/03/2027', amount: eur('800.00'), type: 'transfer', reference: `DE-RPR-${m1}` },
    });
    expect(stored(T1, MARCH)).toEqual([MRE_CASH, { date: '02/03/2027', amount: 800, type: 'transfer', reference: `DE-RPR-${m1}`, description: '' }]);
    expect(mre.patches.length).toBe(patches + 1);
    // A repeat answers without an MRE call and adds nothing.
    const reads = rentReads();
    expect(await json(await writeBack(m1), 200)).toMatchObject({ mreWriteBackState: 'WRITTEN' });
    expect(rentReads()).toBe(reads);
    expect(mre.patches.length).toBe(patches + 1);
    // A crashed earlier attempt: its PATCH reached MRE, its record did not. The read finds the marker; no PATCH.
    const t2April = realmA.rentTerms?.[`${T2}/${APRIL}`];
    if (t2April === undefined) throw new Error('term');
    t2April.payments = [{ date: '03/04/2027', amount: 650, type: 'transfer', reference: `DE-RPR-${m4b}`, description: '' }];
    expect(await json(await writeBack(m4b), 200)).toMatchObject({ mreWriteBackState: 'WRITTEN' });
    expect(mre.patches.length).toBe(patches + 1);
    expect(stored(T2, APRIL).filter((p) => p.reference === `DE-RPR-${m4b}`)).toHaveLength(1);
    expect(t2April).toMatchObject({ discounts: [{ amount: 10, description: 'Rabatt' }], description: 'April' });
    // A lost answer: MRE applies the PATCH and the answer is dropped; the second read records WRITTEN.
    mre.faults.push('DROP_ANSWER');
    expect(await json(await writeBack(m4a), 200)).toMatchObject({ mreWriteBackState: 'WRITTEN' });
    expect(mre.patches.length).toBe(patches + 2);
    expect(stored(T1, APRIL).filter((p) => p.reference === `DE-RPR-${m4a}`)).toHaveLength(1);

    // MRE settlement and DE cash remain distinct records.
    expect(await term(T1, MARCH)).toMatchObject({
      reconciliations: [{ reconciliationId: m1 }],
      matchedTotal: eur('800.00'),
      coverage: 'MATCHED',
      mre: {
        payments: [
          { date: '2027-03-01', amount: eur('100.00'), type: 'cash' },
          { date: '2027-03-02', amount: eur('800.00'), type: 'transfer', reference: `DE-RPR-${m1}` },
        ],
      },
    });
    const transaction = await json<{ version: number; amount: Money; splits: unknown[] }>(await A('GET', `/transactions/${r1}`), 200);
    expect(transaction).toMatchObject({ amount: eur('800.00'), splits: [{ amount: eur('800.00'), financialCategoryCode: 'RENT_BASE' }] });
    expect(transaction.splits).toHaveLength(1);
    expect(await json(await A('GET', `/rent-reconciliations/${m1}?checkMre=true`), 200)).toMatchObject({ mrePresence: 'PRESENT' });

    // A correction is refused until release, and a release is DE-only.
    expect(await conflict(await A('POST', `/transactions/${r2}/reverse`, { reason: 'falsch zugeordnet' }))).toEqual({
      reason: 'TRANSACTION_RENT_RECONCILED',
      reconciliationIds: [m2],
    });
    expect(await json(await A('POST', `/rent-reconciliations/${m2}/release`, { reason: 'falsch zugeordnet' }), 200)).toMatchObject({
      status: 'RELEASED',
      mreWriteBackState: 'NOT_WRITTEN',
    });
    expect(await term(T2, MARCH)).toMatchObject({ coverage: 'PARTIALLY_MATCHED', openAmount: eur('400.00') });
    await json(await A('POST', `/transactions/${r2}/reverse`, { reason: 'falsch zugeordnet' }), 201);
    const beforeRelease = rentReads();
    expect(await json(await A('POST', `/rent-reconciliations/${m1}/release`, { reason: 'falscher Monat' }), 200)).toMatchObject({
      status: 'RELEASED',
      mreWriteBackState: 'REMOVAL_REQUIRED',
    });
    expect(rentReads()).toBe(beforeRelease);
    await pause(LEASE_MS + 50);
    expect(await json(await A('POST', `/rent-reconciliations/${m1}/remove-from-mre`), 200)).toMatchObject({ mreWriteBackState: 'REMOVED' });
    expect(stored(T1, MARCH)).toEqual([MRE_CASH]);
    // The write-back changed no Transaction: R1's version is what its confirm left.
    expect((await json<{ version: number }>(await A('GET', `/transactions/${r1}`), 200)).version).toBe(transaction.version);

    // Realm isolation: every Phase-4 route, called by Realm B with Realm A's ids, answers as its row expects.
    const ids: Record<string, string> = { reconciliationId: m1, transactionId: r1, mreTenantId: T1, mreRentTerm: MARCH };
    type Row = { readonly expect: 404 | ((body: unknown) => void); readonly body?: unknown; readonly query?: string };
    const emptyPage = (body: unknown) => expect(body).toMatchObject({ items: [], total: 0 });
    const routes: Record<string, readonly Row[]> = {
      'POST /rent-reconciliations': [{ expect: 404, body: { transactionId: r1, mreTenantId: T1, mreRentTerm: APRIL, matchedAmount: eur('1.00') } }],
      'POST /rent-reconciliations/suggest': [
        {
          expect: (body) => expect(body).toEqual({ from: '2027-03', to: '2027-04', items: [], skipped: { unconfirmed: 0, noRentCash: 0 } }),
          body: { from: '2027-03', to: '2027-04' },
        },
      ],
      'GET /rent-reconciliations': [
        { expect: emptyPage, query: `transactionId=${r1}` },
        { expect: emptyPage, query: `mreTenantId=${T1}` },
        { expect: emptyPage, query: `mreRentTerm=${MARCH}` },
      ],
      'GET /rent-reconciliations/:reconciliationId': [{ expect: 404 }, { expect: 404, query: 'checkMre=true' }],
      // #126 (§37.6): another Realm's Transaction is unknown here, before MRE is asked.
      'GET /rent-reconciliations/split-proposal': [{ expect: 404, query: `transactionId=${r1}&mreTenantId=${T1}&mreRentTerm=${MARCH}` }],
      'POST /rent-reconciliations/:reconciliationId/confirm': [{ expect: 404 }],
      'POST /rent-reconciliations/:reconciliationId/reject': [{ expect: 404, body: { reason: 'x' } }],
      'POST /rent-reconciliations/:reconciliationId/release': [{ expect: 404, body: { reason: 'x' } }],
      'POST /rent-reconciliations/:reconciliationId/write-back-to-mre': [{ expect: 404 }],
      'POST /rent-reconciliations/:reconciliationId/remove-from-mre': [{ expect: 404 }],
      'GET /rent-reconciliations/terms/:mreTenantId/:mreRentTerm': [
        { expect: (body) => expect(body).toMatchObject({ reconciliations: [], matchedTotal: eur('0.00'), mreStatus: 'NOT_RETURNED', mre: null }) },
      ],
      'GET /transactions/:transactionId/rent-reconciliations': [{ expect: 404 }],
    };
    // The table is the app's Phase-4 routes, no more and no fewer: a new route without a row turns this red.
    expect(Object.keys(routes).sort()).toEqual(
      routesOf(app)
        .filter((route) => PHASE_4.test(route))
        .sort(),
    );
    const stateOfA = async () =>
      (await pool.query(`SELECT id, version, status, mre_write_back_state FROM rent_payment_reconciliation WHERE mre_realm_id = $1 ORDER BY id`, [REALM_A]))
        .rows;
    const audits = async () => (await pool.query(`SELECT count(*)::int AS n FROM audit_record`)).rows[0].n as number;
    const before = { state: await stateOfA(), audits: await audits(), patches: mre.patches.length };
    for (const [route, rows] of Object.entries(routes)) {
      for (const row of rows) {
        const [method = '', template = ''] = route.split(' ');
        const path = template.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? `missing-${name}`) + (row.query === undefined ? '' : `?${row.query}`);
        const res = await call(REALM_B, method, path, row.body);
        if (row.expect === 404) {
          expect(res.status, `${route} ${row.query ?? ''}`).toBe(404);
          expect(((await res.json()) as { error: { code: string } }).error.code, route).toBe('NOT_FOUND');
        } else {
          row.expect(await json(res, 200));
        }
        // Nothing is written in Realm A after any row.
        expect(await stateOfA(), route).toEqual(before.state);
        expect(await audits(), route).toBe(before.audits);
        expect(mre.patches.length, route).toBe(before.patches);
      }
    }

    // Traceability: exactly these AuditRecords on the reconciliations, and R2's reversal.
    const audit = await pool.query<{ entity_id: string; action: string; metadata: { manual?: boolean; patched?: boolean } }>(
      `SELECT entity_id, action, metadata FROM audit_record WHERE entity_type = 'RentPaymentReconciliation'`,
    );
    const label = (id: string) => ({ [m1]: 'R1→T1 März', [m2]: 'R2→T2 März', [m3]: 'R3→T2 März', [m4a]: 'R4→T1 April', [m4b]: 'R4→T2 April' })[id] ?? id;
    const flag = (r: (typeof audit.rows)[number]) =>
      r.action === 'CONFIRMED' ? ` manual=${String(r.metadata.manual)}` : r.action === 'WRITE_BACK_WRITTEN' ? ` patched=${String(r.metadata.patched)}` : '';
    expect(audit.rows.map((r) => `${label(r.entity_id)} ${r.action}${flag(r)}`).sort()).toEqual(
      [
        'R1→T1 März SUGGESTED',
        'R1→T1 März CONFIRMED manual=false',
        'R1→T1 März WRITE_BACK_STARTED',
        'R1→T1 März WRITE_BACK_WRITTEN patched=true',
        'R1→T1 März RELEASED',
        'R1→T1 März REMOVAL_STARTED',
        'R1→T1 März REMOVED',
        'R2→T2 März CONFIRMED manual=true',
        'R2→T2 März RELEASED',
        'R3→T2 März CONFIRMED manual=true',
        'R4→T1 April CONFIRMED manual=true',
        'R4→T1 April WRITE_BACK_STARTED',
        'R4→T1 April WRITE_BACK_WRITTEN patched=true',
        'R4→T2 April CONFIRMED manual=true',
        'R4→T2 April WRITE_BACK_STARTED',
        'R4→T2 April WRITE_BACK_WRITTEN patched=false',
      ].sort(),
    );
    const reversed = await pool.query(`SELECT action FROM audit_record WHERE entity_type = 'Transaction' AND entity_id = $1 AND action = 'REVERSED'`, [r2]);
    expect(reversed.rowCount).toBe(1);
  });
});

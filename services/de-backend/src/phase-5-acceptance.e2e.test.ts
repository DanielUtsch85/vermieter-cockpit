import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  amendDeposit,
  closeDeposit,
  confirmReconciliation,
  confirmTransaction,
  correctTransaction,
  createDeposit,
  createFinancialAccount,
  createManualTransaction,
  createReconciliation,
  getDeposit,
  getFinancialCategory,
  getTermCoverage,
  getTransaction,
  getTransactionCoverage,
  importBankStatement,
  listDeposits,
  listFinancialCategories,
  reopenDeposit,
  setTransactionSplits,
  suggestReconciliations,
  voidDeposit,
} from './application/index.js';
import {
  PostgresCorrectionRepository,
  PostgresFinancialAccountRepository,
  PostgresFinancialCategoryRepository,
  PostgresImportRepository,
  PostgresRentReconciliationRepository,
  PostgresSecurityDepositRepository,
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
import { mreMonthReader, mrePrincipalVerifier, mreRentTermLookup, mreRentTermReader, mreTenantDepositReader } from './wiring.js';

/**
 * VC-5-05: the Phase-5 exit of `docs/roadmap.md` as one acceptance run through the HTTP API (ACC5,
 * invariant-suite.md §34), wired as in main.ts: a deposit's expected cash (from MRE's `guaranty`) against its actual
 * cash in instalments, a mixed first transfer, a corrected receipt, interest, a partial repayment with a retained part
 * and the closing, the comparison with MRE; and never rent (P5-D6): only the rent splits are rent cash, a March rent
 * paid in February is suggested in order (#125), a deposit instalment of a rent's amount is no candidate. Every §47
 * route is Realm-isolated. The figures are hand-computed in §34 and checked literally.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000005c';
const REALM_B = '64b0c0ffee0000000000005d';
const T1 = '6512f0c2a1b2c3d4e5f65c01';
const JAN = '2027010100';
const FEB = '2027020100';
const MARCH = '2027030100';
const IBAN_K = 'DE89370400440532013000';

/** The Phase-5 routes (api-design §47) under `/api/v1`, as `METHOD /path/:param`. */
/** The deposit routes of Phase 5; the deposit's tax meaning (`…/tax-meaning`) is Phase 7's (VC-7-02, §58A). */
const PHASE_5 = /^[A-Z]+ \/security-deposits\b(?!.*\/tax-meaning$)/;

/** Every route the app serves, from Express' router stack (Express 4 internals, as ACC2–ACC4). */
function routesOf(app: Express): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle: { stack?: Layer[] } };
  const walk = (stack: readonly Layer[]): string[] =>
    stack.flatMap((layer) => {
      if (layer.route !== undefined) return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route?.path}`);
      return layer.name === 'router' && layer.handle.stack !== undefined ? walk(layer.handle.stack) : [];
    });
  return walk((app as unknown as { _router: { stack: Layer[] } })._router.stack);
}

describe.skipIf(databaseUrl === undefined)('Phase 5 acceptance (roadmap exit)', () => {
  const schema = testSchemaName('phase_5_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let app: Express;
  let server: Server;
  let base: string;
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
  // T1: guaranty 2400 (three net rents of 800, as MRE stores it); after the move-out MRE records the payback.
  const tenant: Record<string, unknown> = { _id: T1, name: 'Mieterin K', guaranty: 2400 };
  const realmA: FakeRealm = {
    _id: REALM_A,
    name: 'A',
    members: member,
    applications: [],
    tenants: [tenant],
    rents: { [T1]: [Number(JAN), Number(FEB), Number(MARCH)] },
    rentTerms: Object.fromEntries([JAN, FEB, MARCH].map((t) => [`${T1}/${t}`, { totalWithoutBalanceAmount: 800 }])),
  };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });

    mre = await startFakeMre([realmA, { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [] }]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const deposits = new PostgresSecurityDepositRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const reconciliations = new PostgresRentReconciliationRepository(db);
    const categories = new PostgresFinancialCategoryRepository(db);
    const readMreTenant = mreTenantDepositReader(client);
    const accounts = new PostgresFinancialAccountRepository(db);
    app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        securityDeposits: {
          create: createDeposit({ repository: deposits, readMreTenant }),
          get: getDeposit({ repository: deposits, readMreTenant }),
          list: listDeposits({ repository: deposits }),
          amend: amendDeposit({ repository: deposits }),
          void: voidDeposit({ repository: deposits }),
          close: closeDeposit({ repository: deposits }),
          reopen: reopenDeposit({ repository: deposits }),
        },
        rentReconciliations: {
          create: createReconciliation({ repository: reconciliations, lookupMreRentTerm: mreRentTermLookup(client) }),
          termCoverage: getTermCoverage({ repository: reconciliations, readMreRentTerm: mreRentTermReader(client) }),
          transactionCoverage: getTransactionCoverage({ repository: reconciliations }),
          suggest: suggestReconciliations({ repository: reconciliations, readMreMonth: mreMonthReader(client) }),
          confirm: confirmReconciliation({ repository: reconciliations, readMreRentTerm: mreRentTermReader(client) }),
        },
        financialAccounts: { create: createFinancialAccount({ repository: accounts }) },
        imports: { importStatement: importBankStatement({ imports: new PostgresImportRepository(db), accounts, findAdapter: findBankStatementAdapter }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
          correct: correctTransaction({ repository: new PostgresCorrectionRepository(db) }),
          get: getTransaction({ queries: new PostgresTransactionQueries(db) }),
        },
        financialCategories: { list: listFinancialCategories({ categories }), get: getFinancialCategory({ categories }) },
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
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const errorOf = async (res: Response, status: number) => (await json<{ error: { code: string; details?: Record<string, unknown> } }>(res, status)).error;
  const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
  const eur = (amount: string) => ({ amount, currency: 'EUR' });

  type Money = { amount: string; currency: string };
  type Deposit = {
    securityDepositId: string;
    status: string;
    version: number;
    expectedAmount: Money;
    expectedAmountSource: string;
    received: Money;
    interestCredited: Money;
    returned: Money;
    outstanding: Money;
    held: Money;
    state: string;
    flags: { code: string; details: Record<string, unknown> }[];
    cash?: { transactionId: string; kind: string; amount: Money }[];
    closing: Record<string, unknown> | null;
    mre?: { guaranty: Money | null; guarantyPayback: Money | null } | null;
  };
  type Split = { amount: string; code: string; deposit?: string };
  const account = async (accountType: string, displayName: string) =>
    (await json<{ financialAccountId: string }>(await A('POST', '/financial-accounts', { accountType, displayName, currency: 'EUR' }), 201)).financialAccountId;
  /** A manual Transaction, split and confirmed (`confirm` false leaves it open). */
  const book = async (on: string, bookingDate: string, direction: 'INFLOW' | 'OUTFLOW', amount: string, splits: readonly Split[], confirm = true) => {
    const id = (
      await json<{ transactionId: string }>(
        await A('POST', '/transactions', { financialAccountId: on, amount: eur(amount), direction, bookingDate, description: 'Überweisung' }),
        201,
      )
    ).transactionId;
    const res = await A('PUT', `/transactions/${id}/splits`, { splits: splits.map(splitDto) });
    if (res.status !== 200) return { id, res };
    if (confirm) await json(await A('POST', `/transactions/${id}/confirm`), 200);
    return { id, res };
  };
  const upload = (financialAccountId: string, file: string) => {
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
    form.append('file', new Blob([file]), 'konto.csv');
    return fetch(`${base}/api/v1/imports/bank-transactions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, organizationid: REALM_A },
      body: form,
    });
  };
  const splitDto = (s: Split) => ({
    amount: eur(s.amount),
    financialCategoryCode: s.code,
    ...(s.deposit === undefined ? {} : { securityDepositId: s.deposit }),
  });
  const figures = (d: Deposit) => ({
    received: d.received.amount,
    interestCredited: d.interestCredited.amount,
    returned: d.returned.amount,
    outstanding: d.outstanding.amount,
    held: d.held.amount,
    state: d.state,
  });
  const flagCodes = (d: Deposit) => d.flags.map((f) => f.code);

  it('runs the Phase-5 exit end to end: expected vs actual deposit cash, never rent, correction, interest, retained part and closing, isolation, audit', async () => {
    const giro = await account('BANK', 'Girokonto');
    const kaution = await account('SECURITY_DEPOSIT', 'Kautionskonto');

    // Expected cash: from MRE's guaranty; one deposit per Tenant.
    const created = await json<Deposit>(await A('POST', '/security-deposits', { mreTenantId: T1, holdingFinancialAccountId: kaution }), 201);
    const id = created.securityDepositId;
    expect([created.expectedAmount, created.expectedAmountSource, created.state, created.outstanding]).toEqual([
      eur('2400.00'),
      'MRE_GUARANTY',
      'EXPECTED',
      eur('2400.00'),
    ]);
    expect(await errorOf(await A('POST', '/security-deposits', { mreTenantId: T1 }), 409)).toMatchObject({ details: { reason: 'DEPOSIT_EXISTS' } });
    const read = async (query = '') => json<Deposit>(await A('GET', `/security-deposits/${id}${query}`), 200);

    // The Girokonto's statement, imported with the tenant's IBAN: R0 January's rent on time; R1 February's rent paid
    // early with the first instalment in one transfer; R2 March's rent paid early (F10, #125).
    const statement = [
      'Buchungstag;Betrag;IBAN;Verwendungszweck',
      `04.01.2027;800,00;${IBAN_K};Miete`,
      `28.01.2027;1.600,00;${IBAN_K};Miete und Kaution`,
      `26.02.2027;800,00;${IBAN_K};Miete`,
    ].join('\r\n');
    const imported = await json<{ rows: { transactionId?: string }[] }>(await upload(giro, statement), 201);
    const [r0, r1, r2] = imported.rows.map((r) => r.transactionId ?? '') as [string, string, string];
    const rent = [
      { amount: '650.00', code: 'RENT_BASE' },
      { amount: '150.00', code: 'RENT_OPERATING_COST_ADVANCE' },
    ];
    const splitAndConfirm = async (transactionId: string, splits: readonly Split[]) => {
      await json(await A('PUT', `/transactions/${transactionId}/splits`, { splits: splits.map(splitDto) }), 200);
      await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
    };
    await splitAndConfirm(r0, rent);
    await splitAndConfirm(r1, [...rent, { amount: '800.00', code: 'SECURITY_DEPOSIT', deposit: id }]);
    let d = await read();
    expect(figures(d)).toMatchObject({ received: '800.00', outstanding: '1600.00', state: 'PARTIALLY_RECEIVED' });
    expect(d.flags).toEqual([{ code: 'RECEIVED_OUTSIDE_HOLDING_ACCOUNT', details: { transactionIds: [r1] } }]);

    // R3, R4: the instalments on the deposit account, R4 entered by hand with a typo.
    await splitAndConfirm(r2, rent);
    const r3 = (await book(kaution, '2027-03-01', 'INFLOW', '800.00', [{ amount: '800.00', code: 'SECURITY_DEPOSIT', deposit: id }])).id;
    expect(figures(await read())).toMatchObject({ received: '1600.00' });
    const r4 = (await book(kaution, '2027-04-01', 'INFLOW', '880.00', [{ amount: '880.00', code: 'SECURITY_DEPOSIT', deposit: id }])).id;
    d = await read();
    expect(figures(d)).toMatchObject({ received: '2480.00', outstanding: '0.00', state: 'RECEIVED' });
    expect(d.flags).toEqual([
      { code: 'RECEIVED_EXCEEDS_EXPECTED', details: { excess: eur('80.00') } },
      { code: 'RECEIVED_OUTSIDE_HOLDING_ACCOUNT', details: { transactionIds: [r1] } },
    ]);
    expect(d.cash?.map((c) => c.transactionId)).toEqual([r1, r3, r4]);

    // A correction of a receipt: R4 replaced by 800.00, the deposit kept; neither R4 nor its reversal counts.
    const corrected = await json<{ replacement: { transactionId: string } }>(
      await A('POST', `/transactions/${r4}/correct`, {
        reason: 'Tippfehler',
        replacement: { amount: eur('800.00'), splits: [splitDto({ amount: '800.00', code: 'SECURITY_DEPOSIT', deposit: id })] },
      }),
      201,
    );
    const r4b = corrected.replacement.transactionId;
    d = await read();
    expect(figures(d)).toMatchObject({ received: '2400.00', outstanding: '0.00', state: 'RECEIVED' });
    expect(flagCodes(d)).toEqual(['RECEIVED_OUTSIDE_HOLDING_ACCOUNT']);
    expect(d.cash?.map((c) => c.transactionId)).toEqual([r1, r3, r4b]);

    // Interest credited: held, never received.
    await book(kaution, '2027-12-31', 'INFLOW', '4.20', [{ amount: '4.20', code: 'SECURITY_DEPOSIT_INTEREST', deposit: id }]);
    d = await read();
    expect(figures(d)).toEqual({ received: '2400.00', interestCredited: '4.20', returned: '0.00', outstanding: '0.00', held: '2404.20', state: 'RECEIVED' });

    // Never rent (P5-D6): R1's rent cash is its rent splits only. January matched by hand, the suggestions for February
    // and March take the early payments in order (#125), never R3, a deposit instalment of a rent's amount.
    expect(await json(await A('GET', `/transactions/${r1}/rent-reconciliations`), 200)).toMatchObject({ available: eur('800.00') });
    await json(await A('POST', '/rent-reconciliations', { transactionId: r0, mreTenantId: T1, mreRentTerm: JAN, matchedAmount: eur('800.00') }), 201);
    const suggested = await json<{
      items: { reconciliationId: string; transactionId: string; mreRentTerm: string; matchedAmount: Money; suggestionReason: string; confidence: string }[];
    }>(await A('POST', '/rent-reconciliations/suggest', { from: '2027-02', to: '2027-03' }), 200);
    expect(
      suggested.items
        .map((i) => [i.transactionId, i.mreRentTerm, i.matchedAmount, i.suggestionReason, i.confidence])
        .sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
    ).toEqual([
      [r1, FEB, eur('800.00'), 'EXACT_AMOUNT_IN_ORDER', 'HIGH'],
      [r2, MARCH, eur('800.00'), 'EXACT_AMOUNT_IN_ORDER', 'HIGH'],
    ]);
    expect(
      await errorOf(await A('POST', '/rent-reconciliations', { transactionId: r3, mreTenantId: T1, mreRentTerm: MARCH, matchedAmount: eur('800.00') }), 422),
    ).toMatchObject({
      code: 'NO_RENT_CASH',
    });
    for (const s of suggested.items) await json(await A('POST', `/rent-reconciliations/${s.reconciliationId}/confirm`, undefined, { 'if-match': '"1"' }), 200);
    for (const term of [FEB, MARCH]) {
      expect(await json(await A('GET', `/rent-reconciliations/terms/${T1}/${term}`), 200), term).toMatchObject({
        matchedTotal: eur('800.00'),
        coverage: 'MATCHED',
      });
    }
    expect(figures(await read())).toMatchObject({ received: '2400.00', held: '2404.20' });
    for (const code of ['SECURITY_DEPOSIT', 'SECURITY_DEPOSIT_INTEREST']) {
      expect(await json(await A('GET', `/financial-categories/${code}`), 200), code).toMatchObject({ categoryType: 'SECURITY_DEPOSIT' });
    }

    // The move-out: 2,254.20 repaid, 150.00 kept for the utility bill; RETURNED refused, RETAINED closes.
    await book(kaution, '2028-01-15', 'OUTFLOW', '2254.20', [{ amount: '2254.20', code: 'SECURITY_DEPOSIT', deposit: id }]);
    d = await read();
    expect(figures(d)).toMatchObject({ returned: '2254.20', held: '150.00', state: 'PARTIALLY_RETURNED' });
    expect(await errorOf(await A('POST', `/security-deposits/${id}/close`, { closingDate: '2028-01-31', reason: 'RETURNED' }), 409)).toMatchObject({
      details: { reason: 'DEPOSIT_STILL_HELD', held: eur('150.00') },
    });
    const closed = await json<Deposit>(
      await A(
        'POST',
        `/security-deposits/${id}/close`,
        { closingDate: '2028-01-31', reason: 'RETAINED', closingNote: 'Nebenkosten 2027' },
        { 'if-match': `"${d.version}"` },
      ),
      200,
    );
    expect([closed.status, closed.state, closed.closing]).toEqual([
      'CLOSED',
      'CLOSED',
      {
        closingDate: '2028-01-31',
        reason: 'RETAINED',
        closingNote: 'Nebenkosten 2027',
        heldAtClosing: eur('150.00'),
        retainedAmount: eur('150.00'),
      },
    ]);
    tenant['guarantyPayback'] = 2254.2;
    const compared = await read('?checkMre=true');
    expect(compared.mre).toEqual({ guaranty: eur('2400.00'), guarantyPayback: eur('2254.20') });
    expect(flagCodes(compared)).toEqual(['RECEIVED_OUTSIDE_HOLDING_ACCOUNT']);
    const late = await book(kaution, '2028-01-20', 'INFLOW', '1.00', [{ amount: '1.00', code: 'SECURITY_DEPOSIT', deposit: id }]);
    expect(await errorOf(late.res, 409)).toMatchObject({ details: { reason: 'DEPOSIT_CLOSED', securityDepositId: id } });
    expect(await errorOf(await A('POST', `/security-deposits/${id}/void`, { reason: 'x' }), 409)).toMatchObject({ details: { reason: 'DEPOSIT_CLOSED' } });

    // Realm isolation: every Phase-5 route, called by Realm B with Realm A's ids, answers as its row expects.
    const ids: Record<string, string> = { securityDepositId: id };
    type Row = { readonly expect: 404 | ((body: unknown) => void); readonly body?: unknown; readonly query?: string };
    const emptyPage = (body: unknown) => expect(body).toMatchObject({ items: [], total: 0 });
    const routes: Record<string, readonly Row[]> = {
      'POST /security-deposits': [{ expect: 404, body: { mreTenantId: T1, holdingFinancialAccountId: kaution } }],
      'GET /security-deposits': [
        { expect: emptyPage, query: `mreTenantId=${T1}` },
        { expect: emptyPage, query: `holdingFinancialAccountId=${kaution}` },
      ],
      'GET /security-deposits/:securityDepositId': [{ expect: 404 }, { expect: 404, query: 'checkMre=true' }],
      'POST /security-deposits/:securityDepositId/amend': [{ expect: 404, body: { notes: 'x' } }],
      'POST /security-deposits/:securityDepositId/void': [{ expect: 404, body: { reason: 'x' } }],
      'POST /security-deposits/:securityDepositId/close': [{ expect: 404, body: { closingDate: '2028-01-31', reason: 'OTHER', closingNote: 'x' } }],
      'POST /security-deposits/:securityDepositId/reopen': [{ expect: 404, body: {} }],
    };
    // The table is the app's Phase-5 routes, no more and no fewer: a new route without a row turns this red.
    expect(Object.keys(routes).sort()).toEqual(
      routesOf(app)
        .filter((route) => PHASE_5.test(route))
        .sort(),
    );
    const stateOfA = async () =>
      (await pool.query(`SELECT id, version, status, closing_reason FROM security_deposit WHERE mre_realm_id = $1 ORDER BY id`, [REALM_A])).rows;
    const audits = async () => (await pool.query(`SELECT count(*)::int AS n FROM audit_record`)).rows[0].n as number;
    const before = { state: await stateOfA(), audits: await audits() };
    const check = async (label: string) => {
      expect(await stateOfA(), label).toEqual(before.state);
      expect(await audits(), label).toBe(before.audits);
    };
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
        await check(route);
      }
    }
    // A split in Realm B naming Realm A's deposit: 404, nothing written.
    const giroB = (
      await json<{ financialAccountId: string }>(
        await call(REALM_B, 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro B', currency: 'EUR' }),
        201,
      )
    ).financialAccountId;
    const txB = (
      await json<{ transactionId: string }>(
        await call(REALM_B, 'POST', '/transactions', { financialAccountId: giroB, amount: eur('1.00'), direction: 'INFLOW', bookingDate: '2028-01-20' }),
        201,
      )
    ).transactionId;
    const foreign = await call(REALM_B, 'PUT', `/transactions/${txB}/splits`, {
      splits: [splitDto({ amount: '1.00', code: 'SECURITY_DEPOSIT', deposit: id })],
    });
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: { details: Record<string, unknown> } }).error.details).toMatchObject({ securityDepositId: id });
    expect(await stateOfA()).toEqual(before.state);

    // Traceability: the deposit's AuditRecords, exactly.
    const trail = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'SecurityDeposit' AND entity_id = $1 ORDER BY new_version`, [
      id,
    ]);
    expect(trail.rows.map((r) => r.action)).toEqual(['CREATED', 'CLOSED']);
    expect(trail.rows[1].metadata).toMatchObject({ reason: 'RETAINED', heldAtClosing: eur('150.00') });
  });
});

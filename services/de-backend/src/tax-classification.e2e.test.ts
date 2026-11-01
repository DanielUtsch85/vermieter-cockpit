import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  confirmTransaction,
  createFinancialAccount,
  createMembership,
  createParty,
  createTaxClassification,
  createWeg,
  getTaxClassification,
  getTaxMeaning,
  getTaxRule,
  importBankStatement,
  listTaxClassificationHistory,
  listTaxMeanings,
  listTaxRules,
  reviewTaxClassification,
  setTransactionSplits,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresImportRepository,
  PostgresPartyRepository,
  PostgresTaxClassificationRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { findBankStatementAdapter } from './integrations/bank-import/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-7-01 end to end (api-design.md §55–§58), wired as in main.ts: a year of imported and split cash; the defaults
 * read per split and per property and year; a MAINTENANCE split reclassified as CAPITALIZED, then advisor-confirmed;
 * a WEG_RESERVE_CONTRIBUTION split refused as DEDUCTIBLE and an ACQUISITION split as CAPITALIZED; the cash unchanged by
 * every command; Realm isolation on every route of §55–§58. Figures are invented.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee000000000000b1';
const REALM_B = '64b0c0ffee000000000000b2';
const IBAN_TENANT = 'DE02120300000000202051';
const IBAN_WEG = 'DE89370400440532013000';

/** The routes of §55–§58 under `/api/v1`, as `METHOD /path/:param`. */
const VC_7_01 =
  /^[A-Z]+ \/(tax-rules|tax-classifications)\b|^[A-Z]+ \/transaction-splits\/:splitId\/tax-meaning$|^[A-Z]+ \/property-references\/:propertyReferenceId\/tax-meanings$/;

function routesOf(app: Express): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle: { stack?: Layer[] } };
  const walk = (stack: readonly Layer[]): string[] =>
    stack.flatMap((layer) => {
      if (layer.route !== undefined) return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route?.path}`);
      return layer.name === 'router' && layer.handle.stack !== undefined ? walk(layer.handle.stack) : [];
    });
  return walk((app as unknown as { _router: { stack: Layer[] } })._router.stack);
}

describe.skipIf(databaseUrl === undefined)('Tax classification (VC-7-01) end to end', () => {
  const schema = testSchemaName('tax_classification_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let app: Express;
  let server: Server;
  let base: string;
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    mre = await startFakeMre([
      { _id: REALM_A, name: 'A', members: member, applications: [] },
      { _id: REALM_B, name: 'B', members: member, applications: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const wegs = new PostgresWegRepository(db);
    const accounts = new PostgresFinancialAccountRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const parties = new PostgresPartyRepository(db);
    const classifications = new PostgresTaxClassificationRepository(db);
    app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        parties: { create: createParty({ repository: parties }) },
        wegs: { createWeg: createWeg({ repository: wegs }), createMembership: createMembership({ repository: wegs }) },
        financialAccounts: { create: createFinancialAccount({ repository: accounts }) },
        imports: { importStatement: importBankStatement({ imports: new PostgresImportRepository(db), accounts, findAdapter: findBankStatementAdapter }) },
        transactions: {
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
        },
        taxation: {
          create: createTaxClassification({ repository: classifications }),
          get: getTaxClassification({ repository: classifications }),
          history: listTaxClassificationHistory({ repository: classifications }),
          review: reviewTaxClassification({ repository: classifications }),
          taxMeaning: getTaxMeaning({ repository: classifications }),
          taxMeanings: listTaxMeanings({ repository: classifications }),
          listRules: listTaxRules(),
          getRule: getTaxRule(),
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
  const B = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_B, method, path, body, extra);
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const errorOf = async (res: Response, status: number) => (await json<{ error: { code: string; details?: Record<string, unknown> } }>(res, status)).error;
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
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
  type Meaning = {
    splitId: string;
    transactionId: string;
    financialCategoryCode: string;
    taxCategory: string;
    treatment: string | null;
    reviewState: string;
    origin: string;
    rule: { ruleCode: string; version: number } | null;
    classificationId: string | null;
    flags: { code: string }[];
  };
  type Classification = {
    classificationId: string;
    reviewState: string;
    treatment: string;
    advisorPartyId: string | null;
    version: number;
    supersedes: string | null;
  };
  /** Every Transaction row and split row of Realm A as stored. */
  const cash = async () => ({
    transactions: (await pool.query(`SELECT row_to_json(t)::text AS j FROM ledger_transaction t WHERE mre_realm_id = $1 ORDER BY id`, [REALM_A])).rows,
    splits: (await pool.query(`SELECT row_to_json(s)::text AS j FROM transaction_split s WHERE mre_realm_id = $1 ORDER BY id`, [REALM_A])).rows,
  });

  it('a year of cash: defaults, a reclassification, an advisor confirmation, the hard rules, Realm isolation', async () => {
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f7b101', 'ACTIVE', 'x') RETURNING id`,
      [REALM_A],
    );
    const flat = rows[0].id as string;
    const weg = await json<{ wegId: string }>(await A('POST', '/wegs', { displayName: 'WEG Musterstraße 7' }), 201);
    await json(await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '250/10000', validFrom: '2026-01-01' }), 201);
    const giro = (
      await json<{ financialAccountId: string }>(
        await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR' }),
        201,
      )
    ).financialAccountId;

    // A year of cash, imported: twelve rents of 900 + 150, twelve reserve contributions, a repair, a purchase payment.
    const lines = [
      ...Array.from({ length: 12 }, (_, i) => {
        const mm = String(i + 1).padStart(2, '0');
        return [`01.${mm}.2026;1050,00;${IBAN_TENANT};Miete ${mm}/2026`, `03.${mm}.2026;-50,00;${IBAN_WEG};Erhaltungsrücklage ${mm}/2026`];
      }).flat(),
      `14.05.2026;-1200,00;${IBAN_WEG};Rechnung 2026-117 Thermostatventile`,
      `20.06.2026;-5000,00;${IBAN_WEG};Kaufpreisrate`,
    ];
    const imported = await json<{ rows: { transactionId?: string }[] }>(
      await upload(giro, ['Buchungstag;Betrag;IBAN;Verwendungszweck', ...lines].join('\r\n')),
      201,
    );
    const ids = imported.rows.map((r) => r.transactionId ?? '');
    expect(ids).toHaveLength(26);
    const apply = async (transactionId: string, splits: { code: string; amount: string }[]) => {
      await json(
        await A('PUT', `/transactions/${transactionId}/splits`, {
          splits: splits.map((s) => ({ amount: eur(s.amount), financialCategoryCode: s.code, propertyReferenceId: flat })),
        }),
        200,
      );
      await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
    };
    for (let i = 0; i < 12; i++) {
      await apply(ids[2 * i] as string, [
        { code: 'RENT_BASE', amount: '900.00' },
        { code: 'RENT_OPERATING_COST_ADVANCE', amount: '150.00' },
      ]);
      await apply(ids[2 * i + 1] as string, [{ code: 'WEG_RESERVE_CONTRIBUTION', amount: '50.00' }]);
    }
    const [repair, purchase] = [ids[24] as string, ids[25] as string];
    await apply(repair, [{ code: 'MAINTENANCE', amount: '1200.00' }]);
    await apply(purchase, [{ code: 'ACQUISITION', amount: '5000.00' }]);

    // The defaults, per property and year: every split counts, read by DE_CATEGORY_DEFAULTS@1.
    const year = await json<{ items: Meaning[]; total: number }>(await A('GET', `/property-references/${flat}/tax-meanings?year=2026&pageSize=200`), 200);
    expect(year.total).toBe(38);
    const byCode = (code: string) => year.items.filter((m) => m.financialCategoryCode === code);
    expect(byCode('RENT_BASE').every((m) => m.taxCategory === 'RENT' && m.treatment === 'INCOME' && m.reviewState === 'SUGGESTED')).toBe(true);
    expect(byCode('RENT_OPERATING_COST_ADVANCE').map((m) => m.taxCategory)).toEqual(Array.from({ length: 12 }, () => 'OPERATING_COST_ADVANCES'));
    expect(byCode('WEG_RESERVE_CONTRIBUTION').every((m) => m.treatment === 'NOT_RELEVANT')).toBe(true);
    expect(byCode('ACQUISITION').map((m) => [m.taxCategory, m.treatment])).toEqual([['NOT_RELEVANT', 'NOT_RELEVANT']]);
    expect(year.items.every((m) => m.origin === 'DEFAULT' && m.rule?.version === 1)).toBe(true);
    // VC-7-02 (§58A): the January rent lies in the window of the year-end and has no reconciliation, so no economic
    // period: it keeps its booking year, flagged. Nothing else is flagged.
    expect(year.items.filter((m) => m.flags.length > 0).map((m) => [m.financialCategoryCode, m.flags.map((f) => f.code)])).toEqual([
      ['RENT_BASE', ['NO_ECONOMIC_PERIOD']],
      ['RENT_OPERATING_COST_ADVANCE', ['NO_ECONOMIC_PERIOD']],
    ]);
    const [repairMeaning] = byCode('MAINTENANCE') as [Meaning];
    expect(repairMeaning).toMatchObject({ taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', reviewState: 'SUGGESTED', classificationId: null });
    const reserveSplit = (byCode('WEG_RESERVE_CONTRIBUTION')[0] as Meaning).splitId;
    const purchaseSplit = (byCode('ACQUISITION')[0] as Meaning).splitId;
    // The list item adds the amount of the year (§58B); the single read is the same meaning otherwise.
    const { yearAmount, ...single } = repairMeaning as Meaning & { yearAmount: unknown };
    expect(yearAmount).toEqual({ amount: '1200.00', currency: 'EUR' });
    expect(await json(await A('GET', `/transaction-splits/${repairMeaning.splitId}/tax-meaning`), 200)).toEqual(single);
    const rules = await json<{ items: { ruleCode: string; versions: { version: number; status: string }[] }[] }>(await A('GET', '/tax-rules'), 200);
    expect(rules.items.map((r) => [r.ruleCode, r.versions.map((v) => [v.version, v.status])])).toEqual([
      ['DE_82B_DISTRIBUTION', [[1, 'ACTIVE']]],
      // VC-8-01 (§59): Depreciation's rule, in the same registry; VC-8-02 (§59A) adds @1 for 2006–2022, today's is @2.
      [
        'DE_AFA_BUILDING_LINEAR',
        [
          [1, 'SUPERSEDED'],
          [2, 'ACTIVE'],
        ],
      ],
      // VC-8-03 (§59B): the movable rule of a separate asset, after the building's.
      ['DE_AFA_MOVABLE_LINEAR', [[1, 'ACTIVE']]],
      ['DE_ANSCHAFFUNGSNAHE', [[1, 'ACTIVE']]],
      ['DE_CASH_TIMING', [[1, 'ACTIVE']]],
      ['DE_CATEGORY_DEFAULTS', [[1, 'ACTIVE']]],
      ['DE_CONSTRUCTION_PERIOD_INTEREST', [[1, 'ACTIVE']]],
      ['DE_WEG_SPENDING', [[1, 'ACTIVE']]],
    ]);
    const before = await cash();

    // The repair is Herstellungskosten: reclassified as CAPITALIZED, then confirmed by the advisor.
    const created = await A(
      'POST',
      '/tax-classifications',
      {
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: repairMeaning.splitId,
        taxCategory: 'MAINTENANCE',
        treatment: 'CAPITALIZED',
        reviewState: 'NEEDS_REVIEW',
        notes: 'Austausch Thermostatventile, Erweiterung',
        sourceReferences: ['Rechnung 2026-117'],
      },
      { 'idempotency-key': 'reclassify-repair' },
    );
    const classification = await json<Classification>(created, 201);
    expect(created.headers.get('etag')).toBe('"1"');
    expect(created.headers.get('location')).toBe(`/api/v1/tax-classifications/${classification.classificationId}`);
    expect(await json<Meaning>(await A('GET', `/transaction-splits/${repairMeaning.splitId}/tax-meaning`), 200)).toMatchObject({
      origin: 'CLASSIFICATION',
      treatment: 'CAPITALIZED',
      reviewState: 'NEEDS_REVIEW',
      classificationId: classification.classificationId,
    });
    const advisor = await json<{ partyId: string }>(
      await A('POST', '/parties', { partyType: 'ORGANIZATION', displayName: 'Steuerbüro', legalName: 'Steuerbüro GmbH' }),
      201,
    );
    const confirmed = await json<Classification>(
      await A(
        'POST',
        `/tax-classifications/${classification.classificationId}/advisor-confirm`,
        { advisorPartyId: advisor.partyId, note: 'Herstellungskosten' },
        { 'if-match': '"1"' },
      ),
      200,
    );
    expect(confirmed).toMatchObject({ reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor.partyId, version: 2 });
    expect(await errorOf(await A('POST', `/tax-classifications/${classification.classificationId}/confirm`, {}), 409)).toMatchObject({
      details: { reason: 'ADVISOR_CONFIRMED' },
    });
    const filtered = await json<{ items: Meaning[] }>(await A('GET', `/property-references/${flat}/tax-meanings?year=2026&origin=CLASSIFICATION`), 200);
    expect(filtered.items.map((m) => [m.splitId, m.reviewState])).toEqual([[repairMeaning.splitId, 'ADVISOR_CONFIRMED']]);

    // The hard rules: the reserve contribution is never deductible (BFH IX R 19/24), the purchase never capitalised here.
    expect(
      await errorOf(
        await A('POST', '/tax-classifications', {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: reserveSplit,
          taxCategory: 'WEG_HAUSGELD',
          treatment: 'DEDUCTIBLE',
        }),
        422,
      ),
    ).toMatchObject({ code: 'TREATMENT_NOT_ALLOWED', details: { categoryType: 'WEG_FUNDS', allowed: ['NOT_RELEVANT'] } });
    expect(
      await errorOf(
        await A('POST', '/tax-classifications', {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: purchaseSplit,
          taxCategory: 'MAINTENANCE',
          treatment: 'CAPITALIZED',
        }),
        422,
      ),
    ).toMatchObject({ code: 'TREATMENT_NOT_ALLOWED', details: { categoryType: 'CAPITAL_MOVEMENT' } });
    // The cash is unchanged: rows and versions of every Transaction and split.
    expect(await cash()).toEqual(before);

    // Realm isolation on every route of §55–§58.
    const c = classification.classificationId;
    const exercised = new Set<string>();
    const isolated = async (method: string, route: string, path: string, body?: unknown) => {
      exercised.add(`${method} ${route}`);
      return B(method, path, body);
    };
    expect(
      (
        await isolated('POST', '/tax-classifications', '/tax-classifications', {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: repairMeaning.splitId,
          taxCategory: 'MAINTENANCE',
          treatment: 'DEDUCTIBLE',
        })
      ).status,
    ).toBe(404);
    expect((await isolated('GET', '/tax-classifications/:classificationId', `/tax-classifications/${c}`)).status).toBe(404);
    expect((await isolated('GET', '/tax-classifications', `/tax-classifications?sourceType=TRANSACTION_SPLIT&sourceId=${repairMeaning.splitId}`)).status).toBe(
      404,
    );
    for (const step of ['confirm', 'advisor-confirm']) {
      expect((await isolated('POST', `/tax-classifications/:classificationId/${step}`, `/tax-classifications/${c}/${step}`, {})).status).toBe(404);
    }
    expect(
      (await isolated('POST', '/tax-classifications/:classificationId/mark-needs-review', `/tax-classifications/${c}/mark-needs-review`, { reason: 'x' }))
        .status,
    ).toBe(404);
    expect((await isolated('GET', '/transaction-splits/:splitId/tax-meaning', `/transaction-splits/${repairMeaning.splitId}/tax-meaning`)).status).toBe(404);
    expect(
      (await isolated('GET', '/property-references/:propertyReferenceId/tax-meanings', `/property-references/${flat}/tax-meanings?year=2026`)).status,
    ).toBe(404);
    // The registry has no Realm: the same for everyone.
    expect(await json(await isolated('GET', '/tax-rules', '/tax-rules'), 200)).toEqual(rules);
    expect((await isolated('GET', '/tax-rules/:ruleCode', '/tax-rules/DE_CATEGORY_DEFAULTS')).status).toBe(200);
    // Every route of §55–§58 was tried from Realm B.
    expect([...exercised].sort()).toEqual(
      routesOf(app)
        .filter((r) => VC_7_01.test(r))
        .sort(),
    );
    // Nothing changed in Realm A, and the history still holds the one classification.
    const history = await json<{ items: Classification[] }>(
      await A('GET', `/tax-classifications?sourceType=TRANSACTION_SPLIT&sourceId=${repairMeaning.splitId}`),
      200,
    );
    expect(history.items.map((h) => [h.classificationId, h.reviewState, h.version])).toEqual([[c, 'ADVISOR_CONFIRMED', 2]]);
    expect(await cash()).toEqual(before);
  });
});

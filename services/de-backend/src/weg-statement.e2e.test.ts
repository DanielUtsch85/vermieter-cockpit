import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  confirmAnnualStatement,
  createAnnualStatement,
  createMembership,
  createWeg,
  endMembership,
  getAnnualStatement,
  getSettlementProposal,
  getStatementComparison,
  listAnnualStatements,
  replaceAnnualStatement,
  voidAnnualStatement,
} from './application/index.js';
import { PostgresWegAnnualStatementRepository, PostgresWegRepository, createDatabase, migrateToLatest } from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-6-03 end to end (api-design.md §50), wired as in main.ts: a Jahresabrechnung entered from the structure of a real
 * Einzelabrechnung (two printed groups, MEA and unit keys, a credit line, the Hausgeld and reserve blocks, a credit as
 * Abrechnungsspitze, the development of the reserve), confirmed; a corrected one superseding it; the next year's
 * classification proposed from it; the membership end guarded by it; Realm isolation on every §50 route. The
 * structure only: every figure is invented.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000007c';
const REALM_B = '64b0c0ffee0000000000007d';
const money = (amount: string) => ({ amount, currency: 'EUR' });

describe.skipIf(databaseUrl === undefined)('Jahresabrechnung (VC-6-03) end to end', () => {
  const schema = testSchemaName('weg_statement_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
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
    const statements = new PostgresWegAnnualStatementRepository(db);
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        wegs: {
          createWeg: createWeg({ repository: wegs }),
          createMembership: createMembership({ repository: wegs }),
          endMembership: endMembership({ repository: wegs }),
        },
        wegAnnualStatements: {
          create: createAnnualStatement({ repository: statements }),
          get: getAnnualStatement({ repository: statements }),
          list: listAnnualStatements({ repository: statements }),
          replace: replaceAnnualStatement({ repository: statements }),
          confirm: confirmAnnualStatement({ repository: statements }),
          void: voidAnnualStatement({ repository: statements }),
          comparison: getStatementComparison({ repository: statements }),
          settlementProposal: getSettlementProposal({ repository: statements }),
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
  const B = (method: string, path: string, body?: unknown) => call(REALM_B, method, path, body);
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const errorOf = async (res: Response, status: number) => (await json<{ error: { code: string; details?: Record<string, unknown> } }>(res, status)).error;
  type Statement = {
    statementId: string;
    status: string;
    version: number;
    supersedes: string | null;
    supersededBy: string | null;
    costLines: { position: number; account: string; classification: string; classificationSource: string }[];
    byClassification: Record<string, { amount: string }>;
    flags: { code: string; details: Record<string, unknown> }[];
  };

  /** As printed: MEA 250/10000 for the shared costs, one of 20 units for the per-unit ones. */
  const costLine = (position: number, account: string, group: string, key: string, total: string, share: string, totalAmount: string, unitShare: string) => ({
    position,
    account,
    group,
    allocationKey: key,
    allocationTotal: total,
    allocationShare: share,
    totalAmount: money(totalAmount),
    unitShare: money(unitShare),
  });
  const statementBody = (financialYear: number, overrides: Record<string, unknown> = {}) => ({
    financialYear,
    periodFrom: `${financialYear}-01-01`,
    periodUntil: `${financialYear}-12-31`,
    documentDate: `${financialYear + 1}-04-15`,
    costLines: [
      costLine(1, 'Hausmeister', 'RECOVERABLE', 'Miteigentumsanteile', '10000', '250', '4000.00', '100.00'),
      costLine(2, 'Gebäudeversicherung', 'RECOVERABLE', 'Miteigentumsanteile', '10000', '250', '2000.00', '50.00'),
      costLine(3, 'Verwaltervergütung', 'NON_RECOVERABLE', 'Einheit', '20', '1', '6000.00', '300.00'),
      costLine(4, 'Instandhaltung', 'NON_RECOVERABLE', 'Miteigentumsanteile', '10000', '250', '2400.00', '60.00'),
      costLine(5, 'Zinserträge', 'NON_RECOVERABLE', 'Miteigentumsanteile', '10000', '250', '-40.00', '-1.00'),
    ],
    recoverableSubtotal: money('150.00'),
    nonRecoverableSubtotal: money('359.00'),
    totalCosts: money('509.00'),
    hausgeldRequested: money('600.00'),
    hausgeldPaid: money('600.00'),
    reserveRequested: money('240.00'),
    reservePaid: money('240.00'),
    settlementPeak: money('-91.00'),
    settlementResult: money('-91.00'),
    reserve: {
      source: 'ANNUAL_STATEMENT',
      lines: [
        { position: 1, description: 'Anfangsbestand', kind: 'OPENING', opening: money('20000.00'), closing: money('20000.00') },
        {
          position: 2,
          description: 'Zuführung lt. Wirtschaftsplan',
          kind: 'CONTRIBUTION',
          opening: money('20000.00'),
          addition: money('9600.00'),
          closing: money('29600.00'),
        },
        { position: 3, description: 'Zinsen', kind: 'INTEREST', addition: money('40.00') },
        {
          position: 4,
          description: 'Entnahme Dachreparatur',
          kind: 'WITHDRAWAL',
          opening: money('29600.00'),
          withdrawal: money('3000.00'),
          closing: money('26600.00'),
        },
      ],
      unitShareOpening: money('500.00'),
      unitShareClosing: money('665.00'),
    },
    sourceReferences: ['Einzelabrechnung S. 1–3'],
    ...overrides,
  });

  it('entered, confirmed, corrected by supersede, the next year classified from it, the guards, Realm isolation', async () => {
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6c101', 'ACTIVE', 'x') RETURNING id`,
      [REALM_A],
    );
    const weg = await json<{ wegId: string }>(await A('POST', '/wegs', { displayName: 'WEG Musterstraße 1' }), 201);
    const membership = await json<{ membershipId: string }>(
      await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: rows[0].id, miteigentumsanteil: '250/10000', validFrom: '2023-01-01' }),
      201,
    );
    const statementsPath = `/weg-memberships/${membership.membershipId}/annual-statements`;

    // The Verwalter's Instandhaltung is a reserve matter for this owner: classified so, against its printed group.
    const body2024 = statementBody(2024, {
      costLines: statementBody(2024).costLines.map((l) => (l.account === 'Instandhaltung' ? { ...l, classification: 'RESERVE' } : l)),
    });
    const entered = await json<Statement>(await A('POST', statementsPath, body2024, { 'idempotency-key': 'abrechnung-2024' }), 201);
    expect(entered).toMatchObject({ status: 'DRAFT', version: 1 });
    // The statement checks itself: consistent as printed, one line classified against its group.
    expect(entered.flags).toEqual([{ code: 'CLASSIFIED_AGAINST_GROUP', details: { positions: [4] } }]);
    expect(entered.byClassification).toEqual({ RECOVERABLE: money('150.00'), NON_RECOVERABLE: money('299.00'), RESERVE: money('60.00') });
    const replay = await A('POST', statementsPath, body2024, { 'idempotency-key': 'abrechnung-2024' });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');

    const confirmed = await json<Statement>(await A('POST', `/weg-annual-statements/${entered.statementId}/confirm`, undefined, { 'if-match': '"1"' }), 200);
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', version: 2 });
    expect(await errorOf(await A('PUT', `/weg-annual-statements/${entered.statementId}`, body2024), 409)).toMatchObject({
      details: { reason: 'STATEMENT_NOT_DRAFT', status: 'CONFIRMED' },
    });
    expect(await errorOf(await A('POST', `/weg-annual-statements/${entered.statementId}/void`, { reason: 'x' }), 409)).toMatchObject({
      details: { reason: 'STATEMENT_NOT_DRAFT' },
    });

    // The Verwalter corrects the statement: a second one of the year cannot simply be confirmed, it supersedes.
    const correctedBody = { ...body2024, settlementPeak: money('-90.00'), notes: 'Korrigierte Abrechnung' };
    const correction = await json<Statement>(await A('POST', statementsPath, correctedBody), 201);
    expect(correction.flags.map((f) => f.code)).toEqual(['SETTLEMENT_DIFFERS', 'CLASSIFIED_AGAINST_GROUP']);
    expect(await errorOf(await A('POST', `/weg-annual-statements/${correction.statementId}/confirm`), 409)).toMatchObject({
      details: { reason: 'STATEMENT_EXISTS', statementId: entered.statementId },
    });
    const named = await json<Statement>(
      await A('PUT', `/weg-annual-statements/${correction.statementId}`, { ...correctedBody, supersedes: entered.statementId }, { 'if-match': '"1"' }),
      200,
    );
    expect(named).toMatchObject({ version: 2, supersedes: entered.statementId });
    expect(await json<Statement>(await A('POST', `/weg-annual-statements/${correction.statementId}/confirm`), 200)).toMatchObject({ status: 'CONFIRMED' });
    // The old one stays readable.
    expect(await json<Statement>(await A('GET', `/weg-annual-statements/${entered.statementId}`), 200)).toMatchObject({
      status: 'SUPERSEDED',
      supersededBy: correction.statementId,
    });

    // The next year: the classification comes from the confirmed statement of 2024 by account.
    const next = await json<Statement>(await A('POST', statementsPath, statementBody(2025)), 201);
    expect(next.costLines.map((l) => [l.account, l.classification, l.classificationSource])).toEqual([
      ['Hausmeister', 'RECOVERABLE', 'PREVIOUS_STATEMENT'],
      ['Gebäudeversicherung', 'RECOVERABLE', 'PREVIOUS_STATEMENT'],
      ['Verwaltervergütung', 'NON_RECOVERABLE', 'PREVIOUS_STATEMENT'],
      ['Instandhaltung', 'RESERVE', 'PREVIOUS_STATEMENT'],
      ['Zinserträge', 'NON_RECOVERABLE', 'PREVIOUS_STATEMENT'],
    ]);

    const list = await json<{ total: number; items: Statement[] }>(await A('GET', `${statementsPath}?financialYear=2024`), 200);
    expect(list.items.map((s) => [s.statementId, s.status])).toEqual([
      [entered.statementId, 'SUPERSEDED'],
      [correction.statementId, 'CONFIRMED'],
    ]);
    expect(list.items[0]).not.toHaveProperty('costLines');

    // The membership cannot end before its statements.
    expect(await errorOf(await A('POST', `/weg-memberships/${membership.membershipId}/end`, { validUntil: '2024-12-31' }), 409)).toMatchObject({
      details: { reason: 'MEMBERSHIP_HAS_STATEMENTS', statementIds: [next.statementId] },
    });
    expect((await A('POST', `/weg-annual-statements/${next.statementId}/void`, { reason: 'Doppelt erfasst' })).status).toBe(200);
    expect((await A('POST', `/weg-memberships/${membership.membershipId}/end`, { validUntil: '2024-12-31' })).status).toBe(200);

    // Realm isolation on every §50 route.
    expect((await B('POST', statementsPath, statementBody(2024))).status).toBe(404);
    expect((await B('GET', statementsPath)).status).toBe(404);
    expect((await B('GET', `/weg-annual-statements/${correction.statementId}`)).status).toBe(404);
    expect((await B('PUT', `/weg-annual-statements/${next.statementId}`, statementBody(2025))).status).toBe(404);
    expect((await B('POST', `/weg-annual-statements/${correction.statementId}/confirm`)).status).toBe(404);
    expect((await B('POST', `/weg-annual-statements/${next.statementId}/void`, { reason: 'x' })).status).toBe(404);
  });
});

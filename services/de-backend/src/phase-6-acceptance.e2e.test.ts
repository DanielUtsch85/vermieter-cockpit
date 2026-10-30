import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  amendMembership,
  amendSpecialAssessment,
  amendWeg,
  confirmAnnualStatement,
  confirmTransaction,
  createAnnualStatement,
  createEconomicPlan,
  createFinancialAccount,
  createManualTransaction,
  createMembership,
  createSpecialAssessment,
  createWeg,
  endMembership,
  getAnnualStatement,
  getEconomicPlan,
  getFinancialCategory,
  getHausgeldProposal,
  getMembership,
  getSettlementProposal,
  getSpecialAssessment,
  getStatementComparison,
  getTransaction,
  getWeg,
  importBankStatement,
  linkPropertyReference,
  listAnnualStatements,
  listEconomicPlans,
  listFinancialCategories,
  listMemberships,
  listSpecialAssessments,
  listWegs,
  readUnitMemberships,
  refreshPropertyReference,
  replaceAnnualStatement,
  replaceAssessmentUses,
  setTransactionSplits,
  voidAnnualStatement,
  voidEconomicPlan,
  voidMembership,
  voidSpecialAssessment,
  voidWeg,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresFinancialCategoryRepository,
  PostgresImportRepository,
  PostgresPropertyReferenceRepository,
  PostgresTransactionQueries,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegAnnualStatementRepository,
  PostgresWegEconomicPlanRepository,
  PostgresWegRepository,
  PostgresWegSpecialAssessmentRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { findBankStatementAdapter } from './integrations/bank-import/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier, mrePropertyLookup } from './wiring.js';

/**
 * VC-6-06: the Phase-6 exit of `docs/roadmap.md` as one acceptance run through the HTTP API (ACC6, invariant-suite.md
 * §40), wired as in main.ts: a WEG with a membership, a plan, twelve months of the two debits of F5 imported and split
 * by the Hausgeld proposal, a statement with a back-payment, the comparison whose differences sum to the
 * Abrechnungsspitze, the settlement split naming the statement, a corrected statement superseding it with the flag, a
 * Sonderumlage in two instalments, and Realm isolation on every §49–§51A route. The figures are hand-computed in §40
 * and checked literally; all of them are invented.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000006e';
const REALM_B = '64b0c0ffee0000000000006f';
const PROPERTY = '6512f0c2a1b2c3d4e5f66e01';
const IBAN_WEG = 'DE89370400440532013000';

/** The Phase-6 routes (api-design §49–§51A) under `/api/v1`, as `METHOD /path/:param`; the WEG sources' tax meanings are VC-7-03's (§58B). */
const PHASE_6 =
  /^(?!.*\/tax-meaning$)(?:[A-Z]+ \/(wegs|weg-memberships|weg-economic-plans|weg-annual-statements|weg-special-assessments)\b|[A-Z]+ \/transactions\/:transactionId\/(hausgeld|settlement)-proposal$|[A-Z]+ \/property-references\/:propertyReferenceId\/weg-memberships$)/;

/** Every route the app serves, from Express' router stack (Express 4 internals, as ACC2–ACC5). */
function routesOf(app: Express): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle: { stack?: Layer[] } };
  const walk = (stack: readonly Layer[]): string[] =>
    stack.flatMap((layer) => {
      if (layer.route !== undefined) return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route?.path}`);
      return layer.name === 'router' && layer.handle.stack !== undefined ? walk(layer.handle.stack) : [];
    });
  return walk((app as unknown as { _router: { stack: Layer[] } })._router.stack);
}

describe.skipIf(databaseUrl === undefined)('Phase 6 acceptance (roadmap exit)', () => {
  const schema = testSchemaName('phase_6_e2e');
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
      { _id: REALM_A, name: 'A', members: member, applications: [], properties: [{ _id: PROPERTY, name: 'Wohnung Musterstraße 1', surface: 70 }] },
      { _id: REALM_B, name: 'B', members: member, applications: [], properties: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const propertyReferences = { repository: new PostgresPropertyReferenceRepository(db), lookupMreProperty: mrePropertyLookup(client) };
    const wegs = new PostgresWegRepository(db);
    const plans = new PostgresWegEconomicPlanRepository(db);
    const statements = new PostgresWegAnnualStatementRepository(db);
    const assessments = new PostgresWegSpecialAssessmentRepository(db);
    const accounts = new PostgresFinancialAccountRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const categories = new PostgresFinancialCategoryRepository(db);
    app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        propertyReferences: { link: linkPropertyReference(propertyReferences), refresh: refreshPropertyReference(propertyReferences) },
        wegs: {
          createWeg: createWeg({ repository: wegs }),
          getWeg: getWeg({ repository: wegs }),
          listWegs: listWegs({ repository: wegs }),
          amendWeg: amendWeg({ repository: wegs }),
          voidWeg: voidWeg({ repository: wegs }),
          createMembership: createMembership({ repository: wegs }),
          getMembership: getMembership({ repository: wegs }),
          listMemberships: listMemberships({ repository: wegs }),
          readUnitMemberships: readUnitMemberships({ repository: wegs }),
          amendMembership: amendMembership({ repository: wegs }),
          endMembership: endMembership({ repository: wegs }),
          voidMembership: voidMembership({ repository: wegs }),
        },
        wegEconomicPlans: {
          create: createEconomicPlan({ repository: plans }),
          get: getEconomicPlan({ repository: plans }),
          list: listEconomicPlans({ repository: plans }),
          void: voidEconomicPlan({ repository: plans }),
          hausgeldProposal: getHausgeldProposal({ repository: plans }),
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
        wegSpecialAssessments: {
          create: createSpecialAssessment({ repository: assessments }),
          get: getSpecialAssessment({ repository: assessments }),
          list: listSpecialAssessments({ repository: assessments }),
          amend: amendSpecialAssessment({ repository: assessments }),
          replaceUses: replaceAssessmentUses({ repository: assessments }),
          void: voidSpecialAssessment({ repository: assessments }),
        },
        financialAccounts: { create: createFinancialAccount({ repository: accounts }) },
        imports: { importStatement: importBankStatement({ imports: new PostgresImportRepository(db), accounts, findAdapter: findBankStatementAdapter }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
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
  type Split = {
    financialCategoryCode: string;
    propertyReferenceId?: string | null;
    wegAnnualStatementId?: string;
    wegSpecialAssessmentId?: string;
    amount: Money;
  };
  type Comparison = {
    classes: Record<'RECOVERABLE' | 'NON_RECOVERABLE' | 'RESERVE', { paid: Money; actual: Money; difference: Money }>;
    advances: { requested: Money; counted: Money; unpaidAdvances: Money };
    settlementPeak: Money;
    settlement: { settledBy: { transactionId: string; statementId: string; amount: Money }[]; settled: Money; open: Money };
    flags: { code: string; details: Record<string, unknown> }[];
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
  const amounts = (c: Comparison) => Object.fromEntries(Object.entries(c.classes).map(([k, v]) => [k, [v.paid.amount, v.actual.amount, v.difference.amount]]));
  const cents = (m: Money) => Math.round(Number(m.amount) * 100);

  /** As printed: MEA 250/10000 for the shared costs, one of 20 units for the per-unit ones. */
  const line = (position: number, account: string, group: string, key: string, total: string, share: string, totalAmount: string, unitShare: string) => ({
    position,
    account,
    group,
    allocationKey: key,
    allocationTotal: total,
    allocationShare: share,
    totalAmount: eur(totalAmount),
    unitShare: eur(unitShare),
  });
  const statementBody = (administration: { total: string; share: string }, peak: string, extra: Record<string, unknown> = {}) => {
    const nonRecoverable = (Number(administration.share) + 200).toFixed(2);
    const total = (1300 + Number(nonRecoverable)).toFixed(2);
    return {
      financialYear: 2026,
      periodFrom: '2026-01-01',
      periodUntil: '2026-12-31',
      documentDate: '2027-04-15',
      costLines: [
        line(1, 'Hausmeister', 'RECOVERABLE', 'Miteigentumsanteile', '10000', '250', '40000.00', '1000.00'),
        line(2, 'Gebäudeversicherung', 'RECOVERABLE', 'Miteigentumsanteile', '10000', '250', '12000.00', '300.00'),
        line(3, 'Verwaltervergütung', 'NON_RECOVERABLE', 'Einheit', '20', '1', administration.total, administration.share),
        line(4, 'Instandhaltung', 'NON_RECOVERABLE', 'Miteigentumsanteile', '10000', '250', '8000.00', '200.00'),
      ],
      recoverableSubtotal: eur('1300.00'),
      nonRecoverableSubtotal: eur(nonRecoverable),
      totalCosts: eur(total),
      hausgeldRequested: eur('1800.00'),
      hausgeldPaid: eur('1800.00'),
      reserveRequested: eur('600.00'),
      reservePaid: eur('600.00'),
      settlementPeak: eur(peak),
      settlementResult: eur(peak),
      ...extra,
    };
  };

  it('the Phase-6 exit, claim by claim', async () => {
    // The unit, the WEG, the membership.
    const flat = (
      await json<{ propertyReferenceId: string }>(await A('POST', '/property-references/link', { mreRealmId: REALM_A, mrePropertyId: PROPERTY }), 201)
    ).propertyReferenceId;
    const weg = await json<{ wegId: string }>(await A('POST', '/wegs', { displayName: 'WEG Musterstraße 1' }), 201);
    const membership = await json<{ membershipId: string }>(
      await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '250/10000', validFrom: '2026-01-01' }),
      201,
    );
    const m = membership.membershipId;

    // The plan: Hausgeld 150.00 a month (100.00 recoverable, 50.00 not) and the reserve 50.00.
    const plan = await json<{ economicPlanId: string; components: Record<string, Money>; flags: unknown[] }>(
      await A('POST', `/weg-memberships/${m}/economic-plans`, {
        financialYear: 2026,
        effectiveFrom: '2026-01-01',
        monthlyHausgeld: eur('150.00'),
        monthlyReserveContribution: eur('50.00'),
        recoverableCosts: eur('1200.00'),
        nonRecoverableCosts: eur('600.00'),
        annualReserveContribution: eur('600.00'),
      }),
      201,
    );
    expect(plan.components).toEqual({ recoverable: eur('100.00'), nonRecoverable: eur('50.00'), reserve: eur('50.00') });
    expect(plan.flags).toEqual([]);

    // Twelve months of the two debits of F5, imported from the bank statement and split by the Hausgeld proposal.
    const giro = (
      await json<{ financialAccountId: string }>(
        await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR' }),
        201,
      )
    ).financialAccountId;
    const rows = Array.from({ length: 12 }, (_, i) => {
      const mm = String(i + 1).padStart(2, '0');
      return [`03.${mm}.2026;-150,00;${IBAN_WEG};Hausgeld ${mm}/2026`, `03.${mm}.2026;-50,00;${IBAN_WEG};Erhaltungsrücklage ${mm}/2026`];
    }).flat();
    const imported = await json<{ rows: { transactionId?: string }[] }>(
      await upload(giro, ['Buchungstag;Betrag;IBAN;Verwendungszweck', ...rows].join('\r\n')),
      201,
    );
    const debits = imported.rows.map((r) => r.transactionId ?? '');
    expect(debits).toHaveLength(24);
    const apply = async (transactionId: string, splits: readonly Split[]) => {
      await json(
        await A('PUT', `/transactions/${transactionId}/splits`, {
          splits: splits.map((s) => ({
            amount: s.amount,
            financialCategoryCode: s.financialCategoryCode,
            propertyReferenceId: s.propertyReferenceId ?? null,
            ...(s.wegAnnualStatementId === undefined ? {} : { wegAnnualStatementId: s.wegAnnualStatementId }),
            ...(s.wegSpecialAssessmentId === undefined ? {} : { wegSpecialAssessmentId: s.wegSpecialAssessmentId }),
          })),
        }),
        200,
      );
      await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
    };
    const cases: string[] = [];
    for (const id of debits) {
      const proposal = await json<{ case: string; splits: Split[] }>(await A('GET', `/transactions/${id}/hausgeld-proposal?propertyReferenceId=${flat}`), 200);
      cases.push(proposal.case);
      await apply(id, proposal.splits);
    }
    expect(cases).toEqual(Array.from({ length: 12 }, () => ['HAUSGELD_ONLY', 'RESERVE_ONLY']).flat());

    // Counter-check: a WEG split names its unit, and needs a membership on the booking date.
    const before = (
      await json<{ transactionId: string }>(
        await A('POST', '/transactions', { financialAccountId: giro, amount: eur('150.00'), direction: 'OUTFLOW', bookingDate: '2025-12-03' }),
        201,
      )
    ).transactionId;
    expect(
      await errorOf(await A('PUT', `/transactions/${before}/splits`, { splits: [{ amount: eur('150.00'), financialCategoryCode: 'WEG_RECOVERABLE' }] }), 422),
    ).toMatchObject({ code: 'NO_WEG_MEMBERSHIP', details: { reason: 'NO_UNIT' } });
    expect(
      await errorOf(
        await A('PUT', `/transactions/${before}/splits`, {
          splits: [{ amount: eur('150.00'), financialCategoryCode: 'WEG_RECOVERABLE', propertyReferenceId: flat }],
        }),
        422,
      ),
    ).toMatchObject({ code: 'NO_WEG_MEMBERSHIP', details: { reason: 'NO_MEMBERSHIP', bookingDate: '2025-12-03' } });

    // Counter-check: a reserve contribution and a Sonderumlage are WEG_FUNDS, never an operating expense.
    const typeOf = async (code: string) => (await json<{ categoryType: string }>(await A('GET', `/financial-categories/${code}`), 200)).categoryType;
    expect([await typeOf('WEG_RESERVE_CONTRIBUTION'), await typeOf('WEG_SPECIAL_ASSESSMENT'), await typeOf('WEG_RECOVERABLE')]).toEqual([
      'WEG_FUNDS',
      'WEG_FUNDS',
      'OPERATING_EXPENSE',
    ]);

    // A Sonderumlage in two instalments, paid: SETTLED.
    const assessment = await json<{ assessmentId: string }>(
      await A('POST', `/weg-memberships/${m}/special-assessments`, {
        description: 'Fassadensanierung',
        resolutionDate: '2026-04-20',
        purpose: 'MAINTENANCE',
        unitShare: eur('600.00'),
        instalments: [
          { position: 1, dueDate: '2026-06-01', amount: eur('300.00') },
          { position: 2, dueDate: '2026-09-01', amount: eur('300.00') },
        ],
      }),
      201,
    );
    const payInstalment = async (bookingDate: string) => {
      const id = (
        await json<{ transactionId: string }>(
          await A('POST', '/transactions', { financialAccountId: giro, amount: eur('300.00'), direction: 'OUTFLOW', bookingDate, propertyReferenceId: flat }),
          201,
        )
      ).transactionId;
      await apply(id, [
        { financialCategoryCode: 'WEG_SPECIAL_ASSESSMENT', propertyReferenceId: flat, wegSpecialAssessmentId: assessment.assessmentId, amount: eur('300.00') },
      ]);
    };
    await payInstalment('2026-06-02');
    const half = await json<{ status: string; outstanding: Money; instalments: { overdue: boolean }[] }>(
      await A('GET', `/weg-special-assessments/${assessment.assessmentId}?asOf=2026-09-15`),
      200,
    );
    expect(half).toMatchObject({ status: 'ACTIVE', outstanding: eur('300.00') });
    expect(half.instalments.map((i) => i.overdue)).toEqual([false, true]);
    await payInstalment('2026-09-02');
    expect(await json(await A('GET', `/weg-special-assessments/${assessment.assessmentId}?asOf=2026-09-15`), 200)).toMatchObject({
      status: 'SETTLED',
      paid: eur('600.00'),
      outstanding: eur('0.00'),
    });

    // The statement of 2026 with a back-payment of 100.00.
    const first = await json<{ statementId: string; flags: unknown[] }>(
      await A('POST', `/weg-memberships/${m}/annual-statements`, statementBody({ total: '8000.00', share: '400.00' }, '100.00')),
      201,
    );
    expect(first.flags).toEqual([]);
    await json(await A('POST', `/weg-annual-statements/${first.statementId}/confirm`), 200);

    // The comparison: the differences sum to the Abrechnungsspitze (no advance unpaid); the Sonderumlage is no advance.
    const comparison = await json<Comparison>(await A('GET', `/weg-annual-statements/${first.statementId}/comparison`), 200);
    expect(amounts(comparison)).toEqual({
      RECOVERABLE: ['1200.00', '1300.00', '100.00'],
      NON_RECOVERABLE: ['600.00', '600.00', '0.00'],
      RESERVE: ['600.00', '600.00', '0.00'],
    });
    expect(comparison.advances).toEqual({ requested: eur('2400.00'), counted: eur('2400.00'), unpaidAdvances: eur('0.00') });
    const sum = Object.values(comparison.classes).reduce((total, c) => total + cents(c.difference), 0);
    expect(sum - cents(comparison.advances.unpaidAdvances)).toBe(cents(comparison.settlementPeak));
    expect(comparison.flags).toEqual([]);

    // Counter-check: the statement re-split no confirmed cash; a confirmed split stays frozen.
    const january = await json<{ splits: { financialCategoryCode: string; amount: Money }[] }>(await A('GET', `/transactions/${debits[0]}`), 200);
    expect(january.splits.map((s) => [s.financialCategoryCode, s.amount.amount])).toEqual([
      ['WEG_RECOVERABLE', '100.00'],
      ['WEG_NON_RECOVERABLE', '50.00'],
    ]);
    expect(
      (
        await A('PUT', `/transactions/${debits[0]}/splits`, {
          splits: [{ amount: eur('150.00'), financialCategoryCode: 'WEG_RECOVERABLE', propertyReferenceId: flat }],
        })
      ).status,
    ).toBe(409);

    // The back-payment, split by the settlement proposal and naming the statement.
    const backPayment = (
      await json<{ transactionId: string }>(
        await A('POST', '/transactions', {
          financialAccountId: giro,
          amount: eur('100.00'),
          direction: 'OUTFLOW',
          bookingDate: '2027-05-03',
          propertyReferenceId: flat,
        }),
        201,
      )
    ).transactionId;
    const settlement = await json<{ splits: Split[]; flags: unknown[] }>(
      await A('GET', `/transactions/${backPayment}/settlement-proposal?statementId=${first.statementId}`),
      200,
    );
    expect(settlement.splits.map((s) => [s.financialCategoryCode, s.amount.amount, s.wegAnnualStatementId])).toEqual([
      ['WEG_RECOVERABLE', '100.00', first.statementId],
    ]);
    expect(settlement.flags).toEqual([]);
    await apply(backPayment, settlement.splits);
    expect((await json<Comparison>(await A('GET', `/weg-annual-statements/${first.statementId}/comparison`), 200)).settlement).toMatchObject({
      settled: eur('100.00'),
      open: eur('0.00'),
    });

    // A corrected statement (the administration 420.00) supersedes it; the settlement keeps naming the first.
    const corrected = await json<{ statementId: string }>(
      await A(
        'POST',
        `/weg-memberships/${m}/annual-statements`,
        statementBody({ total: '8400.00', share: '420.00' }, '120.00', { supersedes: first.statementId }),
      ),
      201,
    );
    await json(await A('POST', `/weg-annual-statements/${corrected.statementId}/confirm`), 200);
    expect(await json(await A('GET', `/weg-annual-statements/${first.statementId}`), 200)).toMatchObject({
      status: 'SUPERSEDED',
      supersededBy: corrected.statementId,
    });
    const taken = await json<Comparison>(await A('GET', `/weg-annual-statements/${corrected.statementId}/comparison`), 200);
    expect(amounts(taken).NON_RECOVERABLE).toEqual(['600.00', '620.00', '20.00']);
    expect(taken.settlement).toMatchObject({ settled: eur('100.00'), open: eur('20.00') });
    expect(taken.settlement.settledBy.map((s) => [s.transactionId, s.statementId])).toEqual([[backPayment, first.statementId]]);
    expect(taken.flags).toEqual([{ code: 'SETTLED_AGAINST_SUPERSEDED', details: { transactionIds: [backPayment] } }]);
    const late = (
      await json<{ transactionId: string }>(
        await A('POST', '/transactions', {
          financialAccountId: giro,
          amount: eur('20.00'),
          direction: 'OUTFLOW',
          bookingDate: '2027-07-01',
          propertyReferenceId: flat,
        }),
        201,
      )
    ).transactionId;
    expect(
      await errorOf(
        await A('PUT', `/transactions/${late}/splits`, {
          splits: [{ amount: eur('20.00'), financialCategoryCode: 'WEG_NON_RECOVERABLE', propertyReferenceId: flat, wegAnnualStatementId: first.statementId }],
        }),
        409,
      ),
    ).toMatchObject({ details: { reason: 'STATEMENT_NOT_CURRENT', supersededBy: corrected.statementId } });

    // Traceability: the first statement's AuditRecords, exactly.
    const trail = await pool.query(`SELECT action FROM audit_record WHERE entity_type = 'WegAnnualStatement' AND entity_id = $1 ORDER BY new_version`, [
      first.statementId,
    ]);
    expect(trail.rows.map((r) => r.action)).toEqual(['CREATED', 'CONFIRMED', 'SUPERSEDED']);

    // Realm isolation: every Phase-6 route, called by Realm B with Realm A's ids, answers as its row expects.
    const ids: Record<string, string> = {
      wegId: weg.wegId,
      membershipId: m,
      propertyReferenceId: flat,
      planId: plan.economicPlanId,
      statementId: corrected.statementId,
      assessmentId: assessment.assessmentId,
      transactionId: late,
    };
    type Row = { readonly expect: 404 | 201 | ((body: unknown) => void); readonly body?: unknown; readonly query?: string };
    const routes: Record<string, readonly Row[]> = {
      'POST /wegs': [{ expect: 201, body: { displayName: 'WEG of Realm B' } }],
      // Realm B sees only the WEG it created itself (the row above), never Realm A's.
      'GET /wegs': [{ expect: (body) => expect((body as { items: { wegId: string }[] }).items.map((w) => w.wegId)).not.toContain(weg.wegId) }],
      'GET /wegs/:wegId': [{ expect: 404 }],
      'POST /wegs/:wegId/amend': [{ expect: 404, body: { notes: 'x' } }],
      'POST /wegs/:wegId/void': [{ expect: 404, body: { reason: 'x' } }],
      'POST /wegs/:wegId/memberships': [{ expect: 404, body: { propertyReferenceId: flat, miteigentumsanteil: '1/10', validFrom: '2026-01-01' } }],
      'GET /wegs/:wegId/memberships': [{ expect: 404 }],
      'GET /weg-memberships/:membershipId': [{ expect: 404 }],
      'POST /weg-memberships/:membershipId/amend': [{ expect: 404, body: { notes: 'x' } }],
      'POST /weg-memberships/:membershipId/end': [{ expect: 404, body: { validUntil: '2026-12-31' } }],
      'POST /weg-memberships/:membershipId/void': [{ expect: 404, body: { reason: 'x' } }],
      'GET /property-references/:propertyReferenceId/weg-memberships': [{ expect: 404 }],
      'POST /weg-memberships/:membershipId/economic-plans': [
        {
          expect: 404,
          body: {
            financialYear: 2027,
            effectiveFrom: '2027-01-01',
            monthlyHausgeld: eur('1.00'),
            monthlyReserveContribution: eur('0.00'),
            recoverableCosts: eur('0.00'),
            nonRecoverableCosts: eur('12.00'),
          },
        },
      ],
      'GET /weg-memberships/:membershipId/economic-plans': [{ expect: 404 }],
      'GET /weg-economic-plans/:planId': [{ expect: 404 }],
      'POST /weg-economic-plans/:planId/void': [{ expect: 404, body: { reason: 'x' } }],
      'GET /transactions/:transactionId/hausgeld-proposal': [{ expect: 404 }],
      'POST /weg-memberships/:membershipId/annual-statements': [{ expect: 404, body: statementBody({ total: '8000.00', share: '400.00' }, '100.00') }],
      'GET /weg-memberships/:membershipId/annual-statements': [{ expect: 404 }],
      'GET /weg-annual-statements/:statementId': [{ expect: 404 }],
      'PUT /weg-annual-statements/:statementId': [{ expect: 404, body: statementBody({ total: '8000.00', share: '400.00' }, '100.00') }],
      'POST /weg-annual-statements/:statementId/confirm': [{ expect: 404 }],
      'POST /weg-annual-statements/:statementId/void': [{ expect: 404, body: { reason: 'x' } }],
      'GET /weg-annual-statements/:statementId/comparison': [{ expect: 404 }],
      'GET /transactions/:transactionId/settlement-proposal': [{ expect: 404, query: `statementId=${corrected.statementId}` }],
      'POST /weg-memberships/:membershipId/special-assessments': [
        {
          expect: 404,
          body: {
            description: 'x',
            resolutionDate: '2026-04-20',
            purpose: 'OTHER',
            unitShare: eur('1.00'),
            instalments: [{ position: 1, dueDate: '2026-06-01', amount: eur('1.00') }],
          },
        },
      ],
      'GET /weg-memberships/:membershipId/special-assessments': [{ expect: 404 }],
      'GET /weg-special-assessments/:assessmentId': [{ expect: 404 }],
      'POST /weg-special-assessments/:assessmentId/amend': [
        {
          expect: 404,
          body: { description: 'x', purpose: 'OTHER', unitShare: eur('1.00'), instalments: [{ position: 1, dueDate: '2026-06-01', amount: eur('1.00') }] },
        },
      ],
      'PUT /weg-special-assessments/:assessmentId/uses': [{ expect: 404, body: { uses: [] } }],
      'POST /weg-special-assessments/:assessmentId/void': [{ expect: 404, body: { reason: 'x' } }],
    };
    // The table is the app's Phase-6 routes, no more and no fewer: a new route without a row turns this red.
    expect(Object.keys(routes).sort()).toEqual(
      routesOf(app)
        .filter((route) => PHASE_6.test(route))
        .sort(),
    );
    const tables = ['weg', 'weg_membership', 'weg_economic_plan', 'weg_annual_statement', 'weg_special_assessment'];
    const stateOfA = async () => {
      const state: Record<string, unknown[]> = {};
      for (const table of tables)
        state[table] = (await pool.query(`SELECT id, version, status FROM ${table} WHERE mre_realm_id = $1 ORDER BY id`, [REALM_A])).rows;
      return state;
    };
    const auditsOfA = async () =>
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM audit_record WHERE entity_id IN (${tables.map((t) => `SELECT id::text FROM ${t} WHERE mre_realm_id = $1`).join(' UNION ')})`,
          [REALM_A],
        )
      ).rows[0].n as number;
    const snapshot = { state: await stateOfA(), audits: await auditsOfA() };
    for (const [route, rowsOfRoute] of Object.entries(routes)) {
      for (const row of rowsOfRoute) {
        const [method = '', template = ''] = route.split(' ');
        const path = template.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? `missing-${name}`) + (row.query === undefined ? '' : `?${row.query}`);
        const res = await call(REALM_B, method, path, row.body);
        if (row.expect === 404) {
          expect(res.status, `${route} ${await res.clone().text()}`).toBe(404);
          expect(((await res.json()) as { error: { code: string } }).error.code, route).toBe('NOT_FOUND');
        } else if (row.expect === 201) {
          expect(res.status, route).toBe(201);
        } else {
          row.expect(await json(res, 200));
        }
        expect(await stateOfA(), route).toEqual(snapshot.state);
        expect(await auditsOfA(), route).toBe(snapshot.audits);
      }
    }
  });
});

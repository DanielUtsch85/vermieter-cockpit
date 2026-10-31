import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  amendRentalContractReference,
  closeDeposit,
  confirmAcquisition,
  confirmAnnualStatement,
  confirmTransaction,
  createAcquisition,
  createAcquisitionCost,
  createAnnualStatement,
  createDeposit,
  createFinancialAccount,
  createLandBuildingAllocation,
  createLoan,
  createLoanAllocation,
  createManualTransaction,
  createMembership,
  createOwnership,
  createParty,
  createReconciliation,
  createRentalContractReference,
  createSpecialAssessment,
  createTaxClassification,
  createWeg,
  getAnschaffungsnaheCheck,
  getDepositTaxMeaning,
  getRentalContractReference,
  getTaxClassification,
  getTaxMeaning,
  getTaxRule,
  getTaxYearView,
  getTransaction,
  getUseTaxMeaning,
  getWithdrawalTaxMeaning,
  linkPropertyReference,
  listRentalContractReferences,
  listTaxClassificationHistory,
  listTaxMeanings,
  listTaxRules,
  refreshPropertyReference,
  replaceAssessmentUses,
  reviewTaxClassification,
  setTransactionSplits,
} from './application/index.js';
import {
  PostgresAcquisitionCostRepository,
  PostgresAcquisitionRepository,
  PostgresFinancialAccountRepository,
  PostgresLandBuildingAllocationRepository,
  PostgresLoanAllocationRepository,
  PostgresLoanRepository,
  PostgresOwnershipRepository,
  PostgresPartyRepository,
  PostgresPropertyReferenceRepository,
  PostgresRentReconciliationRepository,
  PostgresRentalContractReferenceRepository,
  PostgresSecurityDepositRepository,
  PostgresTaxClassificationRepository,
  PostgresTransactionQueries,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegAnnualStatementRepository,
  PostgresWegRepository,
  PostgresWegSpecialAssessmentRepository,
  checkStoredRuleReferences,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { cents, codes, figures, lineOf, placed, type Check, type Money, type Totals, type View } from './phase-7-acceptance.test-support.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier, mrePropertyLookup, mreRentTermLookup, mreTenantDepositReader, mreTenantLookup } from './wiring.js';

/**
 * VC-7-05: the Phase-7 exit of `docs/roadmap.md` as one acceptance run through the HTTP API (ACC7, invariant-suite.md
 * §45), wired as in main.ts with the fake MRE: a WEG unit owned by two owners (3/5 and 2/5) from its Acquisition; a year
 * of rent, the December rent paid within the 10 days after the year-end; Hausgeld in two debits a month; interest and
 * principal, a debit of an allocated Loan (attributed by its set, §58D) and one booked before a Loan's first set (not attributed); a repair; a deposit, retained in part; a statement with a reserve withdrawal; a Sonderumlage with a use;
 * a refund of an earlier year; the anschaffungsnahe check exactly at 15 %, then above it; a § 82b election; the
 * tax-year view of 2027 and 2028 per property and per owner. The counter-checks of phase-7-plan §2 item 5, Realm
 * isolation on every §55–§58C route. The figures are invented and hand-computed in §45; they are checked literally.
 * Every date is set explicitly: no figure asserted here depends on today's date.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee000000000000a7';
const REALM_B = '64b0c0ffee000000000000a8';
const PROPERTY = '6512f0c2a1b2c3d4e5f6a701';
const TENANT = '6512f0c2a1b2c3d4e5f6a7a1';
const DECEMBER = '2027120100';

/** The Phase-7 routes (api-design §55–§58C) under `/api/v1`, as `METHOD /path/:param`; §49.5's plan route stays Phase 6's. */
const PHASE_7 =
  /^[A-Z]+ \/(?:(?:tax-rules|tax-classifications|rental-contract-references)\b|.*\/(?:tax-meaning|tax-meanings|anschaffungsnahe-herstellungskosten|tax-years\/:year)$)/;

/** Every route the app serves, from Express' router stack (Express 4 internals, as ACC2–ACC6). */
function routesOf(app: Express): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle: { stack?: Layer[] } };
  const walk = (stack: readonly Layer[]): string[] =>
    stack.flatMap((layer) => {
      if (layer.route !== undefined) return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route?.path}`);
      return layer.name === 'router' && layer.handle.stack !== undefined ? walk(layer.handle.stack) : [];
    });
  return walk((app as unknown as { _router: { stack: Layer[] } })._router.stack);
}

describe.skipIf(databaseUrl === undefined)('Phase 7 acceptance (roadmap exit)', () => {
  const schema = testSchemaName('phase_7_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let app: Express;
  let server: Server;
  let base: string;
  /** The SQL the pool's clients run while `recording` is set (the view's read-only transaction, §58C). */
  const statements: string[] = [];
  let recording = false;
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    pool.on('connect', (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        if (recording) statements.push(typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string }).text));
        return query(...args);
      };
    });
    await migrateToLatest(pool, { migrationTableSchema: schema });

    mre = await startFakeMre([
      {
        _id: REALM_A,
        name: 'A',
        members: member,
        applications: [],
        properties: [{ _id: PROPERTY, name: 'Wohnung Beispielweg 7', surface: 64 }],
        tenants: [{ _id: TENANT, name: 'Mieterin Muster', guaranty: 2700 }],
        rents: { [TENANT]: [Number(DECEMBER)] },
      },
      { _id: REALM_B, name: 'B', members: member, applications: [], properties: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const propertyReferences = { repository: new PostgresPropertyReferenceRepository(db), lookupMreProperty: mrePropertyLookup(client) };
    const wegs = new PostgresWegRepository(db);
    const statements6 = new PostgresWegAnnualStatementRepository(db);
    const assessments = new PostgresWegSpecialAssessmentRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const acquisitions = new PostgresAcquisitionRepository(db);
    const deposits = new PostgresSecurityDepositRepository(db);
    const classifications = new PostgresTaxClassificationRepository(db);
    const references = new PostgresRentalContractReferenceRepository(db);
    app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        propertyReferences: { link: linkPropertyReference(propertyReferences), refresh: refreshPropertyReference(propertyReferences) },
        parties: { create: createParty({ repository: new PostgresPartyRepository(db) }) },
        ownerships: { create: createOwnership({ repository: new PostgresOwnershipRepository(db) }) },
        acquisitions: { create: createAcquisition({ repository: acquisitions }), confirm: confirmAcquisition({ repository: acquisitions }) },
        acquisitionCosts: { createCost: createAcquisitionCost({ repository: new PostgresAcquisitionCostRepository(db) }) },
        landBuildingAllocations: { create: createLandBuildingAllocation({ repository: new PostgresLandBuildingAllocationRepository(db) }) },
        wegs: { createWeg: createWeg({ repository: wegs }), createMembership: createMembership({ repository: wegs }) },
        wegAnnualStatements: { create: createAnnualStatement({ repository: statements6 }), confirm: confirmAnnualStatement({ repository: statements6 }) },
        wegSpecialAssessments: {
          create: createSpecialAssessment({ repository: assessments }),
          replaceUses: replaceAssessmentUses({ repository: assessments }),
        },
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        loans: { create: createLoan({ repository: new PostgresLoanRepository(db) }) },
        loanAllocations: { create: createLoanAllocation({ repository: new PostgresLoanAllocationRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
          get: getTransaction({ queries: new PostgresTransactionQueries(db) }),
        },
        rentReconciliations: {
          create: createReconciliation({ repository: new PostgresRentReconciliationRepository(db), lookupMreRentTerm: mreRentTermLookup(client) }),
        },
        securityDeposits: {
          create: createDeposit({ repository: deposits, readMreTenant: mreTenantDepositReader(client) }),
          close: closeDeposit({ repository: deposits }),
        },
        taxation: {
          create: createTaxClassification({ repository: classifications }),
          get: getTaxClassification({ repository: classifications }),
          history: listTaxClassificationHistory({ repository: classifications }),
          review: reviewTaxClassification({ repository: classifications }),
          taxMeaning: getTaxMeaning({ repository: classifications }),
          depositTaxMeaning: getDepositTaxMeaning({ repository: classifications }),
          withdrawalTaxMeaning: getWithdrawalTaxMeaning({ repository: classifications }),
          useTaxMeaning: getUseTaxMeaning({ repository: classifications }),
          anschaffungsnahe: getAnschaffungsnaheCheck({ repository: classifications }),
          taxMeanings: listTaxMeanings({ repository: classifications }),
          taxYear: getTaxYearView({ repository: classifications }),
          listRules: listTaxRules(),
          getRule: getTaxRule(),
        },
        rentalContractReferences: {
          create: createRentalContractReference({ repository: references, lookupMreTenant: mreTenantLookup(client) }),
          get: getRentalContractReference({ repository: references }),
          list: listRentalContractReferences({ repository: references }),
          amend: amendRentalContractReference({ repository: references }),
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
  const eur = (amount: string) => ({ amount, currency: 'EUR' });

  it('the Phase-7 exit, claim by claim', async () => {
    // The unit, its owners from the Acquisition (3/5 and 2/5), the WEG membership (MEA 100/1000).
    const flat = (
      await json<{ propertyReferenceId: string }>(await A('POST', '/property-references/link', { mreRealmId: REALM_A, mrePropertyId: PROPERTY }), 201)
    ).propertyReferenceId;
    const party = async (displayName: string) =>
      (await json<{ partyId: string }>(await A('POST', '/parties', { partyType: 'PERSON', displayName }), 201)).partyId;
    const [ownerA, ownerB] = [await party('Eigentümerin A'), await party('Eigentümer B')];
    const acquisition = (
      await json<{ acquisitionId: string }>(
        await A('POST', '/acquisitions', {
          propertyReferenceId: flat,
          purchasePrice: eur('100000.00'),
          acquiredShare: '1/1',
          contractDate: '2026-02-01',
          economicTransferDate: '2026-03-15',
          buyerPartyIds: [ownerA, ownerB],
          sellerPartyIds: [],
        }),
        201,
      )
    ).acquisitionId;
    for (const [ownerPartyId, share] of [
      [ownerA, '3/5'],
      [ownerB, '2/5'],
    ] as const) {
      await json(await A('POST', '/ownerships', { propertyReferenceId: flat, ownerPartyId, share, validFrom: '2026-03-15', acquisitionId: acquisition }), 201);
    }
    await json(await A('POST', `/acquisitions/${acquisition}/confirm`, {}), 200);
    await json(await A('POST', `/acquisitions/${acquisition}/costs`, { category: 'REAL_ESTATE_TRANSFER_TAX', amount: eur('5000.00') }), 201);
    await json(await A('POST', `/acquisitions/${acquisition}/costs`, { category: 'FINANCING_RELATED', amount: eur('800.00') }), 201);
    await json(
      await A('POST', `/acquisitions/${acquisition}/land-building-allocation`, {
        totalAllocableAmount: eur('105000.00'),
        landAmount: eur('21000.00'),
        buildingAmount: eur('84000.00'),
        method: 'PURCHASE_CONTRACT',
        reviewState: 'CONFIRMED',
        supersedes: null,
      }),
      201,
    );
    const weg = await json<{ wegId: string }>(await A('POST', '/wegs', { displayName: 'WEG Beispielweg 7' }), 201);
    const membership = (
      await json<{ membershipId: string }>(
        await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '100/1000', validFrom: '2026-03-15' }),
        201,
      )
    ).membershipId;

    // The cash, split and confirmed.
    const giro = (
      await json<{ financialAccountId: string }>(
        await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR' }),
        201,
      )
    ).financialAccountId;
    const booked = async (direction: 'INFLOW' | 'OUTFLOW', bookingDate: string, splits: Record<string, unknown>[]) => {
      const total = splits.reduce((sum, s) => sum + cents(s['amount'] as Money), 0n);
      const amount = `${total / 100n}.${String(total % 100n).padStart(2, '0')}`;
      const { transactionId } = await json<{ transactionId: string }>(
        await A('POST', '/transactions', { financialAccountId: giro, amount: eur(amount), direction, bookingDate }),
        201,
      );
      const set = await json<{ splits: { splitId: string }[] }>(await A('PUT', `/transactions/${transactionId}/splits`, { splits }), 200);
      await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
      return { transactionId, splitIds: set.splits.map((s) => s.splitId) };
    };
    const on = (amount: string, financialCategoryCode: string, extra: Record<string, unknown> = {}) => ({
      amount: eur(amount),
      financialCategoryCode,
      propertyReferenceId: flat,
      ...extra,
    });
    const mm = (month: number) => String(month).padStart(2, '0');

    // A year of rent, 900.00 and 200.00 advances, paid in arrears on the 28th; December's on 2028-01-04.
    const rents: string[] = [];
    for (let month = 1; month <= 11; month++) {
      rents.push(...(await booked('INFLOW', `2027-${mm(month)}-28`, [on('900.00', 'RENT_BASE'), on('200.00', 'RENT_OPERATING_COST_ADVANCE')])).splitIds);
    }
    const december = await booked('INFLOW', '2028-01-04', [on('900.00', 'RENT_BASE'), on('200.00', 'RENT_OPERATING_COST_ADVANCE')]);
    await json(
      await A('POST', '/rent-reconciliations', {
        transactionId: december.transactionId,
        mreTenantId: TENANT,
        mreRentTerm: DECEMBER,
        matchedAmount: eur('1100.00'),
      }),
      201,
    );
    // The lease: rent due on the last day of the month (day 31), from the start of the tenancy.
    await json(await A('POST', '/rental-contract-references', { mreTenantId: TENANT, rentDueDays: [{ validFrom: '2027-01-01', day: 31 }] }), 201);
    // Hausgeld in two debits a month: 250.00 (150.00 recoverable, 100.00 not) and the reserve 50.00.
    const reserve: string[] = [];
    for (let month = 1; month <= 12; month++) {
      await booked('OUTFLOW', `2027-${mm(month)}-15`, [on('150.00', 'WEG_RECOVERABLE'), on('100.00', 'WEG_NON_RECOVERABLE')]);
      reserve.push(...(await booked('OUTFLOW', `2027-${mm(month)}-15`, [on('50.00', 'WEG_RESERVE_CONTRIBUTION')])).splitIds);
    }
    // Interest and principal, quarterly: 612.37 and 887.63.
    const principal: string[] = [];
    for (const month of [3, 6, 9, 12]) {
      principal.push((await booked('OUTFLOW', `2027-${mm(month)}-20`, [on('612.37', 'LOAN_INTEREST'), on('887.63', 'LOAN_PRINCIPAL')])).splitIds[1] as string);
    }
    // A Loan allocated MANUAL 1/1 to the unit from 2026-03-15, and one debit booked the Loan's way (splits with `loanId`,
    // no PropertyReference, 0027): its interest of 450.00 is attributed by that set (VC-X-29, §58D).
    const bank = (await json<{ partyId: string }>(await A('POST', '/parties', { partyType: 'ORGANIZATION', displayName: 'Bank Beispiel' }), 201)).partyId;
    const loanId = (
      await json<{ loanId: string }>(
        await A('POST', '/loans', { lenderPartyId: bank, borrowerPartyIds: [ownerA, ownerB], principalOriginal: eur('80000.00'), startDate: '2026-03-15' }),
        201,
      )
    ).loanId;
    await json(
      await A('POST', `/loans/${loanId}/allocations`, { validFrom: '2026-03-15', basis: 'MANUAL', allocations: [{ propertyReferenceId: flat, share: '1/1' }] }),
      201,
    );
    const loanDebit = await booked('OUTFLOW', '2027-07-20', [
      { amount: eur('450.00'), financialCategoryCode: 'LOAN_INTEREST', loanId },
      { amount: eur('550.00'), financialCategoryCode: 'LOAN_PRINCIPAL', loanId },
    ]);
    // A second Loan whose first set starts on 2027-10-01, and its interest of 120.00 booked on 2027-09-20: not attributed.
    const lateLoan = (
      await json<{ loanId: string }>(
        await A('POST', '/loans', { lenderPartyId: bank, borrowerPartyIds: [ownerA, ownerB], principalOriginal: eur('20000.00'), startDate: '2027-01-01' }),
        201,
      )
    ).loanId;
    await json(
      await A('POST', `/loans/${lateLoan}/allocations`, {
        validFrom: '2027-10-01',
        basis: 'MANUAL',
        allocations: [{ propertyReferenceId: flat, share: '1/1' }],
      }),
      201,
    );
    const lateDebit = await booked('OUTFLOW', '2027-09-20', [{ amount: eur('120.00'), financialCategoryCode: 'LOAN_INTEREST', loanId: lateLoan }]);
    // A repair (9,996.00 gross, 8,400.00 net) and a second one (3,570.00 gross, 3,000.00 net) for the § 82b election.
    const repair = (await booked('OUTFLOW', '2027-05-12', [on('9996.00', 'MAINTENANCE')])).splitIds[0] as string;
    const elected = (await booked('OUTFLOW', '2027-08-20', [on('3570.00', 'MAINTENANCE')])).splitIds[0] as string;
    // A refund of an earlier year: an insurance premium of 2026, 84.01 back.
    const refund = (await booked('INFLOW', '2027-04-10', [on('84.01', 'INSURANCE')])).splitIds[0] as string;
    // A Sonderumlage of 2,000.00, paid, and its use.
    const assessment = (
      await json<{ assessmentId: string }>(
        await A('POST', `/weg-memberships/${membership}/special-assessments`, {
          description: 'Dachsanierung',
          resolutionDate: '2027-06-10',
          purpose: 'MAINTENANCE',
          unitShare: eur('2000.00'),
          instalments: [{ position: 1, dueDate: '2027-09-01', amount: eur('2000.00') }],
        }),
        201,
      )
    ).assessmentId;
    const levy = (await booked('OUTFLOW', '2027-09-01', [on('2000.00', 'WEG_SPECIAL_ASSESSMENT', { wegSpecialAssessmentId: assessment })]))
      .splitIds[0] as string;
    await json(
      await A('PUT', `/weg-special-assessments/${assessment}/uses`, {
        uses: [{ position: 1, date: '2027-10-15', description: 'Dachsanierung', unitShare: eur('2000.00') }],
      }),
      200,
    );
    // The statement of 2027: cost lines of 3,000.00 (the Hausgeld paid explains them), a reserve withdrawal of 12,000.00.
    const statementId = (
      await json<{ statementId: string }>(
        await A('POST', `/weg-memberships/${membership}/annual-statements`, {
          financialYear: 2027,
          periodFrom: '2027-01-01',
          periodUntil: '2027-12-31',
          supersedes: null,
          costLines: [
            { position: 1, account: 'Hausmeister', group: 'RECOVERABLE', allocationKey: 'MEA', totalAmount: eur('18000.00'), unitShare: eur('1800.00') },
            {
              position: 2,
              account: 'Verwaltervergütung',
              group: 'NON_RECOVERABLE',
              allocationKey: 'MEA',
              totalAmount: eur('12000.00'),
              unitShare: eur('1200.00'),
            },
          ],
          recoverableSubtotal: eur('1800.00'),
          nonRecoverableSubtotal: eur('1200.00'),
          totalCosts: eur('3000.00'),
          hausgeldRequested: eur('3000.00'),
          hausgeldPaid: eur('3000.00'),
          settlementPeak: eur('0.00'),
          reserve: {
            source: 'ANNUAL_STATEMENT',
            lines: [{ position: 1, description: 'Erneuerung Heizung', kind: 'WITHDRAWAL', withdrawal: eur('12000.00'), date: '2027-07-01' }],
          },
        }),
        201,
      )
    ).statementId;
    await json(await A('POST', `/weg-annual-statements/${statementId}/confirm`), 200);
    // The deposit of 2,700.00 (no PropertyReference, §47.2), 2,400.00 repaid, 300.00 retained at the closing.
    const depositId = (await json<{ securityDepositId: string }>(await A('POST', '/security-deposits', { mreTenantId: TENANT }), 201)).securityDepositId;
    const receipt = (
      await booked('INFLOW', '2026-12-15', [{ amount: eur('2700.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: depositId }])
    ).splitIds[0] as string;
    await booked('OUTFLOW', '2028-01-20', [{ amount: eur('2400.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: depositId }]);
    await json(
      await A('POST', `/security-deposits/${depositId}/close`, { closingDate: '2028-01-31', reason: 'RETAINED', closingNote: 'Schaden Bodenbelag' }),
      200,
    );

    // From here on, taxation only interprets: the cash, the WEG records, the deposit and the Acquisition stay as they are.
    const facts = async () => {
      const { tax_classification: _classifications, audit_record: _audits, ...rows } = await rowsSnapshot(pool);
      return rows;
    };
    const before = await facts();

    // The hard rules (counter-checks): a reserve contribution, a Sonderumlage payment, principal and a deposit are never
    // Werbungskosten or income, whatever the user says.
    const classify = (body: Record<string, unknown>) => A('POST', '/tax-classifications', { reviewState: 'USER_CONFIRMED', supersedes: null, ...body });
    const split = (sourceId: string, taxCategory: string, treatment: string | null, extra: Record<string, unknown> = {}) =>
      classify({ sourceType: 'TRANSACTION_SPLIT', sourceId, taxCategory, treatment, ...extra });
    for (const [sourceId, taxCategory, treatment, categoryType] of [
      [reserve[0], 'WEG_HAUSGELD', 'DEDUCTIBLE', 'WEG_FUNDS'],
      [levy, 'MAINTENANCE', 'DEDUCTIBLE', 'WEG_FUNDS'],
      [principal[0], 'LOAN_INTEREST', 'DEDUCTIBLE', 'FINANCING'],
      [receipt, 'RENT', 'INCOME', 'SECURITY_DEPOSIT'],
    ] as const) {
      expect(await errorOf(await split(sourceId as string, taxCategory, treatment), 422), taxCategory).toMatchObject({
        code: 'TREATMENT_NOT_ALLOWED',
        details: { categoryType },
      });
    }

    // One current classification per source: the repair classified, a second create refused, then superseded with its net amount.
    const first = await json<{ classificationId: string }>(await split(repair, 'MAINTENANCE', 'DEDUCTIBLE'), 201);
    expect(await errorOf(await split(repair, 'MAINTENANCE', 'DEDUCTIBLE', { netAmount: eur('8400.00') }), 409)).toMatchObject({
      details: { reason: 'CLASSIFICATION_EXISTS', currentClassificationId: first.classificationId },
    });
    const second = await json<{ classificationId: string }>(
      await split(repair, 'MAINTENANCE', 'DEDUCTIBLE', {
        netAmount: eur('8400.00'),
        supersedes: first.classificationId,
        sourceReferences: ['Rechnung 2027-05'],
      }),
      201,
    );
    const history = await json<{ items: { classificationId: string; supersededBy: string | null }[] }>(
      await A('GET', `/tax-classifications?sourceType=TRANSACTION_SPLIT&sourceId=${repair}`),
      200,
    );
    expect(history.items.map((c) => [c.classificationId, c.supersededBy])).toEqual([
      [first.classificationId, second.classificationId],
      [second.classificationId, null],
    ]);
    // The § 82b election: 3,570.00 over three years (1,190.00 each), the building mostly residential.
    await json(
      await split(elected, 'MAINTENANCE', 'DISTRIBUTED_82B', { distributionYears: 3, mostlyResidentialConfirmed: true, netAmount: eur('3000.00') }),
      201,
    );
    // The refund of 2026; the reserve withdrawal (1,200.00 = 12,000.00 × 100/1000) as Erhaltungsaufwand when spent.
    await json(await split(refund, 'INSURANCE', 'DEDUCTIBLE', { refundOfYear: 2026 }), 201);
    const withdrawal = await json<{ amount: Money; date: string; taxYear: number; origin: string; reviewState: string }>(
      await A('GET', `/weg-annual-statements/${statementId}/reserve-withdrawals/1/tax-meaning`),
      200,
    );
    expect(withdrawal).toMatchObject({ amount: eur('1200.00'), date: '2027-07-01', taxYear: 2027, origin: 'DEFAULT', reviewState: 'NEEDS_REVIEW' });
    await json(
      await classify({ sourceType: 'WEG_RESERVE_WITHDRAWAL', sourceId: statementId, sourcePosition: 1, taxCategory: 'WEG_SPENDING', treatment: 'DEDUCTIBLE' }),
      201,
    );

    // The anschaffungsnahe check: basis (100,000.00 + 5,000.00) × 84,000.00 / 105,000.00 = 84,000.00, threshold 12,600.00.
    // 8,400.00 + 3,000.00 (net) + 1,200.00 (gross) = 12,600.00: exactly 15 % is not above.
    const check = async () => json<Check>(await A('GET', `/acquisitions/${acquisition}/anschaffungsnahe-herstellungskosten`), 200);
    const exactly = await check();
    expect(exactly).toMatchObject({
      status: 'NOT_ABOVE_THRESHOLD',
      basis: { basisAmount: eur('84000.00') },
      threshold: eur('12600.00'),
      sum: eur('12600.00'),
      attributableAmount: eur('12600.00'),
      affectedYears: [],
    });
    expect(exactly.unclassified.map((s) => s.sourceType)).toEqual(['WEG_ASSESSMENT_USE']);
    // The Sonderumlage use within the three years, classified: 14,600.00, above.
    await json(
      await classify({ sourceType: 'WEG_ASSESSMENT_USE', sourceId: assessment, sourcePosition: 1, taxCategory: 'WEG_SPENDING', treatment: 'DEDUCTIBLE' }),
      201,
    );
    const above = await check();
    expect(above).toMatchObject({ status: 'ABOVE_THRESHOLD', sum: eur('14600.00'), percentOfBasis: '17.38', affectedYears: [2027], final: false });
    expect(above.sources.map((s) => [s.sourceId, s.amountUsed.amount, s.suggestedTreatment])).toEqual([
      [repair, '8400.00', 'CAPITALIZED'],
      [statementId, '1200.00', 'CAPITALIZED'],
      [elected, '3000.00', 'CAPITALIZED'],
      [assessment, '2000.00', 'CAPITALIZED'],
    ]);
    expect((above.flags.find((f) => f.code === 'NOT_FINAL')?.details as { reasons: string[] }).reasons).toEqual(
      expect.arrayContaining(['GROSS_AMOUNTS', 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED']),
    );

    // The retained deposit: 300.00 in 2028, the year of the closing, classified as compensation for damage.
    expect(await json(await A('GET', `/security-deposits/${depositId}/tax-meaning`), 200)).toMatchObject({
      counts: true,
      taxYear: 2028,
      amount: eur('300.00'),
      propertyReferenceId: flat,
      taxCategory: 'UNCLASSIFIED',
      reviewState: 'NEEDS_REVIEW',
    });
    await json(await classify({ sourceType: 'DEPOSIT_CLOSING', sourceId: depositId, taxCategory: 'RETAINED_DEPOSIT_DAMAGES', treatment: 'INCOME' }), 201);

    // The tax-year views. Every figure below is checked literally (invariant-suite §45).
    const view = async (year: number, ownerPartyId?: string) =>
      json<View>(await A('GET', `/property-references/${flat}/tax-years/${year}${ownerPartyId === undefined ? '' : `?ownerPartyId=${ownerPartyId}`}`), 200);
    const ownerOf = (v: View, ownerPartyId: string) => v.owners?.find((o) => o.ownerPartyId === ownerPartyId) as Totals;
    const before2027 = await rowsSnapshot(pool);
    recording = true;
    const y2027 = await view(2027);
    recording = false;
    expect(figures(y2027)).toEqual({
      einnahmen: ['13284.01', { RENT: '10800.00', OPERATING_COST_ADVANCES: '2400.00', REFUNDS_OF_EARLIER_YEARS: '84.01' }],
      werbungskosten: ['20285.48', { LOAN_INTEREST: '2899.48', WEG_HAUSGELD: '3000.00', WEG_SPENDING: '3200.00', MAINTENANCE: '11186.00' }],
      result: ['-7001.47', 'LOSS'],
    });
    expect(y2027.result.basis).toBe('BEFORE_DEPRECIATION');
    expect(y2027.depreciation).toMatchObject({ status: 'DEPRECIATION_NOT_AVAILABLE', amount: null });
    expect(y2027.review.final).toBe(false);

    // The view reads in one REPEATABLE READ READ ONLY transaction and writes nothing.
    expect(statements[0]).toMatch(/^start transaction isolation level repeatable read read only$/i);
    expect(statements.at(-1)).toMatch(/^commit$/i);
    expect(statements.filter((s) => /^\s*(start transaction|begin)\b/i.test(s))).toHaveLength(1);
    expect(statements.filter((s) => /^\s*(insert|update|delete)\b/i.test(s))).toEqual([]);

    // The 10-day rule: December's rent, paid on 2028-01-04 and due on 2027-12-31, is 2027's.
    const rent = lineOf(y2027, 'RENT');
    expect(rent.items).toHaveLength(12);
    expect(rent.items.at(-1)).toMatchObject({ sourceId: december.splitIds[0], date: '2028-01-04', taxYear: 2027, lineAmount: eur('900.00') });
    expect(codes(rent.items.at(-1)?.flags ?? [])).toEqual(['ATTRIBUTED_BY_10_DAY_RULE']);
    expect(rent.items.slice(0, 11).map((i) => i.sourceId)).toEqual(rents.filter((_, i) => i % 2 === 0));
    expect(lineOf(y2027, 'OPERATING_COST_ADVANCES').items.at(-1)?.sourceId).toBe(december.splitIds[1]);
    // The refund of 2026 is income of 2027, on its own line; the insurance line is not reduced.
    expect(lineOf(y2027, 'REFUNDS_OF_EARLIER_YEARS').items.map((i) => [i.sourceId, i.taxCategory, i.lineAmount])).toEqual([
      [refund, 'INSURANCE', eur('84.01')],
    ]);
    expect(lineOf(y2027, 'INSURANCE').total).toEqual(eur('0.00'));
    // WEG money counts when spent: the withdrawal and the use; the Hausgeld without the reserve when paid.
    expect(lineOf(y2027, 'WEG_SPENDING').items.map((i) => [i.sourceType, i.sourceId, i.lineAmount?.amount])).toEqual([
      ['WEG_RESERVE_WITHDRAWAL', statementId, '1200.00'],
      ['WEG_ASSESSMENT_USE', assessment, '2000.00'],
    ]);
    expect(lineOf(y2027, 'WEG_HAUSGELD').items).toHaveLength(24);
    // The repair and the first part of the § 82b election; both flagged by the check, their treatments unchanged.
    const maintenance = lineOf(y2027, 'MAINTENANCE');
    expect(maintenance.subtotals).toEqual({ immediate: eur('9996.00'), distributed82b: eur('1190.00') });
    expect(maintenance.items.map((i) => [i.sourceId, i.treatment, i.lineAmount?.amount])).toEqual([
      [repair, 'DEDUCTIBLE', '9996.00'],
      [elected, 'DISTRIBUTED_82B', '1190.00'],
    ]);
    for (const item of [...maintenance.items, ...lineOf(y2027, 'WEG_SPENDING').items]) {
      expect(codes(item.flags), item.sourceId).toContain('ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN');
    }
    expect(y2027.acquisitions).toEqual([expect.objectContaining({ acquisitionId: acquisition, status: 'ABOVE_THRESHOLD', final: false })]);
    expect(codes(y2027.flags)).toEqual(expect.arrayContaining(['DEPRECIATION_NOT_AVAILABLE', 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL']));
    expect(y2027.capitalized).toEqual({ total: eur('0.00'), items: [] });
    expect(y2027.unclassified.items).toEqual([]);
    // Interest booked against the allocated Loan (§58D): attributed by its MANUAL 1/1 set, on the LOAN_INTEREST line with
    // the four debits on the PropertyReference (2,449.48 + 450.00 = 2,899.48); its principal is in no place.
    expect(
      placed(y2027)
        .filter((i) => loanDebit.splitIds.includes(i.sourceId))
        .map((i) => [i.sourceId, i.lineAmount, i.loanAllocation?.share]),
    ).toEqual([[loanDebit.splitIds[0], eur('450.00'), '1/1']]);
    // The debit before the second Loan's first set: listed as not attributed, summed nowhere, and the only split of the flag.
    expect(y2027.notAttributed.items.map((i) => [i.sourceId, i.lineAmount, i.reason, i.candidates])).toEqual([
      [lateDebit.splitIds[0], null, 'NO_LOAN_ALLOCATION', [flat]],
    ]);
    const loanInterest = { loanIds: [lateLoan], interestTotal: eur('120.00'), splitIds: [lateDebit.splitIds[0]] };
    expect(y2027.flags.find((f) => f.code === 'LOAN_INTEREST_NOT_ATTRIBUTED')?.details).toEqual(loanInterest);
    expect(y2027.review.open).toContainEqual({ code: 'LOAN_INTEREST_NOT_ATTRIBUTED', count: 1 });

    // Counter-check: a reserve contribution counted when paid. All twelve, and the Sonderumlage payment, are listed in
    // notInView and summed nowhere; WEG_HAUSGELD holds the 24 × … Hausgeld splits only (3,000.00, not 3,600.00).
    const listed = y2027.notInView.items;
    expect(listed.filter((i) => reserve.includes(i.sourceId)).map((i) => [i.taxCategory, i.lineAmount])).toEqual(Array(12).fill(['NOT_RELEVANT', null]));
    expect(listed.find((i) => i.sourceId === levy)).toMatchObject({ taxCategory: 'NOT_RELEVANT', lineAmount: null });
    // Counter-check: principal or a deposit counted. Principal is listed, never summed; the deposit's cash is in no place.
    expect(listed.filter((i) => principal.includes(i.sourceId)).map((i) => i.lineAmount)).toEqual([null, null, null, null]);
    expect(listed).toHaveLength(17);
    // Counter-check: a WEG cost line counted on top of the Hausgeld. The statement appears once, as its withdrawal.
    expect(
      placed(y2027)
        .filter((i) => i.sourceId === statementId)
        .map((i) => [i.sourceType, i.sourcePosition]),
    ).toEqual([['WEG_RESERVE_WITHDRAWAL', 1]]);
    // Counter-check: a figure without its items. Every line is the sum of its items, every section of its lines, the
    // result of the sections; every item names its source and its rule; the items are exactly §55's list of the year.
    const traceable = (v: View) => {
      for (const section of [v.einnahmen, v.werbungskosten]) {
        for (const line of section.lines) {
          expect(
            line.items.reduce((s, i) => s + cents(i.lineAmount), 0n),
            line.taxCategory,
          ).toBe(cents(line.total));
          expect(line.itemCount, line.taxCategory).toBe(line.items.length);
          for (const item of line.items) expect([item.sourceId, item.rule?.ruleCode]).toEqual([expect.any(String), expect.any(String)]);
        }
        expect(section.lines.reduce((s, l) => s + cents(l.total), 0n)).toBe(cents(section.total));
      }
      expect(cents(v.einnahmen.total) - cents(v.werbungskosten.total)).toBe(cents(v.result.amount));
      const named = new Set(v.ruleVersions.map((r) => `${r.ruleCode}@${r.version}`));
      for (const item of placed(v)) expect(named.has(`${item.rule?.ruleCode}@${item.rule?.version}`), item.sourceId).toBe(true);
    };
    traceable(y2027);
    const list = await json<{ items: { sourceType: string; sourceId: string; sourcePosition: number | null }[] }>(
      await A('GET', `/property-references/${flat}/tax-meanings?year=2027&pageSize=200`),
      200,
    );
    const key = (i: { sourceType: string; sourceId: string; sourcePosition: number | null }) => `${i.sourceType}:${i.sourceId}:${i.sourcePosition}`;
    // The Loan's items are §58D's, not the list's (a split with `loanId` has no PropertyReference): the rest is the list.
    const loanSplits = [loanDebit.splitIds[0], lateDebit.splitIds[0]];
    expect(
      placed(y2027)
        .filter((i) => !loanSplits.includes(i.sourceId))
        .map(key)
        .sort(),
    ).toEqual(list.items.map(key).sort());

    // Per owner: each item × the share on its date, by largest remainder; A + B = the property, to the cent.
    const reconciles = (property: View) => {
      const owners = [...(property.owners ?? []), ...(property.notOwned === null ? [] : [property.notOwned])];
      for (const section of ['einnahmen', 'werbungskosten'] as const) {
        property[section].lines.forEach((line, i) =>
          expect(
            owners.reduce((s, o) => s + cents(o[section].lines[i]?.total), 0n),
            line.taxCategory,
          ).toBe(cents(line.total)),
        );
        expect(owners.reduce((s, o) => s + cents(o[section].total), 0n)).toBe(cents(property[section].total));
      }
      expect(owners.reduce((s, o) => s + cents(o.result.amount), 0n)).toBe(cents(property.result.amount));
    };
    reconciles(y2027);
    expect(y2027.notOwned).toBeNull();
    expect(figures(ownerOf(y2027, ownerA))).toEqual({
      einnahmen: ['7970.41', { RENT: '6480.00', OPERATING_COST_ADVANCES: '1440.00', REFUNDS_OF_EARLIER_YEARS: '50.41' }],
      werbungskosten: ['12171.28', { LOAN_INTEREST: '1739.68', WEG_HAUSGELD: '1800.00', WEG_SPENDING: '1920.00', MAINTENANCE: '6711.60' }],
      result: ['-4200.87', 'LOSS'],
    });
    expect(figures(ownerOf(y2027, ownerB))).toEqual({
      einnahmen: ['5313.60', { RENT: '4320.00', OPERATING_COST_ADVANCES: '960.00', REFUNDS_OF_EARLIER_YEARS: '33.60' }],
      werbungskosten: ['8114.20', { LOAN_INTEREST: '1159.80', WEG_HAUSGELD: '1200.00', WEG_SPENDING: '1280.00', MAINTENANCE: '4474.40' }],
      result: ['-2800.60', 'LOSS'],
    });
    // The owner level: A's own view, with A's part of each item (612.37 → 367.42, the Loan's 450.00 → 270.00, 84.01 → 50.41).
    const a2027 = await view(2027, ownerA);
    expect(a2027.level).toBe('OWNER');
    expect(a2027.flags.find((f) => f.code === 'LOAN_INTEREST_NOT_ATTRIBUTED')?.details).toEqual(loanInterest);
    expect(figures(a2027)).toEqual(figures(ownerOf(y2027, ownerA)));
    expect(lineOf(a2027, 'LOAN_INTEREST').items.map((i) => i.lineAmount?.amount)).toEqual(['367.42', '367.42', '270.00', '367.42', '367.42']);
    expect(lineOf(a2027, 'LOAN_INTEREST').items[2]?.loanAllocation?.propertyPart).toEqual(eur('450.00'));
    expect(lineOf(a2027, 'REFUNDS_OF_EARLIER_YEARS').items[0]?.share).toMatchObject({ share: '3/5', amount: eur('50.41') });
    traceable(a2027);
    const b2027 = await view(2027, ownerB);
    expect(lineOf(b2027, 'LOAN_INTEREST').items.map((i) => i.lineAmount?.amount)).toEqual(['244.95', '244.95', '180.00', '244.95', '244.95']);
    expect(figures(b2027)).toEqual(figures(ownerOf(y2027, ownerB)));

    // 2028: the retained deposit and the second § 82b part; December's rent is not here (it is 2027's).
    const y2028 = await view(2028);
    expect(figures(y2028)).toEqual({
      einnahmen: ['300.00', { RETAINED_DEPOSIT_DAMAGES: '300.00' }],
      werbungskosten: ['1190.00', { MAINTENANCE: '1190.00' }],
      result: ['-890.00', 'LOSS'],
    });
    expect(lineOf(y2028, 'RETAINED_DEPOSIT_DAMAGES').items.map((i) => [i.sourceType, i.sourceId, i.date])).toEqual([
      ['DEPOSIT_CLOSING', depositId, '2028-01-31'],
    ]);
    expect(lineOf(y2028, 'MAINTENANCE').subtotals).toEqual({ immediate: eur('0.00'), distributed82b: eur('1190.00') });
    expect(placed(y2028).some((i) => i.sourceId === december.splitIds[0])).toBe(false);
    expect(y2028.notInView.items).toEqual([]);
    expect(codes(y2028.flags)).not.toContain('LOAN_INTEREST_NOT_ATTRIBUTED');
    traceable(y2028);
    reconciles(y2028);
    expect([figures(ownerOf(y2028, ownerA)), figures(ownerOf(y2028, ownerB))]).toEqual([
      { einnahmen: ['180.00', { RETAINED_DEPOSIT_DAMAGES: '180.00' }], werbungskosten: ['714.00', { MAINTENANCE: '714.00' }], result: ['-534.00', 'LOSS'] },
      { einnahmen: ['120.00', { RETAINED_DEPOSIT_DAMAGES: '120.00' }], werbungskosten: ['476.00', { MAINTENANCE: '476.00' }], result: ['-356.00', 'LOSS'] },
    ]);
    // The third part in 2029.
    expect(figures(await view(2029))).toEqual({
      einnahmen: ['0.00', {}],
      werbungskosten: ['1190.00', { MAINTENANCE: '1190.00' }],
      result: ['-1190.00', 'LOSS'],
    });

    // No cash mutated: the views wrote nothing, not even an AuditRecord.
    expect(await rowsSnapshot(pool)).toEqual(before2027);
    // Counter-check: a classification that changes a split. Every split, Transaction, statement, Sonderumlage, deposit,
    // Acquisition, allocation, Ownership and RentalContractReference is unchanged in row and version by every Phase-7
    // command above.
    expect(await facts()).toEqual(before);
    const repairTx = await json<{ splits: { splitId: string; financialCategoryCode: string; amount: Money }[]; version: number }>(
      await A('GET', `/transactions/${(await pool.query(`SELECT transaction_id FROM transaction_split WHERE id = $1`, [repair])).rows[0].transaction_id}`),
      200,
    );
    expect(repairTx.splits.map((s) => [s.splitId, s.financialCategoryCode, s.amount.amount])).toEqual([[repair, 'MAINTENANCE', '9996.00']]);

    // Every stored rule reference resolves (the start check of §58).
    expect((await checkStoredRuleReferences(createDatabase(pool))).map((r) => `${r.ruleCode}@${r.version}`).sort()).toEqual([
      'DE_82B_DISTRIBUTION@1',
      'DE_CATEGORY_DEFAULTS@1',
      'DE_WEG_SPENDING@1',
    ]);

    // Realm isolation: every Phase-7 route, called by Realm B with Realm A's ids, answers as its row expects; nothing
    // of Realm A changes and no AuditRecord is written.
    const classificationId = second.classificationId;
    const referenceId = (
      await json<{ items: { rentalContractReferenceId: string }[] }>(await A('GET', `/rental-contract-references?mreTenantId=${TENANT}`), 200)
    ).items[0]?.rentalContractReferenceId as string;
    const ids: Record<string, string> = {
      splitId: repair,
      depositId,
      statementId,
      assessmentId: assessment,
      position: '1',
      acquisitionId: acquisition,
      propertyReferenceId: flat,
      year: '2027',
      classificationId,
      rentalContractReferenceId: referenceId,
      ruleCode: 'DE_CATEGORY_DEFAULTS',
    };
    const sameAsA = (path: string) => async (body: unknown) => expect(body).toEqual(await json(await A('GET', path), 200));
    type Row = {
      readonly expect: 404 | 422 | ((body: unknown) => Promise<void> | void);
      readonly body?: unknown;
      readonly query?: string;
      readonly headers?: Record<string, string>;
    };
    const create = (body: Record<string, unknown>): Row => ({ expect: 404, body: { reviewState: 'USER_CONFIRMED', supersedes: null, ...body } });
    const routes: Record<string, readonly Row[]> = {
      // The registry is the same for every Realm (§58): no Realm A data in it.
      'GET /tax-rules': [{ expect: sameAsA('/tax-rules') }],
      'GET /tax-rules/:ruleCode': [{ expect: sameAsA('/tax-rules/DE_CATEGORY_DEFAULTS') }],
      'GET /transaction-splits/:splitId/tax-meaning': [{ expect: 404 }],
      'GET /security-deposits/:depositId/tax-meaning': [{ expect: 404 }],
      'GET /weg-annual-statements/:statementId/reserve-withdrawals/:position/tax-meaning': [{ expect: 404 }],
      'GET /weg-special-assessments/:assessmentId/uses/:position/tax-meaning': [{ expect: 404 }],
      'GET /acquisitions/:acquisitionId/anschaffungsnahe-herstellungskosten': [{ expect: 404 }],
      'GET /property-references/:propertyReferenceId/tax-meanings': [{ expect: 404, query: 'year=2027' }],
      'GET /property-references/:propertyReferenceId/tax-years/:year': [{ expect: 404 }, { expect: 404, query: `ownerPartyId=${ownerA}` }],
      'POST /tax-classifications': [
        create({ sourceType: 'TRANSACTION_SPLIT', sourceId: repair, taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED' }),
        create({ sourceType: 'DEPOSIT_CLOSING', sourceId: depositId, taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' }),
        create({ sourceType: 'WEG_RESERVE_WITHDRAWAL', sourceId: statementId, sourcePosition: 1, taxCategory: 'WEG_SPENDING', treatment: 'CAPITALIZED' }),
        create({ sourceType: 'WEG_ASSESSMENT_USE', sourceId: assessment, sourcePosition: 1, taxCategory: 'WEG_SPENDING', treatment: 'CAPITALIZED' }),
      ],
      'GET /tax-classifications': [
        { expect: 404, query: `sourceType=TRANSACTION_SPLIT&sourceId=${repair}` },
        { expect: 404, query: `sourceType=DEPOSIT_CLOSING&sourceId=${depositId}` },
        { expect: 404, query: `sourceType=WEG_RESERVE_WITHDRAWAL&sourceId=${statementId}&sourcePosition=1` },
        { expect: 404, query: `sourceType=WEG_ASSESSMENT_USE&sourceId=${assessment}&sourcePosition=1` },
      ],
      'GET /tax-classifications/:classificationId': [{ expect: 404 }],
      'POST /tax-classifications/:classificationId/confirm': [{ expect: 404, body: {}, headers: { 'if-match': '"1"' } }],
      'POST /tax-classifications/:classificationId/advisor-confirm': [{ expect: 404, body: {}, headers: { 'if-match': '"1"' } }],
      'POST /tax-classifications/:classificationId/mark-needs-review': [{ expect: 404, body: { reason: 'x' }, headers: { 'if-match': '"1"' } }],
      // A create names an MRE Tenant, not a DE id: Realm A's Tenant is unknown in Realm B's MRE (§58A).
      'POST /rental-contract-references': [{ expect: 422, body: { mreTenantId: TENANT, rentDueDays: [] } }],
      'GET /rental-contract-references': [{ expect: (body) => expect(body).toEqual({ items: [] }), query: `mreTenantId=${TENANT}` }],
      'GET /rental-contract-references/:rentalContractReferenceId': [{ expect: 404 }],
      'POST /rental-contract-references/:rentalContractReferenceId/amend': [{ expect: 404, body: { notes: 'x' }, headers: { 'if-match': '"1"' } }],
    };
    // The table is the app's Phase-7 routes, no more and no fewer: a new route without a row turns this red.
    expect(Object.keys(routes).sort()).toEqual(
      routesOf(app)
        .filter((route) => PHASE_7.test(route))
        .sort(),
    );
    const stateOfA = async () => ({
      classifications: (
        await pool.query(`SELECT id, version, review_state, superseded_at FROM tax_classification WHERE mre_realm_id = $1 ORDER BY id`, [REALM_A])
      ).rows,
      references: (await pool.query(`SELECT id, version FROM rental_contract_reference ORDER BY id`)).rows,
      facts: await facts(),
    });
    const audits = async () => Number((await pool.query(`SELECT count(*) AS n FROM audit_record`)).rows[0].n);
    const snapshot = { state: await stateOfA(), audits: await audits() };
    for (const [route, rowsOfRoute] of Object.entries(routes)) {
      for (const row of rowsOfRoute) {
        const [method = '', template = ''] = route.split(' ');
        const path = template.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? `missing-${name}`) + (row.query === undefined ? '' : `?${row.query}`);
        const res = await call(REALM_B, method, path, row.body, row.headers);
        if (row.expect === 404) {
          expect(res.status, `${route} ${await res.clone().text()}`).toBe(404);
          expect(((await res.json()) as { error: { code: string } }).error.code, route).toBe('NOT_FOUND');
        } else if (row.expect === 422) {
          expect(await errorOf(res, 422)).toMatchObject({ code: 'MRE_TENANT_NOT_FOUND', details: { mreTenantId: TENANT } });
        } else {
          await row.expect(await json(res, 200));
        }
        expect(await stateOfA(), route).toEqual(snapshot.state);
        expect(await audits(), route).toBe(snapshot.audits);
      }
    }
  });
});

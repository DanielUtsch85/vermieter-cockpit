import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from './api/index.js';
import {
  closeFinancialAccount,
  confirmTransaction,
  correctTransaction,
  reverseTransaction,
  getTransaction,
  listPropertyReferenceTransactions,
  listTransactions,
  amendTransaction,
  ignoreTransaction,
  restoreTransaction,
  amendParty,
  createFinancialAccount,
  createParty,
  deactivateParty,
  createExternalReference,
  endExternalReference,
  listExternalReferences,
  changeOwnership,
  cancelAcquisition,
  confirmAcquisition,
  createCostClassification,
  constructionPeriodInterestCommands,
  createLandBuildingAllocation,
  listCostClassifications,
  listLandBuildingAllocations,
  getOwnerAllocation,
  createAcquisitionCost,
  voidAcquisitionCost,
  listAcquisitionCosts,
  linkAcquisitionPayment,
  unlinkAcquisitionPayment,
  listAcquisitionPayments,
  amendLoan,
  createLoan,
  getLoan,
  listLoans,
  voidLoan,
  closeLoan,
  amendDeposit,
  createDeposit,
  createEconomicPlan,
  getEconomicPlan,
  listEconomicPlans,
  voidEconomicPlan,
  getHausgeldProposal,
  amendSpecialAssessment,
  createSpecialAssessment,
  getSpecialAssessment,
  listSpecialAssessments,
  replaceAssessmentUses,
  voidSpecialAssessment,
  createTaxClassification,
  getTaxClassification,
  getTaxMeaning,
  getDepositTaxMeaning,
  getAnschaffungsnaheCheck,
  getUseTaxMeaning,
  getWithdrawalTaxMeaning,
  createRentalContractReference,
  getRentalContractReference,
  listRentalContractReferences,
  amendRentalContractReference,
  getTaxRule,
  listTaxClassificationHistory,
  listTaxMeanings,
  getTaxYearView,
  listTaxRules,
  reviewTaxClassification,
  confirmAnnualStatement,
  createAnnualStatement,
  getAnnualStatement,
  getSettlementProposal,
  getStatementComparison,
  listAnnualStatements,
  replaceAnnualStatement,
  voidAnnualStatement,
  createWeg,
  getWeg,
  listWegs,
  amendWeg,
  voidWeg,
  createMembership,
  getMembership,
  listMemberships,
  readUnitMemberships,
  amendMembership,
  endMembership,
  voidMembership,
  createReconciliation,
  getDeposit,
  listDeposits,
  voidDeposit,
  closeDeposit,
  reopenDeposit,
  getReconciliation,
  listReconciliations,
  releaseReconciliation,
  getTermCoverage,
  getTransactionCoverage,
  suggestReconciliations,
  confirmReconciliation,
  rejectReconciliation,
  writeBackToMre,
  getReconciliationWithPresence,
  getRentSplitProposal,
  removeFromMre,
  createLoanTerms,
  listLoanTerms,
  voidLoanTerms,
  getLoanSchedule,
  getPaymentProposal,
  getRemainingDebt,
  getLoanPayments,
  createBalanceStatement,
  voidBalanceStatement,
  listBalanceStatements,
  createLoanAllocation,
  getLoanAllocationOn,
  listLoanAllocations,
  listPropertyLoans,
  voidLoanAllocation,
  createAcquisition,
  getAcquisition,
  listAcquisitions,
  listPropertyAcquisitions,
  closeOwnership,
  createOwnership,
  getOwnership,
  readPropertyOwnerships,
  voidOwnership,
  getParty,
  listParties,
  createManualTransaction,
  getFinancialCategory,
  getImportBatch,
  importBankStatement,
  linkPropertyReference,
  listFinancialCategories,
  listReviewItems,
  refreshPropertyReference,
  resolveReviewItem,
  setTransactionSplits,
  getFinancialAccount,
  getPropertyReference,
  listFinancialAccounts,
  listPropertyReferences,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresPartyRepository,
  PostgresPartyExternalReferenceRepository,
  PostgresOwnershipRepository,
  PostgresAcquisitionCostRepository,
  PostgresAcquisitionCostClassificationRepository,
  PostgresConstructionPeriodInterestRepository,
  PostgresLandBuildingAllocationRepository,
  PostgresLoanRepository,
  PostgresRentReconciliationRepository,
  PostgresSecurityDepositRepository,
  PostgresWegRepository,
  PostgresWegAnnualStatementRepository,
  PostgresWegEconomicPlanRepository,
  PostgresWegSpecialAssessmentRepository,
  PostgresTaxClassificationRepository,
  PostgresRentalContractReferenceRepository,
  PostgresLoanDebtRepository,
  PostgresLoanTermsRepository,
  PostgresLoanAllocationRepository,
  PostgresOwnerAllocationSource,
  PostgresAcquisitionRepository,
  PostgresFinancialCategoryRepository,
  PostgresImportRepository,
  PostgresPropertyReferenceRepository,
  PostgresCorrectionRepository,
  PostgresTransactionQueries,
  PostgresUnconfirmedTransactionRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { depreciationCommands } from './depreciation-commands.test-support.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { findBankStatementAdapter } from './integrations/bank-import/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import {
  mrePrincipalVerifier,
  mrePropertyLookup,
  mreRentTermLookup,
  mreTenantDepositReader,
  mreMonthReader,
  mreRentTermReader,
  mreTenantLookup,
  mreRentBreakdownReader,
  mreWriteBackTermReader,
  mreWriteBackTermWriter,
} from './wiring.js';

/**
 * VC-3-08: the Phase-3 exit of `docs/roadmap.md` as one acceptance run through the HTTP API (ACC3,
 * invariant-suite.md §23), wired as in main.ts: a shared Loan allocates to two properties without duplication;
 * interest and principal flow into the ledger through splits with `loanId`; the remaining debt is derived, never
 * stored; refinancing closes the Loan; every Phase-3 route is Realm-isolated; every Loan write leaves its AuditRecord.
 * The figures are hand-computed in §23 and checked literally.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000003a';
const REALM_B = '64b0c0ffee0000000000003b';
const PROPERTY_1 = '6512f0c2a1b2c3d4e5f63901';
const PROPERTY_2 = '6512f0c2a1b2c3d4e5f63902';

/** The Phase-3 routes (api-design §41) under `/api/v1`, as `METHOD /path/:param`. */
const PHASE_3 = /^[A-Z]+ \/loans\b|^[A-Z]+ \/property-references\/:propertyReferenceId\/loans$/;

/**
 * Every route the app serves, from Express' router stack, relative to its mount point. This reads Express 4
 * internals (`app._router.stack`), as ACC2 does; on Express 5 it finds no routes and the comparison fails loudly.
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

describe.skipIf(databaseUrl === undefined)('Phase 3 acceptance (roadmap exit)', () => {
  const schema = testSchemaName('phase_3_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let app: Express;
  let server: Server;
  let base: string;

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
        properties: [
          { _id: PROPERTY_1, name: 'Haus Lindenweg', surface: 180 },
          { _id: PROPERTY_2, name: 'Wohnung Gartenstraße', surface: 70 },
        ],
      },
      { _id: REALM_B, name: 'B', members: member, applications: [], properties: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const propertyReferences = { repository: new PostgresPropertyReferenceRepository(db), lookupMreProperty: mrePropertyLookup(client) };
    const accounts = new PostgresFinancialAccountRepository(db);
    const parties = new PostgresPartyRepository(db);
    const externalReferences = new PostgresPartyExternalReferenceRepository(db);
    const ownerships = new PostgresOwnershipRepository(db);
    const acquisitions = new PostgresAcquisitionRepository(db);
    const acquisitionCosts = new PostgresAcquisitionCostRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const unconfirmed = new PostgresUnconfirmedTransactionRepository(db);
    const imports = new PostgresImportRepository(db);
    const categories = new PostgresFinancialCategoryRepository(db);
    app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      propertyReferences: {
        link: linkPropertyReference(propertyReferences),
        refresh: refreshPropertyReference(propertyReferences),
        get: getPropertyReference({ repository: propertyReferences.repository }),
        list: listPropertyReferences({ repository: propertyReferences.repository }),
      },
      parties: {
        create: createParty({ repository: parties }),
        get: getParty({ repository: parties }),
        list: listParties({ repository: parties }),
        amend: amendParty({ repository: parties }),
        deactivate: deactivateParty({ repository: parties }),
      },
      externalReferences: {
        create: createExternalReference({ repository: externalReferences, lookupMreTenant: mreTenantLookup(client) }),
        end: endExternalReference({ repository: externalReferences }),
        list: listExternalReferences({ repository: externalReferences }),
      },
      ownerships: {
        create: createOwnership({ repository: ownerships }),
        get: getOwnership({ repository: ownerships }),
        close: closeOwnership({ repository: ownerships }),
        void: voidOwnership({ repository: ownerships }),
        read: readPropertyOwnerships({ repository: ownerships }),
        change: changeOwnership({ repository: ownerships }),
      },
      acquisitions: {
        create: createAcquisition({ repository: acquisitions }),
        get: getAcquisition({ repository: acquisitions }),
        list: listAcquisitions({ repository: acquisitions }),
        listForPropertyReference: listPropertyAcquisitions({ repository: acquisitions, propertyReferences: propertyReferences.repository }),
        cancel: cancelAcquisition({ repository: acquisitions }),
        confirm: confirmAcquisition({ repository: acquisitions }),
      },
      ownerAllocation: { get: getOwnerAllocation({ source: new PostgresOwnerAllocationSource(db) }) },
      constructionPeriodInterest: constructionPeriodInterestCommands(new PostgresConstructionPeriodInterestRepository(db)),
      costClassifications: {
        create: createCostClassification({ repository: new PostgresAcquisitionCostClassificationRepository(db) }),
        list: listCostClassifications({ repository: new PostgresAcquisitionCostClassificationRepository(db) }),
      },
      landBuildingAllocations: {
        create: createLandBuildingAllocation({ repository: new PostgresLandBuildingAllocationRepository(db) }),
        list: listLandBuildingAllocations({ repository: new PostgresLandBuildingAllocationRepository(db) }),
      },
      acquisitionCosts: {
        createCost: createAcquisitionCost({ repository: acquisitionCosts }),
        voidCost: voidAcquisitionCost({ repository: acquisitionCosts }),
        listCosts: listAcquisitionCosts({ repository: acquisitionCosts }),
        linkPayment: linkAcquisitionPayment({ repository: acquisitionCosts }),
        unlinkPayment: unlinkAcquisitionPayment({ repository: acquisitionCosts }),
        listPayments: listAcquisitionPayments({ repository: acquisitionCosts }),
      },
      loans: {
        create: createLoan({ repository: new PostgresLoanRepository(db) }),
        get: getLoan({ repository: new PostgresLoanRepository(db) }),
        list: listLoans({ repository: new PostgresLoanRepository(db) }),
        amend: amendLoan({ repository: new PostgresLoanRepository(db) }),
        void: voidLoan({ repository: new PostgresLoanRepository(db) }),
        close: closeLoan({ repository: new PostgresLoanRepository(db) }),
      },
      securityDeposits: {
        create: createDeposit({ repository: new PostgresSecurityDepositRepository(db), readMreTenant: mreTenantDepositReader(client) }),
        get: getDeposit({ repository: new PostgresSecurityDepositRepository(db), readMreTenant: mreTenantDepositReader(client) }),
        list: listDeposits({ repository: new PostgresSecurityDepositRepository(db) }),
        amend: amendDeposit({ repository: new PostgresSecurityDepositRepository(db) }),
        void: voidDeposit({ repository: new PostgresSecurityDepositRepository(db) }),
        close: closeDeposit({ repository: new PostgresSecurityDepositRepository(db) }),
        reopen: reopenDeposit({ repository: new PostgresSecurityDepositRepository(db) }),
      },
      wegs: {
        createWeg: createWeg({ repository: new PostgresWegRepository(db) }),
        getWeg: getWeg({ repository: new PostgresWegRepository(db) }),
        listWegs: listWegs({ repository: new PostgresWegRepository(db) }),
        amendWeg: amendWeg({ repository: new PostgresWegRepository(db) }),
        voidWeg: voidWeg({ repository: new PostgresWegRepository(db) }),
        createMembership: createMembership({ repository: new PostgresWegRepository(db) }),
        getMembership: getMembership({ repository: new PostgresWegRepository(db) }),
        listMemberships: listMemberships({ repository: new PostgresWegRepository(db) }),
        readUnitMemberships: readUnitMemberships({ repository: new PostgresWegRepository(db) }),
        amendMembership: amendMembership({ repository: new PostgresWegRepository(db) }),
        endMembership: endMembership({ repository: new PostgresWegRepository(db) }),
        voidMembership: voidMembership({ repository: new PostgresWegRepository(db) }),
      },
      wegEconomicPlans: {
        create: createEconomicPlan({ repository: new PostgresWegEconomicPlanRepository(db) }),
        get: getEconomicPlan({ repository: new PostgresWegEconomicPlanRepository(db) }),
        list: listEconomicPlans({ repository: new PostgresWegEconomicPlanRepository(db) }),
        void: voidEconomicPlan({ repository: new PostgresWegEconomicPlanRepository(db) }),
        hausgeldProposal: getHausgeldProposal({ repository: new PostgresWegEconomicPlanRepository(db) }),
      },
      wegAnnualStatements: {
        create: createAnnualStatement({ repository: new PostgresWegAnnualStatementRepository(db) }),
        get: getAnnualStatement({ repository: new PostgresWegAnnualStatementRepository(db) }),
        list: listAnnualStatements({ repository: new PostgresWegAnnualStatementRepository(db) }),
        replace: replaceAnnualStatement({ repository: new PostgresWegAnnualStatementRepository(db) }),
        confirm: confirmAnnualStatement({ repository: new PostgresWegAnnualStatementRepository(db) }),
        void: voidAnnualStatement({ repository: new PostgresWegAnnualStatementRepository(db) }),
        comparison: getStatementComparison({ repository: new PostgresWegAnnualStatementRepository(db) }),
        settlementProposal: getSettlementProposal({ repository: new PostgresWegAnnualStatementRepository(db) }),
      },
      wegSpecialAssessments: {
        create: createSpecialAssessment({ repository: new PostgresWegSpecialAssessmentRepository(db) }),
        get: getSpecialAssessment({ repository: new PostgresWegSpecialAssessmentRepository(db) }),
        list: listSpecialAssessments({ repository: new PostgresWegSpecialAssessmentRepository(db) }),
        amend: amendSpecialAssessment({ repository: new PostgresWegSpecialAssessmentRepository(db) }),
        replaceUses: replaceAssessmentUses({ repository: new PostgresWegSpecialAssessmentRepository(db) }),
        void: voidSpecialAssessment({ repository: new PostgresWegSpecialAssessmentRepository(db) }),
      },
      taxation: {
        create: createTaxClassification({ repository: new PostgresTaxClassificationRepository(db) }),
        get: getTaxClassification({ repository: new PostgresTaxClassificationRepository(db) }),
        history: listTaxClassificationHistory({ repository: new PostgresTaxClassificationRepository(db) }),
        review: reviewTaxClassification({ repository: new PostgresTaxClassificationRepository(db) }),
        taxMeaning: getTaxMeaning({ repository: new PostgresTaxClassificationRepository(db) }),
        depositTaxMeaning: getDepositTaxMeaning({ repository: new PostgresTaxClassificationRepository(db) }),
        withdrawalTaxMeaning: getWithdrawalTaxMeaning({ repository: new PostgresTaxClassificationRepository(db) }),
        useTaxMeaning: getUseTaxMeaning({ repository: new PostgresTaxClassificationRepository(db) }),
        anschaffungsnahe: getAnschaffungsnaheCheck({ repository: new PostgresTaxClassificationRepository(db) }),
        taxMeanings: listTaxMeanings({ repository: new PostgresTaxClassificationRepository(db) }),
        taxYear: getTaxYearView({ repository: new PostgresTaxClassificationRepository(db) }),
        listRules: listTaxRules(),
        getRule: getTaxRule(),
      },
      rentalContractReferences: {
        create: createRentalContractReference({ repository: new PostgresRentalContractReferenceRepository(db), lookupMreTenant: mreTenantLookup(client) }),
        get: getRentalContractReference({ repository: new PostgresRentalContractReferenceRepository(db) }),
        list: listRentalContractReferences({ repository: new PostgresRentalContractReferenceRepository(db) }),
        amend: amendRentalContractReference({ repository: new PostgresRentalContractReferenceRepository(db) }),
      },
      depreciationAssets: depreciationCommands(db),
      rentReconciliations: {
        create: createReconciliation({ repository: new PostgresRentReconciliationRepository(db), lookupMreRentTerm: mreRentTermLookup(client) }),
        get: getReconciliation({ repository: new PostgresRentReconciliationRepository(db) }),
        list: listReconciliations({ repository: new PostgresRentReconciliationRepository(db) }),
        release: releaseReconciliation({ repository: new PostgresRentReconciliationRepository(db) }),
        termCoverage: getTermCoverage({ repository: new PostgresRentReconciliationRepository(db), readMreRentTerm: mreRentTermReader(client) }),
        transactionCoverage: getTransactionCoverage({ repository: new PostgresRentReconciliationRepository(db) }),
        suggest: suggestReconciliations({ repository: new PostgresRentReconciliationRepository(db), readMreMonth: mreMonthReader(client) }),
        confirm: confirmReconciliation({ repository: new PostgresRentReconciliationRepository(db), readMreRentTerm: mreRentTermReader(client) }),
        reject: rejectReconciliation({ repository: new PostgresRentReconciliationRepository(db) }),
        writeBack: writeBackToMre({
          repository: new PostgresRentReconciliationRepository(db),
          readTerm: mreWriteBackTermReader(client),
          writeTerm: mreWriteBackTermWriter(client),
          leaseMs: 4000,
        }),
        getWithPresence: getReconciliationWithPresence({ repository: new PostgresRentReconciliationRepository(db), readTerm: mreWriteBackTermReader(client) }),
        splitProposal: getRentSplitProposal({ queries: new PostgresTransactionQueries(db), readBreakdown: mreRentBreakdownReader(client) }),
        removeFromMre: removeFromMre({
          repository: new PostgresRentReconciliationRepository(db),
          readTerm: mreWriteBackTermReader(client),
          writeTerm: mreWriteBackTermWriter(client),
          leaseMs: 4000,
          marginMs: 0,
        }),
      },
      loanTerms: {
        create: createLoanTerms({ repository: new PostgresLoanTermsRepository(db) }),
        void: voidLoanTerms({ repository: new PostgresLoanTermsRepository(db) }),
        list: listLoanTerms({ repository: new PostgresLoanTermsRepository(db) }),
        schedule: getLoanSchedule({ repository: new PostgresLoanTermsRepository(db) }),
        proposal: getPaymentProposal({ repository: new PostgresLoanTermsRepository(db) }),
      },
      loanDebt: {
        remainingDebt: getRemainingDebt({ repository: new PostgresLoanDebtRepository(db) }),
        payments: getLoanPayments({ repository: new PostgresLoanDebtRepository(db) }),
        createStatement: createBalanceStatement({ repository: new PostgresLoanDebtRepository(db) }),
        voidStatement: voidBalanceStatement({ repository: new PostgresLoanDebtRepository(db) }),
        listStatements: listBalanceStatements({ repository: new PostgresLoanDebtRepository(db) }),
      },
      loanAllocations: {
        create: createLoanAllocation({ repository: new PostgresLoanAllocationRepository(db) }),
        void: voidLoanAllocation({ repository: new PostgresLoanAllocationRepository(db) }),
        list: listLoanAllocations({ repository: new PostgresLoanAllocationRepository(db) }),
        on: getLoanAllocationOn({ repository: new PostgresLoanAllocationRepository(db) }),
        propertyLoans: listPropertyLoans({ repository: new PostgresLoanAllocationRepository(db) }),
      },
      financialAccounts: {
        create: createFinancialAccount({ repository: accounts }),
        close: closeFinancialAccount({ repository: accounts }),
        get: getFinancialAccount({ repository: accounts }),
        list: listFinancialAccounts({ repository: accounts }),
      },
      transactions: {
        createManual: createManualTransaction({ repository: transactions }),
        confirm: confirmTransaction({ repository: transactions }),
        correct: correctTransaction({ repository: new PostgresCorrectionRepository(db) }),
        reverse: reverseTransaction({ repository: new PostgresCorrectionRepository(db) }),
        get: getTransaction({ queries: new PostgresTransactionQueries(db) }),
        list: listTransactions({ queries: new PostgresTransactionQueries(db) }),
        listForPropertyReference: listPropertyReferenceTransactions({
          queries: new PostgresTransactionQueries(db),
          propertyReferences: propertyReferences.repository,
        }),
        amend: amendTransaction({ repository: unconfirmed }),
        ignore: ignoreTransaction({ repository: unconfirmed }),
        restore: restoreTransaction({ repository: unconfirmed }),
        setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
      },
      imports: {
        importStatement: importBankStatement({ imports, accounts, findAdapter: findBankStatementAdapter }),
        getBatch: getImportBatch({ imports }),
        listReviewItems: listReviewItems({ imports }),
        resolveReviewItem: resolveReviewItem({ imports }),
      },
      financialCategories: { list: listFinancialCategories({ categories }), get: getFinancialCategory({ categories }) },
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

  const headers = (realm: string) => ({
    authorization: `Bearer ${signJwt({ account: { email: 'anna@example.com' } })}`,
    organizationid: realm,
  });
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
  const eur = (amount: string) => ({ amount, currency: 'EUR' });

  type Money = { amount: string; currency: string };
  type Debt = {
    principalPaid: Money;
    actual: Money;
    planned: Money | null;
    difference: Money | null;
    planEndReason: string;
    closing: { closingDate: string; reason: string; refinancedByLoanId: string | null; actualOnClosingDate: Money } | null;
    latestStatement: { comparison: { actualOnDate: Money; difference: Money } } | null;
    allocationSetId?: string;
    items?: { propertyReferenceId: string; share: string; actual: Money; planned: Money | null; difference: Money | null }[];
  };
  const upload = (realm: string, financialAccountId: string, file: string) => {
    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({
        financialAccountId,
        adapterId: 'generic-csv',
        adapterVersion: '1',
        columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag', description: 'Verwendungszweck' },
      }),
    );
    form.append('file', new Blob([file]), 'darlehen.csv');
    return fetch(`${base}/api/v1/imports/bank-transactions`, { method: 'POST', headers: headers(realm), body: form });
  };

  it('runs the Phase-3 exit end to end: shared Loan, splits into the ledger, derived remaining debt, refinancing, isolation, audit', async () => {
    const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
    const debt = async (loanId: string, query: string) => json<Debt>(await A('GET', `/loans/${loanId}/remaining-debt?${query}`), 200);

    // The two properties, each with a DRAFT Acquisition: 200,000.00 and 100,000.00.
    const link = async (mrePropertyId: string) =>
      (await json<{ propertyReferenceId: string }>(await A('POST', '/property-references/link', { mreRealmId: REALM_A, mrePropertyId }), 201))
        .propertyReferenceId;
    const [p1, p2] = [await link(PROPERTY_1), await link(PROPERTY_2)];
    const party = async (displayName: string, partyType = 'ORGANIZATION') =>
      (await json<{ partyId: string }>(await A('POST', '/parties', { partyType, displayName }), 201)).partyId;
    const [bank, bank2, anna] = [await party('Hausbank'), await party('Neue Bank'), await party('Anna Darlehensnehmerin', 'PERSON')];
    const acquisition = async (propertyReferenceId: string, price: string) =>
      (
        await json<{ acquisitionId: string }>(
          await A('POST', '/acquisitions', { propertyReferenceId, purchasePrice: eur(price), contractDate: '2026-12-01', buyerPartyIds: [anna] }),
          201,
        )
      ).acquisitionId;
    const [a1, a2] = [await acquisition(p1, '200000.00'), await acquisition(p2, '100000.00')];

    // Loan L1: 240,000.00 from 2027-01-01, ANNUITY at 3.000 % with 1,200.00 a month from 2027-01-31.
    const l1 = (
      await json<{ loanId: string }>(
        await A(
          'POST',
          '/loans',
          { lenderPartyId: bank, borrowerPartyIds: [anna], principalOriginal: eur('240000.00'), startDate: '2027-01-01' },
          { 'idempotency-key': 'acc3-l1' },
        ),
        201,
      )
    ).loanId;
    const loan = `/loans/${l1}`;
    const { termsId } = await json<{ termsId: string }>(
      await A('POST', `${loan}/terms`, {
        validFrom: '2027-01-01',
        interestRate: '3.000',
        repaymentModel: 'ANNUITY',
        scheduledPayment: eur('1200.00'),
        firstPaymentDate: '2027-01-31',
      }),
      201,
    );
    // The plan, hand-computed in §23: 596.99625 rounds up to 597.00.
    const plan = await json<{ items: { paymentDate: string; interest: Money; principal: Money; balanceAfter: Money }[] }>(
      await A('GET', `${loan}/schedule?to=2027-03-31`),
      200,
    );
    expect(plan.items.map((e) => [e.paymentDate, e.interest.amount, e.principal.amount, e.balanceAfter.amount])).toEqual([
      ['2027-01-31', '600.00', '600.00', '239400.00'],
      ['2027-02-28', '598.50', '601.50', '238798.50'],
      ['2027-03-31', '597.00', '603.00', '238195.50'],
    ]);

    // A shared loan allocates to properties without duplication. Before the first set it is unallocated.
    const unallocated = await json<{ error: { details: { reason: string } } }>(await A('GET', `${loan}/remaining-debt?asOf=2027-01-15&perProperty=true`), 409);
    expect(unallocated.error.details.reason).toBe('LOAN_NOT_ALLOCATED');
    const byPrice = await json<{ allocationSetId: string; allocations: { propertyReferenceId: string; share: string }[] }>(
      await A('POST', `${loan}/allocations`, {
        validFrom: '2027-01-01',
        basis: 'PURCHASE_PRICE',
        allocations: [
          { propertyReferenceId: p1, acquisitionId: a1 },
          { propertyReferenceId: p2, acquisitionId: a2 },
        ],
      }),
      201,
    );
    expect(byPrice.allocations.map((a) => [a.propertyReferenceId, a.share])).toEqual([
      [p1, '2/3'],
      [p2, '1/3'],
    ]);
    const notOne = await json<{ error: { details: { fields: unknown[] } } }>(
      await A('POST', `${loan}/allocations`, {
        validFrom: '2027-04-01',
        basis: 'MANUAL',
        allocations: [
          { propertyReferenceId: p1, share: '1/2' },
          { propertyReferenceId: p2, share: '1/3' },
        ],
      }),
      400,
    );
    expect(notOne.error.details.fields).toEqual([{ field: 'allocations', code: 'SHARE_SUM_NOT_ONE' }]);

    // Interest/principal split flows into the ledger: four imported rows, three instalments and a special repayment.
    const { financialAccountId } = await json<{ financialAccountId: string }>(
      await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Darlehenskonto', currency: 'EUR' }),
      201,
    );
    const statement = [
      'Buchungstag;Betrag;Verwendungszweck',
      '31.01.2027;-1.200,00;Rate Januar',
      '28.02.2027;-1.200,00;Rate Februar',
      '15.03.2027;-5.000,00;Sondertilgung',
      '31.03.2027;-1.200,00;Rate März',
    ].join('\r\n');
    const imported = await json<{ transactionCount: number; rows: { transactionId?: string }[] }>(await upload(REALM_A, financialAccountId, statement), 201);
    expect(imported.transactionCount).toBe(4);
    const [january, february, special, march] = imported.rows.map((r) => r.transactionId ?? '') as [string, string, string, string];
    type Split = { financialCategoryCode: string; loanId: string; amount: Money };
    const proposed = async (transactionId: string) =>
      (await json<{ splits: Split[]; flags: unknown[] }>(await A('GET', `${loan}/payment-proposal?transactionId=${transactionId}`), 200)).splits;
    const confirmWith = async (transactionId: string, splits: readonly Split[]) => {
      await json(await A('PUT', `/transactions/${transactionId}/splits`, { splits }), 200);
      expect(await json(await A('POST', `/transactions/${transactionId}/confirm`), 200)).toMatchObject({ status: 'CONFIRMED', direction: 'OUTFLOW' });
    };
    expect(await proposed(january)).toEqual([
      { financialCategoryCode: 'LOAN_INTEREST', loanId: l1, amount: eur('600.00') },
      { financialCategoryCode: 'LOAN_PRINCIPAL', loanId: l1, amount: eur('600.00') },
    ]);
    await confirmWith(january, await proposed(january));
    // February is confirmed with interest and principal swapped by mistake.
    const februaryRight = await proposed(february);
    expect(februaryRight.map((s) => s.amount.amount)).toEqual(['598.50', '601.50']);
    await confirmWith(february, [
      { financialCategoryCode: 'LOAN_INTEREST', loanId: l1, amount: eur('601.50') },
      { financialCategoryCode: 'LOAN_PRINCIPAL', loanId: l1, amount: eur('598.50') },
    ]);
    await confirmWith(special, [{ financialCategoryCode: 'LOAN_PRINCIPAL', loanId: l1, amount: eur('5000.00') }]);
    expect((await proposed(march)).map((s) => s.amount.amount)).toEqual(['597.00', '603.00']);
    await confirmWith(march, await proposed(march));
    // A split with a Loan on an INFLOW is refused.
    const { transactionId: inflow } = await json<{ transactionId: string }>(
      await A('POST', '/transactions', { financialAccountId, amount: eur('1.00'), direction: 'INFLOW', bookingDate: '2027-03-31', description: 'Gutschrift' }),
      201,
    );
    const inflowRefused = await json<{ error: { code: string; details: unknown } }>(
      await A('PUT', `/transactions/${inflow}/splits`, { splits: [{ financialCategoryCode: 'LOAN_INTEREST', loanId: l1, amount: eur('1.00') }] }),
      422,
    );
    expect(inflowRefused.error).toMatchObject({ code: 'INVALID_LOAN_SPLIT', details: { reason: 'DIRECTION' } });

    // A correction is re-counted: with February swapped, 3.00 more is owed; after `correct` the plan holds again.
    expect(await debt(l1, 'asOf=2027-03-31')).toMatchObject({ principalPaid: eur('6801.50'), actual: eur('233198.50') });
    await json(await A('POST', `/transactions/${february}/correct`, { reason: 'Zins und Tilgung vertauscht', replacement: { splits: februaryRight } }), 201);

    // Remaining debt is derived: the special repayment is the difference to the plan.
    const march31 = await debt(l1, 'asOf=2027-03-31');
    expect(march31).toMatchObject({
      principalPaid: eur('6804.50'),
      actual: eur('233195.50'),
      planned: eur('238195.50'),
      difference: eur('-5000.00'),
      closing: null,
    });
    // Per property by the 2/3 : 1/3 set; the odd cent of the actual by largest remainder; each difference derived.
    const perProperty = await debt(l1, 'asOf=2027-03-31&perProperty=true');
    expect(perProperty.allocationSetId).toBe(byPrice.allocationSetId);
    expect(perProperty.items?.map((i) => [i.propertyReferenceId, i.share, i.actual.amount, i.planned?.amount, i.difference?.amount])).toEqual([
      [p1, '2/3', '155463.67', '158797.00', '-3333.33'],
      [p2, '1/3', '77731.83', '79398.50', '-1666.67'],
    ]);
    const cents = (m: Money | null | undefined) => BigInt((m?.amount ?? '0').replace('.', ''));
    for (const column of ['actual', 'planned', 'difference'] as const) {
      expect(
        perProperty.items?.reduce((sum, i) => sum + cents(i[column]), 0n),
        column,
      ).toBe(cents(perProperty[column]));
    }
    // The payments of the year per property, each split by the set of its booking date, by largest remainder.
    const yearPayments = async () => {
      const payments = await json<{
        interest: Money;
        principal: Money;
        payments: number;
        items: { propertyReferenceId: string; interest: Money; principal: Money }[];
      }>(await A('GET', `${loan}/payments?year=2027&perProperty=true`), 200);
      expect(payments).toMatchObject({ interest: eur('1795.50'), principal: eur('6804.50'), payments: 4 });
      expect(Object.fromEntries(payments.items.map((i) => [i.propertyReferenceId, [i.interest.amount, i.principal.amount]]))).toEqual({
        [p1]: ['1197.00', '4536.33'],
        [p2]: ['598.50', '2268.17'],
      });
    };
    await yearPayments();
    // A lender statement is evidence, compared and never replacing the derived value.
    const { statementId, comparison } = await json<{ statementId: string; comparison: { actualOnDate: Money; difference: Money } }>(
      await A('POST', `${loan}/balance-statements`, { statementDate: '2027-03-31', balance: eur('233195.49'), source: 'Jahreskontoauszug 2027' }),
      201,
    );
    expect(comparison).toEqual({ actualOnDate: eur('233195.50'), difference: eur('-0.01') });
    expect(await debt(l1, 'asOf=2027-03-31')).toMatchObject({ actual: eur('233195.50'), latestStatement: { comparison: { difference: eur('-0.01') } } });
    // Never stored: no column of the schema holds a remaining debt; the statement's balance is evidence (ADR-016).
    const stored = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name ~ '(remaining|outstanding|debt)'`,
    );
    expect(stored.rows).toEqual([]);

    // The manual override from 2027-04-01, before L1 is closed (a CLOSED Loan takes no new set, §41.7).
    const manual = await json<{ allocationSetId: string }>(
      await A('POST', `${loan}/allocations`, {
        validFrom: '2027-04-01',
        basis: 'MANUAL',
        allocations: [
          { propertyReferenceId: p1, share: '1/2' },
          { propertyReferenceId: p2, share: '1/2' },
        ],
      }),
      201,
    );
    // The year's payments do not move: each split stays with the set of its booking date, not the year's last set.
    await yearPayments();
    // One Loan per property's history, never a Loan per property.
    const p1Loans = await json<{ items: { loanId: string; allocationSetId: string; share: string }[] }>(
      await A('GET', `/property-references/${p1}/loans`),
      200,
    );
    expect(p1Loans.items.map((i) => [i.loanId, i.allocationSetId, i.share])).toEqual([
      [l1, manual.allocationSetId, '1/2'],
      [l1, byPrice.allocationSetId, '2/3'],
    ]);
    expect((await json<{ total: number }>(await A('GET', '/loans'), 200)).total).toBe(1);

    // Refinancing: L2 at Neue Bank takes over 233,195.50; L1 is closed as REFINANCED on 2027-03-31.
    const l2 = (
      await json<{ loanId: string }>(
        await A('POST', '/loans', { lenderPartyId: bank2, borrowerPartyIds: [anna], principalOriginal: eur('233195.50'), startDate: '2027-04-01' }),
        201,
      )
    ).loanId;
    expect(await json(await A('POST', `${loan}/close`, { closingDate: '2027-03-31', reason: 'REFINANCED', refinancedByLoanId: l2 }), 200)).toMatchObject({
      status: 'CLOSED',
      closingDate: '2027-03-31',
      closingReason: 'REFINANCED',
      refinancedByLoanId: l2,
    });
    expect(await debt(l1, 'asOf=2027-04-01')).toMatchObject({
      principalPaid: eur('6804.50'),
      actual: eur('0.00'),
      planned: eur('0.00'),
      difference: eur('0.00'),
      closing: { closingDate: '2027-03-31', reason: 'REFINANCED', refinancedByLoanId: l2, actualOnClosingDate: eur('233195.50') },
    });
    const { transactionId: april } = await json<{ transactionId: string }>(
      await A('POST', '/transactions', {
        financialAccountId,
        amount: eur('1200.00'),
        direction: 'OUTFLOW',
        bookingDate: '2027-04-30',
        description: 'Rate April',
      }),
      201,
    );
    const afterClosing = await json<{ error: { details: unknown } }>(
      await A('PUT', `/transactions/${april}/splits`, { splits: [{ financialCategoryCode: 'LOAN_PRINCIPAL', loanId: l1, amount: eur('1200.00') }] }),
      409,
    );
    expect(afterClosing.error.details).toEqual({ reason: 'LOAN_CLOSED', loanId: l1, closingDate: '2027-03-31' });
    const successorVoid = await json<{ error: { details: unknown } }>(await A('POST', `/loans/${l2}/void`, { reason: 'x' }), 409);
    expect(successorVoid.error.details).toEqual({ reason: 'LOAN_REFINANCES', loanIds: [l1] });
    expect((await json<{ summary: { endReason: string; payments: number } }>(await A('GET', `${loan}/schedule`), 200)).summary).toMatchObject({
      endReason: 'CLOSED',
      payments: 3,
    });

    // Realm isolation: every Phase-3 route, given Realm A's ids, answers Realm B with 404 and writes nothing.
    const ids: Record<string, string> = { loanId: l1, termsId, allocationSetId: manual.allocationSetId, statementId, propertyReferenceId: p1 };
    type Row = { readonly expect: 404 | 'EMPTY_LIST'; readonly body?: unknown; readonly query?: string };
    const routes: Record<string, Row> = {
      'POST /loans': { expect: 404, body: { lenderPartyId: bank, borrowerPartyIds: [anna], principalOriginal: eur('1.00'), startDate: '2027-01-01' } },
      'GET /loans': { expect: 'EMPTY_LIST' },
      'GET /loans/:loanId': { expect: 404 },
      'POST /loans/:loanId/amend': { expect: 404, body: { notes: 'x' } },
      'POST /loans/:loanId/void': { expect: 404, body: { reason: 'x' } },
      'POST /loans/:loanId/close': { expect: 404, body: { closingDate: '2027-06-30', reason: 'OTHER', closingNote: 'x' } },
      'POST /loans/:loanId/terms': {
        expect: 404,
        body: { validFrom: '2027-06-01', interestRate: '1.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-06-30' },
      },
      'POST /loans/:loanId/terms/:termsId/void': { expect: 404, body: { reason: 'x' } },
      'GET /loans/:loanId/terms': { expect: 404 },
      'GET /loans/:loanId/schedule': { expect: 404 },
      'GET /loans/:loanId/payment-proposal': { expect: 404, query: `transactionId=${april}` },
      'POST /loans/:loanId/allocations': { expect: 404, body: { validFrom: '2027-06-01', allocations: [{ propertyReferenceId: p1, share: '1/1' }] } },
      'POST /loans/:loanId/allocations/:allocationSetId/void': { expect: 404, body: { reason: 'x' } },
      'GET /loans/:loanId/allocations': { expect: 404 },
      'GET /property-references/:propertyReferenceId/loans': { expect: 404 },
      'GET /loans/:loanId/remaining-debt': { expect: 404 },
      'GET /loans/:loanId/payments': { expect: 404, query: 'year=2027' },
      'POST /loans/:loanId/balance-statements': { expect: 404, body: { statementDate: '2027-03-31', balance: eur('1.00'), source: 'x' } },
      'POST /loans/:loanId/balance-statements/:statementId/void': { expect: 404, body: { reason: 'x' } },
      'GET /loans/:loanId/balance-statements': { expect: 404 },
    };
    // The table is the app's Phase-3 routes, no more and no fewer: a new route without a row turns this red.
    expect(Object.keys(routes).sort()).toEqual(
      routesOf(app)
        .filter((route) => PHASE_3.test(route))
        .sort(),
    );
    // "Writes nothing" is checked by the AuditRecord count: every write writes one.
    const auditBefore = (await pool.query(`SELECT count(*)::int AS n FROM audit_record`)).rows[0].n as number;
    for (const [route, row] of Object.entries(routes)) {
      const [method = '', template = ''] = route.split(' ');
      const path = template.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? `missing-${name}`) + (row.query === undefined ? '' : `?${row.query}`);
      const res = await call(REALM_B, method, path, row.body);
      if (row.expect === 404) {
        expect(res.status, route).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code, route).toBe('NOT_FOUND');
      } else {
        expect(await json(res, 200), route).toMatchObject({ items: [], total: 0 });
      }
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_record`)).rows[0].n).toBe(auditBefore);

    // Traceability: exactly these AuditRecords on the Loan aggregates, and the February correction.
    const audit = await pool.query<{ entity_type: string; entity_id: string; action: string; metadata: { settledAmount?: Money } }>(
      `SELECT entity_type, entity_id, action, metadata FROM audit_record WHERE entity_type IN ('Loan', 'LoanTerms', 'LoanAllocationSet', 'LoanBalanceStatement')`,
    );
    expect(audit.rows.map((r) => `${r.entity_type} ${r.entity_id} ${r.action}`).sort()).toEqual(
      [
        `Loan ${l1} CREATED`,
        `Loan ${l2} CREATED`,
        `Loan ${l1} CLOSED`,
        `LoanTerms ${termsId} CREATED`,
        `LoanAllocationSet ${byPrice.allocationSetId} CREATED`,
        `LoanAllocationSet ${manual.allocationSetId} CREATED`,
        `LoanBalanceStatement ${statementId} CREATED`,
      ].sort(),
    );
    expect(audit.rows.find((r) => r.action === 'CLOSED')?.metadata.settledAmount).toEqual(eur('233195.50'));
    const corrected = await pool.query(`SELECT action FROM audit_record WHERE entity_type = 'Transaction' AND entity_id = $1 AND action = 'CORRECTED'`, [
      february,
    ]);
    expect(corrected.rowCount).toBe(1);
  });
});

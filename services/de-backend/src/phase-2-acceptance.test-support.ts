import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';
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
 * The shared setup of the Phase-2 acceptance tests (ACC2, invariant-suite.md §15): one migrated schema and one fake MRE
 * per test file, the app wired as in main.ts behind a real HTTP server, and the request helpers. Test support only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

export const REALM_A = '64b0c0ffee0000000000000a';
export const REALM_B = '64b0c0ffee0000000000000b';
export const PROPERTY = '6512f0c2a1b2c3d4e5f60901';
/** VC-X-30 (§28.1A): an existing owner buying the other half. */
export const PROPERTY_X30 = '6512f0c2a1b2c3d4e5f60902';
export const TENANT = '6512f0c2a1b2c3d4e5f60a01';

/** The Phase-2 routes (api-design §19–§28) under `/api/v1`, as `METHOD /path/:param`; the anschaffungsnahe check is VC-7-03's (§58B). */
export const PHASE_2 =
  /^(?!.*\/anschaffungsnahe-herstellungskosten$)(?:[A-Z]+ \/(parties|ownerships|acquisitions)\b|[A-Z]+ \/property-references\/:propertyReferenceId\/(ownerships|ownership-changes|acquisitions)$)/;

/**
 * Every route the app serves, from Express' router stack, relative to its mount point. This reads Express 4
 * internals (`app._router.stack`); on Express 5 it finds no routes and the comparison below fails loudly, which
 * is the intended direction: adapt it then rather than let the table go unchecked.
 */
export function routesOf(app: Express): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle: { stack?: Layer[] } };
  const walk = (stack: readonly Layer[]): string[] =>
    stack.flatMap((layer) => {
      if (layer.route !== undefined) return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route?.path}`);
      return layer.name === 'router' && layer.handle.stack !== undefined ? walk(layer.handle.stack) : [];
    });
  return walk((app as unknown as { _router: { stack: Layer[] } })._router.stack);
}

export interface Phase2Context {
  pool: pg.Pool;
  mre: FakeMre;
  app: Express;
  server: Server;
  base: string;
}

/**
 * Registers the schema's, the fake MRE's and the server's `beforeAll`/`afterAll` in the calling `describe` and returns
 * the context (filled once `beforeAll` has run) with the request helpers bound to it.
 */
export function usePhase2App(name: `${string}_e2e`) {
  const schema = testSchemaName(name);
  const ctx = {} as Phase2Context;
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
          { _id: PROPERTY, name: 'Haus Lindenweg', surface: 180 },
          { _id: PROPERTY_X30, name: 'Wohnung Ahornstraße', surface: 72 },
        ],
        tenants: [{ _id: TENANT, name: 'Mia Mieter' }],
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
    Object.assign(ctx, { pool, mre, app, server, base });
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
  const cents = (money: { amount: string }) => BigInt(money.amount.replace('.', ''));

  return { ctx, headers, call, json, eur, cents };
}

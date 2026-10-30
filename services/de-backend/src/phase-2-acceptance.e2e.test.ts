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
  createLandBuildingAllocation,
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
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresPartyRepository,
  PostgresPartyExternalReferenceRepository,
  PostgresOwnershipRepository,
  PostgresAcquisitionCostRepository,
  PostgresLandBuildingAllocationRepository,
  PostgresLoanRepository,
  PostgresRentReconciliationRepository,
  PostgresSecurityDepositRepository,
  PostgresWegRepository,
  PostgresWegAnnualStatementRepository,
  PostgresWegEconomicPlanRepository,
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
 * VC-2-10: the Phase-2 exit of `docs/roadmap.md` as one acceptance run through the HTTP API (ACC2,
 * invariant-suite.md §15), wired as in main.ts: an acquisition with purchase price, transaction costs and a
 * land/building split drives the owner-level allocation; ownership changes over time are queryable; ownership shares
 * are validated; every Phase-2 route is Realm-isolated; every write leaves its AuditRecord.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000000a';
const REALM_B = '64b0c0ffee0000000000000b';
const PROPERTY = '6512f0c2a1b2c3d4e5f60901';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';

/** The Phase-2 routes (api-design §19–§28) under `/api/v1`, as `METHOD /path/:param`. */
const PHASE_2 =
  /^[A-Z]+ \/(parties|ownerships|acquisitions)\b|^[A-Z]+ \/property-references\/:propertyReferenceId\/(ownerships|ownership-changes|acquisitions)$/;

/**
 * Every route the app serves, from Express' router stack, relative to its mount point. This reads Express 4
 * internals (`app._router.stack`); on Express 5 it finds no routes and the comparison below fails loudly, which
 * is the intended direction: adapt it then rather than let the table go unchecked.
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

describe.skipIf(databaseUrl === undefined)('Phase 2 acceptance (roadmap exit)', () => {
  const schema = testSchemaName('phase_2_e2e');
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
        properties: [{ _id: PROPERTY, name: 'Haus Lindenweg', surface: 180 }],
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
      propertyReferences: { link: linkPropertyReference(propertyReferences), refresh: refreshPropertyReference(propertyReferences) },
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
      financialAccounts: { create: createFinancialAccount({ repository: accounts }), close: closeFinancialAccount({ repository: accounts }) },
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
  const cents = (money: { amount: string }) => BigInt(money.amount.replace('.', ''));

  it('runs the Phase-2 exit end to end: acquisition, owner-level allocation, ownership over time, validation, isolation, audit', async () => {
    const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);

    // The property and its parties: Sven sells to Anna and Ben; Carl comes later; the notary is a counterparty.
    const { propertyReferenceId } = await json<{ propertyReferenceId: string }>(
      await A('POST', '/property-references/link', { mreRealmId: REALM_A, mrePropertyId: PROPERTY }),
      201,
    );
    const party = async (displayName: string, partyType = 'PERSON') =>
      (await json<{ partyId: string }>(await A('POST', '/parties', { partyType, displayName }), 201)).partyId;
    const sven = await party('Sven Verkäufer');
    const anna = await party('Anna Käuferin');
    const ben = await party('Ben Käufer');
    const carl = await party('Carl Dritter');
    const notary = await party('Notariat Dr. Weber', 'ORGANIZATION');
    // The ownerPartyId tie-break: with 1/2 each, the odd cent of every column goes to the smaller id.
    const [first, second] = [anna, ben].sort() as [string, string];

    // Ownership over time, part 1: Sven holds 1/1 since 2020.
    const svens = await json<{ ownershipId: string }>(
      await A('POST', '/ownerships', { propertyReferenceId, ownerPartyId: sven, share: '1/1', validFrom: '2020-01-01' }),
      201,
    );

    // The acquisition draft: 300,000.00 for the whole property, transferred on 2026-08-01.
    const draft = await json<{ acquisitionId: string; status: string; transferDate: string; acquiredShare: string }>(
      await A(
        'POST',
        '/acquisitions',
        {
          propertyReferenceId,
          purchasePrice: eur('300000.00'),
          acquiredShare: '1/1',
          contractDate: '2026-06-15',
          economicTransferDate: '2026-08-01',
          buyerPartyIds: [anna, ben],
          sellerPartyIds: [sven],
        },
        { 'idempotency-key': 'acc2-acquisition' },
      ),
      201,
    );
    expect(draft).toMatchObject({ status: 'DRAFT', transferDate: '2026-08-01', acquiredShare: '1/1' });
    const acquisition = `/acquisitions/${draft.acquisitionId}`;

    // Share validation, part 1: neither the allocation nor the confirmation runs on a draft without its Ownerships.
    const incomplete = await json<{ error: { details: { reason: string; violations: { code: string }[] } } }>(
      await A('GET', `${acquisition}/owner-allocation`),
      409,
    );
    expect(incomplete.error.details.reason).toBe('OWNERSHIP_BASIS_INCOMPLETE');
    const blocked = await json<{ error: { code: string; details: { violations: { code: string }[] } } }>(await A('POST', `${acquisition}/confirm`, {}), 422);
    expect(blocked.error.code).toBe('CONFIRMATION_BLOCKED');
    expect(blocked.error.details.violations).toEqual([
      // Buyers in id order.
      { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: first },
      { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: second },
      { code: 'SHARE_SUM_MISMATCH', expected: '1/1', actual: '0/1' },
    ]);
    expect(incomplete.error.details.violations).toEqual(blocked.error.details.violations);

    // Transaction costs: the transfer tax, an odd notary amount, a wrong broker fee voided and entered again.
    const cost = async (category: string, amount: string, extra: Record<string, unknown> = {}) =>
      (
        await json<{ costId: string }>(
          await A('POST', `${acquisition}/costs`, { category, amount: eur(amount), ...extra }, { 'idempotency-key': `acc2-${category}-${amount}` }),
          201,
        )
      ).costId;
    const tax = await cost('REAL_ESTATE_TRANSFER_TAX', '18000.00', { incurredDate: '2026-07-01' });
    const notaryFee = await cost('NOTARY', '1234.57', { counterpartyPartyId: notary });
    const wrongBroker = await cost('BROKER', '10000.00');
    expect(await json(await A('POST', `${acquisition}/costs/${wrongBroker}/void`, { reason: 'Courtage falsch erfasst' }), 200)).toMatchObject({
      status: 'VOID',
    });
    const broker = await cost('BROKER', '10710.00');

    // A confirmed bank Transaction pays the price and the tax; the rest of the costs stay expected.
    const { financialAccountId } = await json<{ financialAccountId: string }>(
      await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Anderkonto', currency: 'EUR' }),
      201,
    );
    const { transactionId } = await json<{ transactionId: string }>(
      await A('POST', '/transactions', {
        financialAccountId,
        amount: eur('318000.00'),
        direction: 'OUTFLOW',
        bookingDate: '2026-07-30',
        description: 'Kaufpreis und Grunderwerbsteuer',
      }),
      201,
    );
    await json(
      await A('PUT', `/transactions/${transactionId}/splits`, {
        splits: [{ amount: eur('318000.00'), financialCategoryCode: 'ACQUISITION', propertyReferenceId }],
      }),
      200,
    );
    await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
    const pricePayment = await json<{ paymentId: string; counting: boolean }>(
      await A('POST', `${acquisition}/payments`, { transactionId, amount: eur('300000.00') }, { 'idempotency-key': 'acc2-pay-price' }),
      201,
    );
    expect(pricePayment.counting).toBe(true);
    await json(
      await A('POST', `${acquisition}/payments`, { transactionId, acquisitionCostId: tax, amount: eur('18000.00') }, { 'idempotency-key': 'acc2-pay-tax' }),
      201,
    );
    // The Transaction is used up: one cent more is refused.
    const exceeding = await json<{ error: { details: { reason: string } } }>(
      await A('POST', `${acquisition}/payments`, { transactionId, acquisitionCostId: notaryFee, amount: eur('0.01') }),
      409,
    );
    expect(exceeding.error.details.reason).toBe('PAYMENT_EXCEEDS_TRANSACTION');
    expect(await json(await A('GET', `${acquisition}/payments`), 200)).toMatchObject({
      purchasePrice: { amount: eur('300000.00'), paidAmount: eur('300000.00'), paymentStatus: 'PAID' },
      items: [{}, {}],
    });
    const costs = await json<{ items: { costId: string; status: string; paymentStatus: string | null }[] }>(await A('GET', `${acquisition}/costs`), 200);
    expect(costs.items.map((c) => [c.costId, c.status, c.paymentStatus])).toEqual([
      [tax, 'ACTIVE', 'PAID'],
      [notaryFee, 'ACTIVE', 'EXPECTED'],
      [wrongBroker, 'VOID', null],
      [broker, 'ACTIVE', 'EXPECTED'],
    ]);

    // The land/building split: entered from the contract, then corrected with the BMF tool (supersede).
    const allocation = (body: Record<string, unknown>, key: string) =>
      A('POST', `${acquisition}/land-building-allocation`, { reviewState: 'UNREVIEWED', ...body }, { 'idempotency-key': key });
    const entered = await json<{ allocationId: string }>(
      await allocation(
        {
          totalAllocableAmount: eur('300000.00'),
          landAmount: eur('60000.00'),
          buildingAmount: eur('240000.00'),
          method: 'PURCHASE_CONTRACT',
          supersedes: null,
        },
        'acc2-alloc-1',
      ),
      201,
    );
    const corrected = await json<{ allocationId: string; current: boolean }>(
      await allocation(
        {
          totalAllocableAmount: eur('329944.57'),
          landAmount: eur('82486.15'),
          buildingAmount: eur('247458.42'),
          method: 'BMF_TOOL',
          supersedes: entered.allocationId,
        },
        'acc2-alloc-2',
      ),
      201,
    );
    expect(corrected.current).toBe(true);
    // A second correction naming the old one is refused: it is no longer current.
    expect(
      (
        await allocation(
          { totalAllocableAmount: eur('1.00'), landAmount: eur('0.00'), buildingAmount: eur('1.00'), method: 'OTHER', supersedes: entered.allocationId },
          'acc2-alloc-x',
        )
      ).status,
    ).toBe(409);
    const history = await json<{ current: { allocationId: string }; items: { allocationId: string; current: boolean; supersededById: string | null }[] }>(
      await A('GET', `${acquisition}/land-building-allocations`),
      200,
    );
    expect(history.current.allocationId).toBe(corrected.allocationId);
    expect(history.items.map((a) => [a.allocationId, a.current, a.supersededById])).toEqual([
      [corrected.allocationId, true, null],
      [entered.allocationId, false, corrected.allocationId],
    ]);

    // Ownership over time, part 2: one atomic change on the transfer date (WF-002).
    const change = await json<{
      closed: { ownershipId: string; validUntil: string }[];
      created: { ownershipId: string; ownerPartyId: string; share: string; acquisitionId: string }[];
      completeness: string;
    }>(
      await A(
        'POST',
        `/property-references/${propertyReferenceId}/ownership-changes`,
        {
          effectiveDate: '2026-08-01',
          reason: 'Verkauf an Anna und Ben',
          close: [svens.ownershipId],
          create: [
            { ownerPartyId: anna, share: '1/2' },
            { ownerPartyId: ben, share: '1/2' },
          ],
          acquisitionId: draft.acquisitionId,
        },
        { 'idempotency-key': 'acc2-change' },
      ),
      201,
    );
    expect(change.closed).toEqual([expect.objectContaining({ ownershipId: svens.ownershipId, validUntil: '2026-07-31' })]);
    expect(change.created.map((o) => [o.ownerPartyId, o.share, o.acquisitionId])).toEqual(
      expect.arrayContaining([
        [anna, '1/2', draft.acquisitionId],
        [ben, '1/2', draft.acquisitionId],
      ]),
    );
    expect(change.completeness).toBe('COMPLETE');
    const annas = change.created.find((o) => o.ownerPartyId === anna)?.ownershipId ?? '';

    // Share validation, part 2: a third half on the transfer date would sum to 3/2; nothing is written.
    const ownershipsBefore = await pool.query(`SELECT count(*) FROM ownership`);
    const overShare = await json<{ error: { code: string; details: unknown } }>(
      await A('POST', '/ownerships', { propertyReferenceId, ownerPartyId: carl, share: '1/2', validFrom: '2026-08-01' }),
      422,
    );
    expect(overShare.error).toMatchObject({ code: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', details: { date: '2026-08-01', shareSum: '3/2' } });
    expect((await pool.query(`SELECT count(*) FROM ownership`)).rows).toEqual(ownershipsBefore.rows);

    // With its structure in place the draft previews as PROVISIONAL; then it is confirmed, once.
    expect(await json(await A('GET', `${acquisition}/owner-allocation`), 200)).toMatchObject({ basis: 'PROVISIONAL' });
    expect(await json(await A('POST', `${acquisition}/confirm`, {}), 200)).toMatchObject({ status: 'CONFIRMED', version: 2 });
    const again = await A('POST', `${acquisition}/confirm`, {});
    expect(again.status).toBe(200);
    expect(again.headers.get('idempotent-replayed')).toBe('true');

    // It drives the owner-level allocation: 1/2 each, every column exact to the cent, the odd cent by ownerPartyId.
    type Money = { amount: string; currency: string };
    type Part = {
      ownerPartyId: string;
      ownershipId: string;
      share: string;
      weight: string;
      purchasePrice: Money;
      costs: Record<string, Money>;
      costsTotal: Money;
      landAmount: Money;
      buildingAmount: Money;
      totalAllocableAmount: Money;
    };
    const split = await json<{ basis: string; allocationId: string; owners: Part[]; totals: Omit<Part, 'ownerPartyId' | 'ownershipId' | 'share' | 'weight'> }>(
      await A('GET', `${acquisition}/owner-allocation`),
      200,
    );
    expect(split).toMatchObject({ basis: 'CONFIRMED', allocationId: corrected.allocationId });
    const expected = (owner: string, odd: boolean) => ({
      ownerPartyId: owner,
      ownershipId: change.created.find((o) => o.ownerPartyId === owner)?.ownershipId,
      share: '1/2',
      weight: '1/2',
      purchasePrice: eur('150000.00'),
      costs: { BROKER: eur('5355.00'), NOTARY: eur(odd ? '617.29' : '617.28'), REAL_ESTATE_TRANSFER_TAX: eur('9000.00') },
      costsTotal: eur(odd ? '14972.29' : '14972.28'),
      landAmount: eur(odd ? '41243.08' : '41243.07'),
      buildingAmount: eur('123729.21'),
      totalAllocableAmount: eur(odd ? '164972.29' : '164972.28'),
    });
    expect(split.owners).toEqual([expected(first, true), expected(second, false)]);
    expect(split.totals).toEqual({
      purchasePrice: eur('300000.00'),
      costs: { BROKER: eur('10710.00'), NOTARY: eur('1234.57'), REAL_ESTATE_TRANSFER_TAX: eur('18000.00') },
      costsTotal: eur('29944.57'),
      landAmount: eur('82486.15'),
      buildingAmount: eur('247458.42'),
      totalAllocableAmount: eur('329944.57'),
    });
    // Every column sums exactly to its total; each owner's totals are the sum of their parts (F4b).
    const sum = (values: Money[]) => values.reduce((s, m) => s + cents(m), 0n);
    for (const column of ['purchasePrice', 'costsTotal', 'landAmount', 'buildingAmount', 'totalAllocableAmount'] as const) {
      expect(sum(split.owners.map((o) => o[column])), column).toBe(cents(split.totals[column]));
    }
    for (const category of Object.keys(split.totals.costs)) {
      expect(sum(split.owners.map((o) => o.costs[category] as Money)), category).toBe(cents(split.totals.costs[category] as Money));
    }
    for (const o of split.owners) {
      expect(sum(Object.values(o.costs))).toBe(cents(o.costsTotal));
      expect(cents(o.landAmount) + cents(o.buildingAmount)).toBe(cents(o.totalAllocableAmount));
    }

    // Ownership over time, part 3: queryable before, on and after the transfer date, and as a history.
    const owners = async (asOf: string) => {
      const day = await json<{ completeness: string; shareSum: string; items: { ownerPartyId: string; share: string }[] }>(
        await A('GET', `/property-references/${propertyReferenceId}/ownerships?asOf=${asOf}`),
        200,
      );
      return { completeness: day.completeness, shareSum: day.shareSum, owners: day.items.map((o) => `${o.ownerPartyId}:${o.share}`).sort() };
    };
    expect(await owners('2026-07-31')).toEqual({ completeness: 'COMPLETE', shareSum: '1/1', owners: [`${sven}:1/1`] });
    expect(await owners('2026-08-01')).toEqual({ completeness: 'COMPLETE', shareSum: '1/1', owners: [`${anna}:1/2`, `${ben}:1/2`].sort() });
    expect(await owners('2030-01-01')).toEqual({ completeness: 'COMPLETE', shareSum: '1/1', owners: [`${anna}:1/2`, `${ben}:1/2`].sort() });
    expect(await owners('2019-12-31')).toEqual({ completeness: 'NONE', shareSum: '0/1', owners: [] });
    const all = await json<{ items: { ownerPartyId: string; validFrom: string; validUntil: string | null; status: string }[]; total: number }>(
      await A('GET', `/property-references/${propertyReferenceId}/ownerships`),
      200,
    );
    expect(all.total).toBe(3);
    expect(all.items.map((o) => `${o.ownerPartyId} ${o.validFrom}..${o.validUntil ?? ''} ${o.status}`).sort()).toEqual(
      [`${sven} 2020-01-01..2026-07-31 VALID`, `${anna} 2026-08-01.. VALID`, `${ben} 2026-08-01.. VALID`].sort(),
    );

    // Share validation, part 3: the confirmed purchase is final; its Ownerships cannot be voided, the Acquisition not cancelled.
    const voided = await json<{ error: { details: unknown } }>(await A('POST', `/ownerships/${annas}/void`, { reason: 'Versehen' }), 409);
    expect(voided.error.details).toMatchObject({ reason: 'ACQUISITION_CONFIRMED', acquisitionId: draft.acquisitionId });
    const cancelled = await json<{ error: { details: unknown } }>(await A('POST', `${acquisition}/cancel`, { reason: 'x' }), 409);
    expect(cancelled.error.details).toMatchObject({ reason: 'ACQUISITION_CONFIRMED' });

    // Realm isolation: every Phase-2 route, given Realm A's ids, answers Realm B with 404 and writes nothing.
    const { externalReferenceId } = await json<{ externalReferenceId: string }>(
      await A('POST', `/parties/${anna}/external-references`, { system: 'MRE', entityType: 'tenant', mreRealmId: REALM_A, externalId: TENANT }),
      201,
    );
    const ids: Record<string, string> = {
      partyId: anna,
      externalReferenceId,
      ownershipId: annas,
      propertyReferenceId,
      acquisitionId: draft.acquisitionId,
      costId: notaryFee,
      paymentId: pricePayment.paymentId,
    };
    type Row = { readonly expect: 404 | 'EMPTY_LIST' | 'OWN_REALM'; readonly body?: unknown };
    const routes: Record<string, Row> = {
      'POST /parties': { expect: 'OWN_REALM', body: { partyType: 'PERSON', displayName: 'Bea aus B' } },
      'GET /parties': { expect: 'EMPTY_LIST' },
      'GET /parties/:partyId': { expect: 404 },
      'POST /parties/:partyId/amend': { expect: 404, body: { phone: '0171' } },
      'POST /parties/:partyId/deactivate': { expect: 404, body: { reason: 'x' } },
      'POST /parties/:partyId/external-references': { expect: 404, body: { system: 'MRE', entityType: 'tenant', mreRealmId: REALM_B, externalId: TENANT } },
      'POST /parties/:partyId/external-references/:externalReferenceId/end': { expect: 404 },
      'GET /parties/:partyId/external-references': { expect: 404 },
      'POST /ownerships': { expect: 404, body: { propertyReferenceId, ownerPartyId: carl, share: '1/2', validFrom: '2031-01-01' } },
      'GET /ownerships/:ownershipId': { expect: 404 },
      'POST /ownerships/:ownershipId/close': { expect: 404, body: { validUntil: '2030-12-31' } },
      'POST /ownerships/:ownershipId/void': { expect: 404, body: { reason: 'x' } },
      'POST /property-references/:propertyReferenceId/ownership-changes': {
        expect: 404,
        body: { effectiveDate: '2031-01-01', reason: 'x', close: [annas], create: [{ ownerPartyId: carl, share: '1/2' }] },
      },
      'GET /property-references/:propertyReferenceId/ownerships': { expect: 404 },
      'POST /acquisitions': {
        expect: 404,
        body: { propertyReferenceId, purchasePrice: eur('1.00'), contractDate: '2031-01-01', buyerPartyIds: [carl] },
      },
      'GET /acquisitions': { expect: 'EMPTY_LIST' },
      'GET /acquisitions/:acquisitionId': { expect: 404 },
      'POST /acquisitions/:acquisitionId/cancel': { expect: 404, body: { reason: 'x' } },
      'POST /acquisitions/:acquisitionId/confirm': { expect: 404, body: {} },
      'GET /property-references/:propertyReferenceId/acquisitions': { expect: 404 },
      'GET /acquisitions/:acquisitionId/owner-allocation': { expect: 404 },
      'POST /acquisitions/:acquisitionId/land-building-allocation': {
        expect: 404,
        body: { totalAllocableAmount: eur('1.00'), landAmount: eur('0.00'), buildingAmount: eur('1.00'), method: 'OTHER', supersedes: corrected.allocationId },
      },
      'GET /acquisitions/:acquisitionId/land-building-allocations': { expect: 404 },
      'POST /acquisitions/:acquisitionId/costs': { expect: 404, body: { category: 'OTHER', amount: eur('1.00') } },
      'POST /acquisitions/:acquisitionId/costs/:costId/void': { expect: 404, body: { reason: 'x' } },
      'GET /acquisitions/:acquisitionId/costs': { expect: 404 },
      'POST /acquisitions/:acquisitionId/payments': { expect: 404, body: { transactionId, acquisitionCostId: notaryFee, amount: eur('1.00') } },
      'POST /acquisitions/:acquisitionId/payments/:paymentId/unlink': { expect: 404, body: { reason: 'x' } },
      'GET /acquisitions/:acquisitionId/payments': { expect: 404 },
    };
    // The table is the app's Phase-2 routes, no more and no fewer: a new route without a row turns this red.
    expect(Object.keys(routes).sort()).toEqual(
      routesOf(app)
        .filter((route) => PHASE_2.test(route))
        .sort(),
    );

    // "Writes nothing" is checked by the AuditRecord count: every write writes one (P2-D11), so a write slipping
    // through for Realm B would raise it.
    const auditBefore = await pool.query(`SELECT count(*) FROM audit_record`);
    const own: string[] = [];
    // Creating rows last, so Realm B's own lists are still empty when read.
    const ordered = Object.entries(routes).sort(([, x], [, y]) => Number(x.expect === 'OWN_REALM') - Number(y.expect === 'OWN_REALM'));
    for (const [route, row] of ordered) {
      const [method = '', template = ''] = route.split(' ');
      const path = template.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? `missing-${name}`);
      const res = await call(REALM_B, method, path, row.body);
      if (row.expect === 404) {
        expect(res.status, route).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code, route).toBe('NOT_FOUND');
      } else if (row.expect === 'EMPTY_LIST') {
        expect(await json(res, 200), route).toMatchObject({ items: [], total: 0 });
      } else {
        // Takes no id: what it creates belongs to Realm B, and Realm A cannot see it.
        own.push((await json<{ partyId: string }>(res, 201)).partyId);
      }
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_record`)).rows[0].n).toBe(Number(auditBefore.rows[0].count) + own.length);
    for (const partyId of own) expect((await A('GET', `/parties/${partyId}`)).status).toBe(404);

    // After confirmation a later sale still ends Anna's Ownership: close is allowed.
    expect(await json(await A('POST', `/ownerships/${annas}/close`, { validUntil: '2030-12-31' }), 200)).toMatchObject({
      validUntil: '2030-12-31',
      status: 'VALID',
    });

    // Traceability: every Phase-2 write of the acquisition left its AuditRecord.
    const audit = await pool.query<{ entity_type: string; entity_id: string; action: string }>(
      `SELECT entity_type, entity_id, action FROM audit_record
       WHERE entity_type IN ('Acquisition', 'AcquisitionCost', 'AcquisitionPayment', 'LandBuildingAllocation')`,
    );
    const key = (r: { entity_type: string; entity_id: string; action: string }) => `${r.entity_type} ${r.entity_id} ${r.action}`;
    const taxPayment = (
      await json<{ items: { paymentId: string; acquisitionCostId: string | null }[] }>(await A('GET', `${acquisition}/payments`), 200)
    ).items.find((p) => p.acquisitionCostId === tax)?.paymentId;
    expect(audit.rows.map(key).sort()).toEqual(
      [
        `Acquisition ${draft.acquisitionId} CREATED`,
        `Acquisition ${draft.acquisitionId} CONFIRMED`,
        `AcquisitionCost ${tax} CREATED`,
        `AcquisitionCost ${notaryFee} CREATED`,
        `AcquisitionCost ${wrongBroker} CREATED`,
        `AcquisitionCost ${wrongBroker} VOIDED`,
        `AcquisitionCost ${broker} CREATED`,
        `AcquisitionPayment ${pricePayment.paymentId} LINKED`,
        `AcquisitionPayment ${taxPayment} LINKED`,
        `LandBuildingAllocation ${entered.allocationId} CREATED`,
        `LandBuildingAllocation ${entered.allocationId} SUPERSEDED`,
        `LandBuildingAllocation ${corrected.allocationId} CREATED`,
      ].sort(),
    );
  });
});

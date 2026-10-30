import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * VC-1-09: the Slice-1 definition of done (project-brief.md §7) as one
 * acceptance run through the HTTP API, wired as in main.ts: link an MRE
 * property, create a financial account, import a bank CSV twice without
 * duplicates, split a transaction so totals reconcile and confirm it — all
 * Realm-isolated, all money exact, all records traceable to their source.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000000a';
const REALM_B = '64b0c0ffee0000000000000b';
const PROPERTY = '6512f0c2a1b2c3d4e5f60901';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';

const september = ['Buchungstag;Betrag;Verwendungszweck', '01.09.2026;1.250,00;Miete September', '02.09.2026;-310,40;Hausgeld'].join('\r\n');
const reordered = ['Buchungstag;Betrag;Verwendungszweck', '02.09.2026;-310,40;Hausgeld', '01.09.2026;1.250,00;Miete September'].join('\r\n');

describe.skipIf(databaseUrl === undefined)('Slice 1 acceptance (definition of done)', () => {
  const schema = testSchemaName('slice_1_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
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
        properties: [{ _id: PROPERTY, name: 'Wohnung 1', surface: 64.5 }],
        tenants: [{ _id: TENANT, name: 'Anna Schmidt' }],
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
    server = createApp({
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
    }).listen(0, '127.0.0.1');
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
    form.append('file', new Blob([file]), 'umsatz.csv');
    return fetch(`${base}/api/v1/imports/bank-transactions`, { method: 'POST', headers: headers(realm), body: form });
  };
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const eur = (amount: string) => ({ amount, currency: 'EUR' });

  it('links, imports twice without duplicates, splits exactly, confirms — isolated, exact and traceable', async () => {
    // 1. Link the MRE property.
    const property = await json<{ propertyReferenceId: string }>(
      await call(REALM_A, 'POST', '/property-references/link', { mreRealmId: REALM_A, mrePropertyId: PROPERTY }),
      201,
    );

    // 2. Create the bank account.
    const account = await json<{ financialAccountId: string }>(
      await call(REALM_A, 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Mietkonto', currency: 'EUR' }),
      201,
    );

    // 3. Import the September statement twice: two Transactions, then two duplicates.
    const first = await json<{ importBatchId: string; transactionCount: number; rows: { outcome: string; transactionId?: string }[] }>(
      await upload(REALM_A, account.financialAccountId, september),
      201,
    );
    expect(first.transactionCount).toBe(2);
    const second = await json<{ transactionCount: number; duplicateCount: number }>(await upload(REALM_A, account.financialAccountId, september), 201);
    expect(second).toMatchObject({ transactionCount: 0, duplicateCount: 2 });
    const rentId = first.rows[0]?.transactionId ?? '';

    // 4. Split the rent so the totals reconcile exactly; a cent off is refused.
    const rentSplits = [
      { amount: eur('1000.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: property.propertyReferenceId },
      { amount: eur('250.00'), financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', propertyReferenceId: property.propertyReferenceId },
    ];
    const offByOneCent = await call(REALM_A, 'PUT', `/transactions/${rentId}/splits`, {
      splits: [rentSplits[0], { ...rentSplits[1], amount: eur('249.99') }],
    });
    expect(offByOneCent.status).toBe(409);
    expect(await json(await call(REALM_A, 'PUT', `/transactions/${rentId}/splits`, { splits: rentSplits }), 200)).toMatchObject({
      status: 'CLASSIFIED',
    });

    // 5. Confirm; afterwards the classification is frozen.
    expect(await json(await call(REALM_A, 'POST', `/transactions/${rentId}/confirm`), 200)).toMatchObject({
      status: 'CONFIRMED',
      amount: eur('1250.00'),
      direction: 'INFLOW',
    });
    expect(
      (
        await call(REALM_A, 'PUT', `/transactions/${rentId}/splits`, {
          splits: [{ amount: eur('1250.00'), financialCategoryCode: 'OTHER' }],
        })
      ).status,
    ).toBe(409);

    // Exact money: stored as written, never rounded; over-precise or float input refused.
    const stored = await pool.query(`SELECT amount::text, direction, status FROM ledger_transaction WHERE id = $1`, [rentId]);
    expect(stored.rows).toEqual([{ amount: '1250.00', direction: 'INFLOW', status: 'CONFIRMED' }]);
    const splits = await pool.query(`SELECT amount::text FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [rentId]);
    expect(splits.rows).toEqual([{ amount: '1000.00' }, { amount: '250.00' }]);
    for (const amount of [eur('1.005'), { amount: 1.5, currency: 'EUR' }, { amount: '-1.00', currency: 'EUR' }]) {
      const res = await call(REALM_A, 'POST', '/transactions', {
        financialAccountId: account.financialAccountId,
        amount,
        direction: 'INFLOW',
        bookingDate: '2026-09-01',
      });
      expect(res.status, JSON.stringify(amount)).toBe(400);
    }

    // Traceable: the confirmed Transaction leads back to its import, file row and every step's AuditRecord.
    const source = await pool.query(
      `SELECT import_batch_id, provenance, adapter_id, adapter_version, source_row_key, confirmed_by FROM ledger_transaction WHERE id = $1`,
      [rentId],
    );
    expect(source.rows).toEqual([
      {
        import_batch_id: first.importBatchId,
        provenance: 'BANK_CSV',
        adapter_id: 'generic-csv',
        adapter_version: '1',
        source_row_key: 'pos:1',
        confirmed_by: 'anna@example.com',
      },
    ]);
    const audit = await pool.query(`SELECT entity_type, action FROM audit_record ORDER BY occurred_at, new_version`);
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        { entity_type: 'PropertyReference', action: expect.any(String) },
        { entity_type: 'FinancialAccount', action: 'CREATED' },
        { entity_type: 'ImportBatch', action: 'IMPORTED' },
        { entity_type: 'Transaction', action: 'SPLITS_REPLACED' },
        { entity_type: 'Transaction', action: 'CONFIRMED' },
      ]),
    );

    // Realm isolation: every endpoint, given Realm A's ids, answers Realm B with 404 and changes nothing.
    const review = await json<{ importBatchId: string }>(await upload(REALM_A, account.financialAccountId, reordered), 201);
    const items = await json<{ items: { reviewItemId: string }[] }>(await call(REALM_A, 'GET', `/imports/${review.importBatchId}/review-items`), 200);
    const itemId = items.items[0]?.reviewItemId ?? '';
    // A Party of Realm A (VC-2-01), for the isolation checks below.
    const owner = await json<{ partyId: string }>(
      await call(REALM_A, 'POST', '/parties', { partyType: 'PERSON', displayName: 'Anna Schmidt', firstName: 'Anna', lastName: 'Schmidt' }),
      201,
    );
    // Linked to Realm A's MRE Tenant (VC-2-02): created once, a repeat is the same reference.
    const tenantRef = { system: 'MRE', entityType: 'tenant', mreRealmId: REALM_A, externalId: TENANT };
    const reference = await json<{ externalReferenceId: string; status: string }>(
      await call(REALM_A, 'POST', `/parties/${owner.partyId}/external-references`, tenantRef),
      201,
    );
    expect(reference.status).toBe('ACTIVE');
    // A valid id MRE does not list in the Realm (which has Tenants) is 404, and nothing is written (§20.1).
    const unknownTenant = await call(REALM_A, 'POST', `/parties/${owner.partyId}/external-references`, {
      ...tenantRef,
      externalId: '6512f0c2a1b2c3d4e5f60aff',
    });
    expect(unknownTenant.status).toBe(404);
    expect(await unknownTenant.json()).toMatchObject({ error: { code: 'NOT_FOUND', details: { externalId: '6512f0c2a1b2c3d4e5f60aff' } } });
    expect(await json(await call(REALM_A, 'POST', `/parties/${owner.partyId}/external-references`, tenantRef), 200)).toMatchObject({
      externalReferenceId: reference.externalReferenceId,
    });
    // Ownership of the linked property (VC-2-03): Anna and Ben hold 1/2 each, exactly complete; a third share is refused.
    const ben = await json<{ partyId: string }>(await call(REALM_A, 'POST', '/parties', { partyType: 'PERSON', displayName: 'Ben Keller' }), 201);
    const half = (partyId: string) => ({ propertyReferenceId: property.propertyReferenceId, ownerPartyId: partyId, share: '2/4', validFrom: '2026-08-01' });
    const annasHalf = await json<{ ownershipId: string; share: string }>(
      await call(REALM_A, 'POST', '/ownerships', half(owner.partyId), { 'idempotency-key': 'own-anna' }),
      201,
    );
    expect(annasHalf.share).toBe('1/2');
    const bensHalf = await json<{ ownershipId: string }>(await call(REALM_A, 'POST', '/ownerships', half(ben.partyId)), 201);
    // A retry with the key replays; Anna's second half overlaps her first.
    expect((await call(REALM_A, 'POST', '/ownerships', half(owner.partyId), { 'idempotency-key': 'own-anna' })).headers.get('idempotent-replayed')).toBe(
      'true',
    );
    const overlapping = await call(REALM_A, 'POST', '/ownerships', { ...half(owner.partyId), validFrom: '2027-01-01' });
    expect(overlapping.status).toBe(422);
    expect(await overlapping.json()).toMatchObject({ error: { code: 'OVERLAPPING_OWNERSHIP', details: { ownershipId: annasHalf.ownershipId } } });
    expect(await json(await call(REALM_A, 'GET', `/property-references/${property.propertyReferenceId}/ownerships?asOf=2026-09-01`), 200)).toMatchObject({
      completeness: 'COMPLETE',
      shareSum: '1/1',
      items: [{}, {}],
    });
    // Ben sells his half to Carl from 2031 (VC-2-04): one atomic change, complete before and after.
    const carl = await json<{ partyId: string }>(await call(REALM_A, 'POST', '/parties', { partyType: 'PERSON', displayName: 'Carl Neu' }), 201);
    const sale = {
      effectiveDate: '2031-01-01',
      reason: 'Verkauf an Carl',
      close: [bensHalf.ownershipId],
      create: [{ ownerPartyId: carl.partyId, share: '1/2' }],
    };
    expect(
      await json(
        await call(REALM_A, 'POST', `/property-references/${property.propertyReferenceId}/ownership-changes`, sale, { 'idempotency-key': 'sale-1' }),
        201,
      ),
    ).toMatchObject({
      closed: [{ ownershipId: bensHalf.ownershipId, validUntil: '2030-12-31' }],
      created: [{ ownerPartyId: carl.partyId, validFrom: '2031-01-01' }],
      completeness: 'COMPLETE',
      shareSum: '1/1',
    });
    const owners = async (asOf: string) =>
      (
        await json<{ items: { ownerPartyId: string }[] }>(
          await call(REALM_A, 'GET', `/property-references/${property.propertyReferenceId}/ownerships?asOf=${asOf}`),
          200,
        )
      ).items
        .map((o) => o.ownerPartyId)
        .sort();
    expect(await owners('2030-12-31')).toEqual([owner.partyId, ben.partyId].sort());
    expect(await owners('2031-01-01')).toEqual([owner.partyId, carl.partyId].sort());
    // The purchase behind Carl's half as an Acquisition draft (VC-2-05): read, listed on the property, then cancelled.
    const purchase = {
      propertyReferenceId: property.propertyReferenceId,
      purchasePrice: { amount: '175000.00', currency: 'EUR' },
      acquiredShare: '1/2',
      contractDate: '2030-11-01',
      economicTransferDate: '2031-01-01',
      buyerPartyIds: [carl.partyId],
      sellerPartyIds: [ben.partyId],
    };
    const draftPurchase = await json<{ acquisitionId: string; transferDate: string; status: string }>(
      await call(REALM_A, 'POST', '/acquisitions', purchase, { 'idempotency-key': 'acq-carl' }),
      201,
    );
    expect(draftPurchase).toMatchObject({ status: 'DRAFT', transferDate: '2031-01-01' });
    expect(await json(await call(REALM_A, 'GET', `/property-references/${property.propertyReferenceId}/acquisitions`), 200)).toMatchObject({
      items: [{ acquisitionId: draftPurchase.acquisitionId }],
      total: 1,
    });
    const before = await pool.query(`SELECT count(*) FROM audit_record`);
    const fromB: [string, string, unknown?][] = [
      ['GET', `/parties/${owner.partyId}`],
      ['POST', `/parties/${owner.partyId}/amend`, { phone: '0171' }],
      ['POST', `/parties/${owner.partyId}/deactivate`, { reason: 'x' }],
      ['POST', `/parties/${owner.partyId}/external-references`, { ...tenantRef, mreRealmId: REALM_B }],
      ['POST', `/parties/${owner.partyId}/external-references/${reference.externalReferenceId}/end`],
      ['GET', `/parties/${owner.partyId}/external-references`],
      ['GET', `/ownerships/${annasHalf.ownershipId}`],
      ['POST', `/ownerships/${annasHalf.ownershipId}/close`, { validUntil: '2030-12-31' }],
      ['POST', `/ownerships/${annasHalf.ownershipId}/void`, { reason: 'x' }],
      ['GET', `/property-references/${property.propertyReferenceId}/ownerships`],
      ['GET', `/property-references/${property.propertyReferenceId}/ownerships?asOf=2026-09-01`],
      ['POST', '/ownerships', half(owner.partyId)],
      ['POST', `/property-references/${property.propertyReferenceId}/ownership-changes`, sale],
      ['POST', '/acquisitions', { ...purchase, buyerPartyIds: [owner.partyId] }],
      ['GET', `/acquisitions/${draftPurchase.acquisitionId}`],
      ['POST', `/acquisitions/${draftPurchase.acquisitionId}/cancel`, { reason: 'x' }],
      ['GET', `/property-references/${property.propertyReferenceId}/acquisitions`],
      ['POST', `/property-references/${property.propertyReferenceId}/refresh`],
      ['POST', `/financial-accounts/${account.financialAccountId}/close`],
      ['POST', '/transactions', { financialAccountId: account.financialAccountId, amount: eur('1.00'), direction: 'INFLOW', bookingDate: '2026-09-01' }],
      ['PUT', `/transactions/${rentId}/splits`, { splits: rentSplits }],
      ['POST', `/transactions/${rentId}/confirm`],
      ['POST', `/transactions/${rentId}/correct`, { reason: 'x', replacement: { bookingDate: '2026-09-03' } }],
      ['POST', `/transactions/${rentId}/amend`, { description: 'x' }],
      ['POST', `/transactions/${rentId}/ignore`, { reason: 'x' }],
      ['POST', `/transactions/${rentId}/restore`],
      ['GET', `/transactions/${rentId}`],
      ['GET', `/property-references/${property.propertyReferenceId}/transactions`],
      ['POST', `/transactions/${rentId}/reverse`, { reason: 'x' }],
      ['GET', `/imports/${first.importBatchId}`],
      ['GET', `/imports/${review.importBatchId}/review-items`],
      ['POST', `/imports/${review.importBatchId}/review-items/${itemId}/resolve`, { resolution: 'SKIP' }],
    ];
    for (const [method, path, body] of fromB) {
      expect((await call(REALM_B, method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    expect((await upload(REALM_B, account.financialAccountId, september)).status).toBe(404);
    expect(await json(await call(REALM_B, 'GET', `/transactions?financialAccountId=${account.financialAccountId}`), 200)).toMatchObject({
      items: [],
      total: 0,
    });
    expect(await json(await call(REALM_B, 'GET', '/parties'), 200)).toMatchObject({ items: [], total: 0 });
    expect(await json(await call(REALM_B, 'GET', '/acquisitions'), 200)).toMatchObject({ items: [], total: 0 });
    expect(await json(await call(REALM_A, 'GET', '/parties?name=schmidt'), 200)).toMatchObject({ items: [{ partyId: owner.partyId }], total: 1 });
    // The MRE Tenant resolves to Realm A's Party there, and to nothing in Realm B.
    const byTenant = `/parties?externalSystem=MRE&externalId=${TENANT}`;
    expect(await json(await call(REALM_A, 'GET', byTenant), 200)).toMatchObject({ items: [{ partyId: owner.partyId }], total: 1 });
    expect(await json(await call(REALM_B, 'GET', byTenant), 200)).toMatchObject({ items: [], total: 0 });
    // Realm A reads its confirmed rent with the current version as ETag (VC-X-21).
    const read = await call(REALM_A, 'GET', `/transactions/${rentId}`);
    expect(read.status).toBe(200);
    const body = (await read.json()) as { status: string; version: number; splits: unknown[] };
    expect(body).toMatchObject({
      status: 'CONFIRMED',
      splits: [{ financialCategoryCode: 'RENT_BASE' }, { financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' }],
    });
    expect(read.headers.get('etag')).toBe(`"${body.version}"`);
    expect((await pool.query(`SELECT count(*) FROM audit_record`)).rows).toEqual(before.rows);
    // Realm A cancels its draft (no VALID Ownership carries it); a repeat keeps the first reason.
    expect(await json(await call(REALM_A, 'POST', `/acquisitions/${draftPurchase.acquisitionId}/cancel`, { reason: 'Kauf geplatzt' }), 200)).toMatchObject({
      status: 'CANCELLED',
      cancellationReason: 'Kauf geplatzt',
    });
  });

  it('corrects a confirmed import by reversal + replacement; a re-import still finds the original (VC-1-11)', async () => {
    const account = await json<{ financialAccountId: string }>(
      await call(REALM_A, 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Mietkonto 2', currency: 'EUR' }),
      201,
    );
    const imported = await json<{ rows: { transactionId?: string }[] }>(await upload(REALM_A, account.financialAccountId, september), 201);
    const rentId = imported.rows[0]?.transactionId ?? '';
    await json(await call(REALM_A, 'PUT', `/transactions/${rentId}/splits`, { splits: [{ amount: eur('1250.00'), financialCategoryCode: 'RENT_BASE' }] }), 200);
    await json(await call(REALM_A, 'POST', `/transactions/${rentId}/confirm`), 200);

    // Realm B cannot correct Realm A's Transaction, and nothing is written.
    const before = await pool.query(`SELECT count(*) FROM ledger_transaction`);
    const foreign = await call(REALM_B, 'POST', `/transactions/${rentId}/correct`, { reason: 'x', replacement: { bookingDate: '2026-09-03' } });
    expect(foreign.status).toBe(404);
    expect((await pool.query(`SELECT count(*) FROM ledger_transaction`)).rows).toEqual(before.rows);

    const corrected = await json<Record<'original' | 'reversal' | 'replacement', Record<string, unknown>>>(
      await call(REALM_A, 'POST', `/transactions/${rentId}/correct`, {
        reason: 'Parser hat Kaltmiete und Nebenkosten nicht getrennt',
        replacement: {
          splits: [
            { amount: eur('1000.00'), financialCategoryCode: 'RENT_BASE' },
            { amount: eur('250.00'), financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' },
          ],
        },
      }),
      201,
    );
    expect(corrected.original).toMatchObject({ transactionId: rentId, status: 'CORRECTED', provenance: 'BANK_CSV' });
    expect(corrected.reversal).toMatchObject({ direction: 'OUTFLOW', amount: eur('1250.00'), provenance: 'CORRECTION', correctionRole: 'REVERSAL' });
    expect(corrected.replacement).toMatchObject({ direction: 'INFLOW', amount: eur('1250.00'), status: 'CONFIRMED', correctionRole: 'REPLACEMENT' });
    // A second attempt names the correction instead of making another one.
    const again = await json<{ error: { details: Record<string, unknown> } }>(
      await call(REALM_A, 'POST', `/transactions/${rentId}/correct`, { reason: 'x', replacement: { bookingDate: '2026-09-03' } }),
      409,
    );
    expect(again.error.details).toEqual({
      reason: 'ALREADY_CORRECTED',
      reversalTransactionId: corrected.reversal['transactionId'],
      replacementTransactionId: corrected.replacement['transactionId'],
    });

    // The bank row still belongs to the original: re-importing the file creates nothing.
    const reimport = await json<{ transactionCount: number; duplicateCount: number }>(await upload(REALM_A, account.financialAccountId, september), 201);
    expect(reimport).toMatchObject({ transactionCount: 0, duplicateCount: 2 });

    // Net effect on the account: the rent counts once, now split in two categories.
    const totals = await pool.query(
      `SELECT c.code, sum(CASE t.direction WHEN 'INFLOW' THEN s.amount ELSE -s.amount END)::text AS total
       FROM ledger_transaction t JOIN transaction_split s ON s.transaction_id = t.id JOIN financial_category c ON c.id = s.financial_category_id
       WHERE t.financial_account_id = $1 AND t.status IN ('CONFIRMED', 'RECONCILED', 'CORRECTED')
       GROUP BY c.code HAVING sum(CASE t.direction WHEN 'INFLOW' THEN s.amount ELSE -s.amount END) <> 0 ORDER BY c.code`,
      [account.financialAccountId],
    );
    expect(totals.rows).toEqual([
      { code: 'RENT_BASE', total: '1000.00' },
      { code: 'RENT_OPERATING_COST_ADVANCE', total: '250.00' },
    ]);
  });
});

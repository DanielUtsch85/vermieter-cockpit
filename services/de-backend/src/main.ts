import { createApp } from './api/index.js';
import { loadConfig } from './config.js';
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
  getFinancialAccount,
  getPropertyReference,
  listFinancialAccounts,
  listPropertyReferences,
  createParty,
  amendDepreciationAsset,
  confirmDepreciationAsset,
  createDepreciationAsset,
  getDepreciationAsset,
  listPropertyDepreciationAssets,
  voidDepreciationAsset,
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
  createDeposit,
  getDeposit,
  listDeposits,
  amendDeposit,
  voidDeposit,
  closeDeposit,
  reopenDeposit,
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
  getLoan,
  listLoans,
  voidLoan,
  closeLoan,
  createReconciliation,
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
  createBalanceStatement,
  createLoanTerms,
  getLoanPayments,
  getRemainingDebt,
  listBalanceStatements,
  voidBalanceStatement,
  listLoanTerms,
  voidLoanTerms,
  getLoanSchedule,
  getPaymentProposal,
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
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresPartyRepository,
  PostgresPartyExternalReferenceRepository,
  PostgresOwnershipRepository,
  PostgresAcquisitionCostRepository,
  PostgresLandBuildingAllocationRepository,
  PostgresLoanRepository,
  PostgresSecurityDepositRepository,
  PostgresWegRepository,
  PostgresWegAnnualStatementRepository,
  PostgresWegEconomicPlanRepository,
  PostgresWegSpecialAssessmentRepository,
  PostgresTaxClassificationRepository,
  PostgresDepreciationAssetRepository,
  PostgresRentalContractReferenceRepository,
  PostgresLoanDebtRepository,
  PostgresLoanTermsRepository,
  PostgresLoanAllocationRepository,
  PostgresRentReconciliationRepository,
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
  checkStoredRuleReferences,
  createDatabase,
  createPool,
  isDatabaseReachable,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { findBankStatementAdapter } from './integrations/bank-import/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import {
  cachingPrincipalVerifier,
  mrePrincipalVerifier,
  mrePropertyLookup,
  mreRentTermLookup,
  mreTenantDepositReader,
  mreMonthReader,
  mreRentBreakdownReader,
  mreWriteBackTermReader,
  mreWriteBackTermWriter,
  mreRentTermReader,
  mreTenantLookup,
} from './wiring.js';

/** Composition root: wires configuration, infrastructure and the HTTP app. */
const config = loadConfig(process.env);
const pool = createPool(config.DATABASE_URL);
const db = createDatabase(pool);
const mreClient = new HttpMreClient({ apiBaseUrl: config.MRE_API_URL, timeoutMs: config.MRE_TIMEOUT_MS });
const propertyReferences = {
  repository: new PostgresPropertyReferenceRepository(db),
  lookupMreProperty: mrePropertyLookup(mreClient),
};
const financialAccounts = new PostgresFinancialAccountRepository(db);
const parties = new PostgresPartyRepository(db);
const externalReferences = new PostgresPartyExternalReferenceRepository(db);
const ownerships = new PostgresOwnershipRepository(db);
const acquisitions = new PostgresAcquisitionRepository(db);
const acquisitionCosts = new PostgresAcquisitionCostRepository(db);
const loans = new PostgresLoanRepository(db);
const securityDeposits = new PostgresSecurityDepositRepository(db);
const wegs = new PostgresWegRepository(db);
const wegPlans = new PostgresWegEconomicPlanRepository(db);
const wegStatements = new PostgresWegAnnualStatementRepository(db);
const wegAssessments = new PostgresWegSpecialAssessmentRepository(db);
const taxClassifications = new PostgresTaxClassificationRepository(db);
const rentalContractReferences = new PostgresRentalContractReferenceRepository(db);
const depreciationAssets = new PostgresDepreciationAssetRepository(db);
const loanTerms = new PostgresLoanTermsRepository(db);
const loanAllocations = new PostgresLoanAllocationRepository(db);
const loanDebt = new PostgresLoanDebtRepository(db);
const rentReconciliations = new PostgresRentReconciliationRepository(db);
const imports = new PostgresImportRepository(db);
const transactions = new PostgresTransactionRepository(db);
const unconfirmed = new PostgresUnconfirmedTransactionRepository(db);
const categories = new PostgresFinancialCategoryRepository(db);
const app = createApp({
  isReady: () => isDatabaseReachable(pool),
  verifyPrincipal: cachingPrincipalVerifier(mrePrincipalVerifier(mreClient)),
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
    create: createExternalReference({ repository: externalReferences, lookupMreTenant: mreTenantLookup(mreClient) }),
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
    create: createLoan({ repository: loans }),
    get: getLoan({ repository: loans }),
    list: listLoans({ repository: loans }),
    amend: amendLoan({ repository: loans }),
    void: voidLoan({ repository: loans }),
    close: closeLoan({ repository: loans }),
  },
  securityDeposits: {
    create: createDeposit({ repository: securityDeposits, readMreTenant: mreTenantDepositReader(mreClient) }),
    get: getDeposit({ repository: securityDeposits, readMreTenant: mreTenantDepositReader(mreClient) }),
    list: listDeposits({ repository: securityDeposits }),
    amend: amendDeposit({ repository: securityDeposits }),
    void: voidDeposit({ repository: securityDeposits }),
    close: closeDeposit({ repository: securityDeposits }),
    reopen: reopenDeposit({ repository: securityDeposits }),
  },
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
    create: createEconomicPlan({ repository: wegPlans }),
    get: getEconomicPlan({ repository: wegPlans }),
    list: listEconomicPlans({ repository: wegPlans }),
    void: voidEconomicPlan({ repository: wegPlans }),
    hausgeldProposal: getHausgeldProposal({ repository: wegPlans }),
  },
  wegAnnualStatements: {
    create: createAnnualStatement({ repository: wegStatements }),
    get: getAnnualStatement({ repository: wegStatements }),
    list: listAnnualStatements({ repository: wegStatements }),
    replace: replaceAnnualStatement({ repository: wegStatements }),
    confirm: confirmAnnualStatement({ repository: wegStatements }),
    void: voidAnnualStatement({ repository: wegStatements }),
    comparison: getStatementComparison({ repository: wegStatements }),
    settlementProposal: getSettlementProposal({ repository: wegStatements }),
  },
  wegSpecialAssessments: {
    create: createSpecialAssessment({ repository: wegAssessments }),
    get: getSpecialAssessment({ repository: wegAssessments }),
    list: listSpecialAssessments({ repository: wegAssessments }),
    amend: amendSpecialAssessment({ repository: wegAssessments }),
    replaceUses: replaceAssessmentUses({ repository: wegAssessments }),
    void: voidSpecialAssessment({ repository: wegAssessments }),
  },
  taxation: {
    create: createTaxClassification({ repository: taxClassifications }),
    get: getTaxClassification({ repository: taxClassifications }),
    history: listTaxClassificationHistory({ repository: taxClassifications }),
    review: reviewTaxClassification({ repository: taxClassifications }),
    taxMeaning: getTaxMeaning({ repository: taxClassifications }),
    depositTaxMeaning: getDepositTaxMeaning({ repository: taxClassifications }),
    withdrawalTaxMeaning: getWithdrawalTaxMeaning({ repository: taxClassifications }),
    useTaxMeaning: getUseTaxMeaning({ repository: taxClassifications }),
    anschaffungsnahe: getAnschaffungsnaheCheck({ repository: taxClassifications }),
    taxMeanings: listTaxMeanings({ repository: taxClassifications }),
    taxYear: getTaxYearView({ repository: taxClassifications }),
    listRules: listTaxRules(),
    getRule: getTaxRule(),
  },
  rentalContractReferences: {
    create: createRentalContractReference({ repository: rentalContractReferences, lookupMreTenant: mreTenantLookup(mreClient) }),
    get: getRentalContractReference({ repository: rentalContractReferences }),
    list: listRentalContractReferences({ repository: rentalContractReferences }),
    amend: amendRentalContractReference({ repository: rentalContractReferences }),
  },
  depreciationAssets: {
    create: createDepreciationAsset({ repository: depreciationAssets }),
    get: getDepreciationAsset({ repository: depreciationAssets }),
    listForPropertyReference: listPropertyDepreciationAssets({ repository: depreciationAssets }),
    amend: amendDepreciationAsset({ repository: depreciationAssets }),
    confirm: confirmDepreciationAsset({ repository: depreciationAssets }),
    void: voidDepreciationAsset({ repository: depreciationAssets }),
  },
  rentReconciliations: {
    create: createReconciliation({ repository: rentReconciliations, lookupMreRentTerm: mreRentTermLookup(mreClient) }),
    get: getReconciliation({ repository: rentReconciliations }),
    list: listReconciliations({ repository: rentReconciliations }),
    release: releaseReconciliation({ repository: rentReconciliations }),
    termCoverage: getTermCoverage({ repository: rentReconciliations, readMreRentTerm: mreRentTermReader(mreClient) }),
    transactionCoverage: getTransactionCoverage({ repository: rentReconciliations }),
    suggest: suggestReconciliations({ repository: rentReconciliations, readMreMonth: mreMonthReader(mreClient) }),
    confirm: confirmReconciliation({ repository: rentReconciliations, readMreRentTerm: mreRentTermReader(mreClient) }),
    reject: rejectReconciliation({ repository: rentReconciliations }),
    // §37.4: the lease outlives a PATCH still in flight, assuming MRE finishes a request within twice the timeout.
    writeBack: writeBackToMre({
      repository: rentReconciliations,
      readTerm: mreWriteBackTermReader(mreClient),
      writeTerm: mreWriteBackTermWriter(mreClient),
      leaseMs: 2 * config.MRE_TIMEOUT_MS,
    }),
    getWithPresence: getReconciliationWithPresence({ repository: rentReconciliations, readTerm: mreWriteBackTermReader(mreClient) }),
    splitProposal: getRentSplitProposal({ queries: new PostgresTransactionQueries(db), readBreakdown: mreRentBreakdownReader(mreClient) }),
    // §37.5: a removal waits one MRE timeout past the last lease (review on #82).
    removeFromMre: removeFromMre({
      repository: rentReconciliations,
      readTerm: mreWriteBackTermReader(mreClient),
      writeTerm: mreWriteBackTermWriter(mreClient),
      leaseMs: 2 * config.MRE_TIMEOUT_MS,
      marginMs: config.MRE_TIMEOUT_MS,
    }),
  },
  loanTerms: {
    create: createLoanTerms({ repository: loanTerms }),
    void: voidLoanTerms({ repository: loanTerms }),
    list: listLoanTerms({ repository: loanTerms }),
    schedule: getLoanSchedule({ repository: loanTerms }),
    proposal: getPaymentProposal({ repository: loanTerms }),
  },
  loanDebt: {
    remainingDebt: getRemainingDebt({ repository: loanDebt }),
    payments: getLoanPayments({ repository: loanDebt }),
    createStatement: createBalanceStatement({ repository: loanDebt }),
    voidStatement: voidBalanceStatement({ repository: loanDebt }),
    listStatements: listBalanceStatements({ repository: loanDebt }),
  },
  loanAllocations: {
    create: createLoanAllocation({ repository: loanAllocations }),
    void: voidLoanAllocation({ repository: loanAllocations }),
    list: listLoanAllocations({ repository: loanAllocations }),
    on: getLoanAllocationOn({ repository: loanAllocations }),
    propertyLoans: listPropertyLoans({ repository: loanAllocations }),
  },
  financialAccounts: {
    create: createFinancialAccount({ repository: financialAccounts }),
    close: closeFinancialAccount({ repository: financialAccounts }),
    get: getFinancialAccount({ repository: financialAccounts }),
    list: listFinancialAccounts({ repository: financialAccounts }),
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
    importStatement: importBankStatement({ imports, accounts: financialAccounts, findAdapter: findBankStatementAdapter }),
    getBatch: getImportBatch({ imports }),
    listReviewItems: listReviewItems({ imports }),
    resolveReviewItem: resolveReviewItem({ imports }),
  },
  financialCategories: { list: listFinancialCategories({ categories }), get: getFinancialCategory({ categories }) },
});

// Migrate before accepting requests; a failed migration aborts the start.
const applied = await migrateToLatest(pool);
console.log(`database migrations applied: ${applied.length === 0 ? 'none pending' : applied.map((r) => r.migrationName).join(', ')}`);
// Every stored rule reference (Taxation's and Depreciation's, §59) resolves against the registry, or the start aborts
// naming the missing ones (§58).
try {
  const rules = await checkStoredRuleReferences(db);
  console.log(`tax rule references resolved: ${rules.length === 0 ? 'none stored' : rules.map((r) => `${r.ruleCode}@${r.version}`).join(', ')}`);
} catch (error) {
  console.error(String(error));
  await pool.end();
  process.exit(1);
}

const server = app.listen(config.PORT, () => {
  console.log(`de-backend listening on port ${config.PORT}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

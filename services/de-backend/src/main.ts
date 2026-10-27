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
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresPartyRepository,
  PostgresPartyExternalReferenceRepository,
  PostgresOwnershipRepository,
  PostgresAcquisitionCostRepository,
  PostgresLandBuildingAllocationRepository,
  PostgresLoanRepository,
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
  createPool,
  isDatabaseReachable,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { findBankStatementAdapter } from './integrations/bank-import/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { mrePrincipalVerifier, mrePropertyLookup, mreTenantLookup } from './wiring.js';

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
const loanTerms = new PostgresLoanTermsRepository(db);
const loanAllocations = new PostgresLoanAllocationRepository(db);
const loanDebt = new PostgresLoanDebtRepository(db);
const imports = new PostgresImportRepository(db);
const transactions = new PostgresTransactionRepository(db);
const unconfirmed = new PostgresUnconfirmedTransactionRepository(db);
const categories = new PostgresFinancialCategoryRepository(db);
const app = createApp({
  isReady: () => isDatabaseReachable(pool),
  verifyPrincipal: mrePrincipalVerifier(mreClient),
  linkPropertyReference: linkPropertyReference(propertyReferences),
  refreshPropertyReference: refreshPropertyReference(propertyReferences),
  createParty: createParty({ repository: parties }),
  getParty: getParty({ repository: parties }),
  listParties: listParties({ repository: parties }),
  amendParty: amendParty({ repository: parties }),
  deactivateParty: deactivateParty({ repository: parties }),
  createExternalReference: createExternalReference({ repository: externalReferences, lookupMreTenant: mreTenantLookup(mreClient) }),
  endExternalReference: endExternalReference({ repository: externalReferences }),
  listExternalReferences: listExternalReferences({ repository: externalReferences }),
  createOwnership: createOwnership({ repository: ownerships }),
  getOwnership: getOwnership({ repository: ownerships }),
  closeOwnership: closeOwnership({ repository: ownerships }),
  voidOwnership: voidOwnership({ repository: ownerships }),
  readPropertyOwnerships: readPropertyOwnerships({ repository: ownerships }),
  changeOwnership: changeOwnership({ repository: ownerships }),
  createAcquisition: createAcquisition({ repository: acquisitions }),
  getAcquisition: getAcquisition({ repository: acquisitions }),
  listAcquisitions: listAcquisitions({ repository: acquisitions }),
  listPropertyAcquisitions: listPropertyAcquisitions({ repository: acquisitions, propertyReferences: propertyReferences.repository }),
  cancelAcquisition: cancelAcquisition({ repository: acquisitions }),
  confirmAcquisition: confirmAcquisition({ repository: acquisitions }),
  createLandBuildingAllocation: createLandBuildingAllocation({ repository: new PostgresLandBuildingAllocationRepository(db) }),
  listLandBuildingAllocations: listLandBuildingAllocations({ repository: new PostgresLandBuildingAllocationRepository(db) }),
  getOwnerAllocation: getOwnerAllocation({ source: new PostgresOwnerAllocationSource(db) }),
  createAcquisitionCost: createAcquisitionCost({ repository: acquisitionCosts }),
  voidAcquisitionCost: voidAcquisitionCost({ repository: acquisitionCosts }),
  listAcquisitionCosts: listAcquisitionCosts({ repository: acquisitionCosts }),
  linkAcquisitionPayment: linkAcquisitionPayment({ repository: acquisitionCosts }),
  unlinkAcquisitionPayment: unlinkAcquisitionPayment({ repository: acquisitionCosts }),
  listAcquisitionPayments: listAcquisitionPayments({ repository: acquisitionCosts }),
  createLoan: createLoan({ repository: loans }),
  getLoan: getLoan({ repository: loans }),
  listLoans: listLoans({ repository: loans }),
  amendLoan: amendLoan({ repository: loans }),
  voidLoan: voidLoan({ repository: loans }),
  closeLoan: closeLoan({ repository: loans }),
  createLoanTerms: createLoanTerms({ repository: loanTerms }),
  voidLoanTerms: voidLoanTerms({ repository: loanTerms }),
  listLoanTerms: listLoanTerms({ repository: loanTerms }),
  getLoanSchedule: getLoanSchedule({ repository: loanTerms }),
  getPaymentProposal: getPaymentProposal({ repository: loanTerms }),
  getRemainingDebt: getRemainingDebt({ repository: loanDebt }),
  getLoanPayments: getLoanPayments({ repository: loanDebt }),
  createBalanceStatement: createBalanceStatement({ repository: loanDebt }),
  voidBalanceStatement: voidBalanceStatement({ repository: loanDebt }),
  listBalanceStatements: listBalanceStatements({ repository: loanDebt }),
  createLoanAllocation: createLoanAllocation({ repository: loanAllocations }),
  voidLoanAllocation: voidLoanAllocation({ repository: loanAllocations }),
  listLoanAllocations: listLoanAllocations({ repository: loanAllocations }),
  getLoanAllocationOn: getLoanAllocationOn({ repository: loanAllocations }),
  listPropertyLoans: listPropertyLoans({ repository: loanAllocations }),
  createFinancialAccount: createFinancialAccount({ repository: financialAccounts }),
  closeFinancialAccount: closeFinancialAccount({ repository: financialAccounts }),
  createManualTransaction: createManualTransaction({ repository: transactions }),
  confirmTransaction: confirmTransaction({ repository: transactions }),
  correctTransaction: correctTransaction({ repository: new PostgresCorrectionRepository(db) }),
  reverseTransaction: reverseTransaction({ repository: new PostgresCorrectionRepository(db) }),
  getTransaction: getTransaction({ queries: new PostgresTransactionQueries(db) }),
  listTransactions: listTransactions({ queries: new PostgresTransactionQueries(db) }),
  listPropertyReferenceTransactions: listPropertyReferenceTransactions({
    queries: new PostgresTransactionQueries(db),
    propertyReferences: propertyReferences.repository,
  }),
  amendTransaction: amendTransaction({ repository: unconfirmed }),
  ignoreTransaction: ignoreTransaction({ repository: unconfirmed }),
  restoreTransaction: restoreTransaction({ repository: unconfirmed }),
  setTransactionSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
  listFinancialCategories: listFinancialCategories({ categories }),
  getFinancialCategory: getFinancialCategory({ categories }),
  importBankStatement: importBankStatement({ imports, accounts: financialAccounts, findAdapter: findBankStatementAdapter }),
  getImportBatch: getImportBatch({ imports }),
  listReviewItems: listReviewItems({ imports }),
  resolveReviewItem: resolveReviewItem({ imports }),
});

// Migrate before accepting requests; a failed migration aborts the start.
const applied = await migrateToLatest(pool);
console.log(`database migrations applied: ${applied.length === 0 ? 'none pending' : applied.map((r) => r.migrationName).join(', ')}`);

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

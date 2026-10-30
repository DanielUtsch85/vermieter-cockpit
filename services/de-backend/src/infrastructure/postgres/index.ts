/**
 * PostgreSQL infrastructure adapters (ADR-031). Implements persistence ports for
 * the domains; domain code never imports from here (coding-guidelines §3).
 */
export { createDatabase } from './database.js';
export { migrateToLatest } from './migrate.js';
export { fromNumericAmount, toNumericAmount } from './money-column.js';
export { createPool, isDatabaseReachable } from './pool.js';
export { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
export type { Database } from './schema.js';
export { PostgresFinancialAccountRepository } from './financial-account-repository.js';
export { PostgresPartyRepository } from './party-repository.js';
export { PostgresPartyExternalReferenceRepository } from './party-external-reference-repository.js';
export { PostgresOwnershipRepository } from './ownership-repository.js';
export { PostgresAcquisitionRepository } from './acquisition-repository.js';
export { PostgresAcquisitionCostRepository } from './acquisition-cost-repository.js';
export { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';
export { PostgresLoanRepository } from './loan-repository.js';
export { PostgresSecurityDepositRepository } from './security-deposit-repository.js';
export { PostgresWegRepository } from './weg-repository.js';
export { PostgresLoanAllocationRepository } from './loan-allocation-repository.js';
export { PostgresLoanDebtRepository } from './loan-debt-repository.js';
export { PostgresLoanTermsRepository } from './loan-terms-repository.js';
export { PostgresOwnerAllocationSource } from './owner-allocation-source.js';
export { PostgresTransactionRepository } from './transaction-repository.js';
export { PostgresImportRepository } from './import-repository.js';
export { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
export { PostgresFinancialCategoryRepository } from './financial-category-repository.js';
export { PostgresCorrectionRepository } from './correction-repository.js';
export { PostgresUnconfirmedTransactionRepository } from './unconfirmed-transaction-repository.js';
export { PostgresTransactionQueries } from './transaction-query-repository.js';
export { PostgresRentReconciliationRepository } from './rent-reconciliation-repository.js';
export { PostgresWegAnnualStatementRepository } from './weg-annual-statement-repository.js';
export { PostgresWegEconomicPlanRepository } from './weg-economic-plan-repository.js';
export { PostgresWegSpecialAssessmentRepository } from './weg-special-assessment-repository.js';

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

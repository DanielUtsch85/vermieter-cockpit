import { createApp } from './api/index.js';
import { loadConfig } from './config.js';
import {
  closeFinancialAccount,
  createFinancialAccount,
  createManualTransaction,
  getImportBatch,
  importBankStatement,
  linkPropertyReference,
  refreshPropertyReference,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresImportRepository,
  PostgresPropertyReferenceRepository,
  PostgresTransactionRepository,
  createDatabase,
  createPool,
  isDatabaseReachable,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { findBankStatementAdapter } from './integrations/bank-import/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { mrePrincipalVerifier, mrePropertyLookup } from './wiring.js';

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
const imports = new PostgresImportRepository(db);
const app = createApp({
  isReady: () => isDatabaseReachable(pool),
  verifyPrincipal: mrePrincipalVerifier(mreClient),
  linkPropertyReference: linkPropertyReference(propertyReferences),
  refreshPropertyReference: refreshPropertyReference(propertyReferences),
  createFinancialAccount: createFinancialAccount({ repository: financialAccounts }),
  closeFinancialAccount: closeFinancialAccount({ repository: financialAccounts }),
  createManualTransaction: createManualTransaction({ repository: new PostgresTransactionRepository(db) }),
  importBankStatement: importBankStatement({ imports, accounts: financialAccounts, findAdapter: findBankStatementAdapter }),
  getImportBatch: getImportBatch({ imports }),
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

import { createApp } from './api/index.js';
import { loadConfig } from './config.js';
import { createPool, isDatabaseReachable, migrateToLatest } from './infrastructure/postgres/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { mrePrincipalVerifier } from './wiring.js';

/** Composition root: wires configuration, infrastructure and the HTTP app. */
const config = loadConfig(process.env);
const pool = createPool(config.DATABASE_URL);
const mreClient = new HttpMreClient({ apiBaseUrl: config.MRE_API_URL, timeoutMs: config.MRE_TIMEOUT_MS });
const app = createApp({
  isReady: () => isDatabaseReachable(pool),
  verifyPrincipal: mrePrincipalVerifier(mreClient),
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

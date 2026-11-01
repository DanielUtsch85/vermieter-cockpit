import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Drops the per-file test schemas after all files ran (see the file for why not per file).
    globalSetup: ['./vitest.global-setup.ts'],
    // A database test file migrates a fresh schema in its beforeAll. Migrations run one at a time
    // (MIGRATION_ADVISORY_LOCK), and Kysely's Migrator introspects every schema of the database, so a
    // hook waits for the other workers' migrations and its own gets slower as schemas pile up. Measured
    // under full default parallelism on 4 cores: wait + migration up to ~6.5 s on a fresh database and
    // ~10.3 s on one with old schemas left over — at or past Vitest's default of 10 s. 30 s matches the
    // `{ timeout: 30_000 }` of tests that migrate in their body (coding-guidelines §12).
    hookTimeout: 30_000,
  },
});

import { Kysely, Migrator, PostgresDialect, type Migration, type MigrationResult } from 'kysely';
import type pg from 'pg';
import { migrations } from './migrations/index.js';

/**
 * Applies all pending migrations to the DE database (ADR-031, coding-guidelines §8).
 * Kysely's Migrator takes a database lock, so concurrent starts are safe, and
 * records applied migrations in `kysely_migration`. Throws if any migration fails;
 * the caller must not start serving requests then.
 */
export async function migrateToLatest(
  pool: pg.Pool,
  migrationSet: Record<string, Migration> = migrations,
): Promise<readonly MigrationResult[]> {
  // The Kysely instance borrows the pool; it is not destroyed here because
  // destroying it would end the shared pool.
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrationSet },
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error !== undefined) {
    const failed = results?.find((r) => r.status === 'Error')?.migrationName ?? 'unknown';
    throw new Error(`Database migration failed at ${failed}: ${String(error)}`);
  }
  return results ?? [];
}

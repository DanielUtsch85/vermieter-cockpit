import { Kysely, Migrator, PostgresDialect, type Migration, type MigrationResult } from 'kysely';
import type pg from 'pg';
import { migrations } from './migrations/index.js';

/**
 * Applies all pending migrations to the DE database (ADR-031, coding-guidelines §8).
 * Kysely's Migrator takes a database lock, so concurrent starts are safe, and
 * records applied migrations in `kysely_migration`. Throws if any migration fails;
 * the caller must not start serving requests then.
 */
export interface MigrateOptions {
  /** Migration set to apply; defaults to all registered DE migrations. */
  readonly migrations?: Record<string, Migration>;
  /** Schema for `kysely_migration*` tables; defaults to `public`. Tests use their own. */
  readonly migrationTableSchema?: string;
}

export async function migrateToLatest(
  pool: pg.Pool,
  options: MigrateOptions = {},
): Promise<readonly MigrationResult[]> {
  const migrationSet = options.migrations ?? migrations;
  // The Kysely instance borrows the pool; it is not destroyed here because
  // destroying it would end the shared pool.
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrationSet },
    ...(options.migrationTableSchema === undefined ? {} : { migrationTableSchema: options.migrationTableSchema }),
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error !== undefined) {
    const failed = results?.find((r) => r.status === 'Error')?.migrationName ?? 'unknown';
    throw new Error(`Database migration failed at ${failed}: ${String(error)}`);
  }
  return results ?? [];
}

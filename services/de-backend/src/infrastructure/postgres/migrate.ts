import { Kysely, PostgresDialect } from 'kysely';
import { Migrator, type Migration, type MigrationResult } from 'kysely/migration';
import pg from 'pg';
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

/**
 * Session advisory lock held while migrating. Kysely's Migrator introspects all
 * schemas of the database, which fails if another session drops a schema
 * meanwhile; anything that drops schemas (the test teardown) takes this lock
 * too, so the two never overlap. It also serializes concurrent starts.
 */
export const MIGRATION_ADVISORY_LOCK = 71_340_017;

export async function migrateToLatest(
  pool: pg.Pool,
  options: MigrateOptions = {},
): Promise<readonly MigrationResult[]> {
  // A connection of its own, outside the pool: the migration takes pool
  // connections while the lock is held, so a small or busy pool cannot deadlock.
  const lock = new pg.Client(pool.options);
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    return await migrate(pool, options);
  } finally {
    await lock.end().catch(() => undefined);
  }
}

async function migrate(pool: pg.Pool, options: MigrateOptions): Promise<readonly MigrationResult[]> {
  const migrationSet = options.migrations ?? migrations;
  // The Kysely instance borrows the pool; it is not destroyed here because
  // destroying it would end the shared pool.
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrationSet) },
    ...(options.migrationTableSchema === undefined ? {} : { migrationTableSchema: options.migrationTableSchema }),
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error !== undefined) {
    const failed = results?.find((r) => r.status === 'Error')?.migrationName ?? 'unknown';
    throw new Error(`Database migration failed at ${failed}: ${String(error)}`);
  }
  return results ?? [];
}

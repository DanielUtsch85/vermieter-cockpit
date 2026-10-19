import { Kysely, PostgresDialect } from 'kysely';
import type pg from 'pg';
import type { Database } from './schema.js';

/**
 * Typed query builder over the shared pool. `destroy()` would end the pool, so
 * the composition root ends the pool itself on shutdown instead.
 */
export function createDatabase(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

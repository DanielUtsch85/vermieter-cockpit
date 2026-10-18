import type { Kysely } from 'kysely';

/**
 * Baseline: establishes the migration history (Phase-0 exit "migrations run").
 * No domain tables yet — the first ones arrive with VC-1-01 (PropertyReference).
 */
export async function up(_db: Kysely<unknown>): Promise<void> {}

export async function down(_db: Kysely<unknown>): Promise<void> {}

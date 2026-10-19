import { sql, type Kysely } from 'kysely';

/**
 * VC-1-02: refresh of cached PropertyReference data.
 *
 * - `cached_surface`: MRE surface kept exact as unconstrained NUMERIC (never
 *   NUMERIC(p,s), which rounds silently on insert; coding-guidelines §8).
 * - `last_observed_at`: start of the latest applied MRE lookup (FOUND or
 *   NOT_FOUND). A refresh whose lookup started no later than this is stale and
 *   discarded, so a slow, older observation never overwrites a newer one.
 *   Existing rows start from `last_refreshed_at` (their link lookup).
 * - `audit_record.previous_version` / `new_version` (data-model.md §57).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE property_reference ADD COLUMN cached_surface numeric CHECK (cached_surface >= 0)`.execute(db);
  await sql`ALTER TABLE property_reference ADD COLUMN last_observed_at timestamptz`.execute(db);
  await sql`UPDATE property_reference SET last_observed_at = last_refreshed_at`.execute(db);
  await sql`ALTER TABLE audit_record ADD COLUMN previous_version integer, ADD COLUMN new_version integer`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE audit_record DROP COLUMN new_version, DROP COLUMN previous_version`.execute(db);
  await sql`ALTER TABLE property_reference DROP COLUMN last_observed_at, DROP COLUMN cached_surface`.execute(db);
}

import { sql, type Kysely } from 'kysely';

/**
 * VC-X-12: retention of the `Idempotency-Key` store (api-design.md §15 "Retention"; Entscheidung des Projektinhabers,
 * 2026-11-06): seven days from the key's creation. The creation date is 0004's `idempotency_key.created_at`
 * (`timestamptz NOT NULL DEFAULT now()`); the daily cleanup deletes by it (`created_at <= now − 7 days`), so it gets an
 * index. No column, no CHECK, no row changes: the rule itself lives in the claim and the cleanup
 * (`idempotency.ts`, `idempotency-retention.ts`). `down` drops the index only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX idempotency_key_created_at_idx ON idempotency_key (created_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idempotency_key_created_at_idx`.execute(db);
}

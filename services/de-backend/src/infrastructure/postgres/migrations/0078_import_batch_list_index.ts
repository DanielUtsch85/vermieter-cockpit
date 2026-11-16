import { sql, type Kysely } from 'kysely';

/**
 * VC-X-74 (api-design.md §32.6, #369): `GET /imports` pages a Realm's batches newest first. Until now `import_batch`
 * had only its primary key and `UNIQUE (id, mre_realm_id)`, so every page read the whole table and sorted the Realm's
 * rows; with this index a page is read in the list's own order and stops at its limit. The account and status filters
 * run on it. An index only: no row changes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX import_batch_realm_imported_idx
      ON import_batch (mre_realm_id, imported_at DESC, id DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX import_batch_realm_imported_idx`.execute(db);
}

import { sql, type Kysely } from 'kysely';

/**
 * VC-X-19: `GET /transactions` (api-design.md §30.1) pages a Realm's Transactions newest first. Without an index on
 * the Realm every page read the whole table and sorted the Realm's rows; with this one a page is read in order
 * and stops at its limit, and the count reads only the Realm's rows. The order is the list's own (§30.1).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX ledger_transaction_realm_page_idx
      ON ledger_transaction (mre_realm_id, booking_date DESC, created_at DESC, id DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX ledger_transaction_realm_page_idx`.execute(db);
}

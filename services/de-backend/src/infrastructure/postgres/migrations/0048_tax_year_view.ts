import { sql, type Kysely } from 'kysely';

/**
 * VC-7-04: the tax-year view (api-design.md §58C "Indexes").
 *
 * - `transaction_split_property_reference_idx` on `transaction_split (property_reference_id, transaction_id)`, partial
 *   on `property_reference_id IS NOT NULL`: §55's per-year list and the view select a PropertyReference's splits by
 *   it, which had no index (the list read the table in full).
 *
 * Nothing else: no table, no column, no trigger; the view is derived on read and never stored (P7-D8). `down` drops
 * the index.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX transaction_split_property_reference_idx ON transaction_split (property_reference_id, transaction_id)
      WHERE property_reference_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX transaction_split_property_reference_idx`.execute(db);
}

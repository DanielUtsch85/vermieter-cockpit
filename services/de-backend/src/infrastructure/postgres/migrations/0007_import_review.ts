import { sql, type Kysely } from 'kysely';

/**
 * VC-1-06a: resolving review items (data-model.md §20A, api-design.md §32.2).
 *
 * - A Transaction created by a `CREATE` resolution records its review item.
 *   It is a second payment at a source identity that may already hold one (the
 *   human decided they differ), so the fallback identity index exempts it; one
 *   Transaction per review item is unique instead.
 * - The batch keeps the provenance of its adapter, so a resolution creates the
 *   Transaction with the same provenance as the import would have.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE ledger_transaction
      ADD COLUMN import_review_item_id uuid
        CONSTRAINT ledger_transaction_review_item_fk REFERENCES import_review_item (id),
      ADD CONSTRAINT ledger_transaction_review_item_key UNIQUE (import_review_item_id)
  `.execute(db);
  await sql`DROP INDEX ledger_transaction_source_row_key`.execute(db);
  await sql`
    CREATE UNIQUE INDEX ledger_transaction_source_row_key
      ON ledger_transaction (mre_realm_id, financial_account_id, adapter_id, adapter_version, source_statement_key, source_row_key)
      WHERE external_transaction_id IS NULL AND source_row_key IS NOT NULL AND import_review_item_id IS NULL
  `.execute(db);
  await sql`
    ALTER TABLE import_review_item
      ADD CONSTRAINT import_review_item_transaction_matches CHECK (created_transaction_id IS NULL OR status = 'RESOLVED')
  `.execute(db);

  await sql`ALTER TABLE import_batch ADD COLUMN provenance text NOT NULL DEFAULT 'BANK_CSV'`.execute(db);
  await sql`ALTER TABLE import_batch ALTER COLUMN provenance DROP DEFAULT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE import_batch DROP COLUMN provenance`.execute(db);
  await sql`ALTER TABLE import_review_item DROP CONSTRAINT import_review_item_transaction_matches`.execute(db);
  await sql`DROP INDEX ledger_transaction_source_row_key`.execute(db);
  await sql`
    CREATE UNIQUE INDEX ledger_transaction_source_row_key
      ON ledger_transaction (mre_realm_id, financial_account_id, adapter_id, adapter_version, source_statement_key, source_row_key)
      WHERE external_transaction_id IS NULL AND source_row_key IS NOT NULL
  `.execute(db);
  await sql`
    ALTER TABLE ledger_transaction
      DROP CONSTRAINT ledger_transaction_review_item_key,
      DROP COLUMN import_review_item_id
  `.execute(db);
}

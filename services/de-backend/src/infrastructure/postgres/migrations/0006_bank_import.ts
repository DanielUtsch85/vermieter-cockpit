import { sql, type Kysely } from 'kysely';

/**
 * VC-1-05 / VC-1-06: ImportBatch (data-model.md §20), ImportReviewItem (§20A)
 * and the import identity of Transactions (§70).
 *
 * The duplicate identity is enforced by the schema itself, so even a bug in the
 * import code cannot create a second Transaction for the same source row:
 * - external-id branch: unique per (Realm, account, external id);
 * - fallback branch: unique per (Realm, account, adapter, version, statement, row).
 * One review item exists per full source-row identity (§20A: never a second item).
 * Batches, review items and imported Transactions are bound to their Realm via
 * composite foreign keys, like the rest of the ledger.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE import_batch (
      id uuid PRIMARY KEY,
      mre_realm_id text NOT NULL,
      financial_account_id uuid NOT NULL,
      adapter_id text NOT NULL,
      adapter_version text NOT NULL,
      source_filename text,
      content_hash text NOT NULL,
      status text NOT NULL CHECK (status IN ('COMPLETED', 'NEEDS_REVIEW')),
      transaction_count integer NOT NULL CHECK (transaction_count >= 0),
      duplicate_count integer NOT NULL CHECK (duplicate_count >= 0),
      needs_review_count integer NOT NULL CHECK (needs_review_count >= 0),
      error_count integer NOT NULL CHECK (error_count >= 0),
      skipped_count integer NOT NULL CHECK (skipped_count >= 0),
      rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
      imported_at timestamptz NOT NULL DEFAULT now(),
      imported_by text NOT NULL,
      CONSTRAINT import_batch_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT import_batch_account_fk FOREIGN KEY (financial_account_id, mre_realm_id)
        REFERENCES financial_account (id, mre_realm_id),
      CONSTRAINT import_batch_status_matches CHECK ((status = 'NEEDS_REVIEW') = (needs_review_count > 0))
    )
  `.execute(db);

  await sql`
    ALTER TABLE ledger_transaction
      ADD COLUMN import_batch_id uuid,
      ADD COLUMN external_transaction_id text,
      ADD COLUMN counterparty_name_raw text,
      ADD COLUMN counterparty_iban_raw text,
      ADD COLUMN adapter_id text,
      ADD COLUMN adapter_version text,
      ADD COLUMN source_statement_key text,
      ADD COLUMN source_row_key text,
      ADD COLUMN content_fingerprint text,
      ADD CONSTRAINT ledger_transaction_import_batch_fk FOREIGN KEY (import_batch_id, mre_realm_id)
        REFERENCES import_batch (id, mre_realm_id),
      ADD CONSTRAINT ledger_transaction_import_identity CHECK (
        (import_batch_id IS NULL AND adapter_id IS NULL AND source_row_key IS NULL AND content_fingerprint IS NULL)
        OR (import_batch_id IS NOT NULL AND adapter_id IS NOT NULL AND adapter_version IS NOT NULL
            AND source_statement_key IS NOT NULL AND source_row_key IS NOT NULL AND content_fingerprint IS NOT NULL)
      )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX ledger_transaction_external_id_key
      ON ledger_transaction (mre_realm_id, financial_account_id, external_transaction_id)
      WHERE external_transaction_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX ledger_transaction_source_row_key
      ON ledger_transaction (mre_realm_id, financial_account_id, adapter_id, adapter_version, source_statement_key, source_row_key)
      WHERE external_transaction_id IS NULL AND source_row_key IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX ledger_transaction_source_position_idx
      ON ledger_transaction (financial_account_id, source_statement_key, source_row_key)
      WHERE source_row_key IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX ledger_transaction_fingerprint_idx
      ON ledger_transaction (financial_account_id, content_fingerprint)
      WHERE content_fingerprint IS NOT NULL
  `.execute(db);

  await sql`
    CREATE TABLE import_review_item (
      id uuid PRIMARY KEY,
      import_batch_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      financial_account_id uuid NOT NULL,
      adapter_id text NOT NULL,
      adapter_version text NOT NULL,
      source_statement_key text NOT NULL,
      source_row_key text NOT NULL,
      content_fingerprint text NOT NULL,
      normalized_row jsonb NOT NULL CHECK (jsonb_typeof(normalized_row) = 'object'),
      ambiguity_reason text NOT NULL CHECK (ambiguity_reason IN ('AMBIGUOUS_CROSS_FILE_MATCH', 'ADAPTER_VERSION_CONFLICT')),
      conflicting_transaction_ids uuid[] NOT NULL,
      prior_review_item_ids uuid[] NOT NULL,
      status text NOT NULL CHECK (status IN ('PENDING', 'RESOLVED')),
      resolution text CHECK (resolution IN ('CREATE', 'SKIP')),
      resolved_by text,
      resolved_at timestamptz,
      created_transaction_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT import_review_item_batch_fk FOREIGN KEY (import_batch_id, mre_realm_id)
        REFERENCES import_batch (id, mre_realm_id),
      CONSTRAINT import_review_item_account_fk FOREIGN KEY (financial_account_id, mre_realm_id)
        REFERENCES financial_account (id, mre_realm_id),
      CONSTRAINT import_review_item_transaction_fk FOREIGN KEY (created_transaction_id)
        REFERENCES ledger_transaction (id),
      CONSTRAINT import_review_item_identity_key
        UNIQUE (mre_realm_id, financial_account_id, adapter_id, adapter_version, source_statement_key, source_row_key),
      CONSTRAINT import_review_item_resolution CHECK (
        (status = 'PENDING' AND resolution IS NULL AND resolved_by IS NULL AND resolved_at IS NULL AND created_transaction_id IS NULL)
        OR (status = 'RESOLVED' AND resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
            AND (resolution = 'CREATE') = (created_transaction_id IS NOT NULL))
      )
    )
  `.execute(db);
  await sql`
    CREATE INDEX import_review_item_position_idx
      ON import_review_item (financial_account_id, source_statement_key, source_row_key)
  `.execute(db);
  await sql`CREATE INDEX import_review_item_batch_idx ON import_review_item (import_batch_id, status)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE import_review_item`.execute(db);
  await sql`
    ALTER TABLE ledger_transaction
      DROP CONSTRAINT ledger_transaction_import_identity,
      DROP CONSTRAINT ledger_transaction_import_batch_fk,
      DROP COLUMN content_fingerprint,
      DROP COLUMN source_row_key,
      DROP COLUMN source_statement_key,
      DROP COLUMN adapter_version,
      DROP COLUMN adapter_id,
      DROP COLUMN counterparty_iban_raw,
      DROP COLUMN counterparty_name_raw,
      DROP COLUMN external_transaction_id,
      DROP COLUMN import_batch_id
  `.execute(db);
  await sql`DROP TABLE import_batch`.execute(db);
}

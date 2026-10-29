import { sql, type Kysely } from 'kysely';

/**
 * VC-1-12: balance identity and continuity report for bank imports (ADR-043, data-model.md §70.6, #106).
 *
 * - `ledger_transaction.source_balance_after`: the bank's running balance after the booking, as the file gave it
 *   (signed, import evidence, never a ledger balance). Set at the insert and fixed afterwards, at any status.
 * - An index over the balance identity `(realm, account, booking_date, amount, direction, source_balance_after)`;
 *   not unique, because two Transactions may share it (§70.6 "several matches").
 * - `import_batch.continuity`: the batch's continuity report, null for a file without a balance column.
 * - The review reason `BALANCE_IDENTITY_CONTENT_CONFLICT`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE ledger_transaction
      ADD COLUMN source_balance_after numeric CHECK (scale(source_balance_after) <= 2 AND abs(source_balance_after) < 1e18)
  `.execute(db);
  await sql`
    CREATE INDEX ledger_transaction_balance_identity
      ON ledger_transaction (mre_realm_id, financial_account_id, booking_date, amount, direction, source_balance_after)
      WHERE source_balance_after IS NOT NULL
  `.execute(db);
  await sql`
    CREATE FUNCTION ledger_transaction_balance_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.source_balance_after IS DISTINCT FROM OLD.source_balance_after THEN
        RAISE EXCEPTION 'source_balance_after of Transaction % is fixed after creation (§70.6)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_transaction_balance_fixed BEFORE UPDATE ON ledger_transaction
      FOR EACH ROW EXECUTE FUNCTION ledger_transaction_balance_fixed()
  `.execute(db);
  await sql`ALTER TABLE import_batch ADD COLUMN continuity jsonb`.execute(db);
  await sql`ALTER TABLE import_review_item DROP CONSTRAINT import_review_item_ambiguity_reason_check`.execute(db);
  await sql`
    ALTER TABLE import_review_item ADD CONSTRAINT import_review_item_ambiguity_reason_check
      CHECK (ambiguity_reason IN ('AMBIGUOUS_CROSS_FILE_MATCH', 'ADAPTER_VERSION_CONFLICT', 'EXTERNAL_ID_CONTENT_CONFLICT', 'BALANCE_IDENTITY_CONTENT_CONFLICT'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE import_review_item DROP CONSTRAINT import_review_item_ambiguity_reason_check`.execute(db);
  await sql`
    ALTER TABLE import_review_item ADD CONSTRAINT import_review_item_ambiguity_reason_check
      CHECK (ambiguity_reason IN ('AMBIGUOUS_CROSS_FILE_MATCH', 'ADAPTER_VERSION_CONFLICT', 'EXTERNAL_ID_CONTENT_CONFLICT'))
  `.execute(db);
  await sql`ALTER TABLE import_batch DROP COLUMN continuity`.execute(db);
  await sql`DROP TRIGGER ledger_transaction_balance_fixed ON ledger_transaction`.execute(db);
  await sql`DROP FUNCTION ledger_transaction_balance_fixed()`.execute(db);
  await sql`DROP INDEX ledger_transaction_balance_identity`.execute(db);
  await sql`ALTER TABLE ledger_transaction DROP COLUMN source_balance_after`.execute(db);
}

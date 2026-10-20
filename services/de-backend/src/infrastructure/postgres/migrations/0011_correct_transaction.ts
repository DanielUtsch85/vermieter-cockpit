import { sql, type Kysely } from 'kysely';

/**
 * VC-1-11: correcting a confirmed Transaction by reversal + replacement
 * (api-design.md §35, data-model.md §17.8, ADR-037).
 *
 * - `correction_of_transaction_id` + `correction_role` link a reversal and a
 *   replacement to their original, in the same Realm; they are set together and
 *   exactly on `provenance = 'CORRECTION'`; at most one of each per original.
 * - The immutability trigger of 0009 is extended (one list of frozen fields):
 *   `property_reference_id`, `description` and the correction link are frozen
 *   too, and `CORRECTED` is reached only from `CONFIRMED`/`RECONCILED` — before,
 *   a covered `CLASSIFIED` row could jump straight to `CORRECTED`.
 * - A deferred constraint trigger checks the chain at commit, so reversal,
 *   replacement and the original's status change can be written in any order:
 *   a Transaction is `CORRECTED` exactly when its reversal and replacement
 *   exist; both are confirmed; a reversal matches its original; no link targets
 *   a reversal. It fires on the status change and on the linked inserts, and
 *   re-reads the rows as committed, not as they were when the event was queued.
 */
const CONFIRMED_STATES = sql.raw(`('CONFIRMED', 'RECONCILED', 'CORRECTED')`);

/** Body of `ledger_transaction_immutable()`: as in 0009, or extended for VC-1-11. */
const IMMUTABLE_BODY = (correction: boolean) =>
  sql.raw(`
    BEGIN
      ${
        correction
          ? `-- CORRECTED only after a confirmation (domain-model.md §21), never from an unconfirmed status.
      IF TG_OP = 'UPDATE' AND NEW.status = 'CORRECTED' AND OLD.status NOT IN ('CONFIRMED', 'RECONCILED', 'CORRECTED') THEN
        RAISE EXCEPTION 'Transaction % is % and cannot become CORRECTED (domain-model §21)', OLD.id, OLD.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;`
          : ''
      }
      IF OLD.status IN ('CONFIRMED', 'RECONCILED', 'CORRECTED') THEN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'confirmed Transaction % cannot be deleted (ADR-037)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        -- Only forward (domain-model.md §21): CONFIRMED → RECONCILED / CORRECTED, RECONCILED → CORRECTED.
        -- CORRECTED is terminal; nothing returns to CONFIRMED or to an unconfirmed state.
        IF (NEW.status IS DISTINCT FROM OLD.status AND NOT (
              (OLD.status = 'CONFIRMED' AND NEW.status IN ('RECONCILED', 'CORRECTED'))
              OR (OLD.status = 'RECONCILED' AND NEW.status = 'CORRECTED')))
           -- Cash facts, and the provenance and import identity a re-import relies on (§70).
           OR (NEW.mre_realm_id, NEW.financial_account_id, NEW.amount, NEW.currency, NEW.direction, NEW.booking_date,
               NEW.value_date, NEW.confirmed_at, NEW.confirmed_by, NEW.provenance, NEW.import_batch_id,
               NEW.external_transaction_id, NEW.adapter_id, NEW.adapter_version, NEW.source_statement_key,
               NEW.source_row_key, NEW.content_fingerprint, NEW.import_review_item_id${
                 correction
                   ? `,
               -- VC-1-11: every change of a confirmed Transaction goes through a correction (api-design §35.6).
               NEW.property_reference_id, NEW.description, NEW.correction_of_transaction_id, NEW.correction_role`
                   : ''
               })
              IS DISTINCT FROM
              (OLD.mre_realm_id, OLD.financial_account_id, OLD.amount, OLD.currency, OLD.direction, OLD.booking_date,
               OLD.value_date, OLD.confirmed_at, OLD.confirmed_by, OLD.provenance, OLD.import_batch_id,
               OLD.external_transaction_id, OLD.adapter_id, OLD.adapter_version, OLD.source_statement_key,
               OLD.source_row_key, OLD.content_fingerprint, OLD.import_review_item_id${
                 correction
                   ? `,
               OLD.property_reference_id, OLD.description, OLD.correction_of_transaction_id, OLD.correction_role`
                   : ''
               }) THEN
          RAISE EXCEPTION 'confirmed Transaction % is immutable (ADR-037)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END`);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE ledger_transaction
      ADD COLUMN correction_of_transaction_id uuid,
      ADD COLUMN correction_role text CHECK (correction_role IN ('REVERSAL', 'REPLACEMENT')),
      ADD CONSTRAINT ledger_transaction_realm_key UNIQUE (id, mre_realm_id),
      ADD CONSTRAINT ledger_transaction_correction_fk FOREIGN KEY (correction_of_transaction_id, mre_realm_id)
        REFERENCES ledger_transaction (id, mre_realm_id),
      ADD CONSTRAINT ledger_transaction_correction_link CHECK (
        (correction_of_transaction_id IS NULL) = (correction_role IS NULL)
        AND (provenance = 'CORRECTION') = (correction_role IS NOT NULL)
      )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX ledger_transaction_correction_key
      ON ledger_transaction (correction_of_transaction_id, correction_role) WHERE correction_of_transaction_id IS NOT NULL
  `.execute(db);

  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_immutable() RETURNS trigger LANGUAGE plpgsql AS $$${IMMUTABLE_BODY(true)} $$`.execute(db);

  await sql`
    CREATE FUNCTION ledger_transaction_correction_chain() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      cur ledger_transaction%ROWTYPE;
      orig ledger_transaction%ROWTYPE;
      links integer;
    BEGIN
      -- The row as it is now: later writes in the same transaction may have changed it since the event.
      SELECT * INTO cur FROM ledger_transaction WHERE id = NEW.id;

      IF cur.correction_of_transaction_id IS NOT NULL THEN
        SELECT * INTO orig FROM ledger_transaction WHERE id = cur.correction_of_transaction_id;
        IF orig.correction_role = 'REVERSAL' THEN
          RAISE EXCEPTION 'Transaction % is a reversal and cannot be corrected (api-design §35.3)', orig.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF orig.status <> 'CORRECTED' THEN
          RAISE EXCEPTION 'correction % of Transaction %: the original is %, not CORRECTED (api-design §35.6)', cur.id, orig.id, orig.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF cur.status NOT IN ${CONFIRMED_STATES} THEN
          RAISE EXCEPTION 'correction % of Transaction % is %, not confirmed (api-design §35.3)', cur.id, orig.id, cur.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF cur.correction_role = 'REVERSAL' AND (
             (cur.financial_account_id, cur.currency, cur.amount, cur.booking_date, cur.value_date)
               IS DISTINCT FROM (orig.financial_account_id, orig.currency, orig.amount, orig.booking_date, orig.value_date)
             OR cur.direction = orig.direction) THEN
          RAISE EXCEPTION 'reversal % does not match Transaction % (same account, amount, dates; opposite direction)', cur.id, orig.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;

      IF cur.status = 'CORRECTED' THEN
        -- At most one of each per original (unique index); CORRECTED needs both.
        SELECT count(*) INTO links FROM ledger_transaction WHERE correction_of_transaction_id = cur.id;
        IF links <> 2 THEN
          RAISE EXCEPTION 'Transaction % is CORRECTED without its reversal and replacement (api-design §35.6)', cur.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  // Only the columns the chain depends on, and only for rows that take part in one: the no-op touch of the split
  // trigger (0010) and ordinary imports or confirmations queue no check.
  await sql`
    CREATE CONSTRAINT TRIGGER ledger_transaction_correction_chain
      AFTER INSERT OR UPDATE OF status, correction_of_transaction_id, correction_role, financial_account_id, amount, currency,
        direction, booking_date, value_date
      ON ledger_transaction DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (NEW.correction_of_transaction_id IS NOT NULL OR NEW.status = 'CORRECTED')
      EXECUTE FUNCTION ledger_transaction_correction_chain()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER ledger_transaction_correction_chain ON ledger_transaction`.execute(db);
  await sql`DROP FUNCTION ledger_transaction_correction_chain()`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_immutable() RETURNS trigger LANGUAGE plpgsql AS $$${IMMUTABLE_BODY(false)} $$`.execute(db);
  await sql`DROP INDEX ledger_transaction_correction_key`.execute(db);
  await sql`
    ALTER TABLE ledger_transaction
      DROP CONSTRAINT ledger_transaction_correction_link,
      DROP CONSTRAINT ledger_transaction_correction_fk,
      DROP CONSTRAINT ledger_transaction_realm_key,
      DROP COLUMN correction_role,
      DROP COLUMN correction_of_transaction_id
  `.execute(db);
}

import { sql, type Kysely } from 'kysely';

/**
 * VC-1-08: confirming a Transaction (api-design.md §34, ADR-037).
 *
 * - `confirmed_at` / `confirmed_by` exist exactly for confirmed Transactions
 *   (CONFIRMED and the states that follow it, RECONCILED and CORRECTED).
 * - Immutability is enforced by the database, not only by the code paths that
 *   exist today: once confirmed, a Transaction's cash fields and account cannot
 *   change, it cannot return to an unconfirmed state or be deleted, and its
 *   splits are frozen. Corrections are new records (reversal + replacement).
 */
const CONFIRMED_STATES = sql.raw(`('CONFIRMED', 'RECONCILED', 'CORRECTED')`);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE ledger_transaction
      ADD COLUMN confirmed_at timestamptz,
      ADD COLUMN confirmed_by text,
      ADD CONSTRAINT ledger_transaction_confirmed CHECK (
        (status IN ${CONFIRMED_STATES}) = (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)
      )
  `.execute(db);

  await sql`
    CREATE FUNCTION ledger_transaction_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status IN ${CONFIRMED_STATES} THEN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'confirmed Transaction % cannot be deleted (ADR-037)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.status NOT IN ${CONFIRMED_STATES}
           OR (NEW.mre_realm_id, NEW.financial_account_id, NEW.amount, NEW.currency, NEW.direction, NEW.booking_date,
               NEW.value_date, NEW.confirmed_at, NEW.confirmed_by)
              IS DISTINCT FROM
              (OLD.mre_realm_id, OLD.financial_account_id, OLD.amount, OLD.currency, OLD.direction, OLD.booking_date,
               OLD.value_date, OLD.confirmed_at, OLD.confirmed_by) THEN
          RAISE EXCEPTION 'confirmed Transaction % is immutable (ADR-037)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_transaction_immutable BEFORE UPDATE OR DELETE ON ledger_transaction
      FOR EACH ROW EXECUTE FUNCTION ledger_transaction_immutable()
  `.execute(db);

  await sql`
    CREATE FUNCTION transaction_split_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      parent_status text;
    BEGIN
      SELECT status INTO parent_status FROM ledger_transaction
        WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.transaction_id ELSE NEW.transaction_id END;
      IF parent_status IN ${CONFIRMED_STATES} THEN
        RAISE EXCEPTION 'splits of a confirmed Transaction are frozen (ADR-037)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER transaction_split_frozen BEFORE INSERT OR UPDATE OR DELETE ON transaction_split
      FOR EACH ROW EXECUTE FUNCTION transaction_split_frozen()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER transaction_split_frozen ON transaction_split`.execute(db);
  await sql`DROP FUNCTION transaction_split_frozen()`.execute(db);
  await sql`DROP TRIGGER ledger_transaction_immutable ON ledger_transaction`.execute(db);
  await sql`DROP FUNCTION ledger_transaction_immutable()`.execute(db);
  await sql`
    ALTER TABLE ledger_transaction
      DROP CONSTRAINT ledger_transaction_confirmed,
      DROP COLUMN confirmed_by,
      DROP COLUMN confirmed_at
  `.execute(db);
}

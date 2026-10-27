import { sql, type Kysely } from 'kysely';

/**
 * VC-3-06: Lender statements (data-model.md §21.3b, api-design.md §41.6, phase-3-plan P3-D6, P3-D8, ADR-016).
 *
 * - `loan_balance_statement`: a balance the lender reports on a date, of a Loan of the same Realm; `balance` ≥ 0 with
 *   at most two decimals; `source` and `notes` as text; status `VALID` → `VOID`, `VOID` exactly with its time and reason.
 * - `loan_balance_statement_append` (before insert): writes the Loan row first (P3-D8's no-op, so a statement and a
 *   void of the Loan serialise and a stale one fails under REPEATABLE READ), then refuses a `VOID` Loan and a date
 *   before the debt starts; only inserted `VALID` with version 1.
 * - `loan_balance_statement_frozen` (before update or delete): the data never changes; the only step is `VALID` →
 *   `VOID` with `version` + 1; never deleted.
 * - Not here: the comparison with the derived remaining debt (a read), the closing rule (VC-3-07).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE loan_balance_statement (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      loan_id uuid NOT NULL,
      status text NOT NULL CHECK (status IN ('VALID', 'VOID')),
      statement_date date NOT NULL,
      balance numeric NOT NULL CHECK (scale(balance) <= 2 AND balance >= 0 AND balance < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      source text NOT NULL CHECK (length(source) BETWEEN 1 AND 200 AND source = btrim(source)),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      voided_at timestamptz,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT loan_balance_statement_loan_fk FOREIGN KEY (loan_id, mre_realm_id) REFERENCES loan (id, mre_realm_id),
      CONSTRAINT loan_balance_statement_status_fields CHECK ((status = 'VOID') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX loan_balance_statement_loan_idx ON loan_balance_statement (loan_id, statement_date, created_at)`.execute(db);

  await sql`
    CREATE FUNCTION loan_balance_statement_append() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      loan_status text;
      debt_from date;
    BEGIN
      IF NEW.status <> 'VALID' OR NEW.version <> 1 THEN
        RAISE EXCEPTION 'LoanBalanceStatement: only inserted VALID with version 1 (api-design §41.6)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- P3-D8: the Loan row first, so a statement and a void of the Loan serialise.
      UPDATE loan SET version = version WHERE id = NEW.loan_id
        RETURNING status, coalesce(disbursement_date, start_date) INTO loan_status, debt_from;
      IF loan_status IS NULL THEN
        RETURN NEW; -- an unknown Loan is left to the foreign key
      END IF;
      IF loan_status = 'VOID' THEN
        RAISE EXCEPTION 'LoanBalanceStatement: Loan % is VOID (LOAN_NOT_ACTIVE)', NEW.loan_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.statement_date < debt_from THEN
        RAISE EXCEPTION 'LoanBalanceStatement: % is before the debt starts on % (STATEMENT_BEFORE_DEBT)', NEW.statement_date, debt_from
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER loan_balance_statement_append BEFORE INSERT ON loan_balance_statement FOR EACH ROW EXECUTE FUNCTION loan_balance_statement_append()`.execute(db);

  await sql`
    CREATE FUNCTION loan_balance_statement_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'LoanBalanceStatement %: never deleted; void it instead (api-design §41.6)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.loan_id, NEW.statement_date, NEW.balance, NEW.currency, NEW.source, NEW.notes, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.loan_id, OLD.statement_date, OLD.balance, OLD.currency, OLD.source, OLD.notes, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'LoanBalanceStatement %: statements are never edited; void it and record again (api-design §41.6)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF NOT (OLD.status = 'VALID' AND NEW.status = 'VOID') OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'LoanBalanceStatement %: the only step is VALID → VOID with version + 1 (api-design §41.6)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- P3-D8: a void writes the Loan row too.
      UPDATE loan SET version = version WHERE id = OLD.loan_id;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER loan_balance_statement_frozen BEFORE UPDATE OR DELETE ON loan_balance_statement FOR EACH ROW EXECUTE FUNCTION loan_balance_statement_frozen()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE loan_balance_statement`.execute(db);
  await sql`DROP FUNCTION loan_balance_statement_frozen()`.execute(db);
  await sql`DROP FUNCTION loan_balance_statement_append()`.execute(db);
}

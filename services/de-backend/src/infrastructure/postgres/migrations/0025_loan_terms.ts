import { sql, type Kysely } from 'kysely';

/**
 * VC-3-02: Loan terms (data-model.md §22, api-design.md §41.2, phase-3-plan P3-D2).
 *
 * - `loan_terms`: periods of a Loan of the same Realm; rate and initial repayment rate in percent with at most three
 *   decimals in `[0, 100)`; `scheduled_payment` exactly for `ANNUITY`; first payment and fixed-rate end not before
 *   `valid_from`; status `VALID` → `VOID`, `VOID` exactly with its time and reason; one `VALID` period per start day.
 * - `loan_terms_append`: writes the Loan row first (P3-D8's no-op, so concurrent appends serialise and a stale one fails
 *   under REPEATABLE READ), then refuses a period on a Loan that is not `ACTIVE`, before its debt starts, not after the
 *   last `VALID` period's start, or not after that period's first payment (review on #61); only inserted `VALID`, v1.
 * - `loan_terms_frozen`: the data never changes; the only step is `VALID` → `VOID` with `version` + 1, and only for the
 *   last `VALID` period. It writes the Loan row too before it looks for a later period (review on #61), so a raw void
 *   and a raw append behind it meet on the Loan row. Never deleted.
 * - Not here: the annuity check (it needs the schedule's derivation) and `principal_at_start` against the Loan; the
 *   repository makes both under the Loan lock.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE loan_terms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      loan_id uuid NOT NULL,
      status text NOT NULL CHECK (status IN ('VALID', 'VOID')),
      valid_from date NOT NULL,
      interest_rate numeric NOT NULL CHECK (scale(interest_rate) <= 3 AND interest_rate >= 0 AND interest_rate < 100),
      repayment_model text NOT NULL CHECK (repayment_model IN ('ANNUITY', 'INTEREST_ONLY')),
      scheduled_payment numeric CHECK (scale(scheduled_payment) <= 2 AND scheduled_payment > 0 AND scheduled_payment < 1e18),
      first_payment_date date NOT NULL,
      principal_at_start numeric CHECK (scale(principal_at_start) <= 2 AND principal_at_start > 0 AND principal_at_start < 1e18),
      fixed_rate_until date,
      initial_repayment_rate numeric CHECK (scale(initial_repayment_rate) <= 3 AND initial_repayment_rate >= 0 AND initial_repayment_rate < 100),
      special_repayment_limit numeric CHECK (scale(special_repayment_limit) <= 2 AND special_repayment_limit >= 0 AND special_repayment_limit < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      voided_at timestamptz,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT loan_terms_loan_fk FOREIGN KEY (loan_id, mre_realm_id) REFERENCES loan (id, mre_realm_id),
      CONSTRAINT loan_terms_payment CHECK ((repayment_model = 'ANNUITY') = (scheduled_payment IS NOT NULL)),
      CONSTRAINT loan_terms_dates CHECK (first_payment_date >= valid_from AND fixed_rate_until >= valid_from),
      CONSTRAINT loan_terms_status_fields CHECK ((status = 'VOID') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX loan_terms_valid_from ON loan_terms (loan_id, valid_from) WHERE status = 'VALID'`.execute(db);
  await sql`CREATE INDEX loan_terms_loan_idx ON loan_terms (loan_id, valid_from, created_at)`.execute(db);

  await sql`
    CREATE FUNCTION loan_terms_append() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      loan_status text;
      debt_from date;
      last record;
    BEGIN
      IF NEW.status <> 'VALID' OR NEW.version <> 1 THEN
        RAISE EXCEPTION 'LoanTerms: only inserted VALID with version 1 (api-design §41.2)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- P3-D8: the Loan row first, so appends to one Loan serialise.
      UPDATE loan SET version = version WHERE id = NEW.loan_id
        RETURNING status, coalesce(disbursement_date, start_date) INTO loan_status, debt_from;
      IF loan_status IS NULL THEN
        RETURN NEW; -- an unknown Loan is left to the foreign key
      END IF;
      IF loan_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'LoanTerms: Loan % is %, terms are appended only to an ACTIVE Loan (LOAN_NOT_ACTIVE)', NEW.loan_id, loan_status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.valid_from < debt_from THEN
        RAISE EXCEPTION 'LoanTerms: % is before the debt starts on % (TERMS_BEFORE_DEBT)', NEW.valid_from, debt_from
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT id, valid_from, first_payment_date INTO last FROM loan_terms
       WHERE loan_id = NEW.loan_id AND status = 'VALID' ORDER BY valid_from DESC LIMIT 1;
      IF last.id IS NOT NULL AND NEW.valid_from <= last.valid_from THEN
        RAISE EXCEPTION 'LoanTerms: % is not after the last period from % (TERMS_NOT_APPENDED)', NEW.valid_from, last.valid_from
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF last.id IS NOT NULL AND NEW.valid_from <= last.first_payment_date THEN
        RAISE EXCEPTION 'LoanTerms: % is not after the first payment % of period % (PREVIOUS_TERMS_WITHOUT_PAYMENT)', NEW.valid_from, last.first_payment_date, last.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER loan_terms_append BEFORE INSERT ON loan_terms FOR EACH ROW EXECUTE FUNCTION loan_terms_append()`.execute(db);

  await sql`
    CREATE FUNCTION loan_terms_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      later uuid;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'LoanTerms %: never deleted; void it instead (api-design §41.2)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.loan_id, NEW.valid_from, NEW.interest_rate, NEW.repayment_model, NEW.scheduled_payment,
          NEW.first_payment_date, NEW.principal_at_start, NEW.fixed_rate_until, NEW.initial_repayment_rate, NEW.special_repayment_limit,
          NEW.currency, NEW.notes, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.loan_id, OLD.valid_from, OLD.interest_rate, OLD.repayment_model, OLD.scheduled_payment,
          OLD.first_payment_date, OLD.principal_at_start, OLD.fixed_rate_until, OLD.initial_repayment_rate, OLD.special_repayment_limit,
          OLD.currency, OLD.notes, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'LoanTerms %: periods are never edited; void the last one and append (api-design §41.2)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF NOT (OLD.status = 'VALID' AND NEW.status = 'VOID') OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'LoanTerms %: the only step is VALID → VOID with version + 1 (api-design §41.2)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- The Loan row first (review on #61): a concurrent append behind this period meets the void there.
      UPDATE loan SET version = version WHERE id = OLD.loan_id;
      SELECT id INTO later FROM loan_terms
       WHERE loan_id = OLD.loan_id AND status = 'VALID' AND valid_from > OLD.valid_from LIMIT 1;
      IF later IS NOT NULL THEN
        RAISE EXCEPTION 'LoanTerms %: period % follows it; only the last period is voided (TERMS_NOT_LAST)', OLD.id, later
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER loan_terms_frozen BEFORE UPDATE OR DELETE ON loan_terms FOR EACH ROW EXECUTE FUNCTION loan_terms_frozen()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE loan_terms`.execute(db);
  await sql`DROP FUNCTION loan_terms_frozen()`.execute(db);
  await sql`DROP FUNCTION loan_terms_append()`.execute(db);
}

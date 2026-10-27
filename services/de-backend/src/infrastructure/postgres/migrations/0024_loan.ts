import { sql, type Kysely } from 'kysely';

/**
 * VC-3-01: Loan (data-model.md §21, api-design.md §41.1, phase-3-plan P3-D1).
 *
 * - `loan`: Realm-bound; lender by composite foreign key; borrowers as `borrower_party_ids uuid[]` on the row (review
 *   on #59), so every rule about them is a rule about one row: 1–20 elements, one-dimensional, no `NULL` element
 *   (review on #59: `NOT (x = ANY (…))` is `NULL`, which a CHECK passes, when the array holds a `NULL`), and the lender
 *   is never a borrower (a CHECK, both directions at once; a swap is one `UPDATE`). Principal > 0 in EUR with at most
 *   two decimals; `disbursement_date` not before `start_date`; `maturity_date` after the debt starts; status `ACTIVE`
 *   → `VOID` / `CLOSED`, `VOID` exactly with its time and reason.
 * - `loan_frozen`: id, Realm, principal, currency, dates of the contract, `acquisition_id` and creation never change.
 *   An unchanged row (P3-D8's no-op `UPDATE … SET version = version`) passes; every other write is a step with
 *   `version` + 1 exactly and only out of `ACTIVE`, so `VOID` and `CLOSED` are final. `loan_initial`: a Loan is only
 *   inserted `ACTIVE` with `version` 1; `loan_no_delete`: never deleted.
 * - `loan_parties`: an array cannot carry a foreign key, so every newly named Party (the lender, or a borrower not in
 *   the old row) must exist in the Loan's Realm and be `ACTIVE`, read `FOR SHARE`; a borrower who stays may have
 *   turned inactive (P2-D1). Duplicates are refused. `party_named_by_loan`: a Party a Loan names is never deleted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE loan (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('ACTIVE', 'VOID', 'CLOSED')),
      lender_party_id uuid NOT NULL,
      borrower_party_ids uuid[] NOT NULL,
      principal_original numeric NOT NULL CHECK (scale(principal_original) <= 2 AND principal_original > 0 AND principal_original < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      start_date date NOT NULL,
      disbursement_date date,
      maturity_date date,
      contract_number text CHECK (length(contract_number) BETWEEN 1 AND 100),
      acquisition_id uuid,
      source_references text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_references) <= 10),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      voided_at timestamptz,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT loan_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT loan_lender_fk FOREIGN KEY (lender_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT loan_acquisition_fk FOREIGN KEY (acquisition_id, mre_realm_id) REFERENCES acquisition (id, mre_realm_id),
      CONSTRAINT loan_borrowers CHECK (
        array_ndims(borrower_party_ids) = 1 AND cardinality(borrower_party_ids) BETWEEN 1 AND 20
        AND array_position(borrower_party_ids, NULL) IS NULL
      ),
      CONSTRAINT loan_lender_not_borrower CHECK (NOT (lender_party_id = ANY (borrower_party_ids))),
      CONSTRAINT loan_dates CHECK (disbursement_date >= start_date AND maturity_date > coalesce(disbursement_date, start_date)),
      CONSTRAINT loan_status_fields CHECK ((status = 'VOID') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX loan_realm_idx ON loan (mre_realm_id, start_date DESC, created_at DESC, id)`.execute(db);
  await sql`CREATE INDEX loan_lender_idx ON loan (lender_party_id)`.execute(db);
  await sql`CREATE INDEX loan_borrowers_idx ON loan USING gin (borrower_party_ids)`.execute(db);
  await sql`CREATE INDEX loan_acquisition_idx ON loan (acquisition_id) WHERE acquisition_id IS NOT NULL`.execute(db);

  await sql`
    CREATE FUNCTION loan_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.id, NEW.mre_realm_id, NEW.principal_original, NEW.currency, NEW.start_date, NEW.disbursement_date,
          NEW.acquisition_id, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.principal_original, OLD.currency, OLD.start_date, OLD.disbursement_date,
          OLD.acquisition_id, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'Loan %: principal, dates of the contract and Acquisition never change; void and create instead (api-design §41.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- The no-op write of P3-D8 (and any write leaving the row as it is) passes.
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF OLD.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Loan %: % is final (api-design §41.1)', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'Loan %: every change raises version by exactly one (% → %)', OLD.id, OLD.version, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER loan_frozen BEFORE UPDATE ON loan FOR EACH ROW EXECUTE FUNCTION loan_frozen()`.execute(db);

  await sql`
    CREATE FUNCTION loan_initial() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status <> 'ACTIVE' OR NEW.version <> 1 THEN
        RAISE EXCEPTION 'Loan: only inserted ACTIVE with version 1, not % / % (api-design §41.1)', NEW.status, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER loan_initial BEFORE INSERT ON loan FOR EACH ROW EXECUTE FUNCTION loan_initial()`.execute(db);

  await sql`
    CREATE FUNCTION loan_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Loan %: never deleted; void it instead (api-design §41.1)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER loan_no_delete BEFORE DELETE ON loan FOR EACH ROW EXECUTE FUNCTION loan_no_delete()`.execute(db);

  await sql`
    CREATE FUNCTION loan_parties() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      named uuid;
      party_status text;
    BEGIN
      -- A NULL element is left to the CHECK loan_borrowers, so that CHECK is tight on its own (review on #59).
      IF (SELECT count(DISTINCT b) <> count(b) FROM unnest(NEW.borrower_party_ids) AS b) THEN
        RAISE EXCEPTION 'Loan %: a borrower is named twice', NEW.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- In id order, as the repository locks them; only Parties this write names anew.
      FOR named IN
        SELECT p FROM unnest(array_append(NEW.borrower_party_ids, NEW.lender_party_id)) AS p
         WHERE p IS NOT NULL AND (TG_OP = 'INSERT' OR NOT (p = ANY (array_append(OLD.borrower_party_ids, OLD.lender_party_id))))
         ORDER BY p
      LOOP
        SELECT status INTO party_status FROM party WHERE id = named AND mre_realm_id = NEW.mre_realm_id FOR SHARE;
        IF party_status IS NULL THEN
          RAISE EXCEPTION 'Loan %: Party % is not a Party of the Realm', NEW.id, named USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF party_status <> 'ACTIVE' THEN
          RAISE EXCEPTION 'Loan %: Party % is %; a new lender or borrower must be ACTIVE (PARTY_INACTIVE)', NEW.id, named, party_status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER loan_parties BEFORE INSERT OR UPDATE OF lender_party_id, borrower_party_ids ON loan
      FOR EACH ROW EXECUTE FUNCTION loan_parties()
  `.execute(db);

  await sql`
    CREATE FUNCTION party_named_by_loan() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM loan WHERE lender_party_id = OLD.id OR borrower_party_ids @> ARRAY[OLD.id]) THEN
        RAISE EXCEPTION 'Party %: a Loan names it; it is never deleted (api-design §41.1)', OLD.id USING ERRCODE = 'foreign_key_violation';
      END IF;
      RETURN OLD;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER party_named_by_loan BEFORE DELETE ON party FOR EACH ROW EXECUTE FUNCTION party_named_by_loan()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER party_named_by_loan ON party`.execute(db);
  await sql`DROP FUNCTION party_named_by_loan()`.execute(db);
  await sql`DROP TABLE loan`.execute(db);
  await sql`DROP FUNCTION loan_parties()`.execute(db);
  await sql`DROP FUNCTION loan_no_delete()`.execute(db);
  await sql`DROP FUNCTION loan_initial()`.execute(db);
  await sql`DROP FUNCTION loan_frozen()`.execute(db);
}

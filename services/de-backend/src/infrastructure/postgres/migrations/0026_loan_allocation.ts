import { sql, type Kysely } from 'kysely';

/**
 * VC-3-03: Loan allocation sets (data-model.md §23, api-design.md §41.3, phase-3-plan P3-D3, ADR-038).
 *
 * - `loan_allocation_set`: dated sets of a Loan of the same Realm; basis `MANUAL` or `PURCHASE_PRICE`; status `VALID` →
 *   `VOID`, `VOID` exactly with its time and reason; one `VALID` set per start day.
 * - `loan_allocation`: the set's entries, one per PropertyReference of the Realm, a reduced fraction `0 < n ≤ d` (the
 *   denominator unbounded: a `PURCHASE_PRICE` set's may exceed 10 000); `acquisition_id` through 0020's key
 *   `(id, mre_realm_id, property_reference_id)`, so only an Acquisition of the entry's property. Never updated or deleted.
 * - `loan_allocation_set_append`: writes the Loan row first (P3-D8's no-op, as `loan_terms_append`), then refuses a set
 *   on a Loan that is not `ACTIVE`, before its debt starts, or not after the last `VALID` set's start; only `VALID`, v1.
 * - `loan_allocation_set_frozen`: the data never changes; the only step is `VALID` → `VOID` with `version` + 1, for the
 *   last `VALID` set only, writing the Loan row before it looks for a later set (as `loan_terms_frozen`). Never deleted.
 * - `loan_allocation_complete` (deferred, at commit): a set's fractions sum to exactly `1/1` in integer arithmetic, and
 *   its entries carry an Acquisition exactly for `PURCHASE_PRICE`. Rows are only added and every share is positive, so
 *   a committed set takes no further row, and a set without rows is refused.
 * - Not here: `ACQUISITION_CANCELLED` (a status read at write time; a later cancel keeps the set, §41.3), `d ≤ 10000`
 *   for `MANUAL` (the input format of §26.1) and the 1–50 entries of a request; the repository and the API check them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE loan_allocation_set (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      loan_id uuid NOT NULL,
      status text NOT NULL CHECK (status IN ('VALID', 'VOID')),
      valid_from date NOT NULL,
      basis text NOT NULL CHECK (basis IN ('MANUAL', 'PURCHASE_PRICE')),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      voided_at timestamptz,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT loan_allocation_set_loan_fk FOREIGN KEY (loan_id, mre_realm_id) REFERENCES loan (id, mre_realm_id),
      CONSTRAINT loan_allocation_set_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT loan_allocation_set_status_fields CHECK ((status = 'VOID') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX loan_allocation_set_valid_from ON loan_allocation_set (loan_id, valid_from) WHERE status = 'VALID'`.execute(db);
  await sql`CREATE INDEX loan_allocation_set_loan_idx ON loan_allocation_set (loan_id, valid_from, created_at)`.execute(db);

  await sql`
    CREATE TABLE loan_allocation (
      set_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      property_reference_id uuid NOT NULL,
      share_numerator numeric NOT NULL,
      share_denominator numeric NOT NULL,
      acquisition_id uuid,
      PRIMARY KEY (set_id, position),
      CONSTRAINT loan_allocation_set_fk FOREIGN KEY (set_id, mre_realm_id) REFERENCES loan_allocation_set (id, mre_realm_id),
      CONSTRAINT loan_allocation_property_reference_fk FOREIGN KEY (property_reference_id, mre_realm_id) REFERENCES property_reference (id, mre_realm_id),
      CONSTRAINT loan_allocation_acquisition_fk FOREIGN KEY (acquisition_id, mre_realm_id, property_reference_id)
        REFERENCES acquisition (id, mre_realm_id, property_reference_id),
      CONSTRAINT loan_allocation_property UNIQUE (set_id, property_reference_id),
      CONSTRAINT loan_allocation_share CHECK (
        scale(share_numerator) = 0 AND scale(share_denominator) = 0
        AND share_numerator > 0 AND share_numerator <= share_denominator
        AND gcd(share_numerator, share_denominator) = 1
      )
    )
  `.execute(db);
  await sql`CREATE INDEX loan_allocation_property_reference_idx ON loan_allocation (property_reference_id)`.execute(db);

  await sql`
    CREATE FUNCTION loan_allocation_set_append() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      loan_status text;
      debt_from date;
      last_from date;
    BEGIN
      IF NEW.status <> 'VALID' OR NEW.version <> 1 THEN
        RAISE EXCEPTION 'LoanAllocationSet: only inserted VALID with version 1 (api-design §41.3)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- P3-D8: the Loan row first, so appends to one Loan serialise.
      UPDATE loan SET version = version WHERE id = NEW.loan_id
        RETURNING status, coalesce(disbursement_date, start_date) INTO loan_status, debt_from;
      IF loan_status IS NULL THEN
        RETURN NEW; -- an unknown Loan is left to the foreign key
      END IF;
      IF loan_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'LoanAllocationSet: Loan % is %, sets are appended only to an ACTIVE Loan (LOAN_NOT_ACTIVE)', NEW.loan_id, loan_status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.valid_from < debt_from THEN
        RAISE EXCEPTION 'LoanAllocationSet: % is before the debt starts on % (ALLOCATION_BEFORE_DEBT)', NEW.valid_from, debt_from
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT max(valid_from) INTO last_from FROM loan_allocation_set WHERE loan_id = NEW.loan_id AND status = 'VALID';
      IF NEW.valid_from <= last_from THEN
        RAISE EXCEPTION 'LoanAllocationSet: % is not after the last set from % (ALLOCATION_NOT_APPENDED)', NEW.valid_from, last_from
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER loan_allocation_set_append BEFORE INSERT ON loan_allocation_set FOR EACH ROW EXECUTE FUNCTION loan_allocation_set_append()`.execute(db);

  await sql`
    CREATE FUNCTION loan_allocation_set_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      later uuid;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'LoanAllocationSet %: never deleted; void it instead (api-design §41.3)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.loan_id, NEW.valid_from, NEW.basis, NEW.notes, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.loan_id, OLD.valid_from, OLD.basis, OLD.notes, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'LoanAllocationSet %: sets are never edited; void the last one and append (api-design §41.3)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF NOT (OLD.status = 'VALID' AND NEW.status = 'VOID') OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'LoanAllocationSet %: the only step is VALID → VOID with version + 1 (api-design §41.3)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- The Loan row first: a concurrent append behind this set meets the void there (as loan_terms_frozen).
      UPDATE loan SET version = version WHERE id = OLD.loan_id;
      SELECT id INTO later FROM loan_allocation_set
       WHERE loan_id = OLD.loan_id AND status = 'VALID' AND valid_from > OLD.valid_from LIMIT 1;
      IF later IS NOT NULL THEN
        RAISE EXCEPTION 'LoanAllocationSet %: set % follows it; only the last set is voided (ALLOCATION_NOT_LAST)', OLD.id, later
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER loan_allocation_set_frozen BEFORE UPDATE OR DELETE ON loan_allocation_set FOR EACH ROW EXECUTE FUNCTION loan_allocation_set_frozen()`.execute(db);

  await sql`
    CREATE FUNCTION loan_allocation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'LoanAllocation of set %: entries are never updated or deleted (api-design §41.3)', OLD.set_id
        USING ERRCODE = 'integrity_constraint_violation';
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER loan_allocation_frozen BEFORE UPDATE OR DELETE ON loan_allocation FOR EACH ROW EXECUTE FUNCTION loan_allocation_frozen()`.execute(db);

  await sql`
    CREATE FUNCTION loan_allocation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      target uuid;
      set_basis text;
      row record;
      n numeric := 0;
      d numeric := 1;
      g numeric;
    BEGIN
      -- Separate statements: a field of NEW is resolved only when its statement runs.
      IF TG_TABLE_NAME = 'loan_allocation_set' THEN
        target := NEW.id;
      ELSE
        target := NEW.set_id;
      END IF;
      SELECT basis INTO set_basis FROM loan_allocation_set WHERE id = target;
      FOR row IN SELECT share_numerator, share_denominator, acquisition_id FROM loan_allocation WHERE set_id = target LOOP
        IF (row.acquisition_id IS NOT NULL) <> (set_basis = 'PURCHASE_PRICE') THEN
          RAISE EXCEPTION 'LoanAllocationSet %: a % set carries an Acquisition exactly for PURCHASE_PRICE (api-design §41.3)', target, set_basis
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        n := n * row.share_denominator + row.share_numerator * d;
        d := d * row.share_denominator;
        g := gcd(n, d);
        n := n / g;
        d := d / g;
      END LOOP;
      IF n <> d THEN
        RAISE EXCEPTION 'LoanAllocationSet %: shares sum to %/%, not 1/1 (SHARE_SUM_NOT_ONE)', target, n, d
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER loan_allocation_set_complete AFTER INSERT ON loan_allocation_set
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION loan_allocation_complete()
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER loan_allocation_complete AFTER INSERT ON loan_allocation
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION loan_allocation_complete()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE loan_allocation`.execute(db);
  await sql`DROP TABLE loan_allocation_set`.execute(db);
  await sql`DROP FUNCTION loan_allocation_complete()`.execute(db);
  await sql`DROP FUNCTION loan_allocation_frozen()`.execute(db);
  await sql`DROP FUNCTION loan_allocation_set_frozen()`.execute(db);
  await sql`DROP FUNCTION loan_allocation_set_append()`.execute(db);
}

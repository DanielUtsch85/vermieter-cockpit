import { sql, type Kysely } from 'kysely';

/**
 * VC-X-28: a person's statements the tax-year view reads (api-design.md §58E "In the database"; decided by the owner on
 * 2026-11-01: two tables, withdrawable with a reason). All Realm-bound; texts trimmed, 1–500 (inline, so `down` of 0045 never depends on this migration).
 *
 * - `tax_year_acknowledgement`: one attribution change (an AuditRecord, by value: `audit_record` has no Realm column) of
 *   one PropertyReference and year, as the person saw it (`change_fingerprint`); `ACTIVE` → `WITHDRAWN` with the three
 *   withdrawal fields set together exactly on `WITHDRAWN`; one `ACTIVE` per PropertyReference, year, record and
 *   fingerprint (unique, partial); `created_txid` the inserting transaction (as 0052).
 * - `tax_year_acknowledgement_item`: the change's items as rows (AGENTS.md §28), `year_before` ≠ `year_after`.
 * - `loan_allocation_tax_confirmation`: one allocation set as a whole (its id is its fingerprint: a set never changes,
 *   §41.3), optionally naming the advisor Party; one `ACTIVE` per set (unique, partial).
 * - Guards: `…_insert` writes the PropertyReference (acknowledgement) or the Loan (confirmation) row first, the lock
 *   order of their writers, and admits only `ACTIVE`, version 1, no withdrawal; a confirmation only of a `VALID`
 *   `PURCHASE_PRICE` set with more than one entry. `…_frozen`: the only change is `ACTIVE` → `WITHDRAWN` with the three
 *   fields and `version` + 1; never deleted. `…_item_append_only`: an item only in its acknowledgement's transaction.
 * - Not here: whether a change is flagged and its fingerprint (a derivation over several domains, the command's).
 * - `down` refuses while a statement exists (a person's statement is never dropped silently), else drops the tables.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const reason = (column: string) => sql.raw(`${column} = btrim(${column}) AND length(${column}) BETWEEN 1 AND 500`);
  const withdrawal = (table: string) =>
    sql.raw(`CONSTRAINT ${table}_withdrawal CHECK (
        (status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL) AND (status = 'WITHDRAWN') = (withdrawn_by IS NOT NULL)
        AND (status = 'WITHDRAWN') = (withdraw_reason IS NOT NULL)
      )`);
  await sql`
    CREATE TABLE tax_year_acknowledgement (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      property_reference_id uuid NOT NULL,
      tax_year integer NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
      audit_record_id uuid NOT NULL,
      change_kind text NOT NULL CHECK (change_kind IN (
        'RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED', 'RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', 'LOAN_TERMS_ADDED', 'LOAN_TERMS_VOIDED'
      )),
      change_entity_type text NOT NULL CHECK (change_entity_type IN ('RentalContractReference', 'RentPaymentReconciliation', 'LoanTerms')),
      change_entity_id uuid NOT NULL,
      change_recorded_at timestamptz NOT NULL,
      change_fingerprint text NOT NULL CHECK (change_fingerprint ~ '^[0-9a-f]{64}$'),
      reason text NOT NULL CHECK (${reason('reason')}),
      acknowledged_at timestamptz NOT NULL DEFAULT now(),
      acknowledged_by text NOT NULL CHECK (length(acknowledged_by) BETWEEN 1 AND 500),
      status text NOT NULL CHECK (status IN ('ACTIVE', 'WITHDRAWN')),
      withdrawn_at timestamptz,
      withdrawn_by text,
      withdraw_reason text CHECK (${reason('withdraw_reason')}),
      version integer NOT NULL DEFAULT 1,
      created_txid bigint NOT NULL DEFAULT txid_current(),
      ${withdrawal('tax_year_acknowledgement')},
      CONSTRAINT tax_year_acknowledgement_kind_entity CHECK (
        (change_entity_type = 'RentalContractReference') = (change_kind IN ('RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED'))
        AND (change_entity_type = 'RentPaymentReconciliation') = (change_kind IN ('RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED'))
      ),
      CONSTRAINT tax_year_acknowledgement_property_reference_fk FOREIGN KEY (property_reference_id, mre_realm_id)
        REFERENCES property_reference (id, mre_realm_id),
      CONSTRAINT tax_year_acknowledgement_realm_key UNIQUE (id, mre_realm_id)
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX tax_year_acknowledgement_active
      ON tax_year_acknowledgement (property_reference_id, tax_year, audit_record_id, change_fingerprint) WHERE status = 'ACTIVE'
  `.execute(db);
  await sql`CREATE INDEX tax_year_acknowledgement_year_idx ON tax_year_acknowledgement (property_reference_id, tax_year, acknowledged_at DESC)`.execute(db);

  await sql`
    CREATE TABLE tax_year_acknowledgement_item (
      acknowledgement_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      source_id uuid NOT NULL,
      year_before integer NOT NULL CHECK (year_before BETWEEN 2000 AND 2100),
      year_after integer NOT NULL CHECK (year_after BETWEEN 2000 AND 2100),
      CONSTRAINT tax_year_acknowledgement_item_key PRIMARY KEY (acknowledgement_id, source_id),
      CONSTRAINT tax_year_acknowledgement_item_moved CHECK (year_before <> year_after),
      CONSTRAINT tax_year_acknowledgement_item_fk FOREIGN KEY (acknowledgement_id, mre_realm_id) REFERENCES tax_year_acknowledgement (id, mre_realm_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE loan_allocation_tax_confirmation (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      allocation_set_id uuid NOT NULL,
      reason text NOT NULL CHECK (${reason('reason')}),
      advisor_party_id uuid,
      confirmed_at timestamptz NOT NULL DEFAULT now(),
      confirmed_by text NOT NULL CHECK (length(confirmed_by) BETWEEN 1 AND 500),
      status text NOT NULL CHECK (status IN ('ACTIVE', 'WITHDRAWN')),
      withdrawn_at timestamptz,
      withdrawn_by text,
      withdraw_reason text CHECK (${reason('withdraw_reason')}),
      version integer NOT NULL DEFAULT 1,
      ${withdrawal('loan_allocation_tax_confirmation')},
      CONSTRAINT loan_allocation_tax_confirmation_set_fk FOREIGN KEY (allocation_set_id, mre_realm_id) REFERENCES loan_allocation_set (id, mre_realm_id),
      CONSTRAINT loan_allocation_tax_confirmation_advisor_fk FOREIGN KEY (advisor_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT loan_allocation_tax_confirmation_realm_key UNIQUE (id, mre_realm_id)
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX loan_allocation_tax_confirmation_active ON loan_allocation_tax_confirmation (allocation_set_id) WHERE status = 'ACTIVE'`.execute(
    db,
  );
  await sql`CREATE INDEX loan_allocation_tax_confirmation_set_idx ON loan_allocation_tax_confirmation (allocation_set_id, confirmed_at DESC)`.execute(db);

  await guards(db);
}

async function guards(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION tax_year_acknowledgement_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      -- The PropertyReference first: the lock order of every writer of it (§59, §58E "Concurrency").
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      IF NEW.status <> 'ACTIVE' OR NEW.version <> 1 OR NEW.withdrawn_at IS NOT NULL OR NEW.withdrawn_by IS NOT NULL OR NEW.withdraw_reason IS NOT NULL THEN
        RAISE EXCEPTION 'TaxYearAcknowledgement: only inserted ACTIVE with version 1, not withdrawn (api-design §58E)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.created_txid <> txid_current() THEN
        RAISE EXCEPTION 'TaxYearAcknowledgement: created_txid is the inserting transaction''s, never given (api-design §58E)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_year_acknowledgement_insert BEFORE INSERT ON tax_year_acknowledgement
      FOR EACH ROW EXECUTE FUNCTION tax_year_acknowledgement_insert()
  `.execute(db);

  // One function for both tables: the only change is ACTIVE → WITHDRAWN with its three fields and version + 1.
  await sql`
    CREATE FUNCTION tax_statement_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '% %: a statement is never deleted (api-design §58E)', TG_TABLE_NAME, OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status <> 'ACTIVE' OR NEW.status <> 'WITHDRAWN' OR NEW.version <> OLD.version + 1
         OR NEW.withdrawn_at IS NULL OR NEW.withdrawn_by IS NULL OR NEW.withdraw_reason IS NULL
         OR (to_jsonb(NEW) - 'status' - 'withdrawn_at' - 'withdrawn_by' - 'withdraw_reason' - 'version')
            IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'withdrawn_at' - 'withdrawn_by' - 'withdraw_reason' - 'version') THEN
        RAISE EXCEPTION '% %: the only change is ACTIVE → WITHDRAWN with its reason (api-design §58E)', TG_TABLE_NAME, OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  for (const table of ['tax_year_acknowledgement', 'loan_allocation_tax_confirmation']) {
    await sql`
      CREATE TRIGGER ${sql.raw(`${table}_frozen`)} BEFORE UPDATE OR DELETE ON ${sql.table(table)}
        FOR EACH ROW EXECUTE FUNCTION tax_statement_frozen()
    `.execute(db);
  }

  await sql`
    CREATE FUNCTION tax_year_acknowledgement_item_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'TaxYearAcknowledgement: items are append-only, never changed or deleted (api-design §58E)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- Never xmin: the withdrawal gives the acknowledgement row the withdrawing transaction's xmin (as 0052).
      IF NOT EXISTS (SELECT 1 FROM tax_year_acknowledgement WHERE id = NEW.acknowledgement_id AND created_txid = txid_current()) THEN
        RAISE EXCEPTION 'TaxYearAcknowledgement %: items are inserted only by the transaction that recorded it (api-design §58E)', NEW.acknowledgement_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_year_acknowledgement_item_append_only BEFORE INSERT OR UPDATE OR DELETE ON tax_year_acknowledgement_item
      FOR EACH ROW EXECUTE FUNCTION tax_year_acknowledgement_item_append_only()
  `.execute(db);

  await sql`
    CREATE FUNCTION loan_allocation_tax_confirmation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      set_status text;
      set_basis text;
      set_loan uuid;
      entries integer;
    BEGIN
      SELECT loan_id INTO set_loan FROM loan_allocation_set WHERE id = NEW.allocation_set_id;
      -- P3-D8: the Loan row first, as loan_allocation_set_append and _frozen, so a confirmation serialises with them.
      UPDATE loan SET version = version WHERE id = set_loan;
      SELECT status, basis INTO set_status, set_basis FROM loan_allocation_set WHERE id = NEW.allocation_set_id;
      SELECT count(*) INTO entries FROM loan_allocation WHERE set_id = NEW.allocation_set_id;
      IF set_status IS DISTINCT FROM 'VALID' OR set_basis IS DISTINCT FROM 'PURCHASE_PRICE' OR entries < 2 THEN
        RAISE EXCEPTION 'LoanAllocationTaxConfirmation: only a VALID PURCHASE_PRICE set with more than one entry is confirmed, not % / % / % entries (api-design §58E)',
          coalesce(set_status, 'unknown'), coalesce(set_basis, 'unknown'), entries USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status <> 'ACTIVE' OR NEW.version <> 1 OR NEW.withdrawn_at IS NOT NULL OR NEW.withdrawn_by IS NOT NULL OR NEW.withdraw_reason IS NOT NULL THEN
        RAISE EXCEPTION 'LoanAllocationTaxConfirmation: only inserted ACTIVE with version 1, not withdrawn (api-design §58E)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER loan_allocation_tax_confirmation_insert BEFORE INSERT ON loan_allocation_tax_confirmation
      FOR EACH ROW EXECUTE FUNCTION loan_allocation_tax_confirmation_insert()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is dropped: a person's statement is never dropped silently (api-design §58E).
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM tax_year_acknowledgement) OR EXISTS (SELECT 1 FROM loan_allocation_tax_confirmation) THEN
        RAISE EXCEPTION 'tax_year_acknowledgement / loan_allocation_tax_confirmation: a statement exists; it is never dropped silently (api-design §58E)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP TABLE tax_year_acknowledgement_item`.execute(db);
  await sql`DROP TABLE tax_year_acknowledgement`.execute(db);
  await sql`DROP TABLE loan_allocation_tax_confirmation`.execute(db);
  await sql`DROP FUNCTION tax_year_acknowledgement_item_append_only()`.execute(db);
  await sql`DROP FUNCTION loan_allocation_tax_confirmation_insert()`.execute(db);
  await sql`DROP FUNCTION tax_statement_frozen()`.execute(db);
  await sql`DROP FUNCTION tax_year_acknowledgement_insert()`.execute(db);
}

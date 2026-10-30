import { sql, type Kysely } from 'kysely';

/** A signed EUR amount check: two decimals at most, below 10^15 in magnitude. */
const money = (column: string) => sql.raw(`CHECK (scale(${column}) <= 2 AND abs(${column}) < 1e15)`);

/**
 * VC-6-05: the Sonderumlage (data-model.md §32, api-design.md §51A, phase-6-plan P6-D7).
 *
 * - The category `WEG_SPECIAL_ASSESSMENT` (`Sonderumlage`, `WEG_FUNDS`, P6-D3).
 * - `weg_special_assessment`: per membership (composite foreign key); description, resolution date, purpose, the WEG
 *   total and the unit's share, instalments and uses (`jsonb`, shape checked by the API); `ACTIVE` → `VOID`.
 *   `weg_special_assessment_membership` (before insert): the unit first, then the membership `ACTIVE` and the
 *   resolution date inside it. `weg_special_assessment_frozen`: membership, resolution date and creation never change;
 *   `VOID` is final; `version` + 1; the no-op passes. `weg_special_assessment_void_unreferenced`: `VOID` only while no
 *   split names it (ASSESSMENT_HAS_SPLITS). Only inserted `ACTIVE` with `version` 1; never deleted.
 * - `transaction_split.weg_special_assessment_id`: composite foreign key; only with a unit, never with a Loan, a deposit
 *   or a statement. `transaction_split_weg_assessment` (after `transaction_split_weg_statement` by name): the unit, then
 *   the assessment (no-op, `RETURNING`), then category, unit and status (reversal exempt).
 * - The WEG category lists of `transaction_split_weg`, `ledger_transaction_weg_booking_date` and `weg_membership_guard`
 *   (0043's) gain `WEG_SPECIAL_ASSESSMENT`; splits naming an assessment take the exemption of §51's settlements (they
 *   follow the assessment, not the booking date). `down` restores 0043's bodies.
 * - `weg_membership_assessments` (after `weg_membership_statements` by name): MEMBERSHIP_HAS_ASSESSMENTS.
 * - 0014's mirror compares `weg_special_assessment_id` too.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`INSERT INTO financial_category (code, name, category_type) VALUES ('WEG_SPECIAL_ASSESSMENT', 'Sonderumlage', 'WEG_FUNDS')`.execute(db);

  await sql`
    CREATE TABLE weg_special_assessment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      membership_id uuid NOT NULL,
      description text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
      resolution_date date NOT NULL,
      purpose text NOT NULL CHECK (purpose IN ('MAINTENANCE', 'MODERNISATION', 'LIQUIDITY', 'OTHER')),
      total_amount numeric ${money('total_amount')} CHECK (total_amount >= 0),
      unit_share numeric NOT NULL ${money('unit_share')} CHECK (unit_share > 0),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      instalments jsonb NOT NULL CHECK (jsonb_typeof(instalments) = 'array' AND jsonb_array_length(instalments) BETWEEN 1 AND 24),
      uses jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(uses) = 'array' AND jsonb_array_length(uses) <= 50),
      status text NOT NULL CHECK (status IN ('ACTIVE', 'VOID')),
      voided_at timestamptz,
      voided_by text,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      source_references text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_references) <= 10 AND weg_texts_valid(source_references)),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT weg_special_assessment_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT weg_special_assessment_membership_fk FOREIGN KEY (membership_id, mre_realm_id) REFERENCES weg_membership (id, mre_realm_id),
      CONSTRAINT weg_special_assessment_void_fields CHECK (
        (status = 'VOID') = (voided_at IS NOT NULL) AND (status = 'VOID') = (voided_by IS NOT NULL) AND (status = 'VOID') = (void_reason IS NOT NULL)
      )
    )
  `.execute(db);
  await sql`CREATE INDEX weg_special_assessment_membership_idx ON weg_special_assessment (membership_id, resolution_date, created_at, id)`.execute(db);
  await sql`CREATE TRIGGER weg_special_assessment_initial BEFORE INSERT ON weg_special_assessment FOR EACH ROW EXECUTE FUNCTION weg_initial()`.execute(db);
  await sql`CREATE TRIGGER weg_special_assessment_no_delete BEFORE DELETE ON weg_special_assessment FOR EACH ROW EXECUTE FUNCTION weg_no_delete()`.execute(db);

  await sql`
    CREATE FUNCTION weg_special_assessment_membership() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      m record;
      unit uuid;
    BEGIN
      SELECT property_reference_id INTO unit FROM weg_membership WHERE id = NEW.membership_id;
      IF unit IS NULL THEN
        RETURN NEW; -- an unknown membership is left to the foreign key
      END IF;
      -- First the unit, as every membership writer: an end or void of the membership waits, or this waits for it.
      UPDATE property_reference SET version = version WHERE id = unit;
      SELECT wm.status, wm.valid_from, wm.valid_until INTO m FROM weg_membership wm WHERE wm.id = NEW.membership_id;
      IF m.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'WegSpecialAssessment: membership % is % (MEMBERSHIP_NOT_ACTIVE)', NEW.membership_id, m.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NOT (NEW.resolution_date <@ daterange(m.valid_from, m.valid_until, '[]')) THEN
        RAISE EXCEPTION 'WegSpecialAssessment: % is outside membership % (ASSESSMENT_OUTSIDE_MEMBERSHIP)', NEW.resolution_date, NEW.membership_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_special_assessment_membership BEFORE INSERT ON weg_special_assessment
      FOR EACH ROW EXECUTE FUNCTION weg_special_assessment_membership()
  `.execute(db);

  await sql`
    CREATE FUNCTION weg_special_assessment_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'VOID' THEN
        RAISE EXCEPTION 'WegSpecialAssessment %: VOID is final (api-design §51A)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.version <> OLD.version + 1
         OR (NEW.id, NEW.mre_realm_id, NEW.membership_id, NEW.resolution_date, NEW.created_at, NEW.created_by)
            IS DISTINCT FROM (OLD.id, OLD.mre_realm_id, OLD.membership_id, OLD.resolution_date, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'WegSpecialAssessment %: version + 1; membership, resolution date and creation never change (api-design §51A)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_special_assessment_frozen BEFORE UPDATE ON weg_special_assessment FOR EACH ROW EXECUTE FUNCTION weg_special_assessment_frozen()
  `.execute(db);

  await sql`
    ALTER TABLE transaction_split
      ADD COLUMN weg_special_assessment_id uuid,
      ADD CONSTRAINT transaction_split_weg_assessment_fk FOREIGN KEY (weg_special_assessment_id, mre_realm_id) REFERENCES weg_special_assessment (id, mre_realm_id),
      ADD CONSTRAINT transaction_split_weg_assessment_alone CHECK (
        weg_special_assessment_id IS NULL
        OR (property_reference_id IS NOT NULL AND loan_id IS NULL AND security_deposit_id IS NULL AND weg_annual_statement_id IS NULL)
      )
  `.execute(db);
  await sql`
    CREATE INDEX transaction_split_weg_assessment_idx ON transaction_split (weg_special_assessment_id) WHERE weg_special_assessment_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE FUNCTION weg_special_assessment_void_unreferenced() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM transaction_split WHERE weg_special_assessment_id = NEW.id) THEN
        RAISE EXCEPTION 'WegSpecialAssessment %: splits name it, reversals included (ASSESSMENT_HAS_SPLITS)', NEW.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_special_assessment_void_unreferenced BEFORE UPDATE ON weg_special_assessment
      FOR EACH ROW WHEN (OLD.status <> 'VOID' AND NEW.status = 'VOID') EXECUTE FUNCTION weg_special_assessment_void_unreferenced()
  `.execute(db);

  await sql`
    CREATE FUNCTION transaction_split_weg_assessment() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      category text;
      assessment record;
      unit uuid;
      role text;
    BEGIN
      IF NEW.property_reference_id IS NULL THEN
        RETURN NEW; -- left to transaction_split_weg_assessment_alone
      END IF;
      -- Transaction → PropertyReference → assessment (§51A): the unit first, as every WEG writer, then the assessment.
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      UPDATE weg_special_assessment SET version = version WHERE id = NEW.weg_special_assessment_id RETURNING status, membership_id INTO assessment;
      IF assessment.membership_id IS NULL THEN
        RETURN NEW; -- an unknown assessment is left to the foreign key
      END IF;
      SELECT code INTO category FROM financial_category WHERE id = NEW.financial_category_id;
      IF category IS DISTINCT FROM 'WEG_SPECIAL_ASSESSMENT' THEN
        RAISE EXCEPTION 'TransactionSplit: a split naming a Sonderumlage is WEG_SPECIAL_ASSESSMENT, not % (INVALID_WEG_ASSESSMENT_SPLIT)', category
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT property_reference_id INTO unit FROM weg_membership WHERE id = assessment.membership_id;
      IF unit IS DISTINCT FROM NEW.property_reference_id THEN
        RAISE EXCEPTION 'TransactionSplit: unit % is not the unit % of Sonderumlage % (INVALID_WEG_ASSESSMENT_SPLIT)', NEW.property_reference_id, unit,
          NEW.weg_special_assessment_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT correction_role INTO role FROM ledger_transaction WHERE id = NEW.transaction_id;
      IF assessment.status <> 'ACTIVE' AND role IS DISTINCT FROM 'REVERSAL' THEN
        RAISE EXCEPTION 'TransactionSplit: Sonderumlage % is % (ASSESSMENT_NOT_ACTIVE)', NEW.weg_special_assessment_id, assessment.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  // Sorts after transaction_split_weg and transaction_split_weg_statement: BEFORE triggers fire in name order.
  await sql`
    CREATE TRIGGER transaction_split_weg_assessment BEFORE INSERT OR UPDATE ON transaction_split
      FOR EACH ROW WHEN (NEW.weg_special_assessment_id IS NOT NULL) EXECUTE FUNCTION transaction_split_weg_assessment()
  `.execute(db);

  await sql`
    CREATE FUNCTION weg_membership_assessments() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      kept daterange;
      held uuid;
    BEGIN
      IF OLD.status <> 'ACTIVE' OR (NEW.status, NEW.valid_until) IS NOT DISTINCT FROM (OLD.status, OLD.valid_until) THEN
        RETURN NEW;
      END IF;
      -- First the unit (weg_membership_guard did too): a concurrent assessment writer is waited for and seen.
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      kept := CASE WHEN NEW.status = 'VOID' THEN 'empty'::daterange ELSE daterange(NEW.valid_from, NEW.valid_until, '[]') END;
      SELECT a.id INTO held FROM weg_special_assessment a
       WHERE a.membership_id = OLD.id AND a.status <> 'VOID' AND NOT (a.resolution_date <@ kept)
       LIMIT 1;
      IF held IS NOT NULL THEN
        RAISE EXCEPTION 'WegMembership %: Sonderumlage % lies outside the remaining period (MEMBERSHIP_HAS_ASSESSMENTS)', OLD.id, held
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_membership_assessments BEFORE UPDATE OF valid_until, status ON weg_membership FOR EACH ROW EXECUTE FUNCTION weg_membership_assessments()
  `.execute(db);

  await sql`CREATE OR REPLACE FUNCTION transaction_split_weg() RETURNS trigger LANGUAGE plpgsql AS $$${splitWegBody(true)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_weg_booking_date() RETURNS trigger LANGUAGE plpgsql AS $$${bookingDateBody(true)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION weg_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$${membershipGuardBody(true)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_reversal_mirror() RETURNS trigger LANGUAGE plpgsql AS $$${mirrorBody(true)}$$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_reversal_mirror() RETURNS trigger LANGUAGE plpgsql AS $$${mirrorBody(false)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION weg_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$${membershipGuardBody(false)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_weg_booking_date() RETURNS trigger LANGUAGE plpgsql AS $$${bookingDateBody(false)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION transaction_split_weg() RETURNS trigger LANGUAGE plpgsql AS $$${splitWegBody(false)}$$`.execute(db);
  await sql`DROP TRIGGER weg_membership_assessments ON weg_membership`.execute(db);
  await sql`DROP FUNCTION weg_membership_assessments()`.execute(db);
  await sql`DROP TRIGGER transaction_split_weg_assessment ON transaction_split`.execute(db);
  await sql`DROP FUNCTION transaction_split_weg_assessment()`.execute(db);
  await sql`ALTER TABLE transaction_split DROP COLUMN weg_special_assessment_id`.execute(db);
  await sql`DROP TABLE weg_special_assessment`.execute(db);
  await sql`DROP FUNCTION weg_special_assessment_void_unreferenced()`.execute(db);
  await sql`DROP FUNCTION weg_special_assessment_frozen()`.execute(db);
  await sql`DROP FUNCTION weg_special_assessment_membership()`.execute(db);
  // Only while no split uses it: the split's foreign key refuses the delete otherwise.
  await sql`DELETE FROM financial_category WHERE code = 'WEG_SPECIAL_ASSESSMENT'`.execute(db);
}

/** The WEG categories (§49.3); with `assessments`, the Sonderumlage's too (§51A). */
const categories = (assessments: boolean) =>
  `'WEG_RECOVERABLE', 'WEG_NON_RECOVERABLE', 'WEG_RESERVE_CONTRIBUTION'${assessments ? `, 'WEG_SPECIAL_ASSESSMENT'` : ''}`;

/** 0043's `transaction_split_weg`; with `assessments`, the Sonderumlage's category and its exemption. */
function splitWegBody(assessments: boolean) {
  return sql.raw(`
    DECLARE
      category text;
      tx record;
    BEGIN
      SELECT code INTO category FROM financial_category WHERE id = NEW.financial_category_id;
      IF category NOT IN (${categories(assessments)}) THEN
        RETURN NEW;
      END IF;
      SELECT booking_date, correction_role INTO tx FROM ledger_transaction WHERE id = NEW.transaction_id;
      -- A reversal mirrors its original's splits, which may predate Phase 6 (§49.3).
      IF tx.correction_role IS NOT DISTINCT FROM 'REVERSAL' THEN
        RETURN NEW;
      END IF;
      IF NEW.property_reference_id IS NULL THEN
        RAISE EXCEPTION 'TransactionSplit: a % split names its unit (NO_WEG_MEMBERSHIP)', category USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- Transaction → PropertyReference: serialises with an end or void of the unit's membership (§49.3).
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      -- A settlement is checked against its statement's membership (§51, transaction_split_weg_statement)${
        assessments
          ? `, a Sonderumlage's
      -- payment against the assessment's (§51A, transaction_split_weg_assessment)`
          : ''
      }.
      IF NEW.weg_annual_statement_id IS NOT NULL${assessments ? ' OR NEW.weg_special_assessment_id IS NOT NULL' : ''} THEN
        RETURN NEW;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM weg_membership m
         WHERE m.property_reference_id = NEW.property_reference_id AND m.status = 'ACTIVE'
           AND tx.booking_date <@ daterange(m.valid_from, m.valid_until, '[]')
      ) THEN
        RAISE EXCEPTION 'TransactionSplit: unit % has no WEG membership on % (NO_WEG_MEMBERSHIP)', NEW.property_reference_id, tx.booking_date
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END`);
}

/** The splits that follow their booking date: neither a settlement (§51) nor, with `assessments`, a Sonderumlage's. */
const datedSplits = (assessments: boolean) => `AND s.weg_annual_statement_id IS NULL${assessments ? ' AND s.weg_special_assessment_id IS NULL' : ''}`;

/** 0043's `ledger_transaction_weg_booking_date`; with `assessments`, the Sonderumlage's category and exemption. */
function bookingDateBody(assessments: boolean) {
  return sql.raw(`
    DECLARE
      unit uuid;
    BEGIN
      IF NEW.correction_role IS NOT DISTINCT FROM 'REVERSAL' THEN
        RETURN NEW;
      END IF;
      -- The kept WEG splits need their unit's membership on the new date (review on #147); units in id order, each
      -- written first (Transaction → PropertyReference), as transaction_split_weg does.
      FOR unit IN
        SELECT DISTINCT s.property_reference_id FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id
         WHERE s.transaction_id = NEW.id AND s.property_reference_id IS NOT NULL
           AND c.code IN (${categories(assessments)})
           ${datedSplits(assessments)}
         ORDER BY 1
      LOOP
        UPDATE property_reference SET version = version WHERE id = unit;
        IF NOT EXISTS (
          SELECT 1 FROM weg_membership m WHERE m.property_reference_id = unit AND m.status = 'ACTIVE'
             AND NEW.booking_date <@ daterange(m.valid_from, m.valid_until, '[]')
        ) THEN
          RAISE EXCEPTION 'Transaction %: unit % has no WEG membership on % (NO_WEG_MEMBERSHIP)', NEW.id, unit, NEW.booking_date
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
      RETURN NEW;
    END`);
}

/** 0043's `weg_membership_guard`; with `assessments`, the Sonderumlage's category and exemption. */
function membershipGuardBody(assessments: boolean) {
  return sql.raw(`
    DECLARE
      kept daterange;
      old_period daterange := daterange(OLD.valid_from, OLD.valid_until, '[]');
      held uuid;
    BEGIN
      IF OLD.status <> 'ACTIVE' OR (NEW.status, NEW.valid_until) IS NOT DISTINCT FROM (OLD.status, OLD.valid_until) THEN
        RETURN NEW;
      END IF;
      -- First the unit: a concurrent split or plan writer is waited for and seen (review on #146).
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      kept := CASE WHEN NEW.status = 'VOID' THEN 'empty'::daterange ELSE daterange(NEW.valid_from, NEW.valid_until, '[]') END;
      SELECT s.transaction_id INTO held FROM transaction_split s
        JOIN financial_category c ON c.id = s.financial_category_id
        JOIN ledger_transaction t ON t.id = s.transaction_id
       WHERE s.property_reference_id = NEW.property_reference_id
         AND c.code IN (${categories(assessments)})
         ${datedSplits(assessments)}
         AND t.booking_date <@ old_period AND NOT (t.booking_date <@ kept)
       LIMIT 1;
      IF held IS NOT NULL THEN
        RAISE EXCEPTION 'WegMembership %: Transaction % has a WEG split of the unit outside the remaining period (MEMBERSHIP_HAS_SPLITS)', OLD.id, held
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT p.id INTO held FROM weg_economic_plan p
       WHERE p.membership_id = OLD.id AND p.status = 'ACTIVE' AND NOT (p.effective_from <@ kept)
       LIMIT 1;
      IF held IS NOT NULL THEN
        RAISE EXCEPTION 'WegMembership %: plan % lies outside the remaining period (MEMBERSHIP_HAS_PLANS)', OLD.id, held
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END`);
}

/** 0043's mirror check; with `assessments` the compared multiset includes `weg_special_assessment_id` (§51A). */
function mirrorBody(assessments: boolean) {
  const columns = `financial_category_id, property_reference_id, loan_id, security_deposit_id, weg_annual_statement_id, ${assessments ? 'weg_special_assessment_id, ' : ''}amount, currency`;
  return sql.raw(`
    DECLARE
      cur ledger_transaction%ROWTYPE;
    BEGIN
      -- The row as it is now, as in the chain check of 0011.
      SELECT * INTO cur FROM ledger_transaction WHERE id = NEW.id;
      IF cur.correction_role IS DISTINCT FROM 'REVERSAL' THEN
        RETURN NULL;
      END IF;
      IF EXISTS (
           (SELECT ${columns} FROM transaction_split WHERE transaction_id = cur.id
            EXCEPT ALL
            SELECT ${columns} FROM transaction_split
              WHERE transaction_id = cur.correction_of_transaction_id)
           UNION ALL
           (SELECT ${columns} FROM transaction_split
              WHERE transaction_id = cur.correction_of_transaction_id
            EXCEPT ALL
            SELECT ${columns} FROM transaction_split WHERE transaction_id = cur.id)) THEN
        RAISE EXCEPTION 'reversal % does not mirror the splits of Transaction % (category, PropertyReference, Loan, security deposit, WEG statement, ${assessments ? 'Sonderumlage, ' : ''}amount; api-design §35.3)',
          cur.id, cur.correction_of_transaction_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END`);
}

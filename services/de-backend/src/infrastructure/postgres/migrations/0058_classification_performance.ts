import { sql, type Kysely } from 'kysely';

/**
 * VC-X-38: the period of performance on a classification (api-design.md §59F "In the database", "As implemented
 * (VC-X-38)"; tax review of 2026-11-01, questions 5, 14 and 16, mündlich bestätigt durch den Steuerberater, laut
 * Projektinhaber am 2026-11-01; the owner's decisions of 2026-11-02).
 *
 * **Migration 0058: merge after #237 (VC-X-39, 0057), which is already on main.** 0056 is VC-X-41 Part 1's; Kysely's
 * Migrator refuses a name sorting before an applied one, so the number follows the merge order.
 *
 * - `up` refuses while any `depreciation_schedule_version` row exists: nothing productive is recorded (the switch has
 *   never been on), and a recorded item component without its performance could not be re-derived. A non-production
 *   database is reset instead.
 * - `tax_classification` gains `performed_from`, `performed_until` (both set or both null, from ≤ until) and
 *   `performance_progress_estimated` (set exactly when points exist, checked at commit), and `created_txid` (the
 *   inserting transaction, by default; null on the rows before 0058). `tax_classification_performance_allowed`: never with
 *   `NOT_RELEVANT`, on a deposit closing or on an interest line (`LOAN_INTEREST`, `FINANCING_COSTS`); else on
 *   `MAINTENANCE`/`WEG_SPENDING`, or with `CAPITALIZED`. The frozen trigger (0047's `tax_classification_weg_source_fixed`)
 *   covers the new columns.
 * - `tax_classification_performance_progress`: 1–5 points by `position`, `through` a date, `amount` > 0; inserted only by
 *   the classification's own transaction, never changed or deleted. A deferred trigger checks at commit that the points
 *   lie in [`performed_from`, `performed_until`) and ascend strictly in date and amount, and that the estimate flag is set
 *   exactly with points. The amount against the amount used is the repository's check (it needs the source).
 * - 0047's `tax_classification_anschaffungsnahe` is replaced: with an anschaffungsnahe link, `performed_from` and
 *   `performed_until` are required and lie within the transfer date and three years later; the source's date is no longer
 *   compared (a straddling source is capitalised only by an evidenced split, the owner's decision of 2026-11-02).
 * - `depreciation_schedule_version_component` (0052) gains `item_performed_from`, `item_performed_until`: set together,
 *   only on a `CAPITALIZED_ITEM`, exactly when `start_date_source` is `PERFORMANCE_UNTIL` (and then `start_date` is the
 *   completion).
 * - **No backfill** (the owner's decision of 2026-11-02, §59F open question 13): no performance is set.
 * - `down` refuses while a classification states a performance or a recorded version exists; else it restores 0047's
 *   two functions and drops what this added.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version) THEN
        RAISE EXCEPTION 'depreciation_schedule_version: recorded versions exist; 0058 (api-design §59F) needs a database without them: reset this non-production database'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);

  await sql`
    ALTER TABLE tax_classification
      ADD COLUMN performed_from date,
      ADD COLUMN performed_until date,
      ADD COLUMN performance_progress_estimated boolean,
      ADD COLUMN created_txid bigint,
      ADD CONSTRAINT tax_classification_performance CHECK (
        (performed_from IS NULL) = (performed_until IS NULL)
          AND (performed_from IS NULL OR performed_from <= performed_until)
          AND (performance_progress_estimated IS NULL OR performed_from IS NOT NULL)
      ),
      ADD CONSTRAINT tax_classification_performance_allowed CHECK (
        performed_from IS NULL OR (
          source_type <> 'DEPOSIT_CLOSING'
            AND treatment IS DISTINCT FROM 'NOT_RELEVANT'
            AND tax_category NOT IN ('LOAN_INTEREST', 'FINANCING_COSTS')
            AND (tax_category IN ('MAINTENANCE', 'WEG_SPENDING') OR treatment = 'CAPITALIZED')
        )
      )
  `.execute(db);
  // Set after the column exists, so the rows before 0058 keep NULL (no backfill) and every later insert takes its own.
  await sql`ALTER TABLE tax_classification ALTER COLUMN created_txid SET DEFAULT txid_current()`.execute(db);

  await sql`
    CREATE TABLE tax_classification_performance_progress (
      classification_id uuid NOT NULL REFERENCES tax_classification (id),
      position integer NOT NULL CHECK (position BETWEEN 1 AND 5),
      through date NOT NULL,
      amount numeric(14, 2) NOT NULL CHECK (amount > 0),
      created_txid bigint NOT NULL DEFAULT txid_current(),
      CONSTRAINT tax_classification_performance_progress_key PRIMARY KEY (classification_id, position)
    )
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_created_txid() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.created_txid IS DISTINCT FROM txid_current() THEN
        RAISE EXCEPTION 'TaxClassification: created_txid is the inserting transaction''s, never given (api-design §59F)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_created_txid BEFORE INSERT ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_created_txid()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_performance_progress_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'TaxClassification: the points of a performance are never changed or deleted; supersede the classification (api-design §59F)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.created_txid <> txid_current()
         OR NOT EXISTS (SELECT 1 FROM tax_classification WHERE id = NEW.classification_id AND created_txid = txid_current()) THEN
        RAISE EXCEPTION 'TaxClassification %: the points are inserted only by the transaction that created it (api-design §59F)', NEW.classification_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_performance_progress_append_only BEFORE INSERT OR UPDATE OR DELETE ON tax_classification_performance_progress
      FOR EACH ROW EXECUTE FUNCTION tax_classification_performance_progress_append_only()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_performance_points() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      c record;
      point record;
      points integer := 0;
      last_through date;
      last_amount numeric;
    BEGIN
      SELECT id, performed_from, performed_until, performance_progress_estimated INTO c FROM tax_classification WHERE id = NEW.id;
      FOR point IN SELECT position, through, amount FROM tax_classification_performance_progress WHERE classification_id = c.id ORDER BY position LOOP
        points := points + 1;
        IF point.position <> points OR c.performed_from IS NULL OR point.through < c.performed_from OR point.through >= c.performed_until
           OR (last_through IS NOT NULL AND (point.through <= last_through OR point.amount <= last_amount)) THEN
          RAISE EXCEPTION 'TaxClassification %: point % (% / %) is not within [%, %) or does not ascend strictly (api-design §59F)',
            c.id, point.position, point.through, point.amount, c.performed_from, c.performed_until
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        last_through := point.through;
        last_amount := point.amount;
      END LOOP;
      IF (points > 0) <> (c.performance_progress_estimated IS NOT NULL) THEN
        RAISE EXCEPTION 'TaxClassification %: performance_progress_estimated is set exactly with points (% points) (api-design §59F)', c.id, points
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER tax_classification_performance_points AFTER INSERT ON tax_classification
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tax_classification_performance_points()
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION tax_classification_anschaffungsnahe() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      acq record;
      source_reference uuid;
    BEGIN
      IF NEW.anschaffungsnahe_acquisition_id IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT id, status, property_reference_id, coalesce(economic_transfer_date, contract_date) AS transfer_date INTO acq
        FROM acquisition WHERE id = NEW.anschaffungsnahe_acquisition_id AND mre_realm_id = NEW.mre_realm_id;
      IF acq.id IS NULL THEN
        RETURN NEW; -- left to the foreign key
      END IF;
      IF NEW.transaction_split_id IS NOT NULL THEN
        SELECT s.property_reference_id INTO source_reference FROM transaction_split s WHERE s.id = NEW.transaction_split_id;
      ELSIF NEW.weg_annual_statement_id IS NOT NULL THEN
        SELECT m.property_reference_id INTO source_reference
          FROM weg_annual_statement st JOIN weg_membership m ON m.id = st.membership_id WHERE st.id = NEW.weg_annual_statement_id;
      ELSIF NEW.weg_special_assessment_id IS NOT NULL THEN
        SELECT m.property_reference_id INTO source_reference
          FROM weg_special_assessment a JOIN weg_membership m ON m.id = a.membership_id WHERE a.id = NEW.weg_special_assessment_id;
      END IF;
      -- DE_ANSCHAFFUNGSNAHE@1 (§58B, §59F): the work performed wholly within the transfer date and three years later.
      IF acq.status <> 'CONFIRMED' OR acq.property_reference_id IS DISTINCT FROM source_reference
         OR NEW.performed_from IS NULL OR NEW.performed_until IS NULL
         OR NEW.performed_from < acq.transfer_date OR NEW.performed_until > acq.transfer_date + interval '3 years' THEN
        RAISE EXCEPTION 'TaxClassification: Acquisition % is % and does not hold the work performed % to % (ANSCHAFFUNGSNAHE_NOT_APPLICABLE)',
          acq.id, acq.status, NEW.performed_from, NEW.performed_until
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION tax_classification_weg_source_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.weg_annual_statement_id, NEW.weg_reserve_position, NEW.weg_withdrawal_unit_share, NEW.weg_special_assessment_id, NEW.weg_use_position,
          NEW.weg_use_date, NEW.weg_use_unit_share, NEW.net_amount, NEW.annually_recurring, NEW.distribution_years, NEW.mostly_residential_confirmed,
          NEW.anschaffungsnahe_acquisition_id, NEW.treatment_rule_code, NEW.treatment_rule_version,
          NEW.performed_from, NEW.performed_until, NEW.performance_progress_estimated, NEW.created_txid)
         IS DISTINCT FROM
         (OLD.weg_annual_statement_id, OLD.weg_reserve_position, OLD.weg_withdrawal_unit_share, OLD.weg_special_assessment_id, OLD.weg_use_position,
          OLD.weg_use_date, OLD.weg_use_unit_share, OLD.net_amount, OLD.annually_recurring, OLD.distribution_years, OLD.mostly_residential_confirmed,
          OLD.anschaffungsnahe_acquisition_id, OLD.treatment_rule_code, OLD.treatment_rule_version,
          OLD.performed_from, OLD.performed_until, OLD.performance_progress_estimated, OLD.created_txid) THEN
        RAISE EXCEPTION 'TaxClassification %: the WEG source and the fields of §58B and §59F never change (api-design §58B, §59F)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);

  await sql`
    ALTER TABLE depreciation_schedule_version_component
      ADD COLUMN item_performed_from date,
      ADD COLUMN item_performed_until date,
      ADD CONSTRAINT depreciation_schedule_version_component_performance CHECK (
        (item_performed_from IS NULL) = (item_performed_until IS NULL)
          AND (item_performed_from IS NULL OR (kind = 'CAPITALIZED_ITEM' AND item_performed_from <= item_performed_until))
          AND (start_date_source = 'PERFORMANCE_UNTIL') = (item_performed_until IS NOT NULL)
          AND (item_performed_until IS NULL OR start_date = item_performed_until)
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is dropped: a person's statement and a recorded version are never dropped silently.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM tax_classification WHERE performed_from IS NOT NULL) THEN
        RAISE EXCEPTION 'tax_classification: a classification states a performance; it is never dropped silently (api-design §59F)'
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version) THEN
        RAISE EXCEPTION 'depreciation_schedule_version: a recorded version exists; its performance dates are never dropped silently (api-design §59F)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`
    ALTER TABLE depreciation_schedule_version_component
      DROP CONSTRAINT depreciation_schedule_version_component_performance,
      DROP COLUMN item_performed_until,
      DROP COLUMN item_performed_from
  `.execute(db);
  // 0047's two functions, restored literally.
  await sql`
    CREATE OR REPLACE FUNCTION tax_classification_weg_source_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.weg_annual_statement_id, NEW.weg_reserve_position, NEW.weg_withdrawal_unit_share, NEW.weg_special_assessment_id, NEW.weg_use_position,
          NEW.weg_use_date, NEW.weg_use_unit_share, NEW.net_amount, NEW.annually_recurring, NEW.distribution_years, NEW.mostly_residential_confirmed,
          NEW.anschaffungsnahe_acquisition_id, NEW.treatment_rule_code, NEW.treatment_rule_version)
         IS DISTINCT FROM
         (OLD.weg_annual_statement_id, OLD.weg_reserve_position, OLD.weg_withdrawal_unit_share, OLD.weg_special_assessment_id, OLD.weg_use_position,
          OLD.weg_use_date, OLD.weg_use_unit_share, OLD.net_amount, OLD.annually_recurring, OLD.distribution_years, OLD.mostly_residential_confirmed,
          OLD.anschaffungsnahe_acquisition_id, OLD.treatment_rule_code, OLD.treatment_rule_version) THEN
        RAISE EXCEPTION 'TaxClassification %: the WEG source and the fields of §58B never change (api-design §58B)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION tax_classification_anschaffungsnahe() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      acq record;
      source_reference uuid;
      source_date date;
      st record;
      line jsonb;
    BEGIN
      IF NEW.anschaffungsnahe_acquisition_id IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT id, status, property_reference_id, coalesce(economic_transfer_date, contract_date) AS transfer_date INTO acq
        FROM acquisition WHERE id = NEW.anschaffungsnahe_acquisition_id AND mre_realm_id = NEW.mre_realm_id;
      IF acq.id IS NULL THEN
        RETURN NEW; -- left to the foreign key
      END IF;
      IF NEW.transaction_split_id IS NOT NULL THEN
        SELECT s.property_reference_id, t.booking_date INTO source_reference, source_date
          FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id WHERE s.id = NEW.transaction_split_id;
      ELSIF NEW.weg_annual_statement_id IS NOT NULL THEN
        SELECT st0.reserve, st0.period_until, m.property_reference_id AS pr INTO st
          FROM weg_annual_statement st0 JOIN weg_membership m ON m.id = st0.membership_id WHERE st0.id = NEW.weg_annual_statement_id;
        SELECT l INTO line FROM jsonb_array_elements(coalesce(st.reserve -> 'lines', '[]'::jsonb)) AS l
         WHERE (l ->> 'position')::integer = NEW.weg_reserve_position;
        source_reference := st.pr;
        source_date := coalesce((line ->> 'date')::date, st.period_until);
      ELSIF NEW.weg_special_assessment_id IS NOT NULL THEN
        SELECT m.property_reference_id INTO source_reference
          FROM weg_special_assessment a JOIN weg_membership m ON m.id = a.membership_id WHERE a.id = NEW.weg_special_assessment_id;
        source_date := NEW.weg_use_date;
      END IF;
      -- DE_ANSCHAFFUNGSNAHE@1 (§58B): the window is the transfer date to three years later, both inclusive.
      IF acq.status <> 'CONFIRMED' OR acq.property_reference_id IS DISTINCT FROM source_reference
         OR source_date IS NULL OR source_date < acq.transfer_date OR source_date > acq.transfer_date + interval '3 years' THEN
        RAISE EXCEPTION 'TaxClassification: Acquisition % is % and does not hold the source of % (ANSCHAFFUNGSNAHE_NOT_APPLICABLE)', acq.id, acq.status, source_date
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`DROP TRIGGER tax_classification_performance_points ON tax_classification`.execute(db);
  await sql`DROP TRIGGER tax_classification_created_txid ON tax_classification`.execute(db);
  await sql`DROP TABLE tax_classification_performance_progress`.execute(db);
  await sql`DROP FUNCTION tax_classification_performance_points()`.execute(db);
  await sql`DROP FUNCTION tax_classification_performance_progress_append_only()`.execute(db);
  await sql`DROP FUNCTION tax_classification_created_txid()`.execute(db);
  await sql`
    ALTER TABLE tax_classification
      DROP CONSTRAINT tax_classification_performance_allowed,
      DROP CONSTRAINT tax_classification_performance,
      DROP COLUMN created_txid,
      DROP COLUMN performance_progress_estimated,
      DROP COLUMN performed_until,
      DROP COLUMN performed_from
  `.execute(db);
}

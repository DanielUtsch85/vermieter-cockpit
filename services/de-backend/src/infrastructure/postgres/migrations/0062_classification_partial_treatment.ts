import { sql, type Kysely } from 'kysely';

/**
 * VC-X-38 Part 2: the partial treatment of a source straddling the anschaffungsnahe window's end (api-design.md §59F "As
 * implemented (VC-X-38 Part 2)"; Entscheidung des Projektinhabers, 2026-11-02, 239-2): one classification, two parts,
 * as the parts of §59D (0054): the part performed in the window `CAPITALIZED` on the check, the rest `DEDUCTIBLE`, the
 * amounts from the evidenced points (derived by the repository; the database checks their shape and their sum).
 *
 * **Migration 0062: merge after #251 (VC-X-41 Part 2, 0061).** Kysely's Migrator refuses a name sorting before an
 * applied one, so 0061 must be applied first; 0060 is VC-X-28's.
 *
 * - `tax_classification.partial_treatment` (boolean, `false` by default, so every earlier row keeps today's meaning; no
 *   backfill): `tax_classification_partial_treatment` allows it only with `treatment` `CAPITALIZED`, an anschaffungsnahe
 *   link and a performance, on `MAINTENANCE`/`WEG_SPENDING`, never on a deposit and never with a § 82b election. Frozen
 *   (0047's `tax_classification_weg_source_fixed`, extended).
 * - `tax_classification_treatment_part`: position 1 `CAPITALIZED`, position 2 `DEDUCTIBLE`, `amount` > 0; inserted only
 *   by the classification's own transaction (`created_txid`, 0058), never changed or deleted. A deferred trigger checks
 *   at commit that a partial treatment has exactly both parts summing to the source's amount (the split's amount, the
 *   withdrawal's or use's unit share as classified), and that any other classification has none. No cash row changes.
 * - 0058's `tax_classification_anschaffungsnahe` is replaced: a partial treatment needs a performance that straddles
 *   the window's end only (begun on or after the transfer date and no later than the window's end, completed after it);
 *   one begun before the transfer date (the start, or both edges) is refused, pending the owner's and the advisor's
 *   decision. Every other link keeps 0058's rule (the work performed wholly in the window).
 * - `down` refuses while a partial treatment exists; else it restores 0058's two functions and drops what this added.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tax_classification
      ADD COLUMN partial_treatment boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT tax_classification_partial_treatment CHECK (
        NOT partial_treatment OR (
          treatment = 'CAPITALIZED'
            AND anschaffungsnahe_acquisition_id IS NOT NULL
            AND performed_from IS NOT NULL
            AND tax_category IN ('MAINTENANCE', 'WEG_SPENDING')
            AND source_type <> 'DEPOSIT_CLOSING'
            AND distribution_years IS NULL
        )
      )
  `.execute(db);

  await sql`
    CREATE TABLE tax_classification_treatment_part (
      classification_id uuid NOT NULL REFERENCES tax_classification (id),
      position integer NOT NULL,
      treatment text NOT NULL,
      amount numeric(14, 2) NOT NULL CHECK (amount > 0),
      created_txid bigint NOT NULL DEFAULT txid_current(),
      CONSTRAINT tax_classification_treatment_part_key PRIMARY KEY (classification_id, position),
      CONSTRAINT tax_classification_treatment_part_kind CHECK ((position = 1 AND treatment = 'CAPITALIZED') OR (position = 2 AND treatment = 'DEDUCTIBLE'))
    )
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_treatment_part_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'TaxClassification: the parts of a partial treatment are never changed or deleted; supersede the classification (api-design §59F)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.created_txid <> txid_current()
         OR NOT EXISTS (SELECT 1 FROM tax_classification WHERE id = NEW.classification_id AND created_txid = txid_current()) THEN
        RAISE EXCEPTION 'TaxClassification %: the parts are inserted only by the transaction that created it (api-design §59F)', NEW.classification_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_treatment_part_append_only BEFORE INSERT OR UPDATE OR DELETE ON tax_classification_treatment_part
      FOR EACH ROW EXECUTE FUNCTION tax_classification_treatment_part_append_only()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_treatment_parts() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      c record;
      parts integer;
      parts_sum numeric;
      source_amount numeric;
    BEGIN
      SELECT id, partial_treatment, transaction_split_id, weg_withdrawal_unit_share, weg_use_unit_share INTO c FROM tax_classification WHERE id = NEW.id;
      SELECT count(*), coalesce(sum(amount), 0) INTO parts, parts_sum FROM tax_classification_treatment_part WHERE classification_id = c.id;
      IF NOT c.partial_treatment THEN
        IF parts > 0 THEN
          RAISE EXCEPTION 'TaxClassification %: parts without a partial treatment (api-design §59F)', c.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END IF;
      IF c.transaction_split_id IS NOT NULL THEN
        SELECT abs(s.amount) INTO source_amount FROM transaction_split s WHERE s.id = c.transaction_split_id;
      ELSE
        source_amount := coalesce(c.weg_withdrawal_unit_share, c.weg_use_unit_share);
      END IF;
      IF parts <> 2 OR source_amount IS NULL OR parts_sum <> source_amount THEN
        RAISE EXCEPTION 'TaxClassification %: a partial treatment has its two parts summing to the source''s amount (% parts, % of %) (api-design §59F)',
          c.id, parts, parts_sum, source_amount
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER tax_classification_treatment_parts AFTER INSERT ON tax_classification
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tax_classification_treatment_parts()
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION tax_classification_anschaffungsnahe() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      acq record;
      source_reference uuid;
      window_until date;
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
      window_until := acq.transfer_date + interval '3 years';
      -- DE_ANSCHAFFUNGSNAHE@1 (§58B, §59F): the work performed wholly within the transfer date and three years later; a
      -- partial treatment (VC-X-38 Part 2) only for work straddling the window's end: begun within it, completed after it.
      IF acq.status <> 'CONFIRMED' OR acq.property_reference_id IS DISTINCT FROM source_reference
         OR NEW.performed_from IS NULL OR NEW.performed_until IS NULL
         OR (NOT NEW.partial_treatment AND (NEW.performed_from < acq.transfer_date OR NEW.performed_until > window_until))
         OR (NEW.partial_treatment AND (NEW.performed_from < acq.transfer_date OR NEW.performed_from > window_until
                                        OR NEW.performed_until <= window_until)) THEN
        RAISE EXCEPTION 'TaxClassification: Acquisition % is % and does not hold the work performed % to % (partial: %) (ANSCHAFFUNGSNAHE_NOT_APPLICABLE)',
          acq.id, acq.status, NEW.performed_from, NEW.performed_until, NEW.partial_treatment
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
          NEW.performed_from, NEW.performed_until, NEW.performance_progress_estimated, NEW.created_txid, NEW.partial_treatment)
         IS DISTINCT FROM
         (OLD.weg_annual_statement_id, OLD.weg_reserve_position, OLD.weg_withdrawal_unit_share, OLD.weg_special_assessment_id, OLD.weg_use_position,
          OLD.weg_use_date, OLD.weg_use_unit_share, OLD.net_amount, OLD.annually_recurring, OLD.distribution_years, OLD.mostly_residential_confirmed,
          OLD.anschaffungsnahe_acquisition_id, OLD.treatment_rule_code, OLD.treatment_rule_version,
          OLD.performed_from, OLD.performed_until, OLD.performance_progress_estimated, OLD.created_txid, OLD.partial_treatment) THEN
        RAISE EXCEPTION 'TaxClassification %: the WEG source and the fields of §58B and §59F never change (api-design §58B, §59F)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is dropped: a person's partial treatment is never dropped silently.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM tax_classification WHERE partial_treatment) THEN
        RAISE EXCEPTION 'tax_classification: a classification states a partial treatment; it is never dropped silently (api-design §59F)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  // 0058's two functions, restored literally.
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
  await sql`DROP TRIGGER tax_classification_treatment_parts ON tax_classification`.execute(db);
  await sql`DROP TABLE tax_classification_treatment_part`.execute(db);
  await sql`DROP FUNCTION tax_classification_treatment_parts()`.execute(db);
  await sql`DROP FUNCTION tax_classification_treatment_part_append_only()`.execute(db);
  await sql`
    ALTER TABLE tax_classification
      DROP CONSTRAINT tax_classification_partial_treatment,
      DROP COLUMN partial_treatment
  `.execute(db);
}

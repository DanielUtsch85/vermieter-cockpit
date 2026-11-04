import { sql, type Kysely } from 'kysely';

/**
 * VC-X-34: the anschaffungsnahe check without `economicTransferDate` (api-design.md §58K "Database"; Entscheidung des
 * Projektinhabers, 2026-11-04, K1–K3, K5: without the transfer date the check is not computable, and a capitalisation on
 * it is refused with a guard). The window starts at the transfer of economic ownership, never at the contract date.
 *
 * - 0062's `tax_classification_anschaffungsnahe()` is replaced: it reads `economic_transfer_date` alone (no `coalesce`
 *   with `contract_date`) and raises `ANSCHAFFUNGSNAHE_NOT_APPLICABLE` (`TRANSFER_DATE_MISSING`) when it is `NULL`,
 *   before the window check; the window from `economic_transfer_date`. Everything else of 0062's function is unchanged.
 *   The trigger is `BEFORE INSERT`, so stored rows are not re-checked (classifications stored before keep their link).
 * - No table, column or CHECK changes; no backfill.
 * - `down` restores 0062's function literally. It refuses nothing: every row this guard accepts, 0062's accepts too (with
 *   the date set both windows are the same), so no stored row depends on it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
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
      SELECT id, status, property_reference_id, economic_transfer_date AS transfer_date INTO acq
        FROM acquisition WHERE id = NEW.anschaffungsnahe_acquisition_id AND mre_realm_id = NEW.mre_realm_id;
      IF acq.id IS NULL THEN
        RETURN NEW; -- left to the foreign key
      END IF;
      -- §58K (VC-X-34): without the transfer of economic ownership the check has no window; never the contract date.
      IF acq.transfer_date IS NULL THEN
        RAISE EXCEPTION 'TaxClassification: Acquisition % has no economic transfer date, TRANSFER_DATE_MISSING (ANSCHAFFUNGSNAHE_NOT_APPLICABLE)', acq.id
          USING ERRCODE = 'integrity_constraint_violation';
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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 0062's function, restored literally.
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
}

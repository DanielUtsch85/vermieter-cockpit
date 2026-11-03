import { sql, type Kysely } from 'kysely';
import { up as restore0064 } from './0064_tax_year_further_inputs.js';

/**
 * VC-X-50: the deposit's other movers (api-design.md §58I "In the database"; Entscheidung des Projektinhabers,
 * 2026-11-03, §58I Fragen 1–7: a reopen and a closing each alone with "in no year" as a year `null`, no `source_type`
 * in the year item, the corrections under `PROPERTY_PART_CHANGED`, one migration). Additive to 0060, 0063 and 0064; no
 * column on `security_deposit`, `ledger_transaction`, `transaction_split`, `rent_payment_reconciliation` or
 * `tax_classification`.
 *
 * - `tax_year_acknowledgement`: `change_kind` gains `DEPOSIT_REOPENED`, `DEPOSIT_CLOSED`, `TRANSACTION_CORRECTED`,
 *   `TRANSACTION_REVERSED`; `change_entity_type` gains `SecurityDeposit`, `Transaction`; `_kind_entity` binds
 *   `SecurityDeposit` to the two deposit kinds and `Transaction` to the two correction kinds.
 * - `tax_year_acknowledgement_item`: `year_before`, `year_after` nullable (their range CHECKs of 0060 hold for a value);
 *   `_moved` becomes `year_before IS DISTINCT FROM year_after`; `_some_year`: at least one of them names a year.
 * - The shape guard (0063's function, replaced as in 0064): the deposit kinds take year items only, the correction kinds
 *   part items only (`TRANSACTION_SPLIT`); a year item with a `null` year only under a deposit kind.
 * - `down` refuses while an acknowledgement of a new kind or a year item with a `null` year exists (a person's statement
 *   is never dropped silently, as 0060, 0063 and 0064), else restores 0064's CHECKs and guard and 0060's item columns.
 */
const KINDS_0064 = `'RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED', 'RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', 'LOAN_TERMS_ADDED', 'LOAN_TERMS_VOIDED', 'LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED', 'LOAN_CLOSED', 'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED'`;
const DEPOSIT_YEAR_KINDS = `'DEPOSIT_REOPENED', 'DEPOSIT_CLOSED'`;
const CORRECTION_KINDS = `'TRANSACTION_CORRECTED', 'TRANSACTION_REVERSED'`;
const NEW_KINDS = `${DEPOSIT_YEAR_KINDS}, ${CORRECTION_KINDS}`;
const ENTITIES = `'RentalContractReference', 'RentPaymentReconciliation', 'LoanTerms', 'LoanAllocationSet', 'Loan', 'SecurityDeposit', 'Transaction'`;
const SET_KINDS = `'LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED'`;
const DEPOSIT_PART_KINDS = `'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED'`;
const KIND_ENTITY = `(change_entity_type = 'RentalContractReference') = (change_kind IN ('RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED'))
        AND (change_entity_type = 'RentPaymentReconciliation') = (change_kind IN ('RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', ${DEPOSIT_PART_KINDS}))
        AND (change_entity_type = 'LoanAllocationSet') = (change_kind IN (${SET_KINDS}))
        AND (change_entity_type = 'Loan') = (change_kind = 'LOAN_CLOSED')
        AND (change_entity_type = 'SecurityDeposit') = (change_kind IN (${DEPOSIT_YEAR_KINDS}))
        AND (change_entity_type = 'Transaction') = (change_kind IN (${CORRECTION_KINDS}))`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tax_year_acknowledgement
      DROP CONSTRAINT tax_year_acknowledgement_change_kind_check,
      DROP CONSTRAINT tax_year_acknowledgement_change_entity_type_check,
      DROP CONSTRAINT tax_year_acknowledgement_kind_entity,
      ADD CONSTRAINT tax_year_acknowledgement_change_kind_check CHECK (change_kind IN (${sql.raw(`${KINDS_0064}, ${NEW_KINDS}`)})),
      ADD CONSTRAINT tax_year_acknowledgement_change_entity_type_check CHECK (change_entity_type IN (${sql.raw(ENTITIES)})),
      ADD CONSTRAINT tax_year_acknowledgement_kind_entity CHECK (${sql.raw(KIND_ENTITY)})
  `.execute(db);
  await sql`
    ALTER TABLE tax_year_acknowledgement_item
      ALTER COLUMN year_before DROP NOT NULL,
      ALTER COLUMN year_after DROP NOT NULL,
      DROP CONSTRAINT tax_year_acknowledgement_item_moved,
      ADD CONSTRAINT tax_year_acknowledgement_item_moved CHECK (year_before IS DISTINCT FROM year_after),
      ADD CONSTRAINT tax_year_acknowledgement_item_some_year CHECK (num_nonnulls(year_before, year_after) >= 1)
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION tax_year_acknowledgement_item_shape() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      kind text;
    BEGIN
      SELECT change_kind INTO kind FROM tax_year_acknowledgement WHERE id = NEW.acknowledgement_id;
      IF (TG_TABLE_NAME = 'tax_year_acknowledgement_part_item') IS DISTINCT FROM (kind IN (${sql.raw(`${SET_KINDS}, ${DEPOSIT_PART_KINDS}, ${CORRECTION_KINDS}`)})) THEN
        RAISE EXCEPTION 'TaxYearAcknowledgement %: a % item does not fit the kind % (api-design §58G)', NEW.acknowledgement_id, TG_TABLE_NAME, coalesce(kind, 'unknown')
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- A field of NEW exists on its own table only (plpgsql does not short-circuit a field of NEW): nested.
      IF TG_TABLE_NAME = 'tax_year_acknowledgement_part_item' THEN
        IF (NEW.source_type = 'DEPOSIT_CLOSING') IS DISTINCT FROM (kind IN (${sql.raw(DEPOSIT_PART_KINDS)})) THEN
          RAISE EXCEPTION 'TaxYearAcknowledgement %: a % part item does not fit the kind % (api-design §58H)', NEW.acknowledgement_id, NEW.source_type, kind
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      ELSE
        IF (NEW.year_before IS NULL OR NEW.year_after IS NULL) AND kind NOT IN (${sql.raw(DEPOSIT_YEAR_KINDS)}) THEN
          RAISE EXCEPTION 'TaxYearAcknowledgement %: a year item in no year does not fit the kind % (api-design §58I)', NEW.acknowledgement_id, kind
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is changed: a person's statement is never dropped silently (api-design §58E, §58G, §58I).
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM tax_year_acknowledgement_item WHERE year_before IS NULL OR year_after IS NULL)
         OR EXISTS (SELECT 1 FROM tax_year_acknowledgement WHERE change_kind IN (${sql.raw(NEW_KINDS)})) THEN
        RAISE EXCEPTION 'tax_year_acknowledgement / tax_year_acknowledgement_item: an acknowledgement of a kind of §58I exists; it is never dropped silently (api-design §58I)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`
    ALTER TABLE tax_year_acknowledgement_item
      DROP CONSTRAINT tax_year_acknowledgement_item_some_year,
      DROP CONSTRAINT tax_year_acknowledgement_item_moved,
      ADD CONSTRAINT tax_year_acknowledgement_item_moved CHECK (year_before <> year_after),
      ALTER COLUMN year_before SET NOT NULL,
      ALTER COLUMN year_after SET NOT NULL
  `.execute(db);
  // 0064's CHECKs and shape guard, exactly as 0064 leaves them (its `up` drops and re-adds them by name).
  await restore0064(db);
}

import { sql, type Kysely } from 'kysely';

/**
 * VC-X-49: further silent inputs of the tax year (api-design.md §58H "In the database"; Entscheidung des
 * Projektinhabers, 2026-11-03, §58H Fragen 1–4: a Loan closed as `LOAN_CLOSED` of `ATTRIBUTION_INPUT_CHANGED`, the
 * deposit's PropertyReference under `PROPERTY_PART_CHANGED`, nothing for a WEG economic plan, one migration). Additive
 * to 0060 and 0063; no column on `loan`, `security_deposit`, `rent_payment_reconciliation`, `weg_economic_plan` or any
 * ledger table.
 *
 * - `tax_year_acknowledgement`: `change_kind` gains `LOAN_CLOSED`, `DEPOSIT_RECONCILIATION_CONFIRMED`,
 *   `DEPOSIT_RECONCILIATION_RELEASED`; `change_entity_type` gains `Loan`; `_kind_entity` binds `Loan` to `LOAN_CLOSED`
 *   and `RentPaymentReconciliation` to its four kinds.
 * - `tax_year_acknowledgement_part_item`: `source_type` gains `DEPOSIT_CLOSING` (the currency is the view's, EUR, as
 *   0063: not stored).
 * - The shape guard (0063's function, replaced): `LOAN_CLOSED` takes year items only, the deposit kinds part items only;
 *   a part item's `source_type` is its kind's (`TRANSACTION_SPLIT` under a set kind, `DEPOSIT_CLOSING` under a deposit
 *   kind).
 * - `down` refuses while an acknowledgement of a new kind or a `DEPOSIT_CLOSING` part item exists (a person's statement
 *   is never dropped silently, as 0060 and 0063), else restores 0063's CHECKs and guard.
 */
const YEAR_KINDS = `'RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED', 'RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', 'LOAN_TERMS_ADDED', 'LOAN_TERMS_VOIDED'`;
const SET_KINDS = `'LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED'`;
const DEPOSIT_KINDS = `'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED'`;
const NEW_KINDS = `'LOAN_CLOSED', ${DEPOSIT_KINDS}`;
const ENTITIES_0063 = `'RentalContractReference', 'RentPaymentReconciliation', 'LoanTerms', 'LoanAllocationSet'`;
const KIND_ENTITY_0063 = `(change_entity_type = 'RentalContractReference') = (change_kind IN ('RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED'))
        AND (change_entity_type = 'RentPaymentReconciliation') = (change_kind IN ('RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED'))
        AND (change_entity_type = 'LoanAllocationSet') = (change_kind IN (${SET_KINDS}))`;
const KIND_ENTITY_0064 = `(change_entity_type = 'RentalContractReference') = (change_kind IN ('RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED'))
        AND (change_entity_type = 'RentPaymentReconciliation') = (change_kind IN ('RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', ${DEPOSIT_KINDS}))
        AND (change_entity_type = 'LoanAllocationSet') = (change_kind IN (${SET_KINDS}))
        AND (change_entity_type = 'Loan') = (change_kind = 'LOAN_CLOSED')`;

async function checks(db: Kysely<unknown>, kinds: string, entities: string, kindEntity: string, sourceTypes: string): Promise<void> {
  await sql`
    ALTER TABLE tax_year_acknowledgement
      DROP CONSTRAINT tax_year_acknowledgement_change_kind_check,
      DROP CONSTRAINT tax_year_acknowledgement_change_entity_type_check,
      DROP CONSTRAINT tax_year_acknowledgement_kind_entity,
      ADD CONSTRAINT tax_year_acknowledgement_change_kind_check CHECK (change_kind IN (${sql.raw(kinds)})),
      ADD CONSTRAINT tax_year_acknowledgement_change_entity_type_check CHECK (change_entity_type IN (${sql.raw(entities)})),
      ADD CONSTRAINT tax_year_acknowledgement_kind_entity CHECK (${sql.raw(kindEntity)})
  `.execute(db);
  await sql`
    ALTER TABLE tax_year_acknowledgement_part_item
      DROP CONSTRAINT tax_year_acknowledgement_part_item_source_type_check,
      ADD CONSTRAINT tax_year_acknowledgement_part_item_source_type_check CHECK (source_type IN (${sql.raw(sourceTypes)}))
  `.execute(db);
}

/** The shape guard over both item tables; `deposits` adds §58H's part kinds and the `source_type` per kind. */
async function shapeGuard(db: Kysely<unknown>, deposits: boolean): Promise<void> {
  const partKinds = deposits ? `${SET_KINDS}, ${DEPOSIT_KINDS}` : SET_KINDS;
  const sourceType = deposits
    ? `
      -- NEW.source_type exists on the part items only (plpgsql does not short-circuit a field of NEW): nested.
      IF TG_TABLE_NAME = 'tax_year_acknowledgement_part_item' THEN
        IF (NEW.source_type = 'DEPOSIT_CLOSING') IS DISTINCT FROM (kind IN (${DEPOSIT_KINDS})) THEN
          RAISE EXCEPTION 'TaxYearAcknowledgement %: a % part item does not fit the kind % (api-design §58H)', NEW.acknowledgement_id, NEW.source_type, kind
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;`
    : '';
  await sql`
    CREATE OR REPLACE FUNCTION tax_year_acknowledgement_item_shape() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      kind text;
    BEGIN
      SELECT change_kind INTO kind FROM tax_year_acknowledgement WHERE id = NEW.acknowledgement_id;
      IF (TG_TABLE_NAME = 'tax_year_acknowledgement_part_item') IS DISTINCT FROM (kind IN (${sql.raw(partKinds)})) THEN
        RAISE EXCEPTION 'TaxYearAcknowledgement %: a % item does not fit the kind % (api-design §58G)', NEW.acknowledgement_id, TG_TABLE_NAME, coalesce(kind, 'unknown')
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;${sql.raw(sourceType)}
      RETURN NEW;
    END $$
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await checks(db, `${YEAR_KINDS}, ${SET_KINDS}, ${NEW_KINDS}`, `${ENTITIES_0063}, 'Loan'`, KIND_ENTITY_0064, `'TRANSACTION_SPLIT', 'DEPOSIT_CLOSING'`);
  await shapeGuard(db, true);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is changed: a person's statement is never dropped silently (api-design §58E, §58G, §58H).
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM tax_year_acknowledgement_part_item WHERE source_type = 'DEPOSIT_CLOSING')
         OR EXISTS (SELECT 1 FROM tax_year_acknowledgement WHERE change_kind IN (${sql.raw(NEW_KINDS)})) THEN
        RAISE EXCEPTION 'tax_year_acknowledgement / tax_year_acknowledgement_part_item: an acknowledgement of a kind of §58H exists; it is never dropped silently (api-design §58H)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await shapeGuard(db, false);
  await checks(db, `${YEAR_KINDS}, ${SET_KINDS}`, ENTITIES_0063, KIND_ENTITY_0063, `'TRANSACTION_SPLIT'`);
}

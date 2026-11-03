import { sql, type Kysely } from 'kysely';

/**
 * VC-X-48: acknowledging a part change (api-design.md §58G "In the database"; Entscheidung des Projektinhabers,
 * 2026-11-03, Fragen 2 und 3: the same `tax_year_acknowledgement` row, a second item table for the part shape and a
 * guard that the item shape matches the kind). Additive to 0060; nothing on `loan_allocation_set`, `loan_allocation`,
 * `loan` or any ledger table.
 *
 * - `tax_year_acknowledgement`: `change_kind` gains `LOAN_ALLOCATION_SET_ADDED`, `LOAN_ALLOCATION_SET_VOIDED`,
 *   `change_entity_type` gains `LoanAllocationSet`, `_kind_entity` binds them. The `ACTIVE` index, `_insert` and
 *   `tax_statement_frozen` are unchanged.
 * - `tax_year_acknowledgement_part_item`: P's state and part before and after per item (`source_type`, `source_id` by
 *   value), a part exactly on `ATTRIBUTED`, numeric scale ≤ 2 and ≥ 0; the part moved, and not between
 *   `NOT_ATTRIBUTED` and `NONE` (Frage 3). The currency is the view's (EUR, data-model.md §17.4), so not stored.
 * - Guards: `…_part_item_append_only` (as 0060's for the year items: inserted only in its acknowledgement's
 *   transaction, never changed or deleted); `tax_year_acknowledgement_item_shape` on both item tables: a part item only
 *   under a part kind, a year item only under a year kind.
 * - `down` refuses while a part item or an acknowledgement of a part kind exists (a person's statement is never dropped
 *   silently, as 0060), else drops the table and its functions and restores 0060's CHECKs.
 */
const PART_KINDS = `'LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED'`;
const YEAR_KINDS = `'RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED', 'RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', 'LOAN_TERMS_ADDED', 'LOAN_TERMS_VOIDED'`;
const YEAR_ENTITIES = `'RentalContractReference', 'RentPaymentReconciliation', 'LoanTerms'`;
const YEAR_KIND_ENTITY = `(change_entity_type = 'RentalContractReference') = (change_kind IN ('RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED'))
        AND (change_entity_type = 'RentPaymentReconciliation') = (change_kind IN ('RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED'))`;

async function checks(db: Kysely<unknown>, kinds: string, entities: string, kindEntity: string): Promise<void> {
  await sql`
    ALTER TABLE tax_year_acknowledgement
      DROP CONSTRAINT tax_year_acknowledgement_change_kind_check,
      DROP CONSTRAINT tax_year_acknowledgement_change_entity_type_check,
      DROP CONSTRAINT tax_year_acknowledgement_kind_entity,
      ADD CONSTRAINT tax_year_acknowledgement_change_kind_check CHECK (change_kind IN (${sql.raw(kinds)})),
      ADD CONSTRAINT tax_year_acknowledgement_change_entity_type_check CHECK (change_entity_type IN (${sql.raw(entities)})),
      ADD CONSTRAINT tax_year_acknowledgement_kind_entity CHECK (${sql.raw(kindEntity)})
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await checks(
    db,
    `${YEAR_KINDS}, ${PART_KINDS}`,
    `${YEAR_ENTITIES}, 'LoanAllocationSet'`,
    `${YEAR_KIND_ENTITY}
        AND (change_entity_type = 'LoanAllocationSet') = (change_kind IN (${PART_KINDS}))`,
  );
  const part = (column: string) => sql.raw(`${column} numeric CHECK (${column} >= 0 AND ${column} = round(${column}, 2))`);
  await sql`
    CREATE TABLE tax_year_acknowledgement_part_item (
      acknowledgement_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      source_type text NOT NULL CHECK (source_type IN ('TRANSACTION_SPLIT')),
      source_id uuid NOT NULL,
      tax_year integer NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
      state_before text NOT NULL CHECK (state_before IN ('ATTRIBUTED', 'NOT_ATTRIBUTED', 'NONE')),
      ${part('part_before')},
      state_after text NOT NULL CHECK (state_after IN ('ATTRIBUTED', 'NOT_ATTRIBUTED', 'NONE')),
      ${part('part_after')},
      CONSTRAINT tax_year_acknowledgement_part_item_key PRIMARY KEY (acknowledgement_id, source_type, source_id),
      CONSTRAINT tax_year_acknowledgement_part_item_part_on_attributed CHECK (
        (state_before = 'ATTRIBUTED') = (part_before IS NOT NULL) AND (state_after = 'ATTRIBUTED') = (part_after IS NOT NULL)
      ),
      CONSTRAINT tax_year_acknowledgement_part_item_moved CHECK ((state_before, part_before) IS DISTINCT FROM (state_after, part_after)),
      CONSTRAINT tax_year_acknowledgement_part_item_not_unattributed_step CHECK (state_before = 'ATTRIBUTED' OR state_after = 'ATTRIBUTED'),
      CONSTRAINT tax_year_acknowledgement_part_item_fk FOREIGN KEY (acknowledgement_id, mre_realm_id) REFERENCES tax_year_acknowledgement (id, mre_realm_id)
    )
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_year_acknowledgement_part_item_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'TaxYearAcknowledgement: part items are append-only, never changed or deleted (api-design §58G)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- Never xmin: the withdrawal gives the acknowledgement row the withdrawing transaction's xmin (as 0060).
      IF NOT EXISTS (SELECT 1 FROM tax_year_acknowledgement WHERE id = NEW.acknowledgement_id AND created_txid = txid_current()) THEN
        RAISE EXCEPTION 'TaxYearAcknowledgement %: part items are inserted only by the transaction that recorded it (api-design §58G)', NEW.acknowledgement_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_year_acknowledgement_part_item_append_only BEFORE INSERT OR UPDATE OR DELETE ON tax_year_acknowledgement_part_item
      FOR EACH ROW EXECUTE FUNCTION tax_year_acknowledgement_part_item_append_only()
  `.execute(db);

  // One function for both item tables: the shape of an item is its acknowledgement's kind's.
  await sql`
    CREATE FUNCTION tax_year_acknowledgement_item_shape() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      kind text;
    BEGIN
      SELECT change_kind INTO kind FROM tax_year_acknowledgement WHERE id = NEW.acknowledgement_id;
      IF (TG_TABLE_NAME = 'tax_year_acknowledgement_part_item') IS DISTINCT FROM (kind IN (${sql.raw(PART_KINDS)})) THEN
        RAISE EXCEPTION 'TaxYearAcknowledgement %: a % item does not fit the kind % (api-design §58G)', NEW.acknowledgement_id, TG_TABLE_NAME, coalesce(kind, 'unknown')
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  for (const table of ['tax_year_acknowledgement_item', 'tax_year_acknowledgement_part_item']) {
    await sql`
      CREATE TRIGGER ${sql.raw(`${table}_shape`)} BEFORE INSERT ON ${sql.table(table)}
        FOR EACH ROW EXECUTE FUNCTION tax_year_acknowledgement_item_shape()
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is dropped: a person's statement is never dropped silently (api-design §58E, §58G).
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM tax_year_acknowledgement_part_item)
         OR EXISTS (SELECT 1 FROM tax_year_acknowledgement WHERE change_kind IN (${sql.raw(PART_KINDS)})) THEN
        RAISE EXCEPTION 'tax_year_acknowledgement_part_item / tax_year_acknowledgement: a part acknowledgement exists; it is never dropped silently (api-design §58G)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP TRIGGER tax_year_acknowledgement_item_shape ON tax_year_acknowledgement_item`.execute(db);
  await sql`DROP TABLE tax_year_acknowledgement_part_item`.execute(db);
  await sql`DROP FUNCTION tax_year_acknowledgement_item_shape()`.execute(db);
  await sql`DROP FUNCTION tax_year_acknowledgement_part_item_append_only()`.execute(db);
  await checks(db, YEAR_KINDS, YEAR_ENTITIES, YEAR_KIND_ENTITY);
}

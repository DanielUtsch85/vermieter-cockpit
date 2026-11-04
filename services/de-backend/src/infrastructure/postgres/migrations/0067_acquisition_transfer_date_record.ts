import { sql, type Kysely } from 'kysely';

/**
 * VC-X-52: recording the transfer of economic ownership later (api-design.md §58N "Migration 0067"; Entscheidung des
 * Projektinhabers, 2026-11-04, §58N Fragen 1–8: (b) the Ownerships stay, the evidence in a column of its own, requirement
 * 0 in 0022's `acquisition_step`, the date's guard in 0020's `acquisition_frozen`, the flag acknowledged as a kind of
 * §58E Part 2).
 *
 * - `acquisition`: `economic_transfer_recorded_at` (`NULL` until `POST …/economic-transfer-date` sets it, with the date)
 *   and `economic_transfer_source_references` (the evidence, 1–10 non-empty entries); CHECKs tie both together and to the
 *   date. No existing row changes, no backfill.
 * - 0020's `acquisition_frozen`: one change of an Acquisition's data is admitted, the date from `NULL`, together with its
 *   time and evidence, on a `DRAFT` or `CONFIRMED` row, without a status step, `version` + 1, nothing else; every other
 *   rule of 0020's function is unchanged.
 * - 0022's `acquisition_step`: the transition to `CONFIRMED` requires `economic_transfer_date` (§28.1 requirement 0,
 *   `TRANSFER_DATE_MISSING`), before requirements 1–6. Rows already `CONFIRMED` are untouched.
 * - 0050's `acquisition_confirmation_violation` and `acquisition_increase_violation`: their `d :=` lines read the day
 *   the Ownerships begin (`ownershipStart`: the contract date once the date was recorded by the command, else as before).
 * - `tax_year_acknowledgement` (0060/0065): the kind `OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER` on the entity
 *   `Acquisition`; the shape guard (0065's function) refuses every item of it (the change moves no item).
 * - The functions are patched in place (their text read with `pg_get_functiondef`, the one changed passage replaced and
 *   checked to occur exactly once); `down` replaces it back, so 0020's, 0022's, 0050's and 0065's functions return
 *   verbatim. `down` refuses while a recorded date or an acknowledgement of the new kind exists (a recorded fact and a
 *   person's statement are never dropped silently).
 */

const KIND = 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER';

/** 0065's CHECKs of `tax_year_acknowledgement`, restored by `down`. */
const KINDS_0065 = `'RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED', 'RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', 'LOAN_TERMS_ADDED', 'LOAN_TERMS_VOIDED', 'LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED', 'LOAN_CLOSED', 'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED', 'DEPOSIT_REOPENED', 'DEPOSIT_CLOSED', 'TRANSACTION_CORRECTED', 'TRANSACTION_REVERSED'`;
const ENTITIES_0065 = `'RentalContractReference', 'RentPaymentReconciliation', 'LoanTerms', 'LoanAllocationSet', 'Loan', 'SecurityDeposit', 'Transaction'`;
const KIND_ENTITY_0065 = `(change_entity_type = 'RentalContractReference') = (change_kind IN ('RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED'))
        AND (change_entity_type = 'RentPaymentReconciliation') = (change_kind IN ('RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', 'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED'))
        AND (change_entity_type = 'LoanAllocationSet') = (change_kind IN ('LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED'))
        AND (change_entity_type = 'Loan') = (change_kind = 'LOAN_CLOSED')
        AND (change_entity_type = 'SecurityDeposit') = (change_kind IN ('DEPOSIT_REOPENED', 'DEPOSIT_CLOSED'))
        AND (change_entity_type = 'Transaction') = (change_kind IN ('TRANSACTION_CORRECTED', 'TRANSACTION_REVERSED'))`;

/** (i) The date's guard, placed at the start of 0020's `acquisition_frozen` body. */
const FROZEN_FROM = `BEGIN
      IF (NEW.id, NEW.mre_realm_id, NEW.property_reference_id, NEW.purchase_price,`;
const FROZEN_TO = `BEGIN
      -- 0067 (api-design §58N, VC-X-52): the one change of an Acquisition's data after creation. The transfer date is
      -- recorded once, from NULL, with its time and evidence, on a DRAFT or CONFIRMED row, without a status step,
      -- version + 1, nothing else; then never changed (also not to NULL).
      IF (NEW.economic_transfer_date, NEW.economic_transfer_recorded_at, NEW.economic_transfer_source_references)
         IS DISTINCT FROM (OLD.economic_transfer_date, OLD.economic_transfer_recorded_at, OLD.economic_transfer_source_references) THEN
        IF OLD.economic_transfer_date IS NOT NULL OR OLD.economic_transfer_recorded_at IS NOT NULL OR OLD.economic_transfer_source_references IS NOT NULL THEN
          RAISE EXCEPTION 'Acquisition %: the economic transfer date is set once and never changes (TRANSFER_DATE_ALREADY_SET, api-design §58N)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.economic_transfer_date IS NULL OR NEW.economic_transfer_recorded_at IS NULL OR NEW.economic_transfer_source_references IS NULL THEN
          RAISE EXCEPTION 'Acquisition %: the economic transfer date is recorded with its time and evidence together (api-design §58N)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status NOT IN ('DRAFT', 'CONFIRMED') THEN
          RAISE EXCEPTION 'Acquisition %: % takes no economic transfer date (ACQUISITION_CANCELLED, api-design §58N)', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          RAISE EXCEPTION 'Acquisition %: the economic transfer date is recorded without a status step (api-design §58N)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
          RAISE EXCEPTION 'Acquisition %: recording the economic transfer date must raise version from % to %, not to % (api-design §58N)',
            OLD.id, OLD.version, OLD.version + 1, NEW.version USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.mre_realm_id, NEW.property_reference_id, NEW.purchase_price, NEW.currency, NEW.acquired_share_numerator,
            NEW.acquired_share_denominator, NEW.contract_date, NEW.land_registry_transfer_date, NEW.source_references, NEW.notes,
            NEW.created_at, NEW.created_by, NEW.cancelled_at, NEW.cancellation_reason, NEW.confirmed_at)
           IS DISTINCT FROM
           (OLD.id, OLD.mre_realm_id, OLD.property_reference_id, OLD.purchase_price, OLD.currency, OLD.acquired_share_numerator,
            OLD.acquired_share_denominator, OLD.contract_date, OLD.land_registry_transfer_date, OLD.source_references, OLD.notes,
            OLD.created_at, OLD.created_by, OLD.cancelled_at, OLD.cancellation_reason, OLD.confirmed_at) THEN
          RAISE EXCEPTION 'Acquisition %: its other data never changes with the economic transfer date (api-design §58N)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.property_reference_id, NEW.purchase_price,`;

/** (ii) Requirement 0 on the transition to CONFIRMED, before 0022's requirements 1–6. */
const STEP_FROM = `        IF NEW.status = 'CONFIRMED' THEN
          violation := acquisition_confirmation_violation(NEW.id);`;
const STEP_TO = `        IF NEW.status = 'CONFIRMED' THEN
          -- 0067 (api-design §58N, §28.1 requirement 0): never confirmed without the transfer date.
          IF NEW.economic_transfer_date IS NULL THEN
            RAISE EXCEPTION 'Acquisition %: cannot be confirmed (TRANSFER_DATE_MISSING)', NEW.id USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          violation := acquisition_confirmation_violation(NEW.id);`;

/** (iii) `ownershipStart` (option (b)): the Ownerships of a date recorded by the command began on the contract date. */
const D_FROM = `      d := coalesce(a.economic_transfer_date, a.contract_date);`;
const D_TO = `      d := CASE WHEN a.economic_transfer_recorded_at IS NOT NULL THEN a.contract_date ELSE coalesce(a.economic_transfer_date, a.contract_date) END;`;

/** The shape guard (0065): the new kind takes no item of either shape. */
const SHAPE_FROM = `      SELECT change_kind INTO kind FROM tax_year_acknowledgement WHERE id = NEW.acknowledgement_id;
`;
const SHAPE_TO = `      SELECT change_kind INTO kind FROM tax_year_acknowledgement WHERE id = NEW.acknowledgement_id;
      IF kind = '${KIND}' THEN
        RAISE EXCEPTION 'TaxYearAcknowledgement %: the kind % takes no items (api-design §58N)', NEW.acknowledgement_id, kind
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
`;

const PATCHES = [
  { fn: 'acquisition_frozen()', from: FROZEN_FROM, to: FROZEN_TO },
  { fn: 'acquisition_step()', from: STEP_FROM, to: STEP_TO },
  { fn: 'acquisition_confirmation_violation(uuid)', from: D_FROM, to: D_TO },
  { fn: 'acquisition_increase_violation(uuid)', from: D_FROM, to: D_TO },
  { fn: 'tax_year_acknowledgement_item_shape()', from: SHAPE_FROM, to: SHAPE_TO },
] as const;

/** Replaces `from` by `to` in the function's current definition, which must hold `from` exactly once. */
async function patchFunction(db: Kysely<unknown>, fn: string, from: string, to: string): Promise<void> {
  const { rows } = await sql<{ def: string }>`SELECT pg_get_functiondef(${fn}::regprocedure) AS def`.execute(db);
  const def = rows[0]?.def ?? '';
  const count = def.split(from).length - 1;
  if (count !== 1) throw new Error(`0067: ${fn} holds the passage to replace ${count} times, expected once`);
  await sql.raw(def.replace(from, () => to)).execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE acquisition
      ADD COLUMN economic_transfer_recorded_at timestamptz,
      ADD COLUMN economic_transfer_source_references text[],
      ADD CONSTRAINT acquisition_transfer_record CHECK (
        (economic_transfer_recorded_at IS NULL) = (economic_transfer_source_references IS NULL)
        AND (economic_transfer_recorded_at IS NULL OR economic_transfer_date IS NOT NULL)
      ),
      ADD CONSTRAINT acquisition_transfer_source_references CHECK (
        cardinality(economic_transfer_source_references) BETWEEN 1 AND 10
        AND array_position(economic_transfer_source_references, NULL) IS NULL
        AND '' <> ALL (economic_transfer_source_references)
      )
  `.execute(db);
  await sql`
    ALTER TABLE tax_year_acknowledgement
      DROP CONSTRAINT tax_year_acknowledgement_change_kind_check,
      DROP CONSTRAINT tax_year_acknowledgement_change_entity_type_check,
      DROP CONSTRAINT tax_year_acknowledgement_kind_entity,
      ADD CONSTRAINT tax_year_acknowledgement_change_kind_check CHECK (change_kind IN (${sql.raw(`${KINDS_0065}, '${KIND}'`)})),
      ADD CONSTRAINT tax_year_acknowledgement_change_entity_type_check CHECK (change_entity_type IN (${sql.raw(`${ENTITIES_0065}, 'Acquisition'`)})),
      ADD CONSTRAINT tax_year_acknowledgement_kind_entity CHECK (${sql.raw(`${KIND_ENTITY_0065}
        AND (change_entity_type = 'Acquisition') = (change_kind = '${KIND}')`)})
  `.execute(db);
  for (const p of PATCHES) await patchFunction(db, p.fn, p.from, p.to);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is changed (api-design §58N "down"; §58E: a person's statement is never dropped silently).
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM acquisition WHERE economic_transfer_recorded_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM tax_year_acknowledgement WHERE change_kind = ${sql.lit(KIND)}) THEN
        RAISE EXCEPTION 'acquisition / tax_year_acknowledgement: a recorded economic transfer date or its acknowledgement exists; it is never dropped silently (api-design §58N)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  for (const p of [...PATCHES].reverse()) await patchFunction(db, p.fn, p.to, p.from);
  await sql`
    ALTER TABLE tax_year_acknowledgement
      DROP CONSTRAINT tax_year_acknowledgement_change_kind_check,
      DROP CONSTRAINT tax_year_acknowledgement_change_entity_type_check,
      DROP CONSTRAINT tax_year_acknowledgement_kind_entity,
      ADD CONSTRAINT tax_year_acknowledgement_change_kind_check CHECK (change_kind IN (${sql.raw(KINDS_0065)})),
      ADD CONSTRAINT tax_year_acknowledgement_change_entity_type_check CHECK (change_entity_type IN (${sql.raw(ENTITIES_0065)})),
      ADD CONSTRAINT tax_year_acknowledgement_kind_entity CHECK (${sql.raw(KIND_ENTITY_0065)})
  `.execute(db);
  await sql`
    ALTER TABLE acquisition
      DROP CONSTRAINT acquisition_transfer_source_references,
      DROP CONSTRAINT acquisition_transfer_record,
      DROP COLUMN economic_transfer_source_references,
      DROP COLUMN economic_transfer_recorded_at
  `.execute(db);
}

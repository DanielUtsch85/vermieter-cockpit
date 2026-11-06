import { sql, type Kysely } from 'kysely';

/**
 * VC-X-55: extending a seller's Ownership up to the economic transfer (api-design.md §58Q "Migration"; Entscheidung des
 * Projektinhabers, 2026-11-05, §58Q Fragen 1–11: option (A), the act at the Acquisition, `ownership_frozen` reads the
 * Acquisition's state, a deferred trigger, no session marker).
 *
 * - `acquisition`: `ownership_aligned_at` and `ownership_alignment_source_references` (`NULL` until
 *   `POST …/align-ownerships-to-transfer` sets both); CHECK `acquisition_ownership_alignment` ties them together, to a
 *   date recorded later (§58N) after the contract date, and the evidence to 1–10 non-empty entries. No backfill.
 * - 0020's `acquisition_frozen` (as patched by 0067): one more change is admitted, the two columns from `NULL` to set on
 *   a `DRAFT` or `CONFIRMED` row with a recorded date after the contract date, without a status step, `version` + 1,
 *   nothing else; any other change of them (also back to `NULL`) is refused.
 * - 0020's `ownership_frozen`: `valid_from` may move from `c` to `t` on a row carrying an aligned Acquisition X (contract
 *   date `c`, transfer `t`), and `valid_until` from `c − 1` to `t − 1` on a row of a seller of X, or of a buyer of X not
 *   carrying X, of X's Realm and PropertyReference. The state is read, not a session setting; every other rule of 0020's
 *   function is unchanged.
 * - `ownership_alignment_complete`: a deferred constraint trigger on `acquisition` (the marker set) and on `ownership` (a
 *   start or an end moved later, which only the act does; a close queues nothing) checks at commit that no `VALID` row
 *   carries X with another start than `t`, no `VALID` row of a seller or a buyer predecessor of X ends on `c − 1`, and for
 *   a `CONFIRMED` X §28.1A's 5a/5b hold on `t` (`acquisition_increase_violation`). Neither half of the act commits alone.
 * - 0050's `acquisition_confirmation_violation` and `acquisition_increase_violation` (their `d :=` lines as 0067 left
 *   them): `ownershipStart` reads the aligned case first.
 * - `tax_year_acknowledgement` (0071's CHECKs): the kind `OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER` on the entity
 *   `Acquisition`; 0067's shape guard refuses every item of it as of `OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER`.
 * - The functions are patched in place (`pg_get_functiondef`, the passage checked to occur exactly once); `down` replaces
 *   it back, so 0020's, 0050's (as 0067 left them) and 0065's functions return verbatim. `down` refuses while an aligned
 *   row or an acknowledgement of the new kind exists (the moved dates cannot be restored without their marker).
 */

const KIND = 'OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER';

/** 0071's CHECKs of `tax_year_acknowledgement`, restored by `down`. */
const KINDS_0071 = `'RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED', 'RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', 'LOAN_TERMS_ADDED', 'LOAN_TERMS_VOIDED', 'LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED', 'LOAN_CLOSED', 'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED', 'DEPOSIT_REOPENED', 'DEPOSIT_CLOSED', 'TRANSACTION_CORRECTED', 'TRANSACTION_REVERSED', 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER', 'LOAN_TERMS_PART_ADDED', 'LOAN_TERMS_PART_VOIDED', 'LOAN_CLOSED_PART'`;
const kindEntity = (
  acquisitionKinds: string,
) => `(change_entity_type = 'RentalContractReference') = (change_kind IN ('RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED'))
        AND (change_entity_type = 'RentPaymentReconciliation') = (change_kind IN ('RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', 'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED'))
        AND (change_entity_type = 'LoanAllocationSet') = (change_kind IN ('LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED'))
        AND (change_entity_type = 'Loan') = (change_kind IN ('LOAN_CLOSED', 'LOAN_CLOSED_PART'))
        AND (change_entity_type = 'SecurityDeposit') = (change_kind IN ('DEPOSIT_REOPENED', 'DEPOSIT_CLOSED'))
        AND (change_entity_type = 'Transaction') = (change_kind IN ('TRANSACTION_CORRECTED', 'TRANSACTION_REVERSED'))
        AND (change_entity_type = 'Acquisition') = (${acquisitionKinds})`;
const KIND_ENTITY_0071 = kindEntity(`change_kind = 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER'`);
const KIND_ENTITY_0072 = kindEntity(`change_kind IN ('OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER', '${KIND}')`);

/** (i) The alignment's guard, placed at the start of `acquisition_frozen`'s body, before 0067's. */
const FROZEN_FROM = `BEGIN
      -- 0067 (api-design §58N, VC-X-52): the one change of an Acquisition's data after creation.`;
const FROZEN_TO = `BEGIN
      -- 0072 (api-design §58Q, VC-X-55): the Ownerships aligned to the transfer, once, from NULL, with the act's evidence,
      -- on a DRAFT or CONFIRMED row whose date was recorded later after the contract date, without a status step,
      -- version + 1, nothing else; then never changed (also not to NULL).
      IF (NEW.ownership_aligned_at, NEW.ownership_alignment_source_references)
         IS DISTINCT FROM (OLD.ownership_aligned_at, OLD.ownership_alignment_source_references) THEN
        IF OLD.ownership_aligned_at IS NOT NULL OR OLD.ownership_alignment_source_references IS NOT NULL THEN
          RAISE EXCEPTION 'Acquisition %: its Ownerships are aligned once and the marker never changes (OWNERSHIPS_ALREADY_ALIGNED, api-design §58Q)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.ownership_aligned_at IS NULL OR NEW.ownership_alignment_source_references IS NULL THEN
          RAISE EXCEPTION 'Acquisition %: the alignment is recorded with its time and evidence together (api-design §58Q)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status NOT IN ('DRAFT', 'CONFIRMED') THEN
          RAISE EXCEPTION 'Acquisition %: % takes no alignment (ACQUISITION_CANCELLED, api-design §58Q)', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.economic_transfer_recorded_at IS NULL OR NOT (OLD.economic_transfer_date > OLD.contract_date) THEN
          RAISE EXCEPTION 'Acquisition %: only a transfer date recorded later after the contract date is aligned (OWNERSHIP_EXTENSION_NOT_APPLICABLE, api-design §58Q)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          RAISE EXCEPTION 'Acquisition %: the alignment is recorded without a status step (api-design §58Q)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
          RAISE EXCEPTION 'Acquisition %: the alignment must raise version from % to %, not to % (api-design §58Q)',
            OLD.id, OLD.version, OLD.version + 1, NEW.version USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.mre_realm_id, NEW.property_reference_id, NEW.purchase_price, NEW.currency, NEW.acquired_share_numerator,
            NEW.acquired_share_denominator, NEW.contract_date, NEW.economic_transfer_date, NEW.economic_transfer_recorded_at,
            NEW.economic_transfer_source_references, NEW.land_registry_transfer_date, NEW.source_references, NEW.notes,
            NEW.created_at, NEW.created_by, NEW.cancelled_at, NEW.cancellation_reason, NEW.confirmed_at)
           IS DISTINCT FROM
           (OLD.id, OLD.mre_realm_id, OLD.property_reference_id, OLD.purchase_price, OLD.currency, OLD.acquired_share_numerator,
            OLD.acquired_share_denominator, OLD.contract_date, OLD.economic_transfer_date, OLD.economic_transfer_recorded_at,
            OLD.economic_transfer_source_references, OLD.land_registry_transfer_date, OLD.source_references, OLD.notes,
            OLD.created_at, OLD.created_by, OLD.cancelled_at, OLD.cancellation_reason, OLD.confirmed_at) THEN
          RAISE EXCEPTION 'Acquisition %: its other data never changes with the alignment (api-design §58Q)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END IF;
      -- 0067 (api-design §58N, VC-X-52): the one change of an Acquisition's data after creation.`;

/** (ii) The one move of a period, placed before 0020's fixed-field check in `ownership_frozen`. */
const OWN_FROM = `      IF (NEW.id, NEW.mre_realm_id, NEW.property_reference_id, NEW.owner_party_id, NEW.share_numerator, NEW.share_denominator,`;
const OWN_TO = `      -- 0072 (api-design §58Q, VC-X-55): the act of POST …/align-ownerships-to-transfer, read from the aligned Acquisition X
      -- of the row's Realm and PropertyReference (contract date c, transfer t): valid_from c -> t on a row carrying X,
      -- valid_until c - 1 -> t - 1 on a row of a seller of X, or of a buyer of X not carrying X. Nothing else changes.
      IF OLD.status = 'VALID' AND NEW.status = 'VALID'
         AND (NEW.valid_from, NEW.valid_until) IS DISTINCT FROM (OLD.valid_from, OLD.valid_until)
         AND (NEW.id, NEW.mre_realm_id, NEW.property_reference_id, NEW.owner_party_id, NEW.share_numerator, NEW.share_denominator,
              NEW.created_at, NEW.created_by, NEW.acquisition_id)
             IS NOT DISTINCT FROM
             (OLD.id, OLD.mre_realm_id, OLD.property_reference_id, OLD.owner_party_id, OLD.share_numerator, OLD.share_denominator,
              OLD.created_at, OLD.created_by, OLD.acquisition_id)
         AND (NEW.valid_from = OLD.valid_from OR EXISTS (
               SELECT 1 FROM acquisition a
                WHERE a.id = OLD.acquisition_id AND a.mre_realm_id = OLD.mre_realm_id AND a.property_reference_id = OLD.property_reference_id
                  AND a.ownership_aligned_at IS NOT NULL
                  AND OLD.valid_from = a.contract_date AND NEW.valid_from = a.economic_transfer_date))
         AND (NEW.valid_until IS NOT DISTINCT FROM OLD.valid_until OR EXISTS (
               SELECT 1 FROM acquisition a JOIN acquisition_party ap ON ap.acquisition_id = a.id
                WHERE a.mre_realm_id = OLD.mre_realm_id AND a.property_reference_id = OLD.property_reference_id
                  AND a.ownership_aligned_at IS NOT NULL AND ap.party_id = OLD.owner_party_id
                  AND (ap.role = 'SELLER' OR OLD.acquisition_id IS DISTINCT FROM a.id)
                  AND OLD.valid_until = a.contract_date - 1 AND NEW.valid_until = a.economic_transfer_date - 1)) THEN
        RETURN NEW;
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.property_reference_id, NEW.owner_party_id, NEW.share_numerator, NEW.share_denominator,`;

/** (iii) `ownershipStart`: the transfer once aligned, else as 0067 left it. */
const D_FROM = `      d := CASE WHEN a.economic_transfer_recorded_at IS NOT NULL THEN a.contract_date ELSE coalesce(a.economic_transfer_date, a.contract_date) END;`;
const D_TO = `      d := CASE WHEN a.ownership_aligned_at IS NOT NULL THEN a.economic_transfer_date WHEN a.economic_transfer_recorded_at IS NOT NULL THEN a.contract_date ELSE coalesce(a.economic_transfer_date, a.contract_date) END;`;

/** (iv) The shape guard (0065, as 0067 patched it): the new kind takes no item either. */
const SHAPE_FROM = `      IF kind = 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER' THEN`;
const SHAPE_TO = `      IF kind IN ('OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER', '${KIND}') THEN`;

const PATCHES = [
  { fn: 'acquisition_frozen()', from: FROZEN_FROM, to: FROZEN_TO },
  { fn: 'ownership_frozen()', from: OWN_FROM, to: OWN_TO },
  { fn: 'acquisition_confirmation_violation(uuid)', from: D_FROM, to: D_TO },
  { fn: 'acquisition_increase_violation(uuid)', from: D_FROM, to: D_TO },
  { fn: 'tax_year_acknowledgement_item_shape()', from: SHAPE_FROM, to: SHAPE_TO },
] as const;

/** Replaces `from` by `to` in the function's current definition, which must hold `from` exactly once (as 0067). */
async function patchFunction(db: Kysely<unknown>, fn: string, from: string, to: string): Promise<void> {
  const { rows } = await sql<{ def: string }>`SELECT pg_get_functiondef(${fn}::regprocedure) AS def`.execute(db);
  const def = rows[0]?.def ?? '';
  const count = def.split(from).length - 1;
  if (count !== 1) throw new Error(`0072: ${fn} holds the passage to replace ${count} times, expected once`);
  await sql.raw(def.replace(from, () => to)).execute(db);
}

async function constraints(db: Kysely<unknown>, kinds: string, kindEntityText: string): Promise<void> {
  await sql`
    ALTER TABLE tax_year_acknowledgement
      DROP CONSTRAINT tax_year_acknowledgement_change_kind_check,
      DROP CONSTRAINT tax_year_acknowledgement_kind_entity,
      ADD CONSTRAINT tax_year_acknowledgement_change_kind_check CHECK (change_kind IN (${sql.raw(kinds)})),
      ADD CONSTRAINT tax_year_acknowledgement_kind_entity CHECK (${sql.raw(kindEntityText)})
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE acquisition
      ADD COLUMN ownership_aligned_at timestamptz,
      ADD COLUMN ownership_alignment_source_references text[],
      ADD CONSTRAINT acquisition_ownership_alignment CHECK (
        (ownership_aligned_at IS NULL) = (ownership_alignment_source_references IS NULL)
        AND (ownership_aligned_at IS NULL OR (economic_transfer_recorded_at IS NOT NULL AND economic_transfer_date > contract_date))
        AND cardinality(ownership_alignment_source_references) BETWEEN 1 AND 10
        AND array_position(ownership_alignment_source_references, NULL) IS NULL
        AND '' <> ALL (ownership_alignment_source_references)
      )
  `.execute(db);
  await constraints(db, `${KINDS_0071}, '${KIND}'`, KIND_ENTITY_0072);
  for (const p of PATCHES) await patchFunction(db, p.fn, p.from, p.to);
  // The act's two halves at commit (§58Q "The act's consistency at commit"): 'BUYER_ROW_NOT_MOVED',
  // 'SELLER_ROW_NOT_EXTENDED', 'BUYER_PREDECESSOR_NOT_EXTENDED' or 5a/5b of §28.1A for a CONFIRMED X; NULL when complete.
  await sql`
    CREATE FUNCTION ownership_alignment_violation(target uuid) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE
      a record;
    BEGIN
      SELECT * INTO a FROM acquisition WHERE id = target;
      IF a.ownership_aligned_at IS NULL THEN
        RETURN NULL;
      END IF;
      IF EXISTS (SELECT 1 FROM ownership o WHERE o.acquisition_id = target AND o.status = 'VALID' AND o.valid_from <> a.economic_transfer_date) THEN
        RETURN 'BUYER_ROW_NOT_MOVED';
      END IF;
      IF EXISTS (SELECT 1 FROM ownership o JOIN acquisition_party ap ON ap.party_id = o.owner_party_id AND ap.acquisition_id = target
                  WHERE o.property_reference_id = a.property_reference_id AND o.mre_realm_id = a.mre_realm_id AND o.status = 'VALID'
                    AND ap.role = 'SELLER' AND o.valid_until = a.contract_date - 1) THEN
        RETURN 'SELLER_ROW_NOT_EXTENDED';
      END IF;
      IF EXISTS (SELECT 1 FROM ownership o JOIN acquisition_party ap ON ap.party_id = o.owner_party_id AND ap.acquisition_id = target
                  WHERE o.property_reference_id = a.property_reference_id AND o.mre_realm_id = a.mre_realm_id AND o.status = 'VALID'
                    AND ap.role = 'BUYER' AND o.acquisition_id IS DISTINCT FROM target AND o.valid_until = a.contract_date - 1) THEN
        RETURN 'BUYER_PREDECESSOR_NOT_EXTENDED';
      END IF;
      IF a.status = 'CONFIRMED' THEN
        RETURN acquisition_increase_violation(target);
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE FUNCTION ownership_alignment_complete() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      targets uuid[];
      target uuid;
      violation text;
    BEGIN
      -- Each branch reads only its own table's columns (PL/pgSQL resolves NEW's fields per statement and table).
      IF TG_TABLE_NAME = 'acquisition' THEN
        targets := ARRAY[NEW.id];
      ELSE
        SELECT coalesce(array_agg(a.id ORDER BY a.id), '{}') INTO targets FROM acquisition a
         WHERE a.ownership_aligned_at IS NOT NULL
           AND a.property_reference_id = NEW.property_reference_id AND a.mre_realm_id = NEW.mre_realm_id
           AND ((a.id = NEW.acquisition_id AND NEW.valid_from = a.economic_transfer_date)
                OR (NEW.valid_until = a.economic_transfer_date - 1
                    AND EXISTS (SELECT 1 FROM acquisition_party ap WHERE ap.acquisition_id = a.id AND ap.party_id = NEW.owner_party_id)));
      END IF;
      FOREACH target IN ARRAY targets LOOP
        violation := ownership_alignment_violation(target);
        IF violation IS NOT NULL THEN
          RAISE EXCEPTION 'Acquisition %: its Ownerships are aligned to the transfer only as a whole (%; api-design §58Q)', target, violation
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER ownership_alignment_complete AFTER UPDATE ON acquisition DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (OLD.ownership_aligned_at IS NULL AND NEW.ownership_aligned_at IS NOT NULL)
      EXECUTE FUNCTION ownership_alignment_complete()
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER ownership_alignment_complete AFTER UPDATE ON ownership DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (NEW.valid_from > OLD.valid_from OR NEW.valid_until > OLD.valid_until)
      EXECUTE FUNCTION ownership_alignment_complete()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is changed (api-design §58Q "down"; §58E: a person's statement is never dropped silently).
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM acquisition WHERE ownership_aligned_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM tax_year_acknowledgement WHERE change_kind = ${sql.lit(KIND)}) THEN
        RAISE EXCEPTION 'acquisition / tax_year_acknowledgement: an alignment to the transfer or its acknowledgement exists; the moved dates cannot be restored without their marker (api-design §58Q)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP TRIGGER ownership_alignment_complete ON ownership`.execute(db);
  await sql`DROP TRIGGER ownership_alignment_complete ON acquisition`.execute(db);
  await sql`DROP FUNCTION ownership_alignment_complete()`.execute(db);
  await sql`DROP FUNCTION ownership_alignment_violation(uuid)`.execute(db);
  for (const p of [...PATCHES].reverse()) await patchFunction(db, p.fn, p.to, p.from);
  await constraints(db, KINDS_0071, KIND_ENTITY_0071);
  await sql`
    ALTER TABLE acquisition
      DROP CONSTRAINT acquisition_ownership_alignment,
      DROP COLUMN ownership_alignment_source_references,
      DROP COLUMN ownership_aligned_at
  `.execute(db);
}

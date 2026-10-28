import { sql, type Kysely } from 'kysely';
import { frozenBody as suggestionsFrozenBody } from './0031_rent_reconciliation_suggestions.js';

/**
 * VC-4-04: write-back to MRE (api-design.md §37.4, phase-4-plan P4-D6, P4-D7's effect of a release).
 *
 * - `rent_payment_reconciliation` gains the lease (`mre_write_back_attempt_id`, `mre_write_back_lease_until`, set
 *   exactly when `PENDING`), the written snapshot (`mre_written_back_at`, `mre_written_back_by`, `mre_payment`: set when
 *   `WRITTEN`, kept into `REMOVAL_REQUIRED`) and the failure (`mre_write_back_error`, `mre_write_back_failed_at`, set
 *   exactly when `FAILED`).
 * - `mre_write_back_state` in `NOT_WRITTEN`, `PENDING`, `WRITTEN`, `FAILED` (only on `CONFIRMED`) and
 *   `REMOVAL_REQUIRED` (only on `RELEASED`); a row is born `NOT_WRITTEN`.
 * - A partial unique index: one `PENDING` per Realm and MRE Tenant (MRE's PATCH rewrites the whole Tenant).
 * - `rent_payment_reconciliation_frozen`: a change that keeps `status` is a write-back step with `version` + 1; the
 *   release sets `REMOVAL_REQUIRED` from every state but `NOT_WRITTEN` and is refused under a live lease.
 * - `down` restores 0031's frozen function exactly.
 */
const ERRORS = `('MRE_RENT_TERM_NOT_FOUND', 'MRE_UNAVAILABLE', 'MRE_FORBIDDEN', 'MRE_WRITE_REFUSED', 'MRE_PAYMENT_CHANGED', 'MRE_TERM_CHANGED', 'LEASE_EXPIRED')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE rent_payment_reconciliation
      DROP CONSTRAINT rent_payment_reconciliation_mre_write_back_state_check,
      ADD COLUMN mre_write_back_attempt_id uuid,
      ADD COLUMN mre_write_back_lease_until timestamptz,
      ADD COLUMN mre_written_back_at timestamptz,
      ADD COLUMN mre_written_back_by text,
      ADD COLUMN mre_payment jsonb,
      ADD COLUMN mre_write_back_error text CHECK (mre_write_back_error IN ${sql.raw(ERRORS)}),
      ADD COLUMN mre_write_back_failed_at timestamptz,
      ADD CONSTRAINT rent_payment_reconciliation_write_back_state CHECK (
        mre_write_back_state IN ('NOT_WRITTEN', 'PENDING', 'WRITTEN', 'FAILED', 'REMOVAL_REQUIRED')
        AND (mre_write_back_state NOT IN ('PENDING', 'WRITTEN', 'FAILED') OR status = 'CONFIRMED')
        AND (mre_write_back_state <> 'REMOVAL_REQUIRED' OR status = 'RELEASED')
      ),
      ADD CONSTRAINT rent_payment_reconciliation_write_back_fields CHECK (
        (mre_write_back_state = 'PENDING') = (mre_write_back_attempt_id IS NOT NULL)
        AND (mre_write_back_state = 'PENDING') = (mre_write_back_lease_until IS NOT NULL)
        AND (mre_write_back_state = 'FAILED') = (mre_write_back_error IS NOT NULL)
        AND (mre_write_back_state = 'FAILED') = (mre_write_back_failed_at IS NOT NULL)
        AND (mre_written_back_at IS NULL) = (mre_written_back_by IS NULL)
        AND (mre_written_back_at IS NULL) = (mre_payment IS NULL)
        AND (mre_write_back_state <> 'WRITTEN' OR mre_written_back_at IS NOT NULL)
        AND (mre_write_back_state NOT IN ('NOT_WRITTEN', 'PENDING', 'FAILED') OR mre_written_back_at IS NULL)
      )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX rent_payment_reconciliation_write_back_tenant_key ON rent_payment_reconciliation (mre_realm_id, mre_tenant_id)
      WHERE mre_write_back_state = 'PENDING'
  `.execute(db);
  await sql`
    CREATE FUNCTION rent_payment_reconciliation_born_unwritten() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.mre_write_back_state <> 'NOT_WRITTEN' THEN
        RAISE EXCEPTION 'RentPaymentReconciliation: only inserted NOT_WRITTEN, not % (api-design §37.4)', NEW.mre_write_back_state
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER rent_payment_reconciliation_born_unwritten BEFORE INSERT ON rent_payment_reconciliation
      FOR EACH ROW EXECUTE FUNCTION rent_payment_reconciliation_born_unwritten()
  `.execute(db);
  await sql`CREATE OR REPLACE FUNCTION rent_payment_reconciliation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${sql.raw(FROZEN)}$$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION rent_payment_reconciliation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${sql.raw(suggestionsFrozenBody(true))}$$`.execute(db);
  await sql`DROP TRIGGER rent_payment_reconciliation_born_unwritten ON rent_payment_reconciliation`.execute(db);
  await sql`DROP FUNCTION rent_payment_reconciliation_born_unwritten()`.execute(db);
  await sql`DROP INDEX rent_payment_reconciliation_write_back_tenant_key`.execute(db);
  await sql`
    ALTER TABLE rent_payment_reconciliation
      DROP CONSTRAINT rent_payment_reconciliation_write_back_fields,
      DROP CONSTRAINT rent_payment_reconciliation_write_back_state,
      DROP COLUMN mre_write_back_failed_at,
      DROP COLUMN mre_write_back_error,
      DROP COLUMN mre_payment,
      DROP COLUMN mre_written_back_by,
      DROP COLUMN mre_written_back_at,
      DROP COLUMN mre_write_back_lease_until,
      DROP COLUMN mre_write_back_attempt_id,
      ADD CONSTRAINT rent_payment_reconciliation_mre_write_back_state_check CHECK (mre_write_back_state = 'NOT_WRITTEN')
  `.execute(db);
}

/**
 * 0031's frozen fields and status steps, plus the write-back: a change that keeps `status` is a step of
 * `mre_write_back_state` on a `CONFIRMED` row, with `version` + 1 and no other field changed; with the release the
 * state becomes exactly `NOT_WRITTEN` from `NOT_WRITTEN` and `REMOVAL_REQUIRED` from the others, never under a live lease.
 */
export const FROZEN = `
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: never deleted; release it instead (api-design §37.1)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.transaction_id, NEW.mre_tenant_id, NEW.mre_rent_term, NEW.currency,
          NEW.confidence, NEW.suggestion_reason, NEW.notes, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.transaction_id, OLD.mre_tenant_id, OLD.mre_rent_term, OLD.currency,
          OLD.confidence, OLD.suggestion_reason, OLD.notes, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: fixed after creation; release it and match again (api-design §37.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- A confirm may lower the suggested amount, never raise it; no other step changes it (api-design §37.3).
      IF NEW.matched_amount IS DISTINCT FROM OLD.matched_amount
         AND NOT (OLD.status = 'SUGGESTED' AND NEW.status = 'CONFIRMED' AND NEW.matched_amount < OLD.matched_amount) THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: matched_amount % → % only lowered when a suggestion is confirmed (api-design §37.3)', OLD.id, OLD.matched_amount, NEW.matched_amount
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF NEW.status = OLD.status THEN
        -- A write-back step (api-design §37.4): only the write-back fields change, on a CONFIRMED row.
        IF (NEW.confirmed_at, NEW.confirmed_by, NEW.released_at, NEW.released_by, NEW.release_reason,
            NEW.rejected_at, NEW.rejected_by, NEW.reject_reason)
           IS DISTINCT FROM
           (OLD.confirmed_at, OLD.confirmed_by, OLD.released_at, OLD.released_by, OLD.release_reason,
            OLD.rejected_at, OLD.rejected_by, OLD.reject_reason)
           OR NEW.version <> OLD.version + 1
           OR NOT (
             (OLD.mre_write_back_state IN ('NOT_WRITTEN', 'FAILED') AND NEW.mre_write_back_state = 'PENDING')
             OR (OLD.mre_write_back_state = 'PENDING' AND NEW.mre_write_back_state = 'PENDING'
                 AND OLD.mre_write_back_lease_until <= now() AND NEW.mre_write_back_attempt_id IS DISTINCT FROM OLD.mre_write_back_attempt_id)
             OR (OLD.mre_write_back_state = 'PENDING' AND NEW.mre_write_back_state IN ('WRITTEN', 'FAILED', 'NOT_WRITTEN'))
           ) THEN
          RAISE EXCEPTION 'RentPaymentReconciliation %: write-back % → % with version % → % is not a step (api-design §37.4)', OLD.id,
            OLD.mre_write_back_state, NEW.mre_write_back_state, OLD.version, NEW.version
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END IF;
      IF NOT ((OLD.status = 'SUGGESTED' AND NEW.status IN ('CONFIRMED', 'REJECTED')) OR (OLD.status = 'CONFIRMED' AND NEW.status = 'RELEASED'))
         OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: % → % with version % → % is not a step (api-design §37.1)', OLD.id, OLD.status, NEW.status, OLD.version, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status = 'RELEASED' THEN
        -- P4-D7: a written-back match is never released silently; a live lease means a PATCH may still be in flight.
        IF OLD.mre_write_back_state = 'PENDING' AND OLD.mre_write_back_lease_until > now() THEN
          RAISE EXCEPTION 'RentPaymentReconciliation %: a write-back is running (WRITE_BACK_IN_PROGRESS)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.mre_write_back_state IS DISTINCT FROM (CASE WHEN OLD.mre_write_back_state = 'NOT_WRITTEN' THEN 'NOT_WRITTEN' ELSE 'REMOVAL_REQUIRED' END)
           OR NEW.mre_written_back_at IS DISTINCT FROM OLD.mre_written_back_at OR NEW.mre_payment IS DISTINCT FROM OLD.mre_payment THEN
          RAISE EXCEPTION 'RentPaymentReconciliation %: released with write-back % → % (api-design §37.4)', OLD.id, OLD.mre_write_back_state, NEW.mre_write_back_state
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      ELSIF NEW.mre_write_back_state <> 'NOT_WRITTEN' THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: % → % with write-back % (api-design §37.4)', OLD.id, OLD.status, NEW.status, NEW.mre_write_back_state
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END `;

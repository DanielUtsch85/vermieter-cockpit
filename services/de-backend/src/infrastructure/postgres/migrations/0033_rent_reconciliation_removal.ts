import { sql, type Kysely } from 'kysely';
import { FROZEN as WRITE_BACK_FROZEN } from './0032_rent_reconciliation_write_back.js';

/**
 * VC-4-05: removal from MRE after release (api-design.md §37.5, phase-4-plan P4-D7).
 *
 * - `rent_payment_reconciliation` gains `mre_last_lease_until` (the end of the last write-back or removal lease, set by
 *   every claim and never cleared), `mre_removed_at` and `mre_removed_by` (set exactly when `REMOVED`).
 * - Backfill: every row claimed under 0032 gets its last known time + 2 minutes, `released_at` included (review on #84).
 * - `mre_write_back_state` adds `REMOVING`, `REMOVED`, `REMOVAL_FAILED`, all on `RELEASED` only; the attempt and the lease
 *   go with `PENDING` and `REMOVING`, the error with `FAILED` and `REMOVAL_FAILED`.
 * - The Tenant index covers `PENDING` and `REMOVING`: one MRE write per Tenant at a time.
 * - `rent_payment_reconciliation_frozen` gains the removal steps; a removal is claimed only past `mre_last_lease_until`.
 * - `down` restores 0032's function, constraints and index exactly.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE rent_payment_reconciliation
      ADD COLUMN mre_last_lease_until timestamptz,
      ADD COLUMN mre_removed_at timestamptz,
      ADD COLUMN mre_removed_by text
  `.execute(db);
  // Rows claimed under 0032: their lease ended at most twice the longest MRE timeout (60 s) after the claim, and the
  // claim came before the failure, the write and the release. The backfill is no step, so the frozen trigger is off.
  await sql`ALTER TABLE rent_payment_reconciliation DISABLE TRIGGER rent_payment_reconciliation_frozen`.execute(db);
  await sql`
    UPDATE rent_payment_reconciliation
       SET mre_last_lease_until = coalesce(mre_write_back_lease_until, mre_write_back_failed_at, mre_written_back_at, released_at) + interval '2 minutes'
     WHERE mre_write_back_state <> 'NOT_WRITTEN'
  `.execute(db);
  await sql`ALTER TABLE rent_payment_reconciliation ENABLE TRIGGER rent_payment_reconciliation_frozen`.execute(db);
  await sql`
    ALTER TABLE rent_payment_reconciliation
      DROP CONSTRAINT rent_payment_reconciliation_write_back_state,
      DROP CONSTRAINT rent_payment_reconciliation_write_back_fields,
      ADD CONSTRAINT rent_payment_reconciliation_write_back_state CHECK (
        mre_write_back_state IN ('NOT_WRITTEN', 'PENDING', 'WRITTEN', 'FAILED', 'REMOVAL_REQUIRED', 'REMOVING', 'REMOVED', 'REMOVAL_FAILED')
        AND (mre_write_back_state NOT IN ('PENDING', 'WRITTEN', 'FAILED') OR status = 'CONFIRMED')
        AND (mre_write_back_state NOT IN ('REMOVAL_REQUIRED', 'REMOVING', 'REMOVED', 'REMOVAL_FAILED') OR status = 'RELEASED')
      ),
      ADD CONSTRAINT rent_payment_reconciliation_write_back_fields CHECK (
        (mre_write_back_state IN ('PENDING', 'REMOVING')) = (mre_write_back_attempt_id IS NOT NULL)
        AND (mre_write_back_state IN ('PENDING', 'REMOVING')) = (mre_write_back_lease_until IS NOT NULL)
        AND (mre_write_back_state IN ('FAILED', 'REMOVAL_FAILED')) = (mre_write_back_error IS NOT NULL)
        AND (mre_write_back_state IN ('FAILED', 'REMOVAL_FAILED')) = (mre_write_back_failed_at IS NOT NULL)
        AND (mre_written_back_at IS NULL) = (mre_written_back_by IS NULL)
        AND (mre_written_back_at IS NULL) = (mre_payment IS NULL)
        AND (mre_write_back_state <> 'WRITTEN' OR mre_written_back_at IS NOT NULL)
        AND (mre_write_back_state NOT IN ('NOT_WRITTEN', 'PENDING', 'FAILED') OR mre_written_back_at IS NULL)
        AND (mre_write_back_state = 'REMOVED') = (mre_removed_at IS NOT NULL)
        AND (mre_write_back_state = 'REMOVED') = (mre_removed_by IS NOT NULL)
        AND (mre_write_back_state = 'NOT_WRITTEN' OR mre_last_lease_until IS NOT NULL)
      )
  `.execute(db);
  await sql`DROP INDEX rent_payment_reconciliation_write_back_tenant_key`.execute(db);
  await sql`
    CREATE UNIQUE INDEX rent_payment_reconciliation_write_back_tenant_key ON rent_payment_reconciliation (mre_realm_id, mre_tenant_id)
      WHERE mre_write_back_state IN ('PENDING', 'REMOVING')
  `.execute(db);
  await sql`CREATE OR REPLACE FUNCTION rent_payment_reconciliation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${sql.raw(FROZEN)}$$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION rent_payment_reconciliation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${sql.raw(WRITE_BACK_FROZEN)}$$`.execute(db);
  await sql`DROP INDEX rent_payment_reconciliation_write_back_tenant_key`.execute(db);
  await sql`
    CREATE UNIQUE INDEX rent_payment_reconciliation_write_back_tenant_key ON rent_payment_reconciliation (mre_realm_id, mre_tenant_id)
      WHERE mre_write_back_state = 'PENDING'
  `.execute(db);
  await sql`
    ALTER TABLE rent_payment_reconciliation
      DROP CONSTRAINT rent_payment_reconciliation_write_back_fields,
      DROP CONSTRAINT rent_payment_reconciliation_write_back_state,
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
      ),
      DROP COLUMN mre_removed_by,
      DROP COLUMN mre_removed_at,
      DROP COLUMN mre_last_lease_until
  `.execute(db);
}

/**
 * 0032's frozen fields, status steps and write-back steps, plus the removal (§37.5): on a `RELEASED` row a change that
 * keeps `status` is a removal step with `version` + 1 and no other field changed; `mre_last_lease_until` is raised by
 * each claim (`PENDING` or `REMOVING`) to its lease if later, never lowered, never cleared, and nothing else changes it.
 */
const FROZEN = `
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
      -- The last lease end (api-design §37.5): each claim raises it to its lease if later; never lowered or cleared.
      IF NEW.mre_write_back_state IN ('PENDING', 'REMOVING') AND NEW.mre_write_back_attempt_id IS DISTINCT FROM OLD.mre_write_back_attempt_id THEN
        IF NEW.mre_last_lease_until IS DISTINCT FROM greatest(OLD.mre_last_lease_until, NEW.mre_write_back_lease_until) THEN
          RAISE EXCEPTION 'RentPaymentReconciliation %: a claim sets mre_last_lease_until to the latest lease (api-design §37.5)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      ELSIF NEW.mre_last_lease_until IS DISTINCT FROM OLD.mre_last_lease_until THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: mre_last_lease_until changed outside a claim (api-design §37.5)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status = OLD.status THEN
        -- A write-back step on a CONFIRMED row (api-design §37.4) or a removal step on a RELEASED row (§37.5).
        IF (NEW.confirmed_at, NEW.confirmed_by, NEW.released_at, NEW.released_by, NEW.release_reason,
            NEW.rejected_at, NEW.rejected_by, NEW.reject_reason)
           IS DISTINCT FROM
           (OLD.confirmed_at, OLD.confirmed_by, OLD.released_at, OLD.released_by, OLD.release_reason,
            OLD.rejected_at, OLD.rejected_by, OLD.reject_reason)
           OR NEW.version <> OLD.version + 1
           OR (OLD.status = 'RELEASED' AND (NEW.mre_written_back_at IS DISTINCT FROM OLD.mre_written_back_at OR NEW.mre_payment IS DISTINCT FROM OLD.mre_payment))
           OR NOT (
             (OLD.status = 'CONFIRMED' AND (
               (OLD.mre_write_back_state IN ('NOT_WRITTEN', 'FAILED') AND NEW.mre_write_back_state = 'PENDING')
               OR (OLD.mre_write_back_state = 'PENDING' AND NEW.mre_write_back_state = 'PENDING'
                   AND OLD.mre_write_back_lease_until <= now() AND NEW.mre_write_back_attempt_id IS DISTINCT FROM OLD.mre_write_back_attempt_id)
               OR (OLD.mre_write_back_state = 'PENDING' AND NEW.mre_write_back_state IN ('WRITTEN', 'FAILED', 'NOT_WRITTEN'))
             ))
             OR (OLD.status = 'RELEASED' AND (
               (OLD.mre_write_back_state IN ('REMOVAL_REQUIRED', 'REMOVAL_FAILED') AND NEW.mre_write_back_state = 'REMOVING'
                   AND OLD.mre_last_lease_until < now())
               OR (OLD.mre_write_back_state = 'REMOVING' AND NEW.mre_write_back_state = 'REMOVING'
                   AND OLD.mre_write_back_lease_until <= now() AND NEW.mre_write_back_attempt_id IS DISTINCT FROM OLD.mre_write_back_attempt_id)
               OR (OLD.mre_write_back_state = 'REMOVING' AND NEW.mre_write_back_state IN ('REMOVED', 'REMOVAL_FAILED', 'REMOVAL_REQUIRED'))
             ))
           ) THEN
          RAISE EXCEPTION 'RentPaymentReconciliation %: write-back % → % with version % → % is not a step (api-design §37.4, §37.5)', OLD.id,
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

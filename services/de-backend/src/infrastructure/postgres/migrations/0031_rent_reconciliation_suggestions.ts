import { sql, type Kysely } from 'kysely';

/**
 * VC-4-03: suggestions (api-design.md §37.3, phase-4-plan P4-D4, P4-D5).
 *
 * - `rent_payment_reconciliation` gains `rejected_at`, `rejected_by`, `reject_reason`, set exactly with `REJECTED`.
 * - A `SUGGESTED` row carries `confidence` and `suggestion_reason` (`EXACT_AMOUNT` | `EXACT_AMOUNT_IBAN_HISTORY`).
 * - A partial unique index: at most one `SUGGESTED` per Transaction and term, the arbiter of two concurrent runs.
 * - `rent_payment_reconciliation_cash`: a `SUGGESTED` insert writes the Transaction row and refuses one not counted, not
 *   `INFLOW` or without rent cash, with no sum check (a suggestion consumes nothing).
 * - `rent_payment_reconciliation_frozen`: `matched_amount` changes only in the step `SUGGESTED` → `CONFIRMED`, and only
 *   to a lower positive amount (a confirm may lower it, never raise it).
 * - `down` restores 0030's functions exactly.
 */
const RENT_CATEGORIES = `('RENT_BASE', 'RENT_OPERATING_COST_ADVANCE', 'RENT_OPERATING_COST_SETTLEMENT')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE rent_payment_reconciliation
      ADD COLUMN rejected_at timestamptz,
      ADD COLUMN rejected_by text,
      ADD COLUMN reject_reason text CHECK (length(reject_reason) BETWEEN 1 AND 500 AND reject_reason = btrim(reject_reason)),
      ADD CONSTRAINT rent_payment_reconciliation_rejected_fields CHECK (
        (status = 'REJECTED') = (rejected_at IS NOT NULL)
        AND (status = 'REJECTED') = (rejected_by IS NOT NULL)
        AND (status = 'REJECTED') = (reject_reason IS NOT NULL)
      ),
      ADD CONSTRAINT rent_payment_reconciliation_suggestion_fields CHECK (
        (status <> 'SUGGESTED' OR (confidence IS NOT NULL AND suggestion_reason IS NOT NULL))
        AND (suggestion_reason IS NULL OR suggestion_reason IN ('EXACT_AMOUNT', 'EXACT_AMOUNT_IBAN_HISTORY'))
        AND (confidence IS NULL) = (suggestion_reason IS NULL)
      )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX rent_payment_reconciliation_suggested_key ON rent_payment_reconciliation (transaction_id, mre_tenant_id, mre_rent_term)
      WHERE status = 'SUGGESTED'
  `.execute(db);
  await sql`CREATE OR REPLACE FUNCTION rent_payment_reconciliation_cash() RETURNS trigger LANGUAGE plpgsql AS $$${sql.raw(cashBody(true))}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION rent_payment_reconciliation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${sql.raw(frozenBody(true))}$$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION rent_payment_reconciliation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${sql.raw(frozenBody(false))}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION rent_payment_reconciliation_cash() RETURNS trigger LANGUAGE plpgsql AS $$${sql.raw(cashBody(false))}$$`.execute(db);
  await sql`DROP INDEX rent_payment_reconciliation_suggested_key`.execute(db);
  await sql`
    ALTER TABLE rent_payment_reconciliation
      DROP CONSTRAINT rent_payment_reconciliation_suggestion_fields,
      DROP CONSTRAINT rent_payment_reconciliation_rejected_fields,
      DROP COLUMN reject_reason,
      DROP COLUMN rejected_by,
      DROP COLUMN rejected_at
  `.execute(db);
}

/** 0030's cash guard; with `suggestions` a `SUGGESTED` insert gets the checks without the sum. */
function cashBody(suggestions: boolean): string {
  return `
    DECLARE
      tx_status text;
      tx_direction text;
      tx_role text;
      rent_cash numeric;
      matched numeric;
    BEGIN
      -- Born only SUGGESTED or CONFIRMED with version 1: the other statuses are reached only by the steps (review on #77).
      IF TG_OP = 'INSERT' AND (NEW.status NOT IN ('SUGGESTED', 'CONFIRMED') OR NEW.version <> 1) THEN
        RAISE EXCEPTION 'RentPaymentReconciliation: only inserted SUGGESTED or CONFIRMED with version 1, not % / % (api-design §37.1)', NEW.status, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- P4-D8: the Transaction row first, so every confirm serialises on it (a stale one fails under REPEATABLE READ).
      UPDATE ledger_transaction SET version = version WHERE id = NEW.transaction_id
        RETURNING status, direction, correction_role INTO tx_status, tx_direction, tx_role;
      IF tx_status IS NULL THEN
        RETURN NEW; -- an unknown Transaction is left to the foreign key
      END IF;
      IF NEW.status <> 'CONFIRMED'${suggestions ? ` AND NEW.status <> 'SUGGESTED'` : ''} THEN
        RETURN NEW;
      END IF;
      IF tx_status NOT IN ('CONFIRMED', 'RECONCILED') OR tx_role IS NOT DISTINCT FROM 'REVERSAL' THEN
        RAISE EXCEPTION 'RentPaymentReconciliation: Transaction % is % (role %), not counted (TRANSACTION_NOT_COUNTED)', NEW.transaction_id, tx_status, tx_role
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF tx_direction <> 'INFLOW' THEN
        RAISE EXCEPTION 'RentPaymentReconciliation: Transaction % is %, not INFLOW (TRANSACTION_NOT_INFLOW)', NEW.transaction_id, tx_direction
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT sum(s.amount) INTO rent_cash FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id
        WHERE s.transaction_id = NEW.transaction_id AND c.code IN ${RENT_CATEGORIES};
      IF rent_cash IS NULL OR rent_cash = 0 THEN
        RAISE EXCEPTION 'RentPaymentReconciliation: Transaction % has no rent cash (NO_RENT_CASH)', NEW.transaction_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;${
        suggestions
          ? `
      -- A suggestion consumes nothing: no sum check (api-design §37.3).
      IF NEW.status = 'SUGGESTED' THEN
        RETURN NEW;
      END IF;`
          : ''
      }
      -- Re-read after the Transaction write: under READ COMMITTED every confirm that committed before is seen.
      SELECT coalesce(sum(matched_amount), 0) INTO matched FROM rent_payment_reconciliation
        WHERE transaction_id = NEW.transaction_id AND status = 'CONFIRMED' AND id <> NEW.id;
      IF matched + NEW.matched_amount > rent_cash THEN
        RAISE EXCEPTION 'RentPaymentReconciliation: Transaction % has rent cash %, % already matched, % more exceeds it (RENT_CASH_EXCEEDED)',
          NEW.transaction_id, rent_cash, matched, NEW.matched_amount
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END `;
}

/** 0030's frozen fields; with `suggestions` `matched_amount` may be lowered in the step SUGGESTED → CONFIRMED. */
function frozenBody(suggestions: boolean): string {
  const amount = suggestions ? '' : 'NEW.matched_amount, ';
  const oldAmount = suggestions ? '' : 'OLD.matched_amount, ';
  return `
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: never deleted; release it instead (api-design §37.1)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.transaction_id, NEW.mre_tenant_id, NEW.mre_rent_term, ${amount}NEW.currency,
          NEW.confidence, NEW.suggestion_reason, NEW.notes, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.transaction_id, OLD.mre_tenant_id, OLD.mre_rent_term, ${oldAmount}OLD.currency,
          OLD.confidence, OLD.suggestion_reason, OLD.notes, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: fixed after creation; release it and match again (api-design §37.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;${
        suggestions
          ? `
      -- A confirm may lower the suggested amount, never raise it; no other step changes it (api-design §37.3).
      IF NEW.matched_amount IS DISTINCT FROM OLD.matched_amount
         AND NOT (OLD.status = 'SUGGESTED' AND NEW.status = 'CONFIRMED' AND NEW.matched_amount < OLD.matched_amount) THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: matched_amount % → % only lowered when a suggestion is confirmed (api-design §37.3)', OLD.id, OLD.matched_amount, NEW.matched_amount
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;`
          : ''
      }
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF NOT ((OLD.status = 'SUGGESTED' AND NEW.status IN ('CONFIRMED', 'REJECTED')) OR (OLD.status = 'CONFIRMED' AND NEW.status = 'RELEASED'))
         OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: % → % with version % → % is not a step (api-design §37.1)', OLD.id, OLD.status, NEW.status, OLD.version, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END `;
}

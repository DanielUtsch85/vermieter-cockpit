import { sql, type Kysely } from 'kysely';

/**
 * VC-4-01: RentPaymentReconciliation (data-model.md §18A, api-design.md §37.1, phase-4-plan P4-D2, P4-D3, P4-D7, P4-D8).
 *
 * - `rent_payment_reconciliation`: one Transaction's rent cash matched to one MRE rent term, of the same Realm and
 *   currency; status `SUGGESTED` → `CONFIRMED` | `REJECTED`, `CONFIRMED` → `RELEASED`; the confirmation and release
 *   fields exactly with their status; `mre_write_back_state` fixed to `NOT_WRITTEN` until VC-4-04.
 * - A partial unique index: at most one `CONFIRMED` reconciliation per Transaction and term.
 * - `rent_payment_reconciliation_cash` (before insert, and before the step into `CONFIRMED`): writes the Transaction
 *   row first (P3-D8's no-op, Transaction → reconciliation), then refuses a Transaction that is not counted, not
 *   `INFLOW`, or without rent cash, and a sum of `CONFIRMED` matches above its rent cash (BR-RENT-005).
 * - `rent_payment_reconciliation_frozen` (before update or delete): the fixed fields never change; the status steps
 *   above only, each with `version` + 1; never deleted.
 * - `ledger_transaction_rent_reconciled` (before the step into `CORRECTED`): refuses while a `CONFIRMED`
 *   reconciliation names the Transaction (P4-D7). The correction path holds the Transaction, so it serialises with
 *   the cash guard on the same row.
 * - Not here: the MRE check (P4-D1), the order of checks, the reads.
 */
const RENT_CATEGORIES = sql.raw(`('RENT_BASE', 'RENT_OPERATING_COST_ADVANCE', 'RENT_OPERATING_COST_SETTLEMENT')`);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE rent_payment_reconciliation (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('SUGGESTED', 'CONFIRMED', 'REJECTED', 'RELEASED')),
      transaction_id uuid NOT NULL,
      mre_tenant_id text NOT NULL CHECK (mre_tenant_id ~ '^[0-9a-f]{24}$'),
      mre_rent_term text NOT NULL CHECK (mre_rent_term ~ '^[0-9]{10}$'),
      matched_amount numeric NOT NULL CHECK (scale(matched_amount) <= 2 AND matched_amount > 0 AND matched_amount < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      confidence text CHECK (confidence IN ('HIGH', 'MEDIUM')),
      suggestion_reason text CHECK (length(suggestion_reason) BETWEEN 1 AND 500),
      confirmed_at timestamptz,
      confirmed_by text,
      released_at timestamptz,
      released_by text,
      release_reason text CHECK (length(release_reason) BETWEEN 1 AND 500 AND release_reason = btrim(release_reason)),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      mre_write_back_state text NOT NULL DEFAULT 'NOT_WRITTEN' CHECK (mre_write_back_state = 'NOT_WRITTEN'),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT rent_payment_reconciliation_transaction_fk FOREIGN KEY (transaction_id, mre_realm_id, currency)
        REFERENCES ledger_transaction (id, mre_realm_id, currency),
      CONSTRAINT rent_payment_reconciliation_confirmed_fields CHECK (
        (status IN ('CONFIRMED', 'RELEASED')) = (confirmed_at IS NOT NULL)
        AND (status IN ('CONFIRMED', 'RELEASED')) = (confirmed_by IS NOT NULL)
      ),
      CONSTRAINT rent_payment_reconciliation_released_fields CHECK (
        (status = 'RELEASED') = (released_at IS NOT NULL)
        AND (status = 'RELEASED') = (released_by IS NOT NULL)
        AND (status = 'RELEASED') = (release_reason IS NOT NULL)
      )
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX rent_payment_reconciliation_confirmed_key ON rent_payment_reconciliation (transaction_id, mre_tenant_id, mre_rent_term)
      WHERE status = 'CONFIRMED'
  `.execute(db);
  await sql`CREATE INDEX rent_payment_reconciliation_list_idx ON rent_payment_reconciliation (mre_realm_id, created_at DESC, id DESC)`.execute(db);
  await sql`CREATE INDEX rent_payment_reconciliation_term_idx ON rent_payment_reconciliation (mre_realm_id, mre_tenant_id, mre_rent_term)`.execute(db);

  await sql`
    CREATE FUNCTION rent_payment_reconciliation_cash() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      tx_status text;
      tx_direction text;
      tx_role text;
      rent_cash numeric;
      matched numeric;
    BEGIN
      -- P4-D8: the Transaction row first, so every confirm serialises on it (a stale one fails under REPEATABLE READ).
      UPDATE ledger_transaction SET version = version WHERE id = NEW.transaction_id
        RETURNING status, direction, correction_role INTO tx_status, tx_direction, tx_role;
      IF tx_status IS NULL THEN
        RETURN NEW; -- an unknown Transaction is left to the foreign key
      END IF;
      IF NEW.status <> 'CONFIRMED' THEN
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
      END IF;
      -- Re-read after the Transaction write: under READ COMMITTED every confirm that committed before is seen.
      SELECT coalesce(sum(matched_amount), 0) INTO matched FROM rent_payment_reconciliation
        WHERE transaction_id = NEW.transaction_id AND status = 'CONFIRMED' AND id <> NEW.id;
      IF matched + NEW.matched_amount > rent_cash THEN
        RAISE EXCEPTION 'RentPaymentReconciliation: Transaction % has rent cash %, % already matched, % more exceeds it (RENT_CASH_EXCEEDED)',
          NEW.transaction_id, rent_cash, matched, NEW.matched_amount
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER rent_payment_reconciliation_cash BEFORE INSERT ON rent_payment_reconciliation
      FOR EACH ROW EXECUTE FUNCTION rent_payment_reconciliation_cash()
  `.execute(db);
  await sql`
    CREATE TRIGGER rent_payment_reconciliation_cash_confirm BEFORE UPDATE ON rent_payment_reconciliation
      FOR EACH ROW WHEN (NEW.status = 'CONFIRMED' AND OLD.status <> 'CONFIRMED') EXECUTE FUNCTION rent_payment_reconciliation_cash()
  `.execute(db);

  await sql`
    CREATE FUNCTION rent_payment_reconciliation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: never deleted; release it instead (api-design §37.1)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.transaction_id, NEW.mre_tenant_id, NEW.mre_rent_term, NEW.matched_amount, NEW.currency,
          NEW.confidence, NEW.suggestion_reason, NEW.notes, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.transaction_id, OLD.mre_tenant_id, OLD.mre_rent_term, OLD.matched_amount, OLD.currency,
          OLD.confidence, OLD.suggestion_reason, OLD.notes, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: fixed after creation; release it and match again (api-design §37.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF NOT ((OLD.status = 'SUGGESTED' AND NEW.status IN ('CONFIRMED', 'REJECTED')) OR (OLD.status = 'CONFIRMED' AND NEW.status = 'RELEASED'))
         OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'RentPaymentReconciliation %: % → % with version % → % is not a step (api-design §37.1)', OLD.id, OLD.status, NEW.status, OLD.version, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER rent_payment_reconciliation_frozen BEFORE UPDATE OR DELETE ON rent_payment_reconciliation
      FOR EACH ROW EXECUTE FUNCTION rent_payment_reconciliation_frozen()
  `.execute(db);

  await sql`
    CREATE FUNCTION ledger_transaction_rent_reconciled() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      ids text;
    BEGIN
      SELECT string_agg(id::text, ', ' ORDER BY id) INTO ids FROM rent_payment_reconciliation
        WHERE transaction_id = NEW.id AND status = 'CONFIRMED';
      IF ids IS NOT NULL THEN
        RAISE EXCEPTION 'Transaction %: confirmed rent reconciliations % name it; release them first (TRANSACTION_RENT_RECONCILED)', NEW.id, ids
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_transaction_rent_reconciled BEFORE UPDATE OF status ON ledger_transaction
      FOR EACH ROW WHEN (NEW.status = 'CORRECTED' AND OLD.status IS DISTINCT FROM 'CORRECTED') EXECUTE FUNCTION ledger_transaction_rent_reconciled()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER ledger_transaction_rent_reconciled ON ledger_transaction`.execute(db);
  await sql`DROP FUNCTION ledger_transaction_rent_reconciled()`.execute(db);
  await sql`DROP TABLE rent_payment_reconciliation`.execute(db);
  await sql`DROP FUNCTION rent_payment_reconciliation_frozen()`.execute(db);
  await sql`DROP FUNCTION rent_payment_reconciliation_cash()`.execute(db);
}

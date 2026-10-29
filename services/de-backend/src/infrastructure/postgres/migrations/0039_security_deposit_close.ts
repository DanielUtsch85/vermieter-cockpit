import { sql, type Kysely } from 'kysely';

/**
 * VC-5-04: closing and reopening a SecurityDeposit (api-design.md §47.4, phase-5-plan P5-D8).
 *
 * - `security_deposit` gains `closing_date`, `closing_reason` (`RETURNED` | `RETAINED` | `OTHER`), `closing_note` and
 *   `held_at_closing`, set exactly while `CLOSED`; `RETURNED` holds 0 or less, `RETAINED` more than 0 with a note, `OTHER` a note.
 * - `security_deposit_frozen` (0037) is replaced: the steps are `ACTIVE` → `CLOSED`, `CLOSED` → `ACTIVE` and
 *   `ACTIVE` → `VOID`; while `CLOSED` only `notes` change; the closing columns change only in a step.
 * - `security_deposit_close_guard` (the step to `CLOSED`): no split of the deposit after `closing_date` that counts or
 *   is open, no open split at all, and `held_at_closing` equal to the counted cash's `held` (§47.3).
 * - `transaction_split_security_deposit` (0038) gains the `CLOSED` rule: a closed deposit takes no split, except a
 *   reversal's and a replacement's whose original names the deposit (P5-D8's corrections).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE security_deposit
      ADD COLUMN closing_date date,
      ADD COLUMN closing_reason text CHECK (closing_reason IN ('RETURNED', 'RETAINED', 'OTHER')),
      ADD COLUMN closing_note text CHECK (length(closing_note) BETWEEN 1 AND 500),
      ADD COLUMN held_at_closing numeric CHECK (scale(held_at_closing) <= 2),
      ADD CONSTRAINT security_deposit_closing_fields CHECK (
        (status = 'CLOSED') = (closing_date IS NOT NULL) AND (status = 'CLOSED') = (closing_reason IS NOT NULL)
          AND (status = 'CLOSED') = (held_at_closing IS NOT NULL) AND (closing_note IS NULL OR status = 'CLOSED')
      ),
      ADD CONSTRAINT security_deposit_closing_reason CHECK (
        (closing_reason IS DISTINCT FROM 'RETURNED' OR held_at_closing <= 0)
          AND (closing_reason IS DISTINCT FROM 'RETAINED' OR (held_at_closing > 0 AND closing_note IS NOT NULL))
          AND (closing_reason IS DISTINCT FROM 'OTHER' OR closing_note IS NOT NULL)
      )
  `.execute(db);

  await sql`CREATE OR REPLACE FUNCTION security_deposit_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${frozenBody(true)}$$`.execute(db);

  await sql`
    CREATE FUNCTION security_deposit_close_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      held numeric;
    BEGIN
      IF EXISTS (SELECT 1 FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id
                  WHERE s.security_deposit_id = NEW.id AND t.booking_date > NEW.closing_date
                    AND t.status IN ('CONFIRMED', 'RECONCILED', 'IMPORTED', 'UNREVIEWED', 'CLASSIFIED', 'IGNORED')
                    AND t.correction_role IS DISTINCT FROM 'REVERSAL') THEN
        RAISE EXCEPTION 'SecurityDeposit %: cash after the closing date (CASH_AFTER_CLOSING_DATE)', NEW.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id
                  WHERE s.security_deposit_id = NEW.id AND t.status IN ('IMPORTED', 'UNREVIEWED', 'CLASSIFIED', 'IGNORED')) THEN
        RAISE EXCEPTION 'SecurityDeposit %: unconfirmed cash names it (UNCONFIRMED_CASH)', NEW.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT coalesce(sum(CASE WHEN c.code = 'SECURITY_DEPOSIT' AND t.direction = 'OUTFLOW' THEN -s.amount ELSE s.amount END), 0) INTO held
        FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id JOIN financial_category c ON c.id = s.financial_category_id
       WHERE s.security_deposit_id = NEW.id AND t.status IN ('CONFIRMED', 'RECONCILED') AND t.correction_role IS DISTINCT FROM 'REVERSAL';
      IF NEW.held_at_closing IS DISTINCT FROM held THEN
        RAISE EXCEPTION 'SecurityDeposit %: held_at_closing % is not the held % of the counted cash (HELD_AT_CLOSING)', NEW.id, NEW.held_at_closing, held
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER security_deposit_close_guard BEFORE UPDATE ON security_deposit
      FOR EACH ROW WHEN (OLD.status <> 'CLOSED' AND NEW.status = 'CLOSED') EXECUTE FUNCTION security_deposit_close_guard()
  `.execute(db);

  await sql`CREATE OR REPLACE FUNCTION transaction_split_security_deposit() RETURNS trigger LANGUAGE plpgsql AS $$${splitBody(true)}$$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION transaction_split_security_deposit() RETURNS trigger LANGUAGE plpgsql AS $$${splitBody(false)}$$`.execute(db);
  await sql`DROP TRIGGER security_deposit_close_guard ON security_deposit`.execute(db);
  await sql`DROP FUNCTION security_deposit_close_guard()`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION security_deposit_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${frozenBody(false)}$$`.execute(db);
  await sql`
    ALTER TABLE security_deposit
      DROP CONSTRAINT security_deposit_closing_reason,
      DROP CONSTRAINT security_deposit_closing_fields,
      DROP COLUMN held_at_closing,
      DROP COLUMN closing_note,
      DROP COLUMN closing_reason,
      DROP COLUMN closing_date
  `.execute(db);
}

/** 0037's frozen rule; with `close` the steps to and from `CLOSED`, and only `notes` while `CLOSED` (§47.4). */
function frozenBody(close: boolean) {
  const amendable = `(NEW.expected_amount, NEW.expected_amount_source, NEW.holding_financial_account_id, NEW.interest_bearing, NEW.notes)
         IS DISTINCT FROM (OLD.expected_amount, OLD.expected_amount_source, OLD.holding_financial_account_id, OLD.interest_bearing, OLD.notes)`;
  const rules = close
    ? `
      IF NEW.status = OLD.status AND OLD.status = 'CLOSED' AND (
           (NEW.expected_amount, NEW.expected_amount_source, NEW.holding_financial_account_id, NEW.interest_bearing)
             IS DISTINCT FROM (OLD.expected_amount, OLD.expected_amount_source, OLD.holding_financial_account_id, OLD.interest_bearing)
           OR (NEW.closing_date, NEW.closing_reason, NEW.closing_note, NEW.held_at_closing)
             IS DISTINCT FROM (OLD.closing_date, OLD.closing_reason, OLD.closing_note, OLD.held_at_closing)) THEN
        RAISE EXCEPTION 'SecurityDeposit %: only notes change while CLOSED; reopen first (api-design §47.4)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status <> OLD.status
         AND NOT ((OLD.status = 'ACTIVE' AND NEW.status IN ('VOID', 'CLOSED')) OR (OLD.status = 'CLOSED' AND NEW.status = 'ACTIVE')) THEN
        RAISE EXCEPTION 'SecurityDeposit %: % → % is not a step (api-design §47.4)', OLD.id, OLD.status, NEW.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status <> OLD.status AND ${amendable} THEN
        RAISE EXCEPTION 'SecurityDeposit %: a step changes nothing else', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;`
    : `
      IF NEW.status = OLD.status AND OLD.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'SecurityDeposit %: amended only while ACTIVE, not % (api-design §47.1)', OLD.id, OLD.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status <> OLD.status AND NOT (OLD.status = 'ACTIVE' AND NEW.status = 'VOID') THEN
        RAISE EXCEPTION 'SecurityDeposit %: % → % is not a step (api-design §47.1)', OLD.id, OLD.status, NEW.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status = 'VOID' AND ${amendable} THEN
        RAISE EXCEPTION 'SecurityDeposit %: a void changes nothing else', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;`;
  return sql.raw(`
    BEGIN
      IF (NEW.id, NEW.mre_realm_id, NEW.mre_tenant_id, NEW.currency, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM (OLD.id, OLD.mre_realm_id, OLD.mre_tenant_id, OLD.currency, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'SecurityDeposit %: the Tenant never changes; void and create instead (api-design §47.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- The no-op write of P3-D8 (and any write leaving the row as it is) passes.
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'VOID' THEN
        RAISE EXCEPTION 'SecurityDeposit %: VOID is final (api-design §47.1)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;${rules}
      IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'SecurityDeposit %: every change raises version by exactly one (% → %)', OLD.id, OLD.version, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END`);
}

/** 0038's split guard; with `close` a `CLOSED` deposit refuses the split unless it is a correction's (§47.4). */
function splitBody(close: boolean) {
  const closed = close
    ? `
      IF deposit_status = 'CLOSED' THEN
        SELECT correction_role, correction_of_transaction_id INTO tx FROM ledger_transaction WHERE id = NEW.transaction_id;
        IF tx.correction_role IS DISTINCT FROM 'REVERSAL' AND NOT (
             tx.correction_role = 'REPLACEMENT'
             AND EXISTS (SELECT 1 FROM transaction_split WHERE transaction_id = tx.correction_of_transaction_id AND security_deposit_id = NEW.security_deposit_id)) THEN
          RAISE EXCEPTION 'TransactionSplit: security deposit % is CLOSED (DEPOSIT_CLOSED)', NEW.security_deposit_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;`
    : '';
  return sql.raw(`
    DECLARE
      deposit_status text;
      category text;
      tx record;
    BEGIN
      -- P5-D9: after the Transaction row and the Loan rows (both triggers sort first), the deposit row.
      UPDATE security_deposit SET version = version WHERE id = NEW.security_deposit_id RETURNING status INTO deposit_status;
      IF deposit_status IS NULL THEN
        RETURN NEW; -- an unknown deposit is left to the foreign key
      END IF;
      IF deposit_status = 'VOID' THEN
        RAISE EXCEPTION 'TransactionSplit: security deposit % is VOID (DEPOSIT_NOT_ACTIVE)', NEW.security_deposit_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;${closed}
      SELECT code INTO category FROM financial_category WHERE id = NEW.financial_category_id;
      IF category NOT IN ('SECURITY_DEPOSIT', 'SECURITY_DEPOSIT_INTEREST') THEN
        RAISE EXCEPTION 'TransactionSplit: a split with a security deposit is SECURITY_DEPOSIT or SECURITY_DEPOSIT_INTEREST, not % (INVALID_SECURITY_DEPOSIT_SPLIT)', category
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF category = 'SECURITY_DEPOSIT_INTEREST' THEN
        SELECT direction, correction_role INTO tx FROM ledger_transaction WHERE id = NEW.transaction_id;
        IF tx.direction <> 'INFLOW' AND tx.correction_role IS DISTINCT FROM 'REVERSAL' THEN
          RAISE EXCEPTION 'TransactionSplit: SECURITY_DEPOSIT_INTEREST needs an INFLOW Transaction or a reversal, not % (INVALID_SECURITY_DEPOSIT_SPLIT)', tx.direction
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      RETURN NEW;
    END`);
}

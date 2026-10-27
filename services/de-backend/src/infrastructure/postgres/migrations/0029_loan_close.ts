import { sql, type Kysely } from 'kysely';

/**
 * VC-3-07: Closing a Loan and refinancing (api-design.md §41.7, data-model.md §21.3a, phase-3-plan P3-D7, P3-D8).
 *
 * - `loan` gains `closing_date`, `closing_reason` (`REPAID` | `REFINANCED` | `OTHER`), `refinanced_by_loan_id` (a Loan
 *   of the same Realm, composite foreign key) and `closing_note`. CHECKs tie them to `CLOSED`; with `loan_frozen` (0024:
 *   a `CLOSED` row is final) they are set only in the step to `CLOSED` and fixed after it.
 * - `loan_close_guard` (before the step to `CLOSED`): refuses a split that could still count on a Transaction booked
 *   after `closing_date` (not a `CORRECTED` original, not a reversal; review on #71), a `REPAID` close while the counted
 *   principal up to `closing_date` is not `principal_original`, and a `REFINANCED` close naming a Loan that is not
 *   `ACTIVE`, whose row it writes first (P3-D8's no-op), so a void of that Loan serialises with the close.
 * - `transaction_split_loan` (0027, same name and so the same place after `transaction_split_frozen`): after the
 *   `VOID` refusal, refuses a `CLOSED` Loan on a Transaction booked after `closing_date`, a reversal exempt.
 * - `ledger_transaction_loan_closing` (before a change of `booking_date`): writes the rows of the Loans its splits name
 *   in id order (Transaction → Loan) and refuses a date after a `CLOSED` one's `closing_date`.
 * - `loan_void_unreferenced` (0027): also refuses the step to `VOID` while a `CLOSED` Loan names the Loan as
 *   `refinanced_by_loan_id` (`LOAN_REFINANCES`, review on #71).
 * - `loan_balance_statement_append` (0028): also refuses a date after a `CLOSED` Loan's `closing_date`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE loan
      ADD COLUMN closing_date date,
      ADD COLUMN closing_reason text CHECK (closing_reason IN ('REPAID', 'REFINANCED', 'OTHER')),
      ADD COLUMN refinanced_by_loan_id uuid,
      ADD COLUMN closing_note text CHECK (length(closing_note) BETWEEN 1 AND 500 AND closing_note = btrim(closing_note)),
      ADD CONSTRAINT loan_refinanced_by_fk FOREIGN KEY (refinanced_by_loan_id, mre_realm_id) REFERENCES loan (id, mre_realm_id),
      ADD CONSTRAINT loan_closing_fields CHECK (
        (status = 'CLOSED') = (closing_date IS NOT NULL) AND (status = 'CLOSED') = (closing_reason IS NOT NULL)
        AND (closing_reason IS NOT DISTINCT FROM 'REFINANCED') = (refinanced_by_loan_id IS NOT NULL)
        AND (closing_reason IS DISTINCT FROM 'OTHER' OR closing_note IS NOT NULL)
        AND (status = 'CLOSED' OR closing_note IS NULL)
      ),
      ADD CONSTRAINT loan_not_refinanced_by_itself CHECK (refinanced_by_loan_id <> id),
      ADD CONSTRAINT loan_closing_after_debt CHECK (closing_date >= coalesce(disbursement_date, start_date))
  `.execute(db);
  await sql`CREATE INDEX loan_refinanced_by_idx ON loan (refinanced_by_loan_id) WHERE refinanced_by_loan_id IS NOT NULL`.execute(db);

  await sql`
    CREATE FUNCTION loan_close_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      later uuid;
      paid numeric;
      successor text;
    BEGIN
      SELECT s.transaction_id INTO later FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id
       WHERE s.loan_id = NEW.id AND t.booking_date > NEW.closing_date
         AND t.status <> 'CORRECTED' AND t.correction_role IS DISTINCT FROM 'REVERSAL'
       LIMIT 1;
      IF later IS NOT NULL THEN
        RAISE EXCEPTION 'Loan %: Transaction % is booked after the closing date % (SPLITS_AFTER_CLOSING)', NEW.id, later, NEW.closing_date
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.closing_reason = 'REPAID' THEN
        SELECT coalesce(sum(s.amount), 0) INTO paid FROM transaction_split s
          JOIN ledger_transaction t ON t.id = s.transaction_id JOIN financial_category c ON c.id = s.financial_category_id
         WHERE s.loan_id = NEW.id AND c.code = 'LOAN_PRINCIPAL' AND t.booking_date <= NEW.closing_date
           AND t.status IN ('CONFIRMED', 'RECONCILED') AND t.correction_role IS DISTINCT FROM 'REVERSAL';
        IF paid <> NEW.principal_original THEN
          RAISE EXCEPTION 'Loan %: % of % repaid by %, not all (REMAINING_DEBT_NOT_ZERO)', NEW.id, paid, NEW.principal_original, NEW.closing_date
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      -- A missing or self reference is left to the CHECKs (BEFORE triggers fire before them).
      IF NEW.closing_reason = 'REFINANCED' AND NEW.refinanced_by_loan_id IS NOT NULL AND NEW.refinanced_by_loan_id <> NEW.id THEN
        -- P3-D8: the named Loan's row is written, so a void of it serialises with this close.
        UPDATE loan SET version = version WHERE id = NEW.refinanced_by_loan_id RETURNING status INTO successor;
        IF successor IS DISTINCT FROM 'ACTIVE' THEN
          RAISE EXCEPTION 'Loan %: the refinancing Loan % is %, not ACTIVE (REFINANCING_LOAN_NOT_ACTIVE)', NEW.id, NEW.refinanced_by_loan_id, successor
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER loan_close_guard BEFORE UPDATE ON loan
      FOR EACH ROW WHEN (OLD.status <> 'CLOSED' AND NEW.status = 'CLOSED') EXECUTE FUNCTION loan_close_guard()
  `.execute(db);

  await sql`CREATE OR REPLACE FUNCTION transaction_split_loan() RETURNS trigger LANGUAGE plpgsql AS $$${splitLoanBody(true)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION loan_void_unreferenced() RETURNS trigger LANGUAGE plpgsql AS $$${voidUnreferencedBody(true)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION loan_balance_statement_append() RETURNS trigger LANGUAGE plpgsql AS $$${statementAppendBody(true)}$$`.execute(db);

  await sql`
    CREATE FUNCTION ledger_transaction_loan_closing() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      named record;
      closed date;
      loan_status text;
    BEGIN
      -- P3-D8: after the Transaction row (this update holds it), the Loans its splits name, in id order.
      FOR named IN SELECT DISTINCT loan_id FROM transaction_split WHERE transaction_id = NEW.id AND loan_id IS NOT NULL ORDER BY loan_id LOOP
        UPDATE loan SET version = version WHERE id = named.loan_id RETURNING status, closing_date INTO loan_status, closed;
        IF loan_status = 'CLOSED' AND NEW.booking_date > closed THEN
          RAISE EXCEPTION 'Transaction %: Loan % was closed on %, the booking date % is after it (LOAN_CLOSED)', NEW.id, named.loan_id, closed, NEW.booking_date
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_transaction_loan_closing BEFORE UPDATE OF booking_date ON ledger_transaction
      FOR EACH ROW WHEN (OLD.booking_date IS DISTINCT FROM NEW.booking_date) EXECUTE FUNCTION ledger_transaction_loan_closing()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER ledger_transaction_loan_closing ON ledger_transaction`.execute(db);
  await sql`DROP FUNCTION ledger_transaction_loan_closing()`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION loan_balance_statement_append() RETURNS trigger LANGUAGE plpgsql AS $$${statementAppendBody(false)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION loan_void_unreferenced() RETURNS trigger LANGUAGE plpgsql AS $$${voidUnreferencedBody(false)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION transaction_split_loan() RETURNS trigger LANGUAGE plpgsql AS $$${splitLoanBody(false)}$$`.execute(db);
  await sql`DROP TRIGGER loan_close_guard ON loan`.execute(db);
  await sql`DROP FUNCTION loan_close_guard()`.execute(db);
  await sql`
    ALTER TABLE loan
      DROP CONSTRAINT loan_closing_after_debt,
      DROP CONSTRAINT loan_not_refinanced_by_itself,
      DROP CONSTRAINT loan_closing_fields,
      DROP CONSTRAINT loan_refinanced_by_fk,
      DROP COLUMN closing_note,
      DROP COLUMN refinanced_by_loan_id,
      DROP COLUMN closing_reason,
      DROP COLUMN closing_date
  `.execute(db);
}

/** 0027's split guard; with `closing` the closing-date rule after the `VOID` refusal (§41.7). */
function splitLoanBody(closing: boolean) {
  return sql.raw(`
    DECLARE
      loan_status text;
      closed date;
      category text;
      tx record;
    BEGIN
      -- P3-D8: after the Transaction row (transaction_split_frozen fires first), the Loan row.
      UPDATE loan SET version = version WHERE id = NEW.loan_id RETURNING status${closing ? ', closing_date' : ''} INTO loan_status${closing ? ', closed' : ''};
      IF loan_status IS NULL THEN
        RETURN NEW; -- an unknown Loan is left to the foreign key
      END IF;
      IF loan_status = 'VOID' THEN
        RAISE EXCEPTION 'TransactionSplit: Loan % is VOID (LOAN_NOT_ACTIVE)', NEW.loan_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT direction, correction_role, booking_date INTO tx FROM ledger_transaction WHERE id = NEW.transaction_id;${
        closing
          ? `
      -- §41.7: nothing after the closing date; a reversal takes its original's date and is exempt.
      IF loan_status = 'CLOSED' AND tx.booking_date > closed AND tx.correction_role IS DISTINCT FROM 'REVERSAL' THEN
        RAISE EXCEPTION 'TransactionSplit: Loan % was closed on %, the Transaction is booked on % (LOAN_CLOSED)', NEW.loan_id, closed, tx.booking_date
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;`
          : ''
      }
      SELECT code INTO category FROM financial_category WHERE id = NEW.financial_category_id;
      IF category NOT IN ('LOAN_INTEREST', 'LOAN_PRINCIPAL') THEN
        RAISE EXCEPTION 'TransactionSplit: a split with a Loan is LOAN_INTEREST or LOAN_PRINCIPAL, not % (INVALID_LOAN_SPLIT)', category
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF tx.direction <> 'OUTFLOW' AND tx.correction_role IS DISTINCT FROM 'REVERSAL' THEN
        RAISE EXCEPTION 'TransactionSplit: a split with a Loan needs an OUTFLOW Transaction or a reversal, not % (INVALID_LOAN_SPLIT)', tx.direction
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END`);
}

/** 0027's void guard; with `refinances` the `LOAN_REFINANCES` refusal (review on #71). */
function voidUnreferencedBody(refinances: boolean) {
  return sql.raw(`
    BEGIN
      IF EXISTS (SELECT 1 FROM transaction_split WHERE loan_id = NEW.id) THEN
        RAISE EXCEPTION 'Loan %: splits reference it, reversals included (LOAN_HAS_SPLITS)', NEW.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;${
        refinances
          ? `
      IF EXISTS (SELECT 1 FROM loan WHERE refinanced_by_loan_id = NEW.id AND status = 'CLOSED') THEN
        RAISE EXCEPTION 'Loan %: a CLOSED Loan names it as its refinancing (LOAN_REFINANCES)', NEW.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;`
          : ''
      }
      RETURN NEW;
    END`);
}

/** 0028's statement guard; with `closing` the `STATEMENT_AFTER_CLOSING` refusal (§41.7). */
function statementAppendBody(closing: boolean) {
  return sql.raw(`
    DECLARE
      loan_status text;
      debt_from date;
      closed date;
    BEGIN
      IF NEW.status <> 'VALID' OR NEW.version <> 1 THEN
        RAISE EXCEPTION 'LoanBalanceStatement: only inserted VALID with version 1 (api-design §41.6)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- P3-D8: the Loan row first, so a statement and a void of the Loan serialise.
      UPDATE loan SET version = version WHERE id = NEW.loan_id
        RETURNING status, coalesce(disbursement_date, start_date)${closing ? ', closing_date' : ''} INTO loan_status, debt_from${closing ? ', closed' : ''};
      IF loan_status IS NULL THEN
        RETURN NEW; -- an unknown Loan is left to the foreign key
      END IF;
      IF loan_status = 'VOID' THEN
        RAISE EXCEPTION 'LoanBalanceStatement: Loan % is VOID (LOAN_NOT_ACTIVE)', NEW.loan_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.statement_date < debt_from THEN
        RAISE EXCEPTION 'LoanBalanceStatement: % is before the debt starts on % (STATEMENT_BEFORE_DEBT)', NEW.statement_date, debt_from
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;${
        closing
          ? `
      IF loan_status = 'CLOSED' AND NEW.statement_date > closed THEN
        RAISE EXCEPTION 'LoanBalanceStatement: % is after the closing date % (STATEMENT_AFTER_CLOSING)', NEW.statement_date, closed
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;`
          : ''
      }
      RETURN NEW;
    END`);
}

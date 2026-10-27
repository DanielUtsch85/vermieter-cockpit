import { sql, type Kysely } from 'kysely';

/**
 * VC-3-05: Loan payments (data-model.md §18, api-design.md §41.5, phase-3-plan P3-D4, P3-D8).
 *
 * - `transaction_split.loan_id`: a Loan of the same Realm (composite foreign key), never together with a
 *   PropertyReference (a Loan reaches its properties through its allocation, §41.3).
 * - `transaction_split_loan` (before insert or update of a split with `loan_id`): writes the Loan row first (P3-D8's
 *   no-op, as 0022 does for the Acquisition), so a split write and a void of the Loan serialise and a stale one fails
 *   under REPEATABLE READ; then refuses a `VOID` Loan, a category other than `LOAN_INTEREST`/`LOAN_PRINCIPAL`, and a
 *   Transaction that is not `OUTFLOW` unless it is a reversal (review on #58).
 *   **Trigger order (review on #67):** BEFORE triggers of a table fire in name order, and `transaction_split_frozen`
 *   (0009/0010) writes the Transaction row. `transaction_split_loan` sorts after it, so past the repository too the
 *   Transaction row is written before the Loan row (P3-D8's Transaction → Loan). Keep the name sorting after it.
 * - `loan_void_unreferenced` (before update of `loan`): a step to `VOID` is refused while a split references the Loan,
 *   a reversal's included. The guard's no-op write is not a step and passes.
 * - 0014's mirror compares `loan_id` too, so a reversal cannot drop or change it.
 * - Not here: the closing date (VC-3-07 adds it to `transaction_split_loan`), the proposal (a read), the order of
 *   checks (the API and the repository).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE transaction_split
      ADD COLUMN loan_id uuid,
      ADD CONSTRAINT transaction_split_loan_fk FOREIGN KEY (loan_id, mre_realm_id) REFERENCES loan (id, mre_realm_id),
      ADD CONSTRAINT transaction_split_loan_no_property CHECK (loan_id IS NULL OR property_reference_id IS NULL)
  `.execute(db);
  await sql`CREATE INDEX transaction_split_loan_idx ON transaction_split (loan_id) WHERE loan_id IS NOT NULL`.execute(db);

  await sql`
    CREATE FUNCTION transaction_split_loan() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      loan_status text;
      category text;
      tx record;
    BEGIN
      -- P3-D8: after the Transaction row (transaction_split_frozen fires first), the Loan row.
      UPDATE loan SET version = version WHERE id = NEW.loan_id RETURNING status INTO loan_status;
      IF loan_status IS NULL THEN
        RETURN NEW; -- an unknown Loan is left to the foreign key
      END IF;
      IF loan_status = 'VOID' THEN
        RAISE EXCEPTION 'TransactionSplit: Loan % is VOID (LOAN_NOT_ACTIVE)', NEW.loan_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT code INTO category FROM financial_category WHERE id = NEW.financial_category_id;
      IF category NOT IN ('LOAN_INTEREST', 'LOAN_PRINCIPAL') THEN
        RAISE EXCEPTION 'TransactionSplit: a split with a Loan is LOAN_INTEREST or LOAN_PRINCIPAL, not % (INVALID_LOAN_SPLIT)', category
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT direction, correction_role INTO tx FROM ledger_transaction WHERE id = NEW.transaction_id;
      IF tx.direction <> 'OUTFLOW' AND tx.correction_role IS DISTINCT FROM 'REVERSAL' THEN
        RAISE EXCEPTION 'TransactionSplit: a split with a Loan needs an OUTFLOW Transaction or a reversal, not % (INVALID_LOAN_SPLIT)', tx.direction
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  // Sorts after transaction_split_frozen: BEFORE triggers fire in name order (review on #67).
  await sql`
    CREATE TRIGGER transaction_split_loan BEFORE INSERT OR UPDATE ON transaction_split
      FOR EACH ROW WHEN (NEW.loan_id IS NOT NULL) EXECUTE FUNCTION transaction_split_loan()
  `.execute(db);

  await sql`
    CREATE FUNCTION loan_void_unreferenced() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM transaction_split WHERE loan_id = NEW.id) THEN
        RAISE EXCEPTION 'Loan %: splits reference it, reversals included (LOAN_HAS_SPLITS)', NEW.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER loan_void_unreferenced BEFORE UPDATE ON loan
      FOR EACH ROW WHEN (OLD.status <> 'VOID' AND NEW.status = 'VOID') EXECUTE FUNCTION loan_void_unreferenced()
  `.execute(db);

  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_reversal_mirror() RETURNS trigger LANGUAGE plpgsql AS $$${mirrorBody(true)}$$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_reversal_mirror() RETURNS trigger LANGUAGE plpgsql AS $$${mirrorBody(false)}$$`.execute(db);
  await sql`DROP TRIGGER loan_void_unreferenced ON loan`.execute(db);
  await sql`DROP FUNCTION loan_void_unreferenced()`.execute(db);
  await sql`DROP TRIGGER transaction_split_loan ON transaction_split`.execute(db);
  await sql`DROP FUNCTION transaction_split_loan()`.execute(db);
  await sql`ALTER TABLE transaction_split DROP COLUMN loan_id`.execute(db);
}

/** 0014's mirror check; with `loanId` the compared multiset includes `loan_id` (P3-D4, review on #58). */
function mirrorBody(loanId: boolean) {
  const columns = `financial_category_id, property_reference_id, ${loanId ? 'loan_id, ' : ''}amount, currency`;
  return sql.raw(`
    DECLARE
      cur ledger_transaction%ROWTYPE;
    BEGIN
      -- The row as it is now, as in the chain check of 0011.
      SELECT * INTO cur FROM ledger_transaction WHERE id = NEW.id;
      IF cur.correction_role IS DISTINCT FROM 'REVERSAL' THEN
        RETURN NULL;
      END IF;
      IF EXISTS (
           (SELECT ${columns} FROM transaction_split WHERE transaction_id = cur.id
            EXCEPT ALL
            SELECT ${columns} FROM transaction_split
              WHERE transaction_id = cur.correction_of_transaction_id)
           UNION ALL
           (SELECT ${columns} FROM transaction_split
              WHERE transaction_id = cur.correction_of_transaction_id
            EXCEPT ALL
            SELECT ${columns} FROM transaction_split WHERE transaction_id = cur.id)) THEN
        RAISE EXCEPTION 'reversal % does not mirror the splits of Transaction % (category, PropertyReference, ${loanId ? 'Loan, ' : ''}amount; api-design §35.3)',
          cur.id, cur.correction_of_transaction_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END`);
}

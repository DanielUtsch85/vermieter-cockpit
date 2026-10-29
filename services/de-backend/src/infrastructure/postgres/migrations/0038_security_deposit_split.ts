import { sql, type Kysely } from 'kysely';

/**
 * VC-5-02: `securityDepositId` on splits (data-model.md §17, api-design.md §47.2, phase-5-plan P5-D3, P5-D5, P5-D9).
 *
 * - `transaction_split.security_deposit_id`: a SecurityDeposit of the same Realm (composite foreign key), never together
 *   with a PropertyReference or a Loan (a deposit is neither a property's income or cost nor a Loan's cash, BR-DEP-001).
 * - The category `SECURITY_DEPOSIT_INTEREST` (`category_type SECURITY_DEPOSIT`, never `INCOME`, P5-D5/D6).
 * - `transaction_split_security_deposit` (before insert or update of a split with `security_deposit_id`): writes the
 *   deposit row first (P3-D8's no-op, which 0037's frozen trigger lets pass on any row), so a split write and a void of
 *   the deposit serialise and a stale one fails under REPEATABLE READ; then refuses a `VOID` deposit, a category other
 *   than `SECURITY_DEPOSIT`/`SECURITY_DEPOSIT_INTEREST`, and `SECURITY_DEPOSIT_INTEREST` on a Transaction that is not
 *   `INFLOW` unless it is a reversal.
 *   **Trigger order (review on #67):** BEFORE triggers of a table fire in name order. This one sorts after
 *   `transaction_split_frozen` (the Transaction row) and `transaction_split_loan` (the Loan rows), so past the repository
 *   too the order is Transaction → Loan → SecurityDeposit (P5-D9). Keep the name sorting after both.
 * - `security_deposit_void_unreferenced` (before update of `security_deposit`): a step to `VOID` is refused while a
 *   split references the deposit, a reversal's included.
 * - 0014's mirror compares `security_deposit_id` too, so a reversal cannot drop or change it.
 * - Not here: `CLOSED` (VC-5-04 adds it to the split trigger), what counts (a read, VC-5-03), the order of checks (the
 *   API and the repository).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE transaction_split
      ADD COLUMN security_deposit_id uuid,
      ADD CONSTRAINT transaction_split_security_deposit_fk FOREIGN KEY (security_deposit_id, mre_realm_id) REFERENCES security_deposit (id, mre_realm_id),
      ADD CONSTRAINT transaction_split_security_deposit_alone CHECK (security_deposit_id IS NULL OR (property_reference_id IS NULL AND loan_id IS NULL))
  `.execute(db);
  await sql`CREATE INDEX transaction_split_security_deposit_idx ON transaction_split (security_deposit_id) WHERE security_deposit_id IS NOT NULL`.execute(db);
  await sql`INSERT INTO financial_category (code, name, category_type) VALUES ('SECURITY_DEPOSIT_INTEREST', 'Kautionszinsen', 'SECURITY_DEPOSIT')`.execute(db);

  await sql`
    CREATE FUNCTION transaction_split_security_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
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
      END IF;
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
    END $$
  `.execute(db);
  // Sorts after transaction_split_frozen and transaction_split_loan: BEFORE triggers fire in name order (review on #67).
  await sql`
    CREATE TRIGGER transaction_split_security_deposit BEFORE INSERT OR UPDATE ON transaction_split
      FOR EACH ROW WHEN (NEW.security_deposit_id IS NOT NULL) EXECUTE FUNCTION transaction_split_security_deposit()
  `.execute(db);

  await sql`
    CREATE FUNCTION security_deposit_void_unreferenced() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM transaction_split WHERE security_deposit_id = NEW.id) THEN
        RAISE EXCEPTION 'SecurityDeposit %: splits reference it, reversals included (DEPOSIT_HAS_SPLITS)', NEW.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER security_deposit_void_unreferenced BEFORE UPDATE ON security_deposit
      FOR EACH ROW WHEN (OLD.status <> 'VOID' AND NEW.status = 'VOID') EXECUTE FUNCTION security_deposit_void_unreferenced()
  `.execute(db);

  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_reversal_mirror() RETURNS trigger LANGUAGE plpgsql AS $$${mirrorBody(true)}$$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_reversal_mirror() RETURNS trigger LANGUAGE plpgsql AS $$${mirrorBody(false)}$$`.execute(db);
  await sql`DROP TRIGGER security_deposit_void_unreferenced ON security_deposit`.execute(db);
  await sql`DROP FUNCTION security_deposit_void_unreferenced()`.execute(db);
  await sql`DROP TRIGGER transaction_split_security_deposit ON transaction_split`.execute(db);
  await sql`DROP FUNCTION transaction_split_security_deposit()`.execute(db);
  await sql`ALTER TABLE transaction_split DROP COLUMN security_deposit_id`.execute(db);
  // Only while no split uses it: the split's foreign key refuses the delete otherwise.
  await sql`DELETE FROM financial_category WHERE code = 'SECURITY_DEPOSIT_INTEREST'`.execute(db);
}

/** 0027's mirror check; with `securityDepositId` the compared multiset includes `security_deposit_id` (P5-D3). */
function mirrorBody(securityDepositId: boolean) {
  const columns = `financial_category_id, property_reference_id, loan_id, ${securityDepositId ? 'security_deposit_id, ' : ''}amount, currency`;
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
        RAISE EXCEPTION 'reversal % does not mirror the splits of Transaction % (category, PropertyReference, Loan, ${securityDepositId ? 'security deposit, ' : ''}amount; api-design §35.3)',
          cur.id, cur.correction_of_transaction_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END`);
}

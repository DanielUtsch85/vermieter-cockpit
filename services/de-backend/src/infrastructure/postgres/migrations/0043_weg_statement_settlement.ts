import { sql, type Kysely } from 'kysely';

/**
 * VC-6-04: the settlement of a Jahresabrechnung names its statement (data-model.md §17, api-design.md §51, phase-6-plan
 * P6-D6).
 *
 * - `transaction_split.weg_annual_statement_id`: a statement of the same Realm (composite foreign key), only with a
 *   PropertyReference and never with a Loan or a security deposit.
 * - `transaction_split_weg` (0041) is replaced: a split naming a statement still writes its unit first, but skips the
 *   check of a membership on the booking date (a statement often arrives after a sale; it is checked against its own
 *   membership instead). `ledger_transaction_weg_booking_date` (0041) skips such splits likewise, and so does
 *   `weg_membership_guard` (0041): a settlement booked after a sale does not hold the membership, its statement does
 *   (MEMBERSHIP_HAS_STATEMENTS; review on #152). `down` restores all three.
 * - `transaction_split_weg_statement` (before insert or update of a split with a statement; sorts after
 *   `transaction_split_weg`): writes the unit (no-op), then the statement (no-op, `RETURNING status, membership_id`, so a
 *   stale writer under REPEATABLE READ fails to serialise), and refuses a category outside the three WEG categories or a
 *   unit other than the statement's (INVALID_WEG_STATEMENT_SPLIT), and a statement that is not `CONFIRMED` unless the
 *   Transaction is a reversal (STATEMENT_NOT_CURRENT). Lock order Transaction → PropertyReference → statement.
 * - 0014's mirror compares `weg_annual_statement_id` too, so a reversal cannot drop or change it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE transaction_split
      ADD COLUMN weg_annual_statement_id uuid,
      ADD CONSTRAINT transaction_split_weg_statement_fk FOREIGN KEY (weg_annual_statement_id, mre_realm_id) REFERENCES weg_annual_statement (id, mre_realm_id),
      ADD CONSTRAINT transaction_split_weg_statement_alone
        CHECK (weg_annual_statement_id IS NULL OR (property_reference_id IS NOT NULL AND loan_id IS NULL AND security_deposit_id IS NULL))
  `.execute(db);
  await sql`
    CREATE INDEX transaction_split_weg_statement_idx ON transaction_split (weg_annual_statement_id) WHERE weg_annual_statement_id IS NOT NULL
  `.execute(db);

  await sql`CREATE OR REPLACE FUNCTION transaction_split_weg() RETURNS trigger LANGUAGE plpgsql AS $$${splitWegBody(true)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_weg_booking_date() RETURNS trigger LANGUAGE plpgsql AS $$${bookingDateBody(true)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION weg_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$${membershipGuardBody(true)}$$`.execute(db);

  await sql`
    CREATE FUNCTION transaction_split_weg_statement() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      category text;
      statement record;
      unit uuid;
      role text;
    BEGIN
      IF NEW.property_reference_id IS NULL THEN
        RETURN NEW; -- left to transaction_split_weg_statement_alone
      END IF;
      -- Transaction → PropertyReference → statement (§51): the unit first, as every WEG writer, then the statement.
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      UPDATE weg_annual_statement SET version = version WHERE id = NEW.weg_annual_statement_id RETURNING status, membership_id INTO statement;
      IF statement.membership_id IS NULL THEN
        RETURN NEW; -- an unknown statement is left to the foreign key
      END IF;
      SELECT code INTO category FROM financial_category WHERE id = NEW.financial_category_id;
      IF category NOT IN ('WEG_RECOVERABLE', 'WEG_NON_RECOVERABLE', 'WEG_RESERVE_CONTRIBUTION') THEN
        RAISE EXCEPTION 'TransactionSplit: a split naming a statement is in a WEG category, not % (INVALID_WEG_STATEMENT_SPLIT)', category
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT property_reference_id INTO unit FROM weg_membership WHERE id = statement.membership_id;
      IF unit IS DISTINCT FROM NEW.property_reference_id THEN
        RAISE EXCEPTION 'TransactionSplit: unit % is not the unit % of statement % (INVALID_WEG_STATEMENT_SPLIT)', NEW.property_reference_id, unit, NEW.weg_annual_statement_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT correction_role INTO role FROM ledger_transaction WHERE id = NEW.transaction_id;
      IF statement.status <> 'CONFIRMED' AND role IS DISTINCT FROM 'REVERSAL' THEN
        RAISE EXCEPTION 'TransactionSplit: statement % is % (STATEMENT_NOT_CURRENT)', NEW.weg_annual_statement_id, statement.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  // Sorts after transaction_split_weg: BEFORE triggers fire in name order.
  await sql`
    CREATE TRIGGER transaction_split_weg_statement BEFORE INSERT OR UPDATE ON transaction_split
      FOR EACH ROW WHEN (NEW.weg_annual_statement_id IS NOT NULL) EXECUTE FUNCTION transaction_split_weg_statement()
  `.execute(db);

  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_reversal_mirror() RETURNS trigger LANGUAGE plpgsql AS $$${mirrorBody(true)}$$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_reversal_mirror() RETURNS trigger LANGUAGE plpgsql AS $$${mirrorBody(false)}$$`.execute(db);
  await sql`DROP TRIGGER transaction_split_weg_statement ON transaction_split`.execute(db);
  await sql`DROP FUNCTION transaction_split_weg_statement()`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION weg_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$${membershipGuardBody(false)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_weg_booking_date() RETURNS trigger LANGUAGE plpgsql AS $$${bookingDateBody(false)}$$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION transaction_split_weg() RETURNS trigger LANGUAGE plpgsql AS $$${splitWegBody(false)}$$`.execute(db);
  await sql`ALTER TABLE transaction_split DROP COLUMN weg_annual_statement_id`.execute(db);
}

/** 0041's `transaction_split_weg`; with `statements`, a split naming a statement skips the booking-date membership. */
function splitWegBody(statements: boolean) {
  return sql.raw(`
    DECLARE
      category text;
      tx record;
    BEGIN
      SELECT code INTO category FROM financial_category WHERE id = NEW.financial_category_id;
      IF category NOT IN ('WEG_RECOVERABLE', 'WEG_NON_RECOVERABLE', 'WEG_RESERVE_CONTRIBUTION') THEN
        RETURN NEW;
      END IF;
      SELECT booking_date, correction_role INTO tx FROM ledger_transaction WHERE id = NEW.transaction_id;
      -- A reversal mirrors its original's splits, which may predate Phase 6 (§49.3).
      IF tx.correction_role IS NOT DISTINCT FROM 'REVERSAL' THEN
        RETURN NEW;
      END IF;
      IF NEW.property_reference_id IS NULL THEN
        RAISE EXCEPTION 'TransactionSplit: a % split names its unit (NO_WEG_MEMBERSHIP)', category USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- Transaction → PropertyReference: serialises with an end or void of the unit's membership (§49.3).
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;${
        statements
          ? `
      -- A settlement is checked against its statement's membership (§51, transaction_split_weg_statement).
      IF NEW.weg_annual_statement_id IS NOT NULL THEN
        RETURN NEW;
      END IF;`
          : ''
      }
      IF NOT EXISTS (
        SELECT 1 FROM weg_membership m
         WHERE m.property_reference_id = NEW.property_reference_id AND m.status = 'ACTIVE'
           AND tx.booking_date <@ daterange(m.valid_from, m.valid_until, '[]')
      ) THEN
        RAISE EXCEPTION 'TransactionSplit: unit % has no WEG membership on % (NO_WEG_MEMBERSHIP)', NEW.property_reference_id, tx.booking_date
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END`);
}

/** 0041's `ledger_transaction_weg_booking_date`; with `statements`, splits naming a statement are left out. */
function bookingDateBody(statements: boolean) {
  return sql.raw(`
    DECLARE
      unit uuid;
    BEGIN
      IF NEW.correction_role IS NOT DISTINCT FROM 'REVERSAL' THEN
        RETURN NEW;
      END IF;
      -- The kept WEG splits need their unit's membership on the new date (review on #147); units in id order, each
      -- written first (Transaction → PropertyReference), as transaction_split_weg does.
      FOR unit IN
        SELECT DISTINCT s.property_reference_id FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id
         WHERE s.transaction_id = NEW.id AND s.property_reference_id IS NOT NULL
           AND c.code IN ('WEG_RECOVERABLE', 'WEG_NON_RECOVERABLE', 'WEG_RESERVE_CONTRIBUTION')${
             statements
               ? `
           AND s.weg_annual_statement_id IS NULL`
               : ''
           }
         ORDER BY 1
      LOOP
        UPDATE property_reference SET version = version WHERE id = unit;
        IF NOT EXISTS (
          SELECT 1 FROM weg_membership m WHERE m.property_reference_id = unit AND m.status = 'ACTIVE'
             AND NEW.booking_date <@ daterange(m.valid_from, m.valid_until, '[]')
        ) THEN
          RAISE EXCEPTION 'Transaction %: unit % has no WEG membership on % (NO_WEG_MEMBERSHIP)', NEW.id, unit, NEW.booking_date
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
      RETURN NEW;
    END`);
}

/** 0038's mirror check; with `statements` the compared multiset includes `weg_annual_statement_id` (§51). */
function mirrorBody(statements: boolean) {
  const columns = `financial_category_id, property_reference_id, loan_id, security_deposit_id, ${statements ? 'weg_annual_statement_id, ' : ''}amount, currency`;
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
        RAISE EXCEPTION 'reversal % does not mirror the splits of Transaction % (category, PropertyReference, Loan, security deposit, ${statements ? 'WEG statement, ' : ''}amount; api-design §35.3)',
          cur.id, cur.correction_of_transaction_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END`);
}

/** 0041's `weg_membership_guard`; with `statements`, splits naming a statement do not hold the membership (§51). */
function membershipGuardBody(statements: boolean) {
  return sql.raw(`
    DECLARE
      kept daterange;
      old_period daterange := daterange(OLD.valid_from, OLD.valid_until, '[]');
      held uuid;
    BEGIN
      IF OLD.status <> 'ACTIVE' OR (NEW.status, NEW.valid_until) IS NOT DISTINCT FROM (OLD.status, OLD.valid_until) THEN
        RETURN NEW;
      END IF;
      -- First the unit: a concurrent split or plan writer is waited for and seen (review on #146).
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      kept := CASE WHEN NEW.status = 'VOID' THEN 'empty'::daterange ELSE daterange(NEW.valid_from, NEW.valid_until, '[]') END;
      SELECT s.transaction_id INTO held FROM transaction_split s
        JOIN financial_category c ON c.id = s.financial_category_id
        JOIN ledger_transaction t ON t.id = s.transaction_id
       WHERE s.property_reference_id = NEW.property_reference_id
         AND c.code IN ('WEG_RECOVERABLE', 'WEG_NON_RECOVERABLE', 'WEG_RESERVE_CONTRIBUTION')${
           statements
             ? `
         AND s.weg_annual_statement_id IS NULL`
             : ''
         }
         AND t.booking_date <@ old_period AND NOT (t.booking_date <@ kept)
       LIMIT 1;
      IF held IS NOT NULL THEN
        RAISE EXCEPTION 'WegMembership %: Transaction % has a WEG split of the unit outside the remaining period (MEMBERSHIP_HAS_SPLITS)', OLD.id, held
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT p.id INTO held FROM weg_economic_plan p
       WHERE p.membership_id = OLD.id AND p.status = 'ACTIVE' AND NOT (p.effective_from <@ kept)
       LIMIT 1;
      IF held IS NOT NULL THEN
        RAISE EXCEPTION 'WegMembership %: plan % lies outside the remaining period (MEMBERSHIP_HAS_PLANS)', OLD.id, held
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END`);
}

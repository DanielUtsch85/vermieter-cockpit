import { sql, type Kysely } from 'kysely';

/**
 * VC-1-09: the split invariant of a confirmed Transaction (data-model.md §18,
 * domain-model.md §24) as a database guarantee, not only a check in the code:
 *
 * - a Transaction becomes CONFIRMED only if it has splits, all in its currency,
 *   summing exactly to its amount;
 * - no Transaction is inserted already confirmed (it would skip that check).
 *
 * With the frozen splits of migration 0009 this holds for every confirmed
 * Transaction for good — also for two writers at once (review note on #19).
 * A foreign-key insert alone only takes `FOR KEY SHARE` on the Transaction,
 * which does not conflict with a status change, so a split written in one
 * session and a confirmation in another would not see each other. The split
 * trigger of 0009 therefore *touches* its Transaction row (a no-op update of
 * `version`): a concurrent confirmation then waits for it and, under READ
 * COMMITTED, re-reads the splits in its trigger; under REPEATABLE READ or
 * SERIALIZABLE it fails with a serialization error instead of confirming a
 * stale sum. A lock alone (`FOR SHARE`) would not suffice there: a waiting
 * REPEATABLE READ statement keeps its snapshot after a mere lock is released.
 */
const SPLIT_FROZEN_BODY = (touchParent: boolean) =>
  sql.raw(`
    DECLARE
      parent_status text;
    BEGIN
      ${
        touchParent
          ? `UPDATE ledger_transaction SET version = version
        WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.transaction_id ELSE NEW.transaction_id END
        RETURNING status INTO parent_status;`
          : `SELECT status INTO parent_status FROM ledger_transaction
        WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.transaction_id ELSE NEW.transaction_id END;`
      }
      IF parent_status IN ('CONFIRMED', 'RECONCILED', 'CORRECTED') THEN
        RAISE EXCEPTION 'splits of a confirmed Transaction are frozen (ADR-037)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END`);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION ledger_transaction_confirm_invariant() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      split_count integer;
      split_sum numeric;
      foreign_currency integer;
    BEGIN
      IF NEW.status NOT IN ('CONFIRMED', 'RECONCILED', 'CORRECTED') THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'a Transaction is not inserted confirmed; split and confirm it (domain-model §21)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status IN ('CONFIRMED', 'RECONCILED', 'CORRECTED') THEN
        RETURN NEW;
      END IF;
      SELECT count(*), coalesce(sum(amount), 0), count(*) FILTER (WHERE currency <> NEW.currency)
        INTO split_count, split_sum, foreign_currency
        FROM transaction_split WHERE transaction_id = NEW.id;
      IF split_count = 0 OR foreign_currency > 0 OR split_sum <> NEW.amount THEN
        RAISE EXCEPTION 'Transaction % cannot be confirmed: its splits (%, sum %) do not cover its amount % exactly (§18)',
          NEW.id, split_count, split_sum, NEW.amount
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_transaction_confirm_invariant BEFORE INSERT OR UPDATE OF status ON ledger_transaction
      FOR EACH ROW EXECUTE FUNCTION ledger_transaction_confirm_invariant()
  `.execute(db);
  // Serializes a split change with a concurrent confirmation: both now write the Transaction row.
  await sql`
    CREATE OR REPLACE FUNCTION transaction_split_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${SPLIT_FROZEN_BODY(true)} $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION transaction_split_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${SPLIT_FROZEN_BODY(false)} $$
  `.execute(db);
  await sql`DROP TRIGGER ledger_transaction_confirm_invariant ON ledger_transaction`.execute(db);
  await sql`DROP FUNCTION ledger_transaction_confirm_invariant()`.execute(db);
}

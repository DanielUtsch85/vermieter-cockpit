import { sql, type Kysely } from 'kysely';

/**
 * VC-X-15: reversing a confirmed Transaction without a replacement (api-design.md §35.9). The chain check of 0011
 * required both records; now the reversal is required and the replacement optional:
 *
 * - `CORRECTED` exactly when its reversal exists (with at most one replacement, unique index of 0011);
 * - a replacement can only be **inserted while its original is not yet `CORRECTED`**: a reversed Transaction stays
 *   reversed and is never given a replacement later (a reinstatement is a new Transaction). The rule rests on the
 *   order of the writes, not on transaction ids, so it neither depends on whether someone touches the original's
 *   `updated_at` nor on savepoints (review on #27). A correction writes reversal and replacement first and moves
 *   the original to `CORRECTED` last (§35.8). The check locks the original `FOR SHARE`: a concurrent reversal that
 *   has already made it `CORRECTED` but not committed is waited for, and then seen.
 *
 * `down` restores 0011's check; run it only while no Transaction is reversed without a replacement, which 0011
 * does not allow.
 */

const CHAIN_BODY = (reversalOnly: boolean) =>
  sql.raw(`
    DECLARE
      cur ledger_transaction%ROWTYPE;
      orig ledger_transaction%ROWTYPE;
      links integer;
    BEGIN
      -- The row as it is now: later writes in the same transaction may have changed it since the event.
      SELECT * INTO cur FROM ledger_transaction WHERE id = NEW.id;

      IF cur.correction_of_transaction_id IS NOT NULL THEN
        SELECT * INTO orig FROM ledger_transaction WHERE id = cur.correction_of_transaction_id;
        IF orig.correction_role = 'REVERSAL' THEN
          RAISE EXCEPTION 'Transaction % is a reversal and cannot be corrected (api-design §35.3)', orig.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF orig.status <> 'CORRECTED' THEN
          RAISE EXCEPTION 'correction % of Transaction %: the original is %, not CORRECTED (api-design §35.6)', cur.id, orig.id, orig.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF cur.status NOT IN ('CONFIRMED', 'RECONCILED', 'CORRECTED') THEN
          RAISE EXCEPTION 'correction % of Transaction % is %, not confirmed (api-design §35.3)', cur.id, orig.id, cur.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF cur.correction_role = 'REVERSAL' AND (
             (cur.financial_account_id, cur.currency, cur.amount, cur.booking_date, cur.value_date)
               IS DISTINCT FROM (orig.financial_account_id, orig.currency, orig.amount, orig.booking_date, orig.value_date)
             OR cur.direction = orig.direction) THEN
          RAISE EXCEPTION 'reversal % does not match Transaction % (same account, amount, dates; opposite direction)', cur.id, orig.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;

      IF cur.status = 'CORRECTED' THEN
        ${
          reversalOnly
            ? `-- The reversal is required; the replacement optional (at most one of each, unique index).
        SELECT count(*) INTO links FROM ledger_transaction WHERE correction_of_transaction_id = cur.id AND correction_role = 'REVERSAL';
        IF links <> 1 THEN
          RAISE EXCEPTION 'Transaction % is CORRECTED without its reversal (api-design §35.6)', cur.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;`
            : `-- At most one of each per original (unique index); CORRECTED needs both.
        SELECT count(*) INTO links FROM ledger_transaction WHERE correction_of_transaction_id = cur.id;
        IF links <> 2 THEN
          RAISE EXCEPTION 'Transaction % is CORRECTED without its reversal and replacement (api-design §35.6)', cur.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;`
        }
      END IF;
      RETURN NULL;
    END`);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_correction_chain() RETURNS trigger LANGUAGE plpgsql AS $$${CHAIN_BODY(true)} $$`.execute(db);
  await sql`
    CREATE FUNCTION ledger_transaction_replacement_in_time() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      original_status text;
    BEGIN
      -- FOR SHARE, not the FOR KEY SHARE of the foreign key: it waits for an uncommitted status change of the
      -- original (a concurrent reversal) and then reads the committed one.
      SELECT status INTO original_status FROM ledger_transaction WHERE id = NEW.correction_of_transaction_id FOR SHARE;
      IF original_status = 'CORRECTED' THEN
        RAISE EXCEPTION 'Transaction % is already CORRECTED; a replacement is written before its original becomes CORRECTED, never later (api-design §35.9)',
          NEW.correction_of_transaction_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_transaction_replacement_in_time
      BEFORE INSERT OR UPDATE OF correction_of_transaction_id, correction_role ON ledger_transaction
      FOR EACH ROW WHEN (NEW.correction_role = 'REPLACEMENT')
      EXECUTE FUNCTION ledger_transaction_replacement_in_time()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER ledger_transaction_replacement_in_time ON ledger_transaction`.execute(db);
  await sql`DROP FUNCTION ledger_transaction_replacement_in_time()`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_correction_chain() RETURNS trigger LANGUAGE plpgsql AS $$${CHAIN_BODY(false)} $$`.execute(db);
}

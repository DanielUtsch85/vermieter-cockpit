import { sql, type Kysely } from 'kysely';

/**
 * VC-X-15: reversing a confirmed Transaction without a replacement (api-design.md §35.9). The chain check of 0011
 * required both records; now the reversal is required and the replacement optional:
 *
 * - `CORRECTED` exactly when its reversal exists (with at most one replacement, unique index of 0011);
 * - a replacement is written only together with its correction, in the transaction that made the original
 *   `CORRECTED`: a reversed Transaction stays reversed and is never given a replacement later (a reinstatement is
 *   a new Transaction). Checked when the replacement is inserted, by the original's `xmin`: the correcting
 *   transaction is the last writer of a `CORRECTED` row, which is immutable afterwards (0009/0011).
 *
 * Everything else of the chain check stays as in 0011.
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
        END IF;${
          reversalOnly
            ? `
        IF TG_OP = 'INSERT' AND cur.correction_role = 'REPLACEMENT'
           AND orig.xmin::text::bigint <> txid_current() % 4294967296 THEN
          RAISE EXCEPTION 'Transaction % was reversed earlier; a replacement is written only with its correction (api-design §35.9)', orig.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;`
            : ''
        }
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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION ledger_transaction_correction_chain() RETURNS trigger LANGUAGE plpgsql AS $$${CHAIN_BODY(false)} $$`.execute(db);
}

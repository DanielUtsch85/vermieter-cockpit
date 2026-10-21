import { sql, type Kysely } from 'kysely';

/**
 * VC-X-17: a reversal mirrors the **splits** of its original, not only the header (review note on #22). The chain
 * check of 0011/0012 compares account, amount, dates and direction; the net effect per split category and split
 * PropertyReference (api-design.md §35.3) rests on the splits as well.
 *
 * A deferred constraint trigger checks at commit that the reversal's splits and the original's are the same
 * multiset of (category, PropertyReference, amount, currency). Position and description may differ: they carry no
 * amount. By then both split sets are final: the reversal is confirmed (0011) and the original is CORRECTED, so
 * both are frozen (0009/0010) from that commit on.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION ledger_transaction_reversal_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      cur ledger_transaction%ROWTYPE;
    BEGIN
      -- The row as it is now, as in the chain check of 0011.
      SELECT * INTO cur FROM ledger_transaction WHERE id = NEW.id;
      IF cur.correction_role IS DISTINCT FROM 'REVERSAL' THEN
        RETURN NULL;
      END IF;
      IF EXISTS (
           (SELECT financial_category_id, property_reference_id, amount, currency FROM transaction_split WHERE transaction_id = cur.id
            EXCEPT ALL
            SELECT financial_category_id, property_reference_id, amount, currency FROM transaction_split
              WHERE transaction_id = cur.correction_of_transaction_id)
           UNION ALL
           (SELECT financial_category_id, property_reference_id, amount, currency FROM transaction_split
              WHERE transaction_id = cur.correction_of_transaction_id
            EXCEPT ALL
            SELECT financial_category_id, property_reference_id, amount, currency FROM transaction_split WHERE transaction_id = cur.id)) THEN
        RAISE EXCEPTION 'reversal % does not mirror the splits of Transaction % (category, PropertyReference, amount; api-design §35.3)',
          cur.id, cur.correction_of_transaction_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  // Split writes touch their Transaction row only through `version` (0010), so the insert's event is the one that
  // checks them: deferred, it reads the splits as they are at commit.
  await sql`
    CREATE CONSTRAINT TRIGGER ledger_transaction_reversal_mirror
      AFTER INSERT OR UPDATE OF status, correction_of_transaction_id, correction_role
      ON ledger_transaction DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (NEW.correction_role = 'REVERSAL')
      EXECUTE FUNCTION ledger_transaction_reversal_mirror()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER ledger_transaction_reversal_mirror ON ledger_transaction`.execute(db);
  await sql`DROP FUNCTION ledger_transaction_reversal_mirror()`.execute(db);
}

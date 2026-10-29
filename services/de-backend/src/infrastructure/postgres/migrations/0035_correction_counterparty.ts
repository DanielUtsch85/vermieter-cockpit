import { sql, type Kysely } from 'kysely';

/**
 * #111: reversals and replacements keep the counterparty of the Transaction they correct. Backfill for corrections
 * written before: each takes its original's raw counterparty name and IBAN, along the chain (a replacement corrected
 * again gets it from its own original, which got it first). The counterparty columns are not among the frozen fields
 * of ledger_transaction_immutable, so confirmed corrections take the update. The backfill deliberately leaves `version`
 * as it is: it adds import evidence and changes nothing in the booking (review on #117).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    WITH RECURSIVE chain AS (
      SELECT t.id, o.counterparty_name_raw, o.counterparty_iban_raw
        FROM ledger_transaction t
        JOIN ledger_transaction o ON o.id = t.correction_of_transaction_id
       WHERE o.correction_of_transaction_id IS NULL
      UNION ALL
      SELECT t.id, chain.counterparty_name_raw, chain.counterparty_iban_raw
        FROM ledger_transaction t
        JOIN chain ON chain.id = t.correction_of_transaction_id
    )
    UPDATE ledger_transaction t
       SET counterparty_name_raw = chain.counterparty_name_raw, counterparty_iban_raw = chain.counterparty_iban_raw
      FROM chain
     WHERE t.id = chain.id
       AND (chain.counterparty_name_raw IS NOT NULL OR chain.counterparty_iban_raw IS NOT NULL)
  `.execute(db);
}

/** Corrections carried no counterparty before 0035; `down` restores that. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE ledger_transaction SET counterparty_name_raw = NULL, counterparty_iban_raw = NULL
     WHERE correction_of_transaction_id IS NOT NULL
  `.execute(db);
}

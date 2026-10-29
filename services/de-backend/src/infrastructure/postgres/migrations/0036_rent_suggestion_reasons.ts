import { sql, type Kysely } from 'kysely';

/**
 * #125 (real-data run F10): two new suggestion reasons for a tenant who pays before the month.
 * - `EXACT_AMOUNT_PURPOSE_MONTH`: the month in the purpose text made the pair unique.
 * - `EXACT_AMOUNT_IN_ORDER`: assigned in order from an anchor (api-design.md §37.3).
 * `down` refuses while a row carries one of them, as the old CHECK would.
 */
const REASONS = ['EXACT_AMOUNT', 'EXACT_AMOUNT_IBAN_HISTORY', 'EXACT_AMOUNT_PURPOSE_MONTH', 'EXACT_AMOUNT_IN_ORDER'];

async function replaceCheck(db: Kysely<unknown>, reasons: readonly string[]): Promise<void> {
  await sql`ALTER TABLE rent_payment_reconciliation DROP CONSTRAINT rent_payment_reconciliation_suggestion_fields`.execute(db);
  await sql`
    ALTER TABLE rent_payment_reconciliation ADD CONSTRAINT rent_payment_reconciliation_suggestion_fields CHECK (
      (status <> 'SUGGESTED' OR (confidence IS NOT NULL AND suggestion_reason IS NOT NULL))
      AND (suggestion_reason IS NULL OR suggestion_reason IN (${sql.join(reasons.map((r) => sql.lit(r)))}))
      AND (confidence IS NULL) = (suggestion_reason IS NULL)
    )
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await replaceCheck(db, REASONS);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await replaceCheck(db, REASONS.slice(0, 2));
}

import { sql, type Kysely } from 'kysely';

/**
 * VC-X-53: the payment interval of a Loan's terms period (api-design.md §58O; Entscheidung des Projektinhabers,
 * 2026-11-04, L4, and 2026-11-05, questions 1–12): the months between two planned payments, one of 1, 3, 6, 12.
 *
 * **Migration 0070:** the next free number after §58L's 0069.
 *
 * - `loan_terms` gains `payment_interval_months` (`smallint NOT NULL DEFAULT 1`), `loan_terms_payment_interval` (CHECK)
 *   `IN (1, 3, 6, 12)`. A constant default, no `UPDATE`: every existing period reads 1 (monthly, as before), no version
 *   and no AuditRecord is written (no backfill).
 * - 0025's `loan_terms_frozen` is replaced with the column in both rows of its `IS DISTINCT FROM`; everything else of
 *   the function stays word for word. `loan_terms_append` is unchanged.
 *
 * `down` refuses while a period states another interval than 1 (dropping it would turn that plan silently monthly),
 * then restores 0025's function verbatim and drops the column with its CHECK.
 */

/** 0025's `loan_terms_frozen`; `extra` adds columns to the frozen list. */
const termsFrozen = (extra: readonly string[]) => {
  const columns = (row: 'NEW' | 'OLD') =>
    [
      `${row}.id, ${row}.mre_realm_id, ${row}.loan_id, ${row}.valid_from, ${row}.interest_rate, ${row}.repayment_model, ${row}.scheduled_payment,`,
      `          ${row}.first_payment_date, ${row}.principal_at_start, ${row}.fixed_rate_until, ${row}.initial_repayment_rate, ${row}.special_repayment_limit,`,
      `          ${row}.currency, ${row}.notes, ${row}.created_at, ${row}.created_by${extra.map((c) => `, ${row}.${c}`).join('')}`,
    ].join('\n');
  return `
    CREATE OR REPLACE FUNCTION loan_terms_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      later uuid;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'LoanTerms %: never deleted; void it instead (api-design §41.2)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (${columns('NEW')})
         IS DISTINCT FROM
         (${columns('OLD')}) THEN
        RAISE EXCEPTION 'LoanTerms %: periods are never edited; void the last one and append (api-design §41.2)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF NOT (OLD.status = 'VALID' AND NEW.status = 'VOID') OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'LoanTerms %: the only step is VALID → VOID with version + 1 (api-design §41.2)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- The Loan row first (review on #61): a concurrent append behind this period meets the void there.
      UPDATE loan SET version = version WHERE id = OLD.loan_id;
      SELECT id INTO later FROM loan_terms
       WHERE loan_id = OLD.loan_id AND status = 'VALID' AND valid_from > OLD.valid_from LIMIT 1;
      IF later IS NOT NULL THEN
        RAISE EXCEPTION 'LoanTerms %: period % follows it; only the last period is voided (TERMS_NOT_LAST)', OLD.id, later
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$`;
};

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE loan_terms
      ADD COLUMN payment_interval_months smallint NOT NULL DEFAULT 1,
      ADD CONSTRAINT loan_terms_payment_interval CHECK (payment_interval_months IN (1, 3, 6, 12))
  `.execute(db);
  await sql.raw(termsFrozen(['payment_interval_months'])).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      stated uuid;
    BEGIN
      SELECT id INTO stated FROM loan_terms WHERE payment_interval_months <> 1 ORDER BY id LIMIT 1;
      IF stated IS NOT NULL THEN
        RAISE EXCEPTION 'down 0070: LoanTerms % states a payment interval other than 1; 0069 cannot hold it', stated
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END $$
  `.execute(db);
  await sql.raw(termsFrozen([])).execute(db);
  await sql`
    ALTER TABLE loan_terms
      DROP CONSTRAINT loan_terms_payment_interval,
      DROP COLUMN payment_interval_months
  `.execute(db);
}

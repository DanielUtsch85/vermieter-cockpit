import { sql, type Kysely } from 'kysely';

/**
 * VC-X-40: the recorded interest period of a Loan's interest split (api-design.md §58L "Database", open question 4;
 * Entscheidung des Projektinhabers, 2026-11-04, L4; Prüfbericht 2026-11-01, Frage 22, mündlich bestätigt durch den
 * Steuerberater, laut Projektinhaber am 2026-11-01). The period distribution itself stores nothing (the view derives on
 * read); this holds only the person's statement of the period an interest pays for, from the lender's statement, which
 * wins over the schedule's for the allocation, never for the 10-day rule.
 *
 * **Migration 0069:** the next free number after §58M's 0068 (the owner's order of 2026-11-04: §58K, §58M, then §58L).
 *
 * - `tax_classification` gains `interest_period_from`, `interest_period_until` (`date`). `tax_classification_interest_period`
 *   (CHECK): both set or both null, `from ≤ until`, only with `source_type` `TRANSACTION_SPLIT`.
 * - `tax_classification_interest_period_split` (before insert): with a period, the split (of the classification's
 *   Realm) has a `loan_id` and the financial category `LOAN_INTEREST`; else `INTEREST_PERIOD_NOT_ALLOWED`.
 * - 0068's frozen guard (`tax_classification_weg_source_fixed`, 0047/0062/0068) covers the two new columns.
 *
 * No backfill: no period is set. `down` refuses while a classification states a period, then restores 0068's guard and
 * drops what this added.
 */

/** 0068's frozen guard of the WEG source and §58B's/§59F's/§58M's fields; `extra` adds columns. */
const wegSourceFixed = (extra: readonly string[]) => {
  const columns = (row: 'NEW' | 'OLD') =>
    [
      `${row}.weg_annual_statement_id, ${row}.weg_reserve_position, ${row}.weg_withdrawal_unit_share, ${row}.weg_special_assessment_id, ${row}.weg_use_position,`,
      `          ${row}.weg_use_date, ${row}.weg_use_unit_share, ${row}.net_amount, ${row}.annually_recurring, ${row}.distribution_years, ${row}.mostly_residential_confirmed,`,
      `          ${row}.anschaffungsnahe_acquisition_id, ${row}.treatment_rule_code, ${row}.treatment_rule_version,`,
      `          ${row}.performed_from, ${row}.performed_until, ${row}.performance_progress_estimated, ${row}.created_txid, ${row}.partial_treatment,`,
      `          ${row}.weg_cost_line_position, ${row}.weg_cost_line_unit_share${extra.map((c) => `, ${row}.${c}`).join('')}`,
    ].join('\n');
  return `
    CREATE OR REPLACE FUNCTION tax_classification_weg_source_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (${columns('NEW')})
         IS DISTINCT FROM
         (${columns('OLD')}) THEN
        RAISE EXCEPTION 'TaxClassification %: the WEG source and the fields of §58B and §59F never change (api-design §58B, §59F)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$`;
};

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tax_classification
      ADD COLUMN interest_period_from date,
      ADD COLUMN interest_period_until date,
      ADD CONSTRAINT tax_classification_interest_period CHECK (
        (interest_period_from IS NULL) = (interest_period_until IS NULL)
          AND (interest_period_from IS NULL OR interest_period_from <= interest_period_until)
          AND (interest_period_from IS NULL OR source_type = 'TRANSACTION_SPLIT')
      )
  `.execute(db);
  await sql.raw(wegSourceFixed(['interest_period_from', 'interest_period_until'])).execute(db);
  await sql`
    CREATE FUNCTION tax_classification_interest_period_split() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      split record;
    BEGIN
      IF NEW.interest_period_from IS NULL AND NEW.interest_period_until IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT s.loan_id, c.code INTO split FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id
       WHERE s.id = NEW.transaction_split_id AND s.mre_realm_id = NEW.mre_realm_id;
      -- §58L (L4): the allocation of a Loan's interest only; an unknown split is left to the foreign key.
      IF FOUND AND (split.loan_id IS NULL OR split.code <> 'LOAN_INTEREST') THEN
        RAISE EXCEPTION 'TaxClassification: an interest period only on a Loan''s LOAN_INTEREST split (api-design §58L), not % (INTEREST_PERIOD_NOT_ALLOWED)', NEW.transaction_split_id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_interest_period_split BEFORE INSERT ON tax_classification
      FOR EACH ROW EXECUTE FUNCTION tax_classification_interest_period_split()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM tax_classification WHERE interest_period_from IS NOT NULL) THEN
        RAISE EXCEPTION 'down 0069: a classification states an interest period; 0068 cannot hold it'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP TRIGGER tax_classification_interest_period_split ON tax_classification`.execute(db);
  await sql`DROP FUNCTION tax_classification_interest_period_split()`.execute(db);
  await sql.raw(wegSourceFixed([])).execute(db);
  await sql`
    ALTER TABLE tax_classification
      DROP CONSTRAINT tax_classification_interest_period,
      DROP COLUMN interest_period_until,
      DROP COLUMN interest_period_from
  `.execute(db);
}

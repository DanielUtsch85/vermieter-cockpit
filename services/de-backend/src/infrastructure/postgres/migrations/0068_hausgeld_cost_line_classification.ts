import { sql, type Kysely } from 'kysely';

/**
 * VC-X-27: maintenance paid from the Hausgeld in the anschaffungsnahe check (api-design.md §58M "Database"; Entscheidung
 * des Projektinhabers, 2026-11-04, M1, M2, M6, M11). A cost line of a WEG annual statement becomes a source of a
 * classification, `WEG_STATEMENT_COST_LINE`, a check-only fact: never a figure of the tax-year view.
 *
 * - `tax_classification` gains `weg_cost_line_position` (1–1000) and `weg_cost_line_unit_share` (signed Money ≠ 0, scale
 *   ≤ 2, the printed unit share as classified); `source_type` takes `WEG_STATEMENT_COST_LINE`; `weg_annual_statement_id`
 *   is set with exactly one of `weg_reserve_position` and `weg_cost_line_position`; a foreign key to the line
 *   (`weg_statement_cost_line (statement_id, position)`, 0042's key; the Realm through the statement's composite key); the
 *   chain keys and supersede foreign keys as 0047's for withdrawals; one current classification per line.
 * - `tax_classification_cost_line_fit` (CHECK): `MAINTENANCE`/`DEDUCTIBLE` or `NOT_RELEVANT`/`NOT_RELEVANT`; the rule
 *   `DE_ANSCHAFFUNGSNAHE`; no link, no partial treatment, no § 82b fields, no `tax_year`, `refund_of_year`, record or
 *   second rule; `net_amount`, `annually_recurring` and the performance only with `MAINTENANCE`. `net_amount` stays at
 *   most the unit share's absolute value (`tax_classification_erhaltung_fields`).
 * - `tax_classification_cost_line_counts` (before insert): writes the statement row first (a no-op, P7-D9, as 0047's
 *   `withdrawal_counts`), then requires the statement `CONFIRMED`, the line's stored classification `NON_RECOVERABLE`
 *   and its `unit_share` ≠ 0 and equal to `weg_cost_line_unit_share` (SOURCE_NOT_COUNTED).
 * - 0047's `tax_classification_withdrawal_counts()` now returns early without a reserve position (a cost line is no
 *   withdrawal); 0062's `tax_classification_weg_source_fixed()` covers the two new columns.
 *
 * Nothing on `weg_annual_statement`, `weg_statement_cost_line` or their guards changes; no backfill. `down` refuses while
 * a `WEG_STATEMENT_COST_LINE` classification exists, then restores 0047's and 0062's functions and constraints.
 */

/** 0047's withdrawal guard; `early` is the condition it returns on (0047: no statement). */
const withdrawalCounts = (early: string) => `
    CREATE OR REPLACE FUNCTION tax_classification_withdrawal_counts() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      st record;
      line jsonb;
      w numeric;
      n numeric;
      d numeric;
      s numeric;
    BEGIN
      IF ${early} THEN
        RETURN NEW;
      END IF;
      -- Statement → classification (P7-D9): a confirm superseding it waits, or this waits for it; under REPEATABLE READ
      -- the later one fails to serialise. Written, never only read (0042's frozen guard lets the no-op pass).
      UPDATE weg_annual_statement SET version = version WHERE id = NEW.weg_annual_statement_id AND mre_realm_id = NEW.mre_realm_id
       RETURNING id, status, reserve, membership_id, period_from, period_until INTO st;
      IF st.id IS NULL THEN
        RETURN NEW; -- an unknown statement, or one of another Realm, is left to the foreign key
      END IF;
      IF st.status <> 'CONFIRMED' THEN
        RAISE EXCEPTION 'TaxClassification: WEG annual statement % is %, not current (SOURCE_NOT_COUNTED)', st.id, st.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT l INTO line FROM jsonb_array_elements(coalesce(st.reserve -> 'lines', '[]'::jsonb)) AS l
       WHERE (l ->> 'position')::integer = NEW.weg_reserve_position;
      IF line IS NULL OR line ->> 'kind' IS DISTINCT FROM 'WITHDRAWAL' OR jsonb_typeof(line -> 'withdrawal') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'TaxClassification: reserve line % of statement % is not a withdrawal (SOURCE_NOT_COUNTED)', NEW.weg_reserve_position, st.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT mea_numerator * 1000, mea_denominator * 1000 INTO n, d FROM weg_membership WHERE id = st.membership_id;
      w := (line -> 'withdrawal' ->> 'amount')::numeric * 100;
      s := NEW.weg_withdrawal_unit_share * 100;
      -- s is the half-up rounding of w·n/d exactly when (2s − 1)·d ≤ 2·w·n < (2s + 1)·d: no division rounds.
      IF w <= 0 OR NOT ((2 * s - 1) * d <= 2 * w * n AND 2 * w * n < (2 * s + 1) * d) THEN
        RAISE EXCEPTION 'TaxClassification: % is not the unit share of withdrawal % (SOURCE_NOT_COUNTED)', NEW.weg_withdrawal_unit_share, NEW.weg_reserve_position
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- An undated withdrawal's tax year: a calendar year its period touches; a dated one has its own.
      IF NEW.tax_year IS NOT NULL AND (line ? 'date' OR NEW.tax_year NOT IN (extract(year FROM st.period_from), extract(year FROM st.period_until))) THEN
        RAISE EXCEPTION 'TaxClassification: tax_year % is not a year of the period of an undated withdrawal (TAX_YEAR_OUT_OF_RANGE)', NEW.tax_year
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$`;

/** 0062's frozen guard of the WEG source and §58B's/§59F's fields; `extra` adds columns (§58M). */
const wegSourceFixed = (extra: readonly string[]) => {
  const columns = (row: 'NEW' | 'OLD') =>
    [
      `${row}.weg_annual_statement_id, ${row}.weg_reserve_position, ${row}.weg_withdrawal_unit_share, ${row}.weg_special_assessment_id, ${row}.weg_use_position,`,
      `          ${row}.weg_use_date, ${row}.weg_use_unit_share, ${row}.net_amount, ${row}.annually_recurring, ${row}.distribution_years, ${row}.mostly_residential_confirmed,`,
      `          ${row}.anschaffungsnahe_acquisition_id, ${row}.treatment_rule_code, ${row}.treatment_rule_version,`,
      `          ${row}.performed_from, ${row}.performed_until, ${row}.performance_progress_estimated, ${row}.created_txid, ${row}.partial_treatment${extra.map((c) => `, ${row}.${c}`).join('')}`,
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

/** The constraints this migration replaces, as 0047 (`one_source`, `weg_source_fields`, `erhaltung_fields`) wrote them. */
const BEFORE = `
      ADD CONSTRAINT tax_classification_source_type_check
        CHECK (source_type IN ('TRANSACTION_SPLIT', 'DEPOSIT_CLOSING', 'WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE')),
      ADD CONSTRAINT tax_classification_one_source CHECK (
        num_nonnulls(transaction_split_id, security_deposit_id, weg_annual_statement_id, weg_special_assessment_id) = 1
          AND (source_type = 'TRANSACTION_SPLIT') = (transaction_split_id IS NOT NULL)
          AND (source_type = 'DEPOSIT_CLOSING') = (security_deposit_id IS NOT NULL)
          AND (source_type = 'WEG_RESERVE_WITHDRAWAL') = (weg_annual_statement_id IS NOT NULL)
          AND (source_type = 'WEG_ASSESSMENT_USE') = (weg_special_assessment_id IS NOT NULL)
      ),
      ADD CONSTRAINT tax_classification_weg_source_fields CHECK (
        (weg_annual_statement_id IS NOT NULL) = (weg_reserve_position IS NOT NULL)
          AND (weg_annual_statement_id IS NOT NULL) = (weg_withdrawal_unit_share IS NOT NULL)
          AND (weg_special_assessment_id IS NOT NULL) = (weg_use_position IS NOT NULL)
          AND (weg_special_assessment_id IS NOT NULL) = (weg_use_date IS NOT NULL)
          AND (weg_special_assessment_id IS NOT NULL) = (weg_use_unit_share IS NOT NULL)
          AND ((weg_annual_statement_id IS NULL AND weg_special_assessment_id IS NULL) OR refund_of_year IS NULL)
          AND (weg_special_assessment_id IS NULL OR tax_year IS NULL)
      ),
      ADD CONSTRAINT tax_classification_erhaltung_fields CHECK (
        ((net_amount IS NULL AND NOT annually_recurring) OR tax_category IN ('MAINTENANCE', 'WEG_SPENDING'))
          AND (net_amount IS NULL OR net_amount <= coalesce(weg_withdrawal_unit_share, weg_use_unit_share, net_amount))
      )`;

const REPLACED = `
      DROP CONSTRAINT tax_classification_source_type_check,
      DROP CONSTRAINT tax_classification_one_source,
      DROP CONSTRAINT tax_classification_weg_source_fields,
      DROP CONSTRAINT tax_classification_erhaltung_fields`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tax_classification
      ADD COLUMN weg_cost_line_position integer CHECK (weg_cost_line_position BETWEEN 1 AND 1000),
      ADD COLUMN weg_cost_line_unit_share numeric CHECK (weg_cost_line_unit_share <> 0 AND scale(weg_cost_line_unit_share) <= 2),
      ${sql.raw(REPLACED)},
      ADD CONSTRAINT tax_classification_source_type_check
        CHECK (source_type IN ('TRANSACTION_SPLIT', 'DEPOSIT_CLOSING', 'WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE', 'WEG_STATEMENT_COST_LINE')),
      ADD CONSTRAINT tax_classification_one_source CHECK (
        num_nonnulls(transaction_split_id, security_deposit_id, weg_annual_statement_id, weg_special_assessment_id) = 1
          AND (source_type = 'TRANSACTION_SPLIT') = (transaction_split_id IS NOT NULL)
          AND (source_type = 'DEPOSIT_CLOSING') = (security_deposit_id IS NOT NULL)
          AND (source_type IN ('WEG_RESERVE_WITHDRAWAL', 'WEG_STATEMENT_COST_LINE')) = (weg_annual_statement_id IS NOT NULL)
          AND (source_type = 'WEG_ASSESSMENT_USE') = (weg_special_assessment_id IS NOT NULL)
      ),
      -- §58M: a statement is named with exactly one of a reserve position (a withdrawal) and a cost line position.
      ADD CONSTRAINT tax_classification_weg_source_fields CHECK (
        num_nonnulls(weg_reserve_position, weg_cost_line_position) = CASE WHEN weg_annual_statement_id IS NULL THEN 0 ELSE 1 END
          AND (source_type = 'WEG_RESERVE_WITHDRAWAL') = (weg_reserve_position IS NOT NULL)
          AND (source_type = 'WEG_STATEMENT_COST_LINE') = (weg_cost_line_position IS NOT NULL)
          AND (weg_reserve_position IS NOT NULL) = (weg_withdrawal_unit_share IS NOT NULL)
          AND (weg_cost_line_position IS NOT NULL) = (weg_cost_line_unit_share IS NOT NULL)
          AND (weg_special_assessment_id IS NOT NULL) = (weg_use_position IS NOT NULL)
          AND (weg_special_assessment_id IS NOT NULL) = (weg_use_date IS NOT NULL)
          AND (weg_special_assessment_id IS NOT NULL) = (weg_use_unit_share IS NOT NULL)
          AND ((weg_annual_statement_id IS NULL AND weg_special_assessment_id IS NULL) OR refund_of_year IS NULL)
          AND (weg_special_assessment_id IS NULL OR tax_year IS NULL)
      ),
      ADD CONSTRAINT tax_classification_erhaltung_fields CHECK (
        ((net_amount IS NULL AND NOT annually_recurring) OR tax_category IN ('MAINTENANCE', 'WEG_SPENDING'))
          AND (net_amount IS NULL OR net_amount <= coalesce(weg_withdrawal_unit_share, weg_use_unit_share, abs(weg_cost_line_unit_share), net_amount))
      ),
      -- DE_ANSCHAFFUNGSNAHE@1's hausgeldMaintenance (§58M), literally: the two lines, check-only, nothing of a treatment.
      ADD CONSTRAINT tax_classification_cost_line_fit CHECK (
        source_type <> 'WEG_STATEMENT_COST_LINE' OR (
          ((tax_category = 'MAINTENANCE' AND treatment = 'DEDUCTIBLE') OR (tax_category = 'NOT_RELEVANT' AND treatment = 'NOT_RELEVANT'))
            AND rule_code = 'DE_ANSCHAFFUNGSNAHE'
            AND anschaffungsnahe_acquisition_id IS NULL AND NOT partial_treatment AND distribution_years IS NULL
            AND mostly_residential_confirmed IS NULL AND tax_year IS NULL AND refund_of_year IS NULL
            AND construction_period_interest_id IS NULL AND treatment_rule_code IS NULL
            AND (tax_category = 'MAINTENANCE' OR (net_amount IS NULL AND NOT annually_recurring AND performed_from IS NULL))
        )
      ),
      ADD CONSTRAINT tax_classification_cost_line_fk FOREIGN KEY (weg_annual_statement_id, weg_cost_line_position)
        REFERENCES weg_statement_cost_line (statement_id, position),
      ADD CONSTRAINT tax_classification_cost_line_chain_key UNIQUE (id, weg_annual_statement_id, weg_cost_line_position),
      ADD CONSTRAINT tax_classification_cost_line_supersedes_fk FOREIGN KEY (supersedes_id, weg_annual_statement_id, weg_cost_line_position)
        REFERENCES tax_classification (id, weg_annual_statement_id, weg_cost_line_position),
      ADD CONSTRAINT tax_classification_cost_line_superseded_by_fk FOREIGN KEY (superseded_by, weg_annual_statement_id, weg_cost_line_position)
        REFERENCES tax_classification (id, weg_annual_statement_id, weg_cost_line_position) DEFERRABLE INITIALLY DEFERRED
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX tax_classification_current_cost_line ON tax_classification (weg_annual_statement_id, weg_cost_line_position)
      WHERE superseded_at IS NULL AND weg_cost_line_position IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX tax_classification_cost_line_idx ON tax_classification (weg_annual_statement_id, weg_cost_line_position, created_at, id)
      WHERE weg_cost_line_position IS NOT NULL
  `.execute(db);
  await sql.raw(withdrawalCounts('NEW.weg_reserve_position IS NULL')).execute(db);
  await sql.raw(wegSourceFixed(['weg_cost_line_position', 'weg_cost_line_unit_share'])).execute(db);
  await sql`
    CREATE FUNCTION tax_classification_cost_line_counts() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      st record;
      line record;
    BEGIN
      IF NEW.weg_cost_line_position IS NULL THEN
        RETURN NEW;
      END IF;
      -- Statement → classification (P7-D9), as 0047's withdrawal guard: written, never only read (0042's frozen guard
      -- lets the no-op pass), so a confirm superseding the statement serialises with this create.
      UPDATE weg_annual_statement SET version = version WHERE id = NEW.weg_annual_statement_id AND mre_realm_id = NEW.mre_realm_id
       RETURNING id, status INTO st;
      IF st.id IS NULL THEN
        RETURN NEW; -- an unknown statement, or one of another Realm, is left to the foreign key
      END IF;
      IF st.status <> 'CONFIRMED' THEN
        RAISE EXCEPTION 'TaxClassification: WEG annual statement % is %, not current (SOURCE_NOT_COUNTED)', st.id, st.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT classification, unit_share INTO line FROM weg_statement_cost_line WHERE statement_id = st.id AND position = NEW.weg_cost_line_position;
      IF line.classification IS NULL THEN
        RETURN NEW; -- left to the foreign key
      END IF;
      -- §58M (M2): only a NON_RECOVERABLE line is judged (§ 1 Abs. 2 Nr. 2 BetrKV); its printed unit share as classified.
      IF line.classification <> 'NON_RECOVERABLE' OR line.unit_share = 0 OR line.unit_share IS DISTINCT FROM NEW.weg_cost_line_unit_share THEN
        RAISE EXCEPTION 'TaxClassification: cost line % of statement % is % with % (classified %), not counted (SOURCE_NOT_COUNTED)',
          NEW.weg_cost_line_position, st.id, line.classification, line.unit_share, NEW.weg_cost_line_unit_share
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_cost_line_counts BEFORE INSERT ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_cost_line_counts()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM tax_classification WHERE source_type = 'WEG_STATEMENT_COST_LINE') THEN
        RAISE EXCEPTION 'down 0068: a classification of a WEG statement cost line exists; 0067 cannot hold it'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP TRIGGER tax_classification_cost_line_counts ON tax_classification`.execute(db);
  await sql`DROP FUNCTION tax_classification_cost_line_counts()`.execute(db);
  await sql.raw(wegSourceFixed([])).execute(db);
  await sql.raw(withdrawalCounts('NEW.weg_annual_statement_id IS NULL')).execute(db);
  await sql`DROP INDEX tax_classification_cost_line_idx`.execute(db);
  await sql`DROP INDEX tax_classification_current_cost_line`.execute(db);
  await sql`
    ALTER TABLE tax_classification
      DROP CONSTRAINT tax_classification_cost_line_superseded_by_fk,
      DROP CONSTRAINT tax_classification_cost_line_supersedes_fk
  `.execute(db);
  await sql`
    ALTER TABLE tax_classification
      DROP CONSTRAINT tax_classification_cost_line_chain_key,
      DROP CONSTRAINT tax_classification_cost_line_fk,
      DROP CONSTRAINT tax_classification_cost_line_fit,
      ${sql.raw(REPLACED)},
      ${sql.raw(BEFORE)},
      DROP COLUMN weg_cost_line_unit_share,
      DROP COLUMN weg_cost_line_position
  `.execute(db);
}

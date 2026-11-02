import { sql, type Kysely } from 'kysely';

/**
 * VC-X-41 (api-design.md §59G "As implemented (VC-X-41 Part 1)"; Entscheidung des Projektinhabers, 2026-11-02, 238-5):
 * an evidence cannot attest a Stichtag after its own date. The API refuses such an entry at the boundary
 * (`422 VALUATION_DATE_AFTER_EVIDENCE_DATE`); this CHECK keeps every other writer to the same rule.
 *
 * - `depreciation_asset_useful_life_valuation_not_after_evidence`: `valuation_date` is `NULL` (an entry stored before
 *   0056, not judged) or not after `evidence_date`; equal dates are allowed.
 * - `up` refuses while a row already states a Stichtag after its document's date: a person's statement is never
 *   changed silently, so such a row is amended (or a non-production database reset) first.
 * - `down` drops the constraint; nothing is lost.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM depreciation_asset_useful_life WHERE valuation_date > evidence_date) THEN
        RAISE EXCEPTION 'depreciation_asset_useful_life: an entry states a Stichtag after its evidence date; 0059 (api-design §59G) needs it amended first'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`
    ALTER TABLE depreciation_asset_useful_life
      ADD CONSTRAINT depreciation_asset_useful_life_valuation_not_after_evidence CHECK (valuation_date IS NULL OR valuation_date <= evidence_date)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE depreciation_asset_useful_life DROP CONSTRAINT depreciation_asset_useful_life_valuation_not_after_evidence`.execute(db);
}

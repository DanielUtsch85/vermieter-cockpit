import { sql, type Kysely } from 'kysely';

/**
 * VC-X-41 Part 1 (api-design.md §59G "In the database", "As implemented (VC-X-41 Part 1)"; tax review of 2026-11-01,
 * question 8; the owner's decisions of 2026-11-02): the shorter useful life's Stichtag (Bewertungsstichtag) apart
 * from the document's date, and the advisor's release note (Freigabevermerk). Migration 0056 was assigned (0057 is
 * VC-X-39's; VC-X-38 takes the next free number).
 *
 * - `up` refuses while any `depreciation_schedule_version` row exists: nothing productive is recorded (the switch has
 *   never been on), and a recorded version without the Stichtag could not be re-derived. A non-production
 *   database is reset instead.
 * - `depreciation_asset_useful_life` (0049) gains `valuation_date` (`date`, the Stichtag) and `release_note` (1–500,
 *   the Freigabevermerk; names as fixed by api-design §59G).
 *   **No backfill:** an existing row keeps `NULL`, which means "not stated"; the old `evidence_date` stays the document's
 *   date and is never read as the Stichtag (the schedule does not compute such an entry: `USEFUL_LIFE_VALUATION_DATE_MISSING`).
 * - `depreciation_asset_useful_life_valuation_date` (before insert or update): every row written from 0056 on states its
 *   Stichtag; `NULL` remains only on a row no write has touched since (the API requires the field).
 * - `depreciation_schedule_version_component` (0052) gains `shorter_life_valuation_date`, set exactly when `kind` is
 *   `ACQUISITION` and `rate_kind` is `SHORTER_USEFUL_LIFE` (the input of the fingerprint, §60).
 * - `down` refuses while an entry states a Stichtag or a release note (a person's statement is never dropped
 *   silently) or a recorded version exists; else it drops the columns, the constraints and the guard.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version) THEN
        RAISE EXCEPTION 'depreciation_schedule_version: recorded versions exist; 0056 (api-design §59G) needs a database without them: reset this non-production database'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);

  await sql`
    ALTER TABLE depreciation_asset_useful_life
      ADD COLUMN valuation_date date,
      ADD COLUMN release_note text CHECK (length(release_note) BETWEEN 1 AND 500)
  `.execute(db);

  await sql`
    CREATE FUNCTION depreciation_asset_useful_life_valuation_date() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.valuation_date IS NULL THEN
        RAISE EXCEPTION 'DepreciationAsset %: a shorter useful life written from migration 0056 on states its Stichtag (api-design §59G)', NEW.asset_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER depreciation_asset_useful_life_valuation_date BEFORE INSERT OR UPDATE ON depreciation_asset_useful_life
      FOR EACH ROW EXECUTE FUNCTION depreciation_asset_useful_life_valuation_date()
  `.execute(db);

  await sql`
    ALTER TABLE depreciation_schedule_version_component
      ADD COLUMN shorter_life_valuation_date date,
      ADD CONSTRAINT depreciation_schedule_version_component_shorter_life CHECK (
        (shorter_life_valuation_date IS NOT NULL) = (kind = 'ACQUISITION' AND rate_kind = 'SHORTER_USEFUL_LIFE')
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is dropped: a person's statement and a recorded version are never dropped silently.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM depreciation_asset_useful_life WHERE valuation_date IS NOT NULL OR release_note IS NOT NULL) THEN
        RAISE EXCEPTION 'depreciation_asset_useful_life: an entry states a Stichtag or a release note; it is never dropped silently (api-design §59G)'
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version) THEN
        RAISE EXCEPTION 'depreciation_schedule_version: a recorded version exists; its Stichtag dates are never dropped silently (api-design §59G)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`
    ALTER TABLE depreciation_schedule_version_component
      DROP CONSTRAINT depreciation_schedule_version_component_shorter_life,
      DROP COLUMN shorter_life_valuation_date
  `.execute(db);
  await sql`DROP TRIGGER depreciation_asset_useful_life_valuation_date ON depreciation_asset_useful_life`.execute(db);
  await sql`DROP FUNCTION depreciation_asset_useful_life_valuation_date()`.execute(db);
  await sql`
    ALTER TABLE depreciation_asset_useful_life
      DROP COLUMN release_note,
      DROP COLUMN valuation_date
  `.execute(db);
}

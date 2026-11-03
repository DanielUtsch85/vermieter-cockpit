import { sql, type Kysely } from 'kysely';

/**
 * VC-X-41 Part 2 (api-design.md §59G "Decided on 2026-11-02 (chat): what follows for Part 2", 4; Entscheidung des
 * Projektinhabers, 2026-11-02, open question 11): a late evidence's release needs, per owner, the cumulative AfA declared
 * per the tax assessments through `YE − 1`, with an evidence reference, as a field of the entry. Migration 0061: 0060 is
 * VC-X-28's (merge after it; Kysely's Migrator refuses a migration whose name sorts before one already applied).
 *
 * - `up` refuses while any `depreciation_schedule_version` row exists: a recorded version's inputs gain the declared
 *   AfA, and nothing productive is recorded (the switch has never been on). A non-production database is reset instead.
 * - `depreciation_asset_useful_life` (0049) gains `declared_afa` (`jsonb`, an array, `[]` for none; **no backfill**: every
 *   row stored before reads `[]`, "none recorded"). Each element is `{ partyId, throughYear, amount, evidenceReference }`;
 *   at most 20 (CHECK `depreciation_asset_useful_life_declared_afa_array`).
 * - `depreciation_asset_useful_life_declared_afa` (before insert or update), each refusal its own code:
 *   - the owner: a Party of the entry's Realm (`23503`), each once (`23505`);
 *   - the amount: a decimal string with two places, never negative (`23514`); `throughYear` an integer 2000–2100
 *     (`23514`); `evidenceReference` 1–500 characters (`23514`); no other key (`23514`);
 *   - only on an entry that can be a late evidence: its Stichtag's year after its Acquisition's contract year (`23514`);
 *     a Stichtag in or before the contract year is `FROM_START` (or before the purchase) whatever the transfer date, so
 *     a declared AfA there could never be read.
 * - `depreciation_schedule_version_component` (0052) gains `shorter_life_declared_afa` (`jsonb`), set only beside a
 *   Stichtag (CHECK `depreciation_schedule_version_component_declared_afa`): the stored input of the fingerprint (§60).
 * - `down` refuses while an entry states a declared AfA (a person's statement is never dropped silently) or a recorded
 *   version exists; else it drops the columns, the constraints and the guard.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version) THEN
        RAISE EXCEPTION 'depreciation_schedule_version: recorded versions exist; 0061 (api-design §59G Part 2) needs a database without them: reset this non-production database'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);

  await sql`
    ALTER TABLE depreciation_asset_useful_life
      ADD COLUMN declared_afa jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD CONSTRAINT depreciation_asset_useful_life_declared_afa_array CHECK (
        jsonb_typeof(declared_afa) = 'array' AND jsonb_array_length(declared_afa) <= 20
      )
  `.execute(db);

  await sql`
    CREATE FUNCTION depreciation_asset_useful_life_declared_afa() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      row jsonb;
      named_party text;
      contract_year integer;
    BEGIN
      -- The shape first (the CHECK says the same; a trigger runs before it).
      IF jsonb_typeof(NEW.declared_afa) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.declared_afa) > 20 THEN
        RAISE EXCEPTION 'DepreciationAsset %: the declared AfA is an array of at most 20 (api-design §59G Part 2)', NEW.asset_id
          USING ERRCODE = 'check_violation';
      END IF;
      IF jsonb_array_length(NEW.declared_afa) = 0 THEN
        RETURN NEW;
      END IF;
      SELECT extract(year FROM contract_date)::int INTO contract_year FROM acquisition WHERE id = NEW.acquisition_id;
      IF NEW.valuation_date IS NULL OR contract_year IS NULL OR extract(year FROM NEW.valuation_date)::int <= contract_year THEN
        RAISE EXCEPTION 'DepreciationAsset %: a declared AfA belongs only to an entry whose Stichtag lies after its contract year (api-design §59G Part 2)', NEW.asset_id
          USING ERRCODE = 'check_violation';
      END IF;
      FOR row IN SELECT value FROM jsonb_array_elements(NEW.declared_afa) LOOP
        IF jsonb_typeof(row) <> 'object'
           OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(row) AS k) IS DISTINCT FROM ARRAY['amount', 'evidenceReference', 'partyId', 'throughYear']
           OR jsonb_typeof(row -> 'partyId') <> 'string'
           OR jsonb_typeof(row -> 'amount') <> 'string'
           OR (row ->> 'amount') !~ '^(0|[1-9][0-9]{0,12})[.][0-9]{2}$'
           OR jsonb_typeof(row -> 'throughYear') <> 'number'
           OR (row ->> 'throughYear') !~ '^[0-9]{4}$'
           OR (row ->> 'throughYear')::int NOT BETWEEN 2000 AND 2100
           OR jsonb_typeof(row -> 'evidenceReference') <> 'string'
           OR length(row ->> 'evidenceReference') NOT BETWEEN 1 AND 500 THEN
          RAISE EXCEPTION 'DepreciationAsset %: a declared AfA is { partyId, throughYear 2000–2100, amount >= 0.00, evidenceReference 1–500 } (api-design §59G Part 2)', NEW.asset_id
            USING ERRCODE = 'check_violation';
        END IF;
        named_party := row ->> 'partyId';
        IF NOT EXISTS (SELECT 1 FROM party WHERE party.id::text = named_party AND party.mre_realm_id = NEW.mre_realm_id) THEN
          RAISE EXCEPTION 'DepreciationAsset %: the declared AfA names Party %, not one of the Realm (api-design §59G Part 2)', NEW.asset_id, named_party
            USING ERRCODE = 'foreign_key_violation';
        END IF;
      END LOOP;
      IF (SELECT count(DISTINCT value ->> 'partyId') FROM jsonb_array_elements(NEW.declared_afa)) <> jsonb_array_length(NEW.declared_afa) THEN
        RAISE EXCEPTION 'DepreciationAsset %: at most one declared AfA per owner (api-design §59G Part 2)', NEW.asset_id
          USING ERRCODE = 'unique_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER depreciation_asset_useful_life_declared_afa BEFORE INSERT OR UPDATE ON depreciation_asset_useful_life
      FOR EACH ROW EXECUTE FUNCTION depreciation_asset_useful_life_declared_afa()
  `.execute(db);

  await sql`
    ALTER TABLE depreciation_schedule_version_component
      ADD COLUMN shorter_life_declared_afa jsonb,
      ADD CONSTRAINT depreciation_schedule_version_component_declared_afa CHECK (
        shorter_life_declared_afa IS NULL OR (shorter_life_valuation_date IS NOT NULL AND jsonb_typeof(shorter_life_declared_afa) = 'array')
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is dropped: a person's statement and a recorded version are never dropped silently.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM depreciation_asset_useful_life WHERE declared_afa <> '[]'::jsonb) THEN
        RAISE EXCEPTION 'depreciation_asset_useful_life: an entry states a declared AfA; it is never dropped silently (api-design §59G Part 2)'
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version) THEN
        RAISE EXCEPTION 'depreciation_schedule_version: a recorded version exists; its declared AfA is never dropped silently (api-design §59G Part 2)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`
    ALTER TABLE depreciation_schedule_version_component
      DROP CONSTRAINT depreciation_schedule_version_component_declared_afa,
      DROP COLUMN shorter_life_declared_afa
  `.execute(db);
  await sql`DROP TRIGGER depreciation_asset_useful_life_declared_afa ON depreciation_asset_useful_life`.execute(db);
  await sql`DROP FUNCTION depreciation_asset_useful_life_declared_afa()`.execute(db);
  await sql`
    ALTER TABLE depreciation_asset_useful_life
      DROP CONSTRAINT depreciation_asset_useful_life_declared_afa_array,
      DROP COLUMN declared_afa
  `.execute(db);
}

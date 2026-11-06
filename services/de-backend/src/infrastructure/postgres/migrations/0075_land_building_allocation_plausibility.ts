import { sql, type Kysely } from 'kysely';

/**
 * VC-X-44: the plausibility warning on the land/building allocation (api-design.md §58T; Entscheidung des
 * Projektinhabers, 2026-11-06). On `land_building_allocation`, nullable columns for the comparison (the values of land
 * and building by another method, with their sources) and the reason, with the CHECKs:
 *
 * 1. `…_comparison_complete`: the four comparison columns all `NULL` or all set;
 * 2. `…_comparison_method`: `BMF_TOOL`, `APPRAISAL`, `MARKET_VALUE` or `OTHER`;
 * 3. `…_comparison_values`: both values with at most two decimals, `≥ 0`, `< 1e18`, and their sum `> 0`;
 * 4. `…_comparison_sources`: 1–10 source references;
 * 5. `…_deviation_reason`: 1–2000 characters, and only with a comparison.
 *
 * The currency is the row's `currency`. `land_building_allocation_frozen` (0023) is replaced with the five columns in
 * both tuples, so they never change after the insert. **No backfill**: every existing row has no comparison, so no
 * warning arises from the migration. The flags are derived on read, never stored. `down` is refused while a row carries
 * a comparison (no data dropped silently), then restores 0023's function verbatim and drops the columns.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE land_building_allocation
      ADD COLUMN comparison_method text,
      ADD COLUMN comparison_land_value numeric,
      ADD COLUMN comparison_building_value numeric,
      ADD COLUMN comparison_source_references text[],
      ADD COLUMN deviation_reason text,
      ADD CONSTRAINT land_building_allocation_comparison_complete CHECK (
        (comparison_method IS NULL AND comparison_land_value IS NULL AND comparison_building_value IS NULL AND comparison_source_references IS NULL)
        OR (comparison_method IS NOT NULL AND comparison_land_value IS NOT NULL AND comparison_building_value IS NOT NULL AND comparison_source_references IS NOT NULL)
      ),
      ADD CONSTRAINT land_building_allocation_comparison_method CHECK (comparison_method IN ('BMF_TOOL', 'APPRAISAL', 'MARKET_VALUE', 'OTHER')),
      ADD CONSTRAINT land_building_allocation_comparison_values CHECK (
        comparison_land_value IS NULL OR comparison_building_value IS NULL OR (
        scale(comparison_land_value) <= 2 AND comparison_land_value >= 0 AND comparison_land_value < 1e18
        AND scale(comparison_building_value) <= 2 AND comparison_building_value >= 0 AND comparison_building_value < 1e18
        AND comparison_land_value + comparison_building_value > 0)
      ),
      ADD CONSTRAINT land_building_allocation_comparison_sources CHECK (cardinality(comparison_source_references) BETWEEN 1 AND 10),
      ADD CONSTRAINT land_building_allocation_deviation_reason CHECK (
        deviation_reason IS NULL OR (length(deviation_reason) BETWEEN 1 AND 2000 AND comparison_method IS NOT NULL)
      )
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION land_building_allocation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'LandBuildingAllocation %: never deleted; supersede it instead (api-design §27.3)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.acquisition_id, NEW.total_allocable_amount, NEW.land_amount, NEW.building_amount, NEW.currency,
          NEW.method, NEW.review_state, NEW.effective_date, NEW.advisor_party_id, NEW.source_references, NEW.notes, NEW.supersedes_id,
          NEW.created_at, NEW.created_by, NEW.comparison_method, NEW.comparison_land_value, NEW.comparison_building_value,
          NEW.comparison_source_references, NEW.deviation_reason)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.acquisition_id, OLD.total_allocable_amount, OLD.land_amount, OLD.building_amount, OLD.currency,
          OLD.method, OLD.review_state, OLD.effective_date, OLD.advisor_party_id, OLD.source_references, OLD.notes, OLD.supersedes_id,
          OLD.created_at, OLD.created_by, OLD.comparison_method, OLD.comparison_land_value, OLD.comparison_building_value,
          OLD.comparison_source_references, OLD.deviation_reason) THEN
        RAISE EXCEPTION 'LandBuildingAllocation %: its data never changes; supersede it with a new one (api-design §27.3, §58T)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
        RAISE EXCEPTION 'LandBuildingAllocation %: superseded is final (api-design §27.3)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      carrying uuid;
    BEGIN
      SELECT id INTO carrying FROM land_building_allocation WHERE comparison_method IS NOT NULL OR deviation_reason IS NOT NULL LIMIT 1;
      IF carrying IS NOT NULL THEN
        RAISE EXCEPTION 'LandBuildingAllocation %: carries a comparison; 0075 cannot be rolled back without dropping it (api-design §58T)', carrying
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  // 0023's function, verbatim.
  await sql`
    CREATE OR REPLACE FUNCTION land_building_allocation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'LandBuildingAllocation %: never deleted; supersede it instead (api-design §27.3)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.acquisition_id, NEW.total_allocable_amount, NEW.land_amount, NEW.building_amount, NEW.currency,
          NEW.method, NEW.review_state, NEW.effective_date, NEW.advisor_party_id, NEW.source_references, NEW.notes, NEW.supersedes_id,
          NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.acquisition_id, OLD.total_allocable_amount, OLD.land_amount, OLD.building_amount, OLD.currency,
          OLD.method, OLD.review_state, OLD.effective_date, OLD.advisor_party_id, OLD.source_references, OLD.notes, OLD.supersedes_id,
          OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'LandBuildingAllocation %: its data never changes; supersede it with a new one (api-design §27.3)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
        RAISE EXCEPTION 'LandBuildingAllocation %: superseded is final (api-design §27.3)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    ALTER TABLE land_building_allocation
      DROP CONSTRAINT land_building_allocation_deviation_reason,
      DROP CONSTRAINT land_building_allocation_comparison_sources,
      DROP CONSTRAINT land_building_allocation_comparison_values,
      DROP CONSTRAINT land_building_allocation_comparison_method,
      DROP CONSTRAINT land_building_allocation_comparison_complete,
      DROP COLUMN deviation_reason,
      DROP COLUMN comparison_source_references,
      DROP COLUMN comparison_building_value,
      DROP COLUMN comparison_land_value,
      DROP COLUMN comparison_method
  `.execute(db);
}

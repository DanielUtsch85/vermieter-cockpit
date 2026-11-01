import { sql, type Kysely } from 'kysely';

/**
 * VC-X-37: the method status of a purchase (api-design.md §59C "In the database", data-model §38). §59C plans "migration
 * 0054"; it also says that whichever of §58E's 0053, §59C's 0054 and §59D's 0055 is implemented first takes the lowest
 * free number. This is the first, so it is 0053: Kysely's Migrator refuses a migration named before one already applied.
 *
 * - `up` refuses while any `depreciation_schedule_version` row exists: nothing productive is recorded (the switch has
 *   never been on), and a recorded version without its method columns could not be re-derived. A non-production
 *   database is reset instead.
 * - `depreciation_asset_purchase_method`, as `depreciation_asset_useful_life` (0049): one entry per Acquisition of the
 *   asset's PropertyReference (the composite key to `acquisition`), the facts with CHECKs of their values (the special
 *   depreciations a subset of the four, each once), the note set exactly with `other_special_case`, the evidence, the
 *   review state (never `SUGGESTED`; the advisor only with `ADVISOR_CONFIRMED`), `notes`; an index on `acquisition_id`.
 * - `depreciation_asset_purchase_method_open` (before insert, update or delete), as `depreciation_asset_useful_life_open`:
 *   the PropertyReference written first; only an `ACTIVE` `BUILDING` asset's entries change; an entry is inserted only
 *   for an Acquisition that is not `CANCELLED`, at most 20 per asset; never moved to another asset or Acquisition. The
 *   touch of 0049 fires after it (by name). No column on `depreciation_asset` or `acquisition`; no backfill (§59C open
 *   question 4): the migration creates no entry.
 * - `depreciation_schedule_version_component` (0052) gains the method entry of a purchase component, set exactly for
 *   `kind` `ACQUISITION`, with a CHECK of the standard values and a confirmed state: only a computable component is
 *   recorded (§60 step 4).
 * - `down` refuses while an entry exists (a person's statement is never dropped silently, as 0051 and 0052) or a
 *   recorded version exists (its method columns would be lost); else it drops the table, its functions and the columns.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version) THEN
        RAISE EXCEPTION 'depreciation_schedule_version: recorded versions exist; 0053 (api-design §59C) needs a database without them: reset this non-production database'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);

  await sql`
    CREATE FUNCTION depreciation_purchase_method_special_valid(special text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT array_position(special, NULL) IS NULL
        AND special <@ ARRAY['SPECIAL_7B', 'INCREASED_7H', 'INCREASED_7I', 'OTHER']::text[]
        AND cardinality(special) = (SELECT count(DISTINCT s) FROM unnest(special) AS s)
    $$
  `.execute(db);

  await sql`
    CREATE TABLE depreciation_asset_purchase_method (
      asset_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      property_reference_id uuid NOT NULL,
      acquisition_id uuid NOT NULL,
      consideration text NOT NULL CHECK (consideration IN ('PAID', 'PARTLY_PAID', 'UNPAID')),
      method text NOT NULL CHECK (method IN ('LINEAR_7_4', 'DEGRESSIVE_7_5', 'DEGRESSIVE_7_5A', 'OTHER')),
      special_depreciation text[] NOT NULL CHECK (depreciation_purchase_method_special_valid(special_depreciation)),
      subsidies_received boolean NOT NULL,
      new_building_by_conversion boolean NOT NULL,
      other_special_case boolean NOT NULL,
      other_special_case_note text CHECK (length(other_special_case_note) BETWEEN 1 AND 500),
      evidence_source text NOT NULL CHECK (length(evidence_source) BETWEEN 1 AND 500),
      evidence_date date NOT NULL,
      evidence_document_reference text CHECK (length(evidence_document_reference) BETWEEN 1 AND 500),
      review_state text NOT NULL CHECK (review_state IN ('UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'ADVISOR_CONFIRMED')),
      advisor_party_id uuid,
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      CONSTRAINT depreciation_asset_purchase_method_key PRIMARY KEY (asset_id, acquisition_id),
      CONSTRAINT depreciation_asset_purchase_method_asset_fk FOREIGN KEY (asset_id, mre_realm_id, property_reference_id)
        REFERENCES depreciation_asset (id, mre_realm_id, property_reference_id),
      CONSTRAINT depreciation_asset_purchase_method_acquisition_fk FOREIGN KEY (acquisition_id, mre_realm_id, property_reference_id)
        REFERENCES acquisition (id, mre_realm_id, property_reference_id),
      CONSTRAINT depreciation_asset_purchase_method_advisor_fk FOREIGN KEY (advisor_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT depreciation_asset_purchase_method_advisor_state CHECK (advisor_party_id IS NULL OR review_state = 'ADVISOR_CONFIRMED'),
      CONSTRAINT depreciation_asset_purchase_method_note CHECK (other_special_case = (other_special_case_note IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX depreciation_asset_purchase_method_acquisition_idx ON depreciation_asset_purchase_method (acquisition_id)`.execute(db);

  await sql`
    CREATE FUNCTION depreciation_asset_purchase_method_open() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      entry record;
      asset_status text;
      asset_kind text;
      acquisition_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        entry := OLD;
      ELSE
        entry := NEW;
      END IF;
      -- The PropertyReference first, as depreciation_asset_touch (which fires after this guard, by name), and on a delete.
      UPDATE property_reference SET version = version WHERE id = entry.property_reference_id;
      SELECT status, asset_type INTO asset_status, asset_kind FROM depreciation_asset WHERE id = entry.asset_id;
      IF asset_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'DepreciationAsset %: % takes no change of its purchase methods (ASSET_NOT_ACTIVE)', entry.asset_id, coalesce(asset_status, 'unknown')
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF asset_kind IS DISTINCT FROM 'BUILDING' THEN
        RAISE EXCEPTION 'DepreciationAsset %: a % has no purchase method entry (api-design §59C)', entry.asset_id, asset_kind
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'UPDATE'
         AND (NEW.asset_id, NEW.mre_realm_id, NEW.property_reference_id, NEW.acquisition_id) IS DISTINCT FROM
             (OLD.asset_id, OLD.mre_realm_id, OLD.property_reference_id, OLD.acquisition_id) THEN
        RAISE EXCEPTION 'DepreciationAsset %: a purchase method entry never moves to another asset or Acquisition', OLD.asset_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'INSERT' THEN
        SELECT status INTO acquisition_status FROM acquisition WHERE id = NEW.acquisition_id;
        IF acquisition_status = 'CANCELLED' THEN
          RAISE EXCEPTION 'DepreciationAsset %: Acquisition % is CANCELLED (ACQUISITION_CANCELLED)', NEW.asset_id, NEW.acquisition_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (SELECT count(*) FROM depreciation_asset_purchase_method WHERE asset_id = NEW.asset_id) >= 20 THEN
          RAISE EXCEPTION 'DepreciationAsset %: at most 20 purchase method entries (api-design §59C)', NEW.asset_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      RETURN entry;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER depreciation_asset_purchase_method_open BEFORE INSERT OR UPDATE OR DELETE ON depreciation_asset_purchase_method
      FOR EACH ROW EXECUTE FUNCTION depreciation_asset_purchase_method_open()
  `.execute(db);
  await sql`
    CREATE TRIGGER depreciation_asset_purchase_method_touch BEFORE INSERT OR UPDATE ON depreciation_asset_purchase_method
      FOR EACH ROW EXECUTE FUNCTION depreciation_asset_touch()
  `.execute(db);

  await sql`
    ALTER TABLE depreciation_schedule_version_component
      ADD COLUMN method_consideration text,
      ADD COLUMN method text,
      ADD COLUMN method_special_depreciation text[],
      ADD COLUMN method_subsidies_received boolean,
      ADD COLUMN method_new_building_by_conversion boolean,
      ADD COLUMN method_other_special_case boolean,
      ADD COLUMN method_review_state text,
      ADD CONSTRAINT depreciation_schedule_version_component_method CHECK (
        CASE kind
          -- coalesce: a missing value is false here, never the NULL a CHECK would let pass.
          WHEN 'ACQUISITION' THEN coalesce(method_consideration = 'PAID' AND method = 'LINEAR_7_4' AND method_special_depreciation = '{}'::text[]
            AND method_subsidies_received = false AND method_new_building_by_conversion = false AND method_other_special_case = false
            AND method_review_state IN ('CONFIRMED', 'ADVISOR_CONFIRMED'), false)
          ELSE (method_consideration, method, method_special_depreciation, method_subsidies_received, method_new_building_by_conversion,
            method_other_special_case, method_review_state) IS NULL
        END
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is dropped: a person's statement and a recorded version are never dropped silently.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM depreciation_asset_purchase_method) THEN
        RAISE EXCEPTION 'depreciation_asset_purchase_method: an entry exists; it is never dropped silently (api-design §59C)' USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version) THEN
        RAISE EXCEPTION 'depreciation_schedule_version: a recorded version exists; its method columns are never dropped silently (api-design §59C)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`
    ALTER TABLE depreciation_schedule_version_component
      DROP CONSTRAINT depreciation_schedule_version_component_method,
      DROP COLUMN method_consideration,
      DROP COLUMN method,
      DROP COLUMN method_special_depreciation,
      DROP COLUMN method_subsidies_received,
      DROP COLUMN method_new_building_by_conversion,
      DROP COLUMN method_other_special_case,
      DROP COLUMN method_review_state
  `.execute(db);
  await sql`DROP TABLE depreciation_asset_purchase_method`.execute(db);
  await sql`DROP FUNCTION depreciation_asset_purchase_method_open()`.execute(db);
  await sql`DROP FUNCTION depreciation_purchase_method_special_valid(text[])`.execute(db);
}

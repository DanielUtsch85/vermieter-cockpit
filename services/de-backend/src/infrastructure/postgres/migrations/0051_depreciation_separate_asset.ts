import { sql, type Kysely } from 'kysely';

/**
 * VC-8-03: separate assets and their capitalised items (api-design.md §59B, phase-8-plan P8-D7 option 1, data-model §38).
 *
 * - `depreciation_asset` (0049's table, widened; every existing row stays valid): `asset_type` `SEPARATE_ASSET` beside
 *   `BUILDING`, `depreciation_method` `LINEAR_7_1` beside `LINEAR_7_4`, each type with its own method; the separate
 *   asset's `description` (1–200), `useful_life_years` (1–99), `useful_life_basis` (1–500) and `acquired_on`, all four
 *   set exactly on a `SEPARATE_ASSET` row, and `building_completion_year` only on a `BUILDING` row; 0049's "confirmed
 *   only with a completion year" for buildings only; `UNIQUE (id, mre_realm_id, property_reference_id, status)` as the
 *   links' key. Still no column for a basis, a cost, a rate, a start, an amount, an Acquisition or a rule.
 * - `depreciation_asset_item`: the links, as rows. The composite foreign key with the asset's `status` is
 *   `ON UPDATE CASCADE`, so a void carries `VOID` into every link without a second writer and frees the item.
 *   `depreciation_asset_item_active`: an item in at most one `ACTIVE` asset (P8-D7).
 * - `depreciation_asset_item_guard` (before insert, update, delete): the PropertyReference first (the lock order of
 *   every writer of it); an insert or a delete only on an `ACTIVE` separate asset; an update only the cascade of a void;
 *   on insert the source exists in the Realm and on the PropertyReference (a split; a statement's reserve line of kind
 *   `WITHDRAWAL`; an assessment's use), at most 50 per asset. Whether the item is `CAPITALIZED` is Taxation's
 *   derivation and is checked by the repository, not here.
 * - `depreciation_asset_frozen` (0049) also keeps the separate asset's fields on a void; `depreciation_asset_useful_life_open`
 *   (0049) refuses a shorter useful life on a separate asset.
 * - `down` drops the links and restores 0049's CHECKs and functions; with a `SEPARATE_ASSET` row the restored CHECK
 *   refuses it and `down` fails: a separate asset is never dropped silently.
 */

const frozen = (separate: boolean) =>
  sql.raw(`
    CREATE OR REPLACE FUNCTION depreciation_asset_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'DepreciationAsset %: never deleted; void it instead (api-design §59)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.property_reference_id, NEW.asset_type, NEW.depreciation_method, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.property_reference_id, OLD.asset_type, OLD.depreciation_method, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'DepreciationAsset %: PropertyReference, type, method and creation never change; void and create instead (api-design §59)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- A no-op write (any write leaving the row as it is) passes.
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'VOID' THEN
        RAISE EXCEPTION 'DepreciationAsset %: VOID is final (api-design §59)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status = 'VOID'
         AND (NEW.building_completion_year, NEW.source_references, NEW.review_state, NEW.advisor_party_id, NEW.notes${
           separate ? ',\n              NEW.description, NEW.useful_life_years, NEW.useful_life_basis, NEW.acquired_on' : ''
         })
             IS DISTINCT FROM (OLD.building_completion_year, OLD.source_references, OLD.review_state, OLD.advisor_party_id, OLD.notes${
               separate ? ',\n              OLD.description, OLD.useful_life_years, OLD.useful_life_basis, OLD.acquired_on' : ''
             }) THEN
        RAISE EXCEPTION 'DepreciationAsset %: a void changes nothing else', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'DepreciationAsset %: every change raises version by exactly one (% → %)', OLD.id, OLD.version, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `);

const usefulLifeOpen = (separate: boolean) =>
  sql.raw(`
    CREATE OR REPLACE FUNCTION depreciation_asset_useful_life_open() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      entry record;
      asset_status text;
      acquisition_status text;${separate ? '\n      asset_kind text;' : ''}
    BEGIN
      IF TG_OP = 'DELETE' THEN
        entry := OLD;
      ELSE
        entry := NEW;
      END IF;
      -- The PropertyReference first, as depreciation_asset_touch (which fires after this guard, by name), and on a delete.
      UPDATE property_reference SET version = version WHERE id = entry.property_reference_id;
      SELECT status${separate ? ', asset_type' : ''} INTO asset_status${separate ? ', asset_kind' : ''} FROM depreciation_asset WHERE id = entry.asset_id;
      IF asset_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'DepreciationAsset %: % takes no change of its shorter useful lives (ASSET_NOT_ACTIVE)', entry.asset_id, coalesce(asset_status, 'unknown')
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'UPDATE'
         AND (NEW.asset_id, NEW.mre_realm_id, NEW.property_reference_id, NEW.acquisition_id) IS DISTINCT FROM
             (OLD.asset_id, OLD.mre_realm_id, OLD.property_reference_id, OLD.acquisition_id) THEN
        RAISE EXCEPTION 'DepreciationAsset %: an entry never moves to another asset or Acquisition', OLD.asset_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'INSERT' THEN${
        separate
          ? `
        IF asset_kind <> 'BUILDING' THEN
          RAISE EXCEPTION 'DepreciationAsset %: a % has no shorter useful life of § 7 Abs. 4 S. 2 EStG (api-design §59B)', NEW.asset_id, asset_kind
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;`
          : ''
      }
        SELECT status INTO acquisition_status FROM acquisition WHERE id = NEW.acquisition_id;
        IF acquisition_status = 'CANCELLED' THEN
          RAISE EXCEPTION 'DepreciationAsset %: Acquisition % is CANCELLED (ACQUISITION_CANCELLED)', NEW.asset_id, NEW.acquisition_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (SELECT count(*) FROM depreciation_asset_useful_life WHERE asset_id = NEW.asset_id) >= 20 THEN
          RAISE EXCEPTION 'DepreciationAsset %: at most 20 shorter useful lives (api-design §59)', NEW.asset_id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      RETURN entry;
    END $$
  `);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE depreciation_asset
      DROP CONSTRAINT depreciation_asset_asset_type_check,
      DROP CONSTRAINT depreciation_asset_depreciation_method_check,
      DROP CONSTRAINT depreciation_asset_confirmed_year,
      ADD COLUMN description text CHECK (length(description) BETWEEN 1 AND 200),
      ADD COLUMN useful_life_years integer CHECK (useful_life_years BETWEEN 1 AND 99),
      ADD COLUMN useful_life_basis text CHECK (length(useful_life_basis) BETWEEN 1 AND 500),
      ADD COLUMN acquired_on date,
      ADD CONSTRAINT depreciation_asset_asset_type_check CHECK (asset_type IN ('BUILDING', 'SEPARATE_ASSET')),
      ADD CONSTRAINT depreciation_asset_depreciation_method_check CHECK (depreciation_method IN ('LINEAR_7_4', 'LINEAR_7_1')),
      ADD CONSTRAINT depreciation_asset_type_method CHECK ((asset_type = 'BUILDING') = (depreciation_method = 'LINEAR_7_4')),
      ADD CONSTRAINT depreciation_asset_type_fields CHECK (
        CASE asset_type
          WHEN 'SEPARATE_ASSET' THEN description IS NOT NULL AND useful_life_years IS NOT NULL AND useful_life_basis IS NOT NULL
                                     AND acquired_on IS NOT NULL AND building_completion_year IS NULL
          ELSE description IS NULL AND useful_life_years IS NULL AND useful_life_basis IS NULL AND acquired_on IS NULL
        END
      ),
      ADD CONSTRAINT depreciation_asset_texts CHECK (depreciation_asset_texts_valid(ARRAY[description, useful_life_basis])),
      ADD CONSTRAINT depreciation_asset_confirmed_year
        CHECK (asset_type <> 'BUILDING' OR review_state NOT IN ('CONFIRMED', 'ADVISOR_CONFIRMED') OR building_completion_year IS NOT NULL),
      ADD CONSTRAINT depreciation_asset_item_key UNIQUE (id, mre_realm_id, property_reference_id, status)
  `.execute(db);
  await frozen(true).execute(db);
  await usefulLifeOpen(true).execute(db);

  await sql`
    CREATE TABLE depreciation_asset_item (
      asset_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      property_reference_id uuid NOT NULL,
      asset_status text NOT NULL CHECK (asset_status IN ('ACTIVE', 'VOID')),
      source_type text NOT NULL CHECK (source_type IN ('TRANSACTION_SPLIT', 'WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE')),
      source_id uuid NOT NULL,
      source_position integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      CONSTRAINT depreciation_asset_item_position CHECK (
        CASE WHEN source_type = 'TRANSACTION_SPLIT' THEN source_position IS NULL ELSE source_position BETWEEN 1 AND 1000 END
      ),
      CONSTRAINT depreciation_asset_item_asset_fk FOREIGN KEY (asset_id, mre_realm_id, property_reference_id, asset_status)
        REFERENCES depreciation_asset (id, mre_realm_id, property_reference_id, status) ON UPDATE CASCADE
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX depreciation_asset_item_once ON depreciation_asset_item (asset_id, source_type, source_id, coalesce(source_position, 0))
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX depreciation_asset_item_active ON depreciation_asset_item (mre_realm_id, source_type, source_id, coalesce(source_position, 0))
      WHERE asset_status = 'ACTIVE'
  `.execute(db);
  await sql`
    CREATE INDEX depreciation_asset_item_property_reference_idx ON depreciation_asset_item (property_reference_id) WHERE asset_status = 'ACTIVE'
  `.execute(db);

  await sql`
    CREATE FUNCTION depreciation_asset_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      link record;
      a record;
      found boolean;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        link := OLD;
      ELSE
        link := NEW;
      END IF;
      -- The PropertyReference first: the lock order of every writer of it (§26.1, §28.1, §59).
      UPDATE property_reference SET version = version WHERE id = link.property_reference_id;
      IF TG_OP = 'UPDATE' THEN
        -- Only the cascade of a void (0051's foreign key): ACTIVE → VOID, nothing else.
        IF NOT (OLD.asset_status = 'ACTIVE' AND NEW.asset_status = 'VOID')
           OR (NEW.asset_id, NEW.mre_realm_id, NEW.property_reference_id, NEW.source_type, NEW.source_id, NEW.source_position, NEW.created_at, NEW.created_by)
              IS DISTINCT FROM
              (OLD.asset_id, OLD.mre_realm_id, OLD.property_reference_id, OLD.source_type, OLD.source_id, OLD.source_position, OLD.created_at, OLD.created_by) THEN
          RAISE EXCEPTION 'DepreciationAsset %: a link changes only by the void of its asset (api-design §59B)', OLD.asset_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END IF;
      SELECT status, asset_type INTO a FROM depreciation_asset WHERE id = link.asset_id;
      IF a.status IS DISTINCT FROM 'ACTIVE' OR a.asset_type IS DISTINCT FROM 'SEPARATE_ASSET' THEN
        RAISE EXCEPTION 'DepreciationAsset %: items are linked or unlinked only on an ACTIVE separate asset (ASSET_NOT_ACTIVE)', link.asset_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      IF NEW.source_type = 'TRANSACTION_SPLIT' THEN
        found := EXISTS (SELECT 1 FROM transaction_split s
                          WHERE s.id = NEW.source_id AND s.mre_realm_id = NEW.mre_realm_id AND s.property_reference_id = NEW.property_reference_id);
      ELSIF NEW.source_type = 'WEG_RESERVE_WITHDRAWAL' THEN
        found := EXISTS (SELECT 1 FROM weg_annual_statement st JOIN weg_membership m ON m.id = st.membership_id
                          CROSS JOIN LATERAL jsonb_array_elements(coalesce(st.reserve -> 'lines', '[]'::jsonb)) AS l
                          WHERE st.id = NEW.source_id AND st.mre_realm_id = NEW.mre_realm_id AND m.property_reference_id = NEW.property_reference_id
                            AND (l ->> 'position')::integer = NEW.source_position AND l ->> 'kind' = 'WITHDRAWAL');
      ELSE
        found := EXISTS (SELECT 1 FROM weg_special_assessment sa JOIN weg_membership m ON m.id = sa.membership_id
                          CROSS JOIN LATERAL jsonb_array_elements(sa.uses) AS u
                          WHERE sa.id = NEW.source_id AND sa.mre_realm_id = NEW.mre_realm_id AND m.property_reference_id = NEW.property_reference_id
                            AND (u ->> 'position')::integer = NEW.source_position);
      END IF;
      IF NOT found THEN
        RAISE EXCEPTION 'DepreciationAsset %: % % (position %) is no source of this Realm and PropertyReference (api-design §59B)',
          NEW.asset_id, NEW.source_type, NEW.source_id, NEW.source_position USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (SELECT count(*) FROM depreciation_asset_item WHERE asset_id = NEW.asset_id) >= 50 THEN
        RAISE EXCEPTION 'DepreciationAsset %: at most 50 items (api-design §59B)', NEW.asset_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER depreciation_asset_item_guard BEFORE INSERT OR UPDATE OR DELETE ON depreciation_asset_item
      FOR EACH ROW EXECUTE FUNCTION depreciation_asset_item_guard()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is dropped (a direct call is not one transaction): a separate asset is never dropped silently.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM depreciation_asset WHERE asset_type = 'SEPARATE_ASSET') THEN
        RAISE EXCEPTION 'depreciation_asset: a SEPARATE_ASSET row exists; 0049 cannot hold it (api-design §59B)' USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP TABLE depreciation_asset_item`.execute(db);
  await sql`DROP FUNCTION depreciation_asset_item_guard()`.execute(db);
  // The restored CHECKs before the columns are dropped: they would refuse a SEPARATE_ASSET row all the same.
  await sql`
    ALTER TABLE depreciation_asset
      DROP CONSTRAINT depreciation_asset_item_key,
      DROP CONSTRAINT depreciation_asset_confirmed_year,
      DROP CONSTRAINT depreciation_asset_texts,
      DROP CONSTRAINT depreciation_asset_type_fields,
      DROP CONSTRAINT depreciation_asset_type_method,
      DROP CONSTRAINT depreciation_asset_depreciation_method_check,
      DROP CONSTRAINT depreciation_asset_asset_type_check,
      ADD CONSTRAINT depreciation_asset_asset_type_check CHECK (asset_type IN ('BUILDING')),
      ADD CONSTRAINT depreciation_asset_depreciation_method_check CHECK (depreciation_method IN ('LINEAR_7_4')),
      ADD CONSTRAINT depreciation_asset_confirmed_year CHECK (review_state NOT IN ('CONFIRMED', 'ADVISOR_CONFIRMED') OR building_completion_year IS NOT NULL)
  `.execute(db);
  await frozen(false).execute(db);
  await usefulLifeOpen(false).execute(db);
  await sql`
    ALTER TABLE depreciation_asset
      DROP COLUMN acquired_on,
      DROP COLUMN useful_life_basis,
      DROP COLUMN useful_life_years,
      DROP COLUMN description
  `.execute(db);
}

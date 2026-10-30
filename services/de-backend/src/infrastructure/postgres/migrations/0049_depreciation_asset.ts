import { sql, type Kysely } from 'kysely';

/**
 * VC-8-01: the DepreciationAsset (data-model.md §38, api-design.md §59, phase-8-plan P8-D1, P8-D4, P8-D14).
 *
 * - `depreciation_asset`: Realm-bound; the PropertyReference and the advisor by composite foreign key; `BUILDING` only
 *   (VC-8-03 widens the CHECK); the completion year (1000–2100, or `null` while unknown), its sources, the method
 *   `LINEAR_7_4`, the review state (never `SUGGESTED`; the advisor only with `ADVISOR_CONFIRMED`; a confirmed state only
 *   with a completion year); `VOID` exactly with its time and reason. No column for a basis, rate, start, amount,
 *   allocation, Acquisition or rule: those are derived (§59A). One `ACTIVE` building per PropertyReference.
 * - `depreciation_asset_useful_life`: the shorter useful lives as rows, one per Acquisition of the asset's
 *   PropertyReference (the composite key to `acquisition_ownership_key` of 0020 holds it to that PropertyReference).
 * - `depreciation_asset_touch` (before insert or update, on both tables): first a no-op write of the PropertyReference
 *   row, the lock order of every writer of it (§26.1, §28.1).
 * - `depreciation_asset_frozen` (before update or delete): PropertyReference, type, method, creation and id never
 *   change; `VOID` is final; every change raises `version` by one; the no-op passes; never deleted.
 * - `depreciation_asset_useful_life_open` (before insert, update or delete): only an `ACTIVE` asset's entries change, an
 *   entry's keys never, and an entry is inserted only for an Acquisition that is not `CANCELLED`, at most 20 per asset.
 *   So the repository writes an amend's entries as a difference: an unchanged entry is never re-inserted (§59).
 * - `depreciation_asset_initial` (before insert): `ACTIVE`, `version` 1, not voided.
 * - `down` drops both tables and their functions; nothing else changes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Its own text check (each 1–500), as 0045's: Depreciation does not depend on another domain's function.
  await sql`
    CREATE FUNCTION depreciation_asset_texts_valid(texts text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT coalesce(bool_and(length(t) BETWEEN 1 AND 500), true) FROM unnest(texts) AS t
    $$
  `.execute(db);
  await sql`
    CREATE TABLE depreciation_asset (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      property_reference_id uuid NOT NULL,
      asset_type text NOT NULL CHECK (asset_type IN ('BUILDING')),
      status text NOT NULL CHECK (status IN ('ACTIVE', 'VOID')),
      building_completion_year integer CHECK (building_completion_year BETWEEN 1000 AND 2100),
      source_references text[] NOT NULL DEFAULT '{}'
        CHECK (cardinality(source_references) <= 20 AND array_position(source_references, NULL) IS NULL AND depreciation_asset_texts_valid(source_references)),
      depreciation_method text NOT NULL CHECK (depreciation_method IN ('LINEAR_7_4')),
      review_state text NOT NULL CHECK (review_state IN ('UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'ADVISOR_CONFIRMED')),
      advisor_party_id uuid,
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      voided_at timestamptz,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT depreciation_asset_property_reference_fk FOREIGN KEY (property_reference_id, mre_realm_id) REFERENCES property_reference (id, mre_realm_id),
      CONSTRAINT depreciation_asset_advisor_fk FOREIGN KEY (advisor_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT depreciation_asset_advisor_state CHECK (advisor_party_id IS NULL OR review_state = 'ADVISOR_CONFIRMED'),
      CONSTRAINT depreciation_asset_confirmed_year CHECK (review_state NOT IN ('CONFIRMED', 'ADVISOR_CONFIRMED') OR building_completion_year IS NOT NULL),
      CONSTRAINT depreciation_asset_void_fields CHECK ((status = 'VOID') = (voided_at IS NOT NULL) AND (status = 'VOID') = (void_reason IS NOT NULL)),
      CONSTRAINT depreciation_asset_entry_key UNIQUE (id, mre_realm_id, property_reference_id)
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX depreciation_asset_building_active ON depreciation_asset (property_reference_id) WHERE asset_type = 'BUILDING' AND status = 'ACTIVE'
  `.execute(db);
  await sql`CREATE INDEX depreciation_asset_property_reference_idx ON depreciation_asset (property_reference_id, asset_type, created_at, id)`.execute(db);

  await sql`
    CREATE TABLE depreciation_asset_useful_life (
      asset_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      property_reference_id uuid NOT NULL,
      acquisition_id uuid NOT NULL,
      useful_life_years integer NOT NULL CHECK (useful_life_years BETWEEN 1 AND 99),
      evidence_source text NOT NULL CHECK (length(evidence_source) BETWEEN 1 AND 500),
      evidence_date date NOT NULL,
      evidence_document_reference text CHECK (length(evidence_document_reference) BETWEEN 1 AND 500),
      review_state text NOT NULL CHECK (review_state IN ('UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'ADVISOR_CONFIRMED')),
      advisor_party_id uuid,
      CONSTRAINT depreciation_asset_useful_life_key PRIMARY KEY (asset_id, acquisition_id),
      CONSTRAINT depreciation_asset_useful_life_asset_fk FOREIGN KEY (asset_id, mre_realm_id, property_reference_id)
        REFERENCES depreciation_asset (id, mre_realm_id, property_reference_id),
      CONSTRAINT depreciation_asset_useful_life_acquisition_fk FOREIGN KEY (acquisition_id, mre_realm_id, property_reference_id)
        REFERENCES acquisition (id, mre_realm_id, property_reference_id),
      CONSTRAINT depreciation_asset_useful_life_advisor_fk FOREIGN KEY (advisor_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT depreciation_asset_useful_life_advisor_state CHECK (advisor_party_id IS NULL OR review_state = 'ADVISOR_CONFIRMED')
    )
  `.execute(db);
  await sql`CREATE INDEX depreciation_asset_useful_life_acquisition_idx ON depreciation_asset_useful_life (acquisition_id)`.execute(db);

  await sql`
    CREATE FUNCTION depreciation_asset_touch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER depreciation_asset_touch BEFORE INSERT OR UPDATE ON depreciation_asset FOR EACH ROW EXECUTE FUNCTION depreciation_asset_touch()
  `.execute(db);
  await sql`
    CREATE TRIGGER depreciation_asset_useful_life_touch BEFORE INSERT OR UPDATE ON depreciation_asset_useful_life
      FOR EACH ROW EXECUTE FUNCTION depreciation_asset_touch()
  `.execute(db);

  await sql`
    CREATE FUNCTION depreciation_asset_initial() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status <> 'ACTIVE' OR NEW.version <> 1 OR NEW.voided_at IS NOT NULL OR NEW.void_reason IS NOT NULL THEN
        RAISE EXCEPTION 'DepreciationAsset: only inserted ACTIVE with version 1, not % / % (api-design §59)', NEW.status, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER depreciation_asset_initial BEFORE INSERT ON depreciation_asset FOR EACH ROW EXECUTE FUNCTION depreciation_asset_initial()`.execute(
    db,
  );

  await sql`
    CREATE FUNCTION depreciation_asset_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
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
         AND (NEW.building_completion_year, NEW.source_references, NEW.review_state, NEW.advisor_party_id, NEW.notes)
             IS DISTINCT FROM (OLD.building_completion_year, OLD.source_references, OLD.review_state, OLD.advisor_party_id, OLD.notes) THEN
        RAISE EXCEPTION 'DepreciationAsset %: a void changes nothing else', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'DepreciationAsset %: every change raises version by exactly one (% → %)', OLD.id, OLD.version, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER depreciation_asset_frozen BEFORE UPDATE OR DELETE ON depreciation_asset FOR EACH ROW EXECUTE FUNCTION depreciation_asset_frozen()
  `.execute(db);

  await sql`
    CREATE FUNCTION depreciation_asset_useful_life_open() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      entry record;
      asset_status text;
      acquisition_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        entry := OLD;
      ELSE
        entry := NEW;
      END IF;
      -- The PropertyReference first, as depreciation_asset_touch (which fires after this guard, by name), and on a delete.
      UPDATE property_reference SET version = version WHERE id = entry.property_reference_id;
      SELECT status INTO asset_status FROM depreciation_asset WHERE id = entry.asset_id;
      IF asset_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'DepreciationAsset %: % takes no change of its shorter useful lives (ASSET_NOT_ACTIVE)', entry.asset_id, coalesce(asset_status, 'unknown')
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'UPDATE'
         AND (NEW.asset_id, NEW.mre_realm_id, NEW.property_reference_id, NEW.acquisition_id) IS DISTINCT FROM
             (OLD.asset_id, OLD.mre_realm_id, OLD.property_reference_id, OLD.acquisition_id) THEN
        RAISE EXCEPTION 'DepreciationAsset %: an entry never moves to another asset or Acquisition', OLD.asset_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'INSERT' THEN
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
  `.execute(db);
  await sql`
    CREATE TRIGGER depreciation_asset_useful_life_open BEFORE INSERT OR UPDATE OR DELETE ON depreciation_asset_useful_life
      FOR EACH ROW EXECUTE FUNCTION depreciation_asset_useful_life_open()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE depreciation_asset_useful_life`.execute(db);
  await sql`DROP TABLE depreciation_asset`.execute(db);
  await sql`DROP FUNCTION depreciation_asset_useful_life_open()`.execute(db);
  await sql`DROP FUNCTION depreciation_asset_frozen()`.execute(db);
  await sql`DROP FUNCTION depreciation_asset_initial()`.execute(db);
  await sql`DROP FUNCTION depreciation_asset_touch()`.execute(db);
  await sql`DROP FUNCTION depreciation_asset_texts_valid(text[])`.execute(db);
}

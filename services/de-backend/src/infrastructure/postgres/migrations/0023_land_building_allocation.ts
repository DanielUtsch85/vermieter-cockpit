import { sql, type Kysely } from 'kysely';

/**
 * VC-2-08: land/building allocation as entered, versioned (data-model.md §15, api-design.md §27.3, P2-D9).
 *
 * - `land_building_allocation`: of an Acquisition of the same Realm, with an advisor of the Realm; amounts with at
 *   most two decimals in EUR, total > 0, land and building ≥ 0, `land + building = total` exactly (CHECK).
 * - At most one current allocation per Acquisition (`land_building_allocation_current`, a partial unique index, which
 *   cannot be deferred). So a supersede writes the old row's `superseded_at` first and then inserts the new one with
 *   `supersedes_id`; there is no stored back-pointer, the successor is derived (review on #52).
 * - The chain stays in one Acquisition (`supersedes_id` references `(id, acquisition_id)`) and is linear (`supersedes_id`
 *   unique). `land_building_allocation_chain`, a deferred constraint trigger, checks at commit both directions for
 *   every row written: a superseded row has a successor, and a successor names a superseded row.
 * - `land_building_allocation_frozen`: data never changes and rows are never deleted; the only step is setting
 *   `superseded_at`, once. `land_building_allocation_insert`: a row is only inserted current, and only for an
 *   Acquisition that is not `CANCELLED` (its row written first by `acquisition_touch_open` of 0021, so inserts
 *   serialise with cancel, confirm and cost or payment writes).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE land_building_allocation (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      acquisition_id uuid NOT NULL,
      total_allocable_amount numeric NOT NULL CHECK (scale(total_allocable_amount) <= 2 AND total_allocable_amount > 0 AND total_allocable_amount < 1e18),
      land_amount numeric NOT NULL CHECK (scale(land_amount) <= 2 AND land_amount >= 0 AND land_amount < 1e18),
      building_amount numeric NOT NULL CHECK (scale(building_amount) <= 2 AND building_amount >= 0 AND building_amount < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      method text NOT NULL CHECK (method IN ('PURCHASE_CONTRACT', 'BMF_TOOL', 'APPRAISAL', 'ADVISOR', 'OTHER')),
      review_state text NOT NULL CHECK (review_state IN ('UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'ADVISOR_CONFIRMED')),
      effective_date date NOT NULL,
      advisor_party_id uuid,
      source_references text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_references) <= 10),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      supersedes_id uuid,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      CONSTRAINT land_building_allocation_acquisition_fk FOREIGN KEY (acquisition_id, mre_realm_id) REFERENCES acquisition (id, mre_realm_id),
      CONSTRAINT land_building_allocation_advisor_fk FOREIGN KEY (advisor_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT land_building_allocation_chain_key UNIQUE (id, acquisition_id),
      CONSTRAINT land_building_allocation_supersedes_fk FOREIGN KEY (supersedes_id, acquisition_id)
        REFERENCES land_building_allocation (id, acquisition_id),
      CONSTRAINT land_building_allocation_supersedes_key UNIQUE (supersedes_id),
      CONSTRAINT land_building_allocation_sum CHECK (land_amount + building_amount = total_allocable_amount)
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX land_building_allocation_current ON land_building_allocation (acquisition_id) WHERE superseded_at IS NULL`.execute(db);
  await sql`CREATE INDEX land_building_allocation_acquisition_idx ON land_building_allocation (acquisition_id, created_at DESC, id)`.execute(db);

  await sql`
    CREATE FUNCTION land_building_allocation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
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
    CREATE TRIGGER land_building_allocation_frozen BEFORE UPDATE OR DELETE ON land_building_allocation
      FOR EACH ROW EXECUTE FUNCTION land_building_allocation_frozen()
  `.execute(db);

  await sql`
    CREATE FUNCTION land_building_allocation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.superseded_at IS NOT NULL THEN
        RAISE EXCEPTION 'LandBuildingAllocation: only inserted current, never superseded (api-design §27.3)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      PERFORM acquisition_touch_open(NEW.acquisition_id);
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER land_building_allocation_insert BEFORE INSERT ON land_building_allocation
      FOR EACH ROW EXECUTE FUNCTION land_building_allocation_insert()
  `.execute(db);

  await sql`
    CREATE FUNCTION land_building_allocation_chain() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      row record;
    BEGIN
      SELECT id, superseded_at, supersedes_id INTO row FROM land_building_allocation WHERE id = NEW.id;
      IF row.superseded_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM land_building_allocation s WHERE s.supersedes_id = row.id) THEN
        RAISE EXCEPTION 'LandBuildingAllocation %: superseded without a successor (api-design §27.3)', row.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF row.supersedes_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM land_building_allocation p WHERE p.id = row.supersedes_id AND p.superseded_at IS NOT NULL) THEN
        RAISE EXCEPTION 'LandBuildingAllocation %: supersedes % which is still current (api-design §27.3)', row.id, row.supersedes_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER land_building_allocation_chain AFTER INSERT OR UPDATE ON land_building_allocation
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION land_building_allocation_chain()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE land_building_allocation`.execute(db);
  await sql`DROP FUNCTION land_building_allocation_chain()`.execute(db);
  await sql`DROP FUNCTION land_building_allocation_insert()`.execute(db);
  await sql`DROP FUNCTION land_building_allocation_frozen()`.execute(db);
}

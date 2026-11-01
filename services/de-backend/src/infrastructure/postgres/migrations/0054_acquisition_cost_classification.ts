import { sql, type Kysely } from 'kysely';

/**
 * VC-X-42: acquisition costs in the basis only when classified (api-design.md §59D "Concurrency and the database",
 * data-model `AcquisitionCostClassification`; tax review of 2026-11-01, questions 10 and 24, mündlich bestätigt durch den
 * Steuerberater, laut Projektinhaber am 2026-11-01). §59D planned "migration 0055"; 0053 is §59C's, and the next free
 * number is taken by whichever is implemented next (Kysely's Migrator refuses a name sorting before an applied one), so
 * this is 0054 and §58E moves to 0055.
 *
 * - `up` refuses while any `depreciation_schedule_version` row exists (as 0053): nothing productive is recorded, and a
 *   recorded version without its classification ids could not be re-derived. A non-production database is reset instead.
 * - `acquisition_cost_classification`: of one cost of the Acquisition (`(cost_id, acquisition_id)` to `acquisition_cost`'s
 *   `UNIQUE (id, acquisition_id)`), of the Realm (`(acquisition_id, mre_realm_id)`), with an advisor of the Realm and only
 *   with `ADVISOR_CONFIRMED`; never `SUGGESTED`. At most one current per cost (`…_current`, a partial unique index); the
 *   chain stays with the cost (`(supersedes_id, cost_id)`) and is linear (`supersedes_id` unique).
 * - `acquisition_cost_classification_part`: 1–5 parts by `position`, `purpose` one of three, `amount` > 0 with scale 2.
 * - Guards: `…_insert` (only inserted current, `created_txid` the transaction's; the Acquisition's row written first and
 *   a `CANCELLED` one refused by 0021's `acquisition_touch_open`; the cost `ACTIVE`, else `COST_VOID`), `…_frozen` (data
 *   never changes, only `superseded_at`, once; never deleted), `…_chain` (deferred, as 0023's: a superseded row has a
 *   successor, a successor names a superseded row), `…_parts` (deferred: at commit the parts sum exactly to the cost's
 *   amount, and a `FINANCING_RELATED` cost has `FINANCING` parts only), `…_part_append_only` (a part is inserted only by
 *   its classification's own transaction, read from `created_txid`; never changed or deleted).
 * - No column on `acquisition_cost`; no backfill (§59D open question 4): the migration creates no classification.
 * - `depreciation_schedule_version_component` (0052) gains `cost_classification_ids`, set exactly for `kind`
 *   `ACQUISITION` (without a NULL element), unset for the others.
 * - `down` refuses while a classification or a recorded version exists (never dropped silently, as 0053); else it
 *   drops the column, both tables and their functions.
 */
const PURPOSES = `'OWNERSHIP_TRANSFER', 'FINANCING', 'NOT_ACQUISITION_COST'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version) THEN
        RAISE EXCEPTION 'depreciation_schedule_version: recorded versions exist; 0054 (api-design §59D) needs a database without them: reset this non-production database'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);

  await sql`
    CREATE TABLE acquisition_cost_classification (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      acquisition_id uuid NOT NULL,
      cost_id uuid NOT NULL,
      description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
      source_references text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_references) <= 10),
      review_state text NOT NULL CHECK (review_state IN ('UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'ADVISOR_CONFIRMED')),
      advisor_party_id uuid,
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      supersedes_id uuid,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      created_txid bigint NOT NULL DEFAULT txid_current(),
      CONSTRAINT acquisition_cost_classification_acquisition_fk FOREIGN KEY (acquisition_id, mre_realm_id) REFERENCES acquisition (id, mre_realm_id),
      CONSTRAINT acquisition_cost_classification_cost_fk FOREIGN KEY (cost_id, acquisition_id) REFERENCES acquisition_cost (id, acquisition_id),
      CONSTRAINT acquisition_cost_classification_advisor_fk FOREIGN KEY (advisor_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT acquisition_cost_classification_advisor_state CHECK (advisor_party_id IS NULL OR review_state = 'ADVISOR_CONFIRMED'),
      CONSTRAINT acquisition_cost_classification_chain_key UNIQUE (id, cost_id),
      CONSTRAINT acquisition_cost_classification_supersedes_fk FOREIGN KEY (supersedes_id, cost_id)
        REFERENCES acquisition_cost_classification (id, cost_id),
      CONSTRAINT acquisition_cost_classification_supersedes_key UNIQUE (supersedes_id)
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX acquisition_cost_classification_current ON acquisition_cost_classification (cost_id) WHERE superseded_at IS NULL
  `.execute(db);
  await sql`CREATE INDEX acquisition_cost_classification_cost_idx ON acquisition_cost_classification (cost_id, created_at DESC, id)`.execute(db);
  await sql`CREATE INDEX acquisition_cost_classification_acquisition_idx ON acquisition_cost_classification (acquisition_id)`.execute(db);

  await sql`
    CREATE TABLE acquisition_cost_classification_part (
      classification_id uuid NOT NULL REFERENCES acquisition_cost_classification (id),
      position integer NOT NULL CHECK (position BETWEEN 1 AND 5),
      purpose text NOT NULL CHECK (purpose IN (${sql.raw(PURPOSES)})),
      amount numeric NOT NULL CHECK (scale(amount) <= 2 AND amount > 0 AND amount < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      created_txid bigint NOT NULL DEFAULT txid_current(),
      CONSTRAINT acquisition_cost_classification_part_key PRIMARY KEY (classification_id, position)
    )
  `.execute(db);

  await sql`
    CREATE FUNCTION acquisition_cost_classification_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      cost_status text;
    BEGIN
      IF NEW.superseded_at IS NOT NULL THEN
        RAISE EXCEPTION 'AcquisitionCostClassification: only inserted current, never superseded (api-design §59D)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.created_txid <> txid_current() THEN
        RAISE EXCEPTION 'AcquisitionCostClassification: created_txid is the inserting transaction''s, never given (api-design §59D)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- The Acquisition first (0021): serialises with cancel, confirm, the cost's void and every cost write; CANCELLED refused.
      PERFORM acquisition_touch_open(NEW.acquisition_id);
      SELECT status INTO cost_status FROM acquisition_cost WHERE id = NEW.cost_id AND acquisition_id = NEW.acquisition_id;
      IF cost_status = 'VOID' THEN
        RAISE EXCEPTION 'AcquisitionCostClassification: cost % is VOID (COST_VOID)', NEW.cost_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER acquisition_cost_classification_insert BEFORE INSERT ON acquisition_cost_classification
      FOR EACH ROW EXECUTE FUNCTION acquisition_cost_classification_insert()
  `.execute(db);

  await sql`
    CREATE FUNCTION acquisition_cost_classification_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AcquisitionCostClassification %: never deleted; supersede it instead (api-design §59D)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at') THEN
        RAISE EXCEPTION 'AcquisitionCostClassification %: its data never changes; supersede it with a new one (api-design §59D)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
        RAISE EXCEPTION 'AcquisitionCostClassification %: superseded is final (api-design §59D)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER acquisition_cost_classification_frozen BEFORE UPDATE OR DELETE ON acquisition_cost_classification
      FOR EACH ROW EXECUTE FUNCTION acquisition_cost_classification_frozen()
  `.execute(db);

  await sql`
    CREATE FUNCTION acquisition_cost_classification_chain() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      row record;
    BEGIN
      SELECT id, superseded_at, supersedes_id INTO row FROM acquisition_cost_classification WHERE id = NEW.id;
      IF row.superseded_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM acquisition_cost_classification s WHERE s.supersedes_id = row.id) THEN
        RAISE EXCEPTION 'AcquisitionCostClassification %: superseded without a successor (api-design §59D)', row.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF row.supersedes_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM acquisition_cost_classification p WHERE p.id = row.supersedes_id AND p.superseded_at IS NOT NULL) THEN
        RAISE EXCEPTION 'AcquisitionCostClassification %: supersedes % which is still current (api-design §59D)', row.id, row.supersedes_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER acquisition_cost_classification_chain AFTER INSERT OR UPDATE ON acquisition_cost_classification
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acquisition_cost_classification_chain()
  `.execute(db);

  await sql`
    CREATE FUNCTION acquisition_cost_classification_parts() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      cost record;
      parts_count integer;
      parts_sum numeric;
      other_purpose text;
    BEGIN
      SELECT c.category, c.amount INTO cost FROM acquisition_cost c WHERE c.id = NEW.cost_id;
      SELECT count(*), coalesce(sum(p.amount), 0) INTO parts_count, parts_sum
        FROM acquisition_cost_classification_part p WHERE p.classification_id = NEW.id;
      IF parts_count = 0 OR parts_sum <> cost.amount THEN
        RAISE EXCEPTION 'AcquisitionCostClassification %: its % parts sum to %, not the cost''s % (PARTS_SUM_MISMATCH)', NEW.id, parts_count, parts_sum, cost.amount
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF cost.category = 'FINANCING_RELATED' THEN
        SELECT p.purpose INTO other_purpose FROM acquisition_cost_classification_part p
          WHERE p.classification_id = NEW.id AND p.purpose <> 'FINANCING' ORDER BY p.position LIMIT 1;
        IF other_purpose IS NOT NULL THEN
          RAISE EXCEPTION 'AcquisitionCostClassification %: a FINANCING_RELATED cost takes FINANCING parts only, not % (PURPOSE_NOT_ALLOWED)', NEW.id, other_purpose
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER acquisition_cost_classification_parts AFTER INSERT ON acquisition_cost_classification
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acquisition_cost_classification_parts()
  `.execute(db);

  await sql`
    CREATE FUNCTION acquisition_cost_classification_part_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AcquisitionCostClassification: parts are never changed or deleted (api-design §59D)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.created_txid <> txid_current()
         OR NOT EXISTS (SELECT 1 FROM acquisition_cost_classification WHERE id = NEW.classification_id AND created_txid = txid_current()) THEN
        RAISE EXCEPTION 'AcquisitionCostClassification %: parts are inserted only by the transaction that created it (api-design §59D)', NEW.classification_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER acquisition_cost_classification_part_append_only BEFORE INSERT OR UPDATE OR DELETE ON acquisition_cost_classification_part
      FOR EACH ROW EXECUTE FUNCTION acquisition_cost_classification_part_append_only()
  `.execute(db);

  await sql`
    ALTER TABLE depreciation_schedule_version_component
      ADD COLUMN cost_classification_ids uuid[],
      ADD CONSTRAINT depreciation_schedule_version_component_cost_classifications CHECK (
        CASE kind
          -- Set, without a NULL element (array_position of a NULL array is NULL, so the IS NOT NULL comes first).
          WHEN 'ACQUISITION' THEN cost_classification_ids IS NOT NULL AND array_position(cost_classification_ids, NULL) IS NULL
          ELSE cost_classification_ids IS NULL
        END
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is dropped: a person's statement and a recorded version are never dropped silently.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM acquisition_cost_classification) THEN
        RAISE EXCEPTION 'acquisition_cost_classification: a classification exists; it is never dropped silently (api-design §59D)' USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version) THEN
        RAISE EXCEPTION 'depreciation_schedule_version: a recorded version exists; its classification ids are never dropped silently (api-design §59D)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`
    ALTER TABLE depreciation_schedule_version_component
      DROP CONSTRAINT depreciation_schedule_version_component_cost_classifications,
      DROP COLUMN cost_classification_ids
  `.execute(db);
  await sql`DROP TABLE acquisition_cost_classification_part`.execute(db);
  await sql`DROP TABLE acquisition_cost_classification`.execute(db);
  await sql`DROP FUNCTION acquisition_cost_classification_part_append_only()`.execute(db);
  await sql`DROP FUNCTION acquisition_cost_classification_parts()`.execute(db);
  await sql`DROP FUNCTION acquisition_cost_classification_chain()`.execute(db);
  await sql`DROP FUNCTION acquisition_cost_classification_frozen()`.execute(db);
  await sql`DROP FUNCTION acquisition_cost_classification_insert()`.execute(db);
}

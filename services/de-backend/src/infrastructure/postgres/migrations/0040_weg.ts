import { sql, type Kysely } from 'kysely';

/**
 * VC-6-01: WEG and WegMembership (data-model.md §27–§28, api-design.md §49.1–§49.2, phase-6-plan P6-D1/P6-D9).
 *
 * - `weg`: Realm-bound; an optional administrator Party by composite foreign key; status `ACTIVE` → `VOID`, `VOID`
 *   exactly with its time, actor and reason.
 * - `weg_membership`: a unit (PropertyReference) in a WEG for a period of inclusive dates, both by composite foreign
 *   key; the Miteigentumsanteil as printed, numerator and denominator with at most three decimals, `0 < n ≤ d`.
 * - `weg_membership_invariants` (after insert or update, after `ownership_invariants` of 0019; no exclusion constraint,
 *   which would need `btree_gist`): first a no-op write of the PropertyReference row, so writers of one unit serialise
 *   (under READ COMMITTED the second waits and its check, a new statement, sees the first's row; under REPEATABLE READ
 *   it fails to serialise). Then, for an `ACTIVE` row: a no-op write of its WEG, which must be `ACTIVE` (WEG_NOT_ACTIVE;
 *   the write makes a concurrent void wait under RC and fail to serialise under RR), and no other `ACTIVE` membership
 *   of the unit overlaps it, in any WEG (OVERLAPPING_WEG_MEMBERSHIP).
 * - `weg_membership_frozen`: Realm, WEG, unit, MEA, `valid_from` and creation never change; `valid_until` is only set
 *   or moved earlier; `VOID` is final; every change raises `version` by one; P3-D8's no-op write passes. Only inserted
 *   `ACTIVE` with `version` 1; never deleted.
 * - `weg_frozen`: Realm and creation never change; changes only while `ACTIVE`, each with `version` + 1; `VOID` is
 *   final, and refused while an `ACTIVE` membership names the WEG (WEG_HAS_MEMBERSHIPS). Only inserted `ACTIVE` with
 *   `version` 1; never deleted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE weg (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('ACTIVE', 'VOID')),
      display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
      administrator_party_id uuid,
      financial_year_start_month smallint NOT NULL CHECK (financial_year_start_month BETWEEN 1 AND 12),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      voided_at timestamptz,
      voided_by text,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT weg_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT weg_administrator_fk FOREIGN KEY (administrator_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT weg_void_fields CHECK (
        (status = 'VOID') = (voided_at IS NOT NULL) AND (status = 'VOID') = (voided_by IS NOT NULL) AND (status = 'VOID') = (void_reason IS NOT NULL)
      )
    )
  `.execute(db);
  await sql`CREATE INDEX weg_realm_idx ON weg (mre_realm_id, display_name, id)`.execute(db);
  await sql`CREATE INDEX weg_administrator_idx ON weg (administrator_party_id) WHERE administrator_party_id IS NOT NULL`.execute(db);

  await sql`
    CREATE TABLE weg_membership (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      weg_id uuid NOT NULL,
      property_reference_id uuid NOT NULL,
      mea_numerator numeric(12, 3) NOT NULL,
      mea_denominator numeric(12, 3) NOT NULL,
      valid_from date NOT NULL,
      valid_until date,
      status text NOT NULL CHECK (status IN ('ACTIVE', 'VOID')),
      voided_at timestamptz,
      voided_by text,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      source_references text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_references) <= 10),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT weg_membership_weg_fk FOREIGN KEY (weg_id, mre_realm_id) REFERENCES weg (id, mre_realm_id),
      CONSTRAINT weg_membership_property_reference_fk FOREIGN KEY (property_reference_id, mre_realm_id) REFERENCES property_reference (id, mre_realm_id),
      CONSTRAINT weg_membership_mea CHECK (mea_numerator > 0 AND mea_numerator <= mea_denominator),
      CONSTRAINT weg_membership_period CHECK (valid_until IS NULL OR valid_until >= valid_from),
      CONSTRAINT weg_membership_source_references CHECK (array_position(source_references, NULL) IS NULL),
      CONSTRAINT weg_membership_void_fields CHECK (
        (status = 'VOID') = (voided_at IS NOT NULL) AND (status = 'VOID') = (voided_by IS NOT NULL) AND (status = 'VOID') = (void_reason IS NOT NULL)
      )
    )
  `.execute(db);
  await sql`CREATE INDEX weg_membership_weg_idx ON weg_membership (weg_id, valid_from, created_at, id)`.execute(db);
  await sql`CREATE INDEX weg_membership_property_reference_idx ON weg_membership (property_reference_id, valid_from, created_at, id)`.execute(db);

  await sql`
    CREATE FUNCTION weg_membership_invariants() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      other record;
      weg_status text;
    BEGIN
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      IF NEW.status <> 'ACTIVE' THEN
        RETURN NULL;
      END IF;
      -- A write, not FOR SHARE: a concurrent void then conflicts under REPEATABLE READ too (a row only locked by a
      -- committed transaction lets an RR update through, whose check would read its old snapshot).
      UPDATE weg SET version = version WHERE id = NEW.weg_id RETURNING status INTO weg_status;
      IF weg_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'WegMembership %: WEG % is % (WEG_NOT_ACTIVE)', NEW.id, NEW.weg_id, weg_status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT m.id, m.weg_id INTO other FROM weg_membership m
       WHERE m.property_reference_id = NEW.property_reference_id AND m.status = 'ACTIVE' AND m.id <> NEW.id
         AND daterange(m.valid_from, m.valid_until, '[]') && daterange(NEW.valid_from, NEW.valid_until, '[]')
       LIMIT 1;
      IF other.id IS NOT NULL THEN
        RAISE EXCEPTION 'WegMembership %: overlaps membership % of WEG % for the same unit (OVERLAPPING_WEG_MEMBERSHIP)', NEW.id, other.id, other.weg_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_membership_invariants AFTER INSERT OR UPDATE ON weg_membership
      FOR EACH ROW EXECUTE FUNCTION weg_membership_invariants()
  `.execute(db);

  await sql`
    CREATE FUNCTION weg_membership_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.id, NEW.mre_realm_id, NEW.weg_id, NEW.property_reference_id, NEW.mea_numerator, NEW.mea_denominator, NEW.valid_from,
          NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.weg_id, OLD.property_reference_id, OLD.mea_numerator, OLD.mea_denominator, OLD.valid_from,
          OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'WegMembership %: WEG, unit, MEA and validFrom never change; void and create instead (api-design §49.2)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- The no-op write of P3-D8 (and any write leaving the row as it is) passes.
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'VOID' THEN
        RAISE EXCEPTION 'WegMembership %: VOID is final (api-design §49.2)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.valid_until IS NOT NULL AND (NEW.valid_until IS NULL OR NEW.valid_until > OLD.valid_until) THEN
        RAISE EXCEPTION 'WegMembership %: validUntil is only set or moved earlier, never extended (api-design §49.2)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status = 'VOID' AND (NEW.valid_until, NEW.source_references, NEW.notes) IS DISTINCT FROM (OLD.valid_until, OLD.source_references, OLD.notes) THEN
        RAISE EXCEPTION 'WegMembership %: a void changes nothing else', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'WegMembership %: every change raises version by exactly one (% → %)', OLD.id, OLD.version, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER weg_membership_frozen BEFORE UPDATE ON weg_membership FOR EACH ROW EXECUTE FUNCTION weg_membership_frozen()`.execute(db);

  await sql`
    CREATE FUNCTION weg_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      held uuid;
    BEGIN
      IF (NEW.id, NEW.mre_realm_id, NEW.created_at, NEW.created_by) IS DISTINCT FROM (OLD.id, OLD.mre_realm_id, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'WEG %: Realm and creation never change (api-design §49.1)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'VOID' THEN
        RAISE EXCEPTION 'WEG %: VOID is final (api-design §49.1)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status = 'VOID' THEN
        IF (NEW.display_name, NEW.administrator_party_id, NEW.financial_year_start_month, NEW.notes)
           IS DISTINCT FROM (OLD.display_name, OLD.administrator_party_id, OLD.financial_year_start_month, OLD.notes) THEN
          RAISE EXCEPTION 'WEG %: a void changes nothing else', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        SELECT id INTO held FROM weg_membership WHERE weg_id = OLD.id AND status = 'ACTIVE' LIMIT 1;
        IF held IS NOT NULL THEN
          RAISE EXCEPTION 'WEG %: membership % is ACTIVE (WEG_HAS_MEMBERSHIPS)', OLD.id, held USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'WEG %: every change raises version by exactly one (% → %)', OLD.id, OLD.version, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER weg_frozen BEFORE UPDATE ON weg FOR EACH ROW EXECUTE FUNCTION weg_frozen()`.execute(db);

  await sql`
    CREATE FUNCTION weg_initial() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status <> 'ACTIVE' OR NEW.version <> 1 THEN
        RAISE EXCEPTION '%: only inserted ACTIVE with version 1, not % / % (api-design §49)', TG_TABLE_NAME, NEW.status, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER weg_initial BEFORE INSERT ON weg FOR EACH ROW EXECUTE FUNCTION weg_initial()`.execute(db);
  await sql`CREATE TRIGGER weg_membership_initial BEFORE INSERT ON weg_membership FOR EACH ROW EXECUTE FUNCTION weg_initial()`.execute(db);

  await sql`
    CREATE FUNCTION weg_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% %: never deleted; void it instead (api-design §49)', TG_TABLE_NAME, OLD.id USING ERRCODE = 'integrity_constraint_violation';
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER weg_no_delete BEFORE DELETE ON weg FOR EACH ROW EXECUTE FUNCTION weg_no_delete()`.execute(db);
  await sql`CREATE TRIGGER weg_membership_no_delete BEFORE DELETE ON weg_membership FOR EACH ROW EXECUTE FUNCTION weg_no_delete()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE weg_membership`.execute(db);
  await sql`DROP TABLE weg`.execute(db);
  await sql`DROP FUNCTION weg_no_delete()`.execute(db);
  await sql`DROP FUNCTION weg_initial()`.execute(db);
  await sql`DROP FUNCTION weg_frozen()`.execute(db);
  await sql`DROP FUNCTION weg_membership_frozen()`.execute(db);
  await sql`DROP FUNCTION weg_membership_invariants()`.execute(db);
}

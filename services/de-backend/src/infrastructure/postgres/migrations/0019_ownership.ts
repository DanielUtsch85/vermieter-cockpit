import { sql, type Kysely } from 'kysely';

/**
 * VC-2-03: Ownership (data-model.md §12, api-design.md §26.1, phase-2-plan P2-D3/P2-D4).
 *
 * - A share is an exact fraction, stored reduced (`gcd = 1`); a period is two inclusive business dates.
 * - Composite foreign keys keep the PropertyReference and the owner in the Ownership's Realm.
 * - `ownership_frozen`: share, owner, PropertyReference, `valid_from` and creation never change; `VOID` is final;
 *   `valid_until` is only set or moved earlier (a close), never later or cleared. `acquisition_id` joins the list
 *   with its column in VC-2-05.
 * - `ownership_invariants`: on every write of a `VALID` row, first a no-op write of the PropertyReference row, so two
 *   writers of one PropertyReference serialise (as 0010 touches the Transaction): under READ COMMITTED the second
 *   waits and its checks (each a new statement, so a new snapshot) see the first's rows; under REPEATABLE READ it
 *   fails with a serialisation error. Then, over `VALID` rows: no overlap per owner, and no day above 1. A day's sum
 *   only rises where a period starts, so the row's `valid_from` and the starts inside its period are checked. Sums
 *   are exact: `numeric` numerators and denominators, reduced by `gcd`, never decimal division.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ownership (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      property_reference_id uuid NOT NULL,
      owner_party_id uuid NOT NULL,
      share_numerator integer NOT NULL,
      share_denominator integer NOT NULL,
      valid_from date NOT NULL,
      valid_until date,
      status text NOT NULL CHECK (status IN ('VALID', 'VOID')),
      voided_at timestamptz,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      source_references text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_references) <= 10),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT ownership_property_reference_fk FOREIGN KEY (property_reference_id, mre_realm_id)
        REFERENCES property_reference (id, mre_realm_id),
      CONSTRAINT ownership_owner_fk FOREIGN KEY (owner_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT ownership_share CHECK (
        share_numerator >= 1 AND share_numerator <= share_denominator AND share_denominator <= 10000
        AND gcd(share_numerator, share_denominator) = 1
      ),
      CONSTRAINT ownership_period CHECK (valid_until IS NULL OR valid_until >= valid_from),
      CONSTRAINT ownership_void CHECK (
        (status = 'VOID') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (void_reason IS NULL)
      )
    )
  `.execute(db);
  await sql`CREATE INDEX ownership_property_reference_idx ON ownership (property_reference_id, valid_from, created_at, id)`.execute(db);
  await sql`CREATE INDEX ownership_owner_idx ON ownership (owner_party_id)`.execute(db);

  await sql`
    CREATE FUNCTION ownership_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status = 'VOID' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Ownership %: VOID is final (api-design §26.1)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.property_reference_id, NEW.owner_party_id, NEW.share_numerator, NEW.share_denominator,
          NEW.valid_from, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.property_reference_id, OLD.owner_party_id, OLD.share_numerator, OLD.share_denominator,
          OLD.valid_from, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'Ownership %: share, owner, PropertyReference and validFrom never change; void and create instead (api-design §26.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.valid_until IS NOT NULL AND (NEW.valid_until IS NULL OR NEW.valid_until > OLD.valid_until) THEN
        RAISE EXCEPTION 'Ownership %: validUntil is only set or moved earlier, never extended (api-design §26.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER ownership_frozen BEFORE UPDATE ON ownership FOR EACH ROW EXECUTE FUNCTION ownership_frozen()`.execute(db);

  await sql`
    CREATE FUNCTION ownership_invariants() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      other uuid;
      day date;
      row record;
      n numeric;
      d numeric;
      g numeric;
    BEGIN
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;

      SELECT o.id INTO other FROM ownership o
       WHERE o.property_reference_id = NEW.property_reference_id AND o.owner_party_id = NEW.owner_party_id
         AND o.status = 'VALID' AND o.id <> NEW.id
         AND daterange(o.valid_from, o.valid_until, '[]') && daterange(NEW.valid_from, NEW.valid_until, '[]')
       LIMIT 1;
      IF other IS NOT NULL THEN
        RAISE EXCEPTION 'Ownership %: overlaps Ownership % of the same owner (OVERLAPPING_OWNERSHIP)', NEW.id, other
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;

      FOR day IN
        SELECT DISTINCT o.valid_from FROM ownership o
         WHERE o.property_reference_id = NEW.property_reference_id AND o.status = 'VALID'
           AND o.valid_from <@ daterange(NEW.valid_from, NEW.valid_until, '[]')
      LOOP
        n := 0;
        d := 1;
        FOR row IN
          SELECT o.share_numerator, o.share_denominator FROM ownership o
           WHERE o.property_reference_id = NEW.property_reference_id AND o.status = 'VALID'
             AND day <@ daterange(o.valid_from, o.valid_until, '[]')
        LOOP
          n := n * row.share_denominator + row.share_numerator * d;
          d := d * row.share_denominator;
          g := gcd(n, d);
          n := n / g;
          d := d / g;
        END LOOP;
        IF n > d THEN
          RAISE EXCEPTION 'PropertyReference %: shares on % sum to %/% (OWNERSHIP_TOTAL_EXCEEDS_ONE)', NEW.property_reference_id, day, n, d
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ownership_invariants
      AFTER INSERT OR UPDATE ON ownership
      FOR EACH ROW WHEN (NEW.status = 'VALID')
      EXECUTE FUNCTION ownership_invariants()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE ownership`.execute(db);
  await sql`DROP FUNCTION ownership_invariants()`.execute(db);
  await sql`DROP FUNCTION ownership_frozen()`.execute(db);
}

import { sql, type Kysely } from 'kysely';

/**
 * VC-2-02: external references of a Party (data-model.md §8, api-design.md §20.1, phase-2-plan P2-D2).
 *
 * - Phase 2 holds MRE Tenant references only (`system = MRE`, `entity_type = tenant`, a 24-hex MRE `_id`).
 * - The composite foreign key to `party (id, mre_realm_id)` (0016) keeps a reference in its Party's Realm.
 * - "Active" is a status, not a period. Among active references a key resolves to at most one Party: the partial
 *   unique index. Its predicate is the one `ON CONFLICT … WHERE status = 'ACTIVE'` names, so it is the arbiter.
 * - Ending is final: an ENDED row never changes again, and no row changes its key, Party or creation. Claiming a
 *   key again creates a new row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE party_external_reference (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      party_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      system text NOT NULL CHECK (system IN ('MRE')),
      entity_type text NOT NULL CHECK (entity_type IN ('tenant')),
      external_id text NOT NULL CHECK (external_id ~ '^[0-9a-f]{24}$'),
      status text NOT NULL CHECK (status IN ('ACTIVE', 'ENDED')),
      ended_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT party_external_reference_party_fk FOREIGN KEY (party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT party_external_reference_ended CHECK ((status = 'ENDED') = (ended_at IS NOT NULL))
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX party_external_reference_active_key
      ON party_external_reference (system, mre_realm_id, entity_type, external_id) WHERE status = 'ACTIVE'
  `.execute(db);
  await sql`CREATE INDEX party_external_reference_party_idx ON party_external_reference (party_id, created_at, id)`.execute(db);
  await sql`
    CREATE FUNCTION party_external_reference_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status = 'ENDED' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'external reference %: ENDED is final (api-design §20.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.party_id, NEW.mre_realm_id, NEW.system, NEW.entity_type, NEW.external_id, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.party_id, OLD.mre_realm_id, OLD.system, OLD.entity_type, OLD.external_id, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'external reference %: key, Party and creation never change; claim again instead (api-design §20.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER party_external_reference_frozen
      BEFORE UPDATE ON party_external_reference
      FOR EACH ROW EXECUTE FUNCTION party_external_reference_frozen()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE party_external_reference`.execute(db);
  await sql`DROP FUNCTION party_external_reference_frozen()`.execute(db);
}

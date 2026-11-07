import { sql, type Kysely } from 'kysely';

/**
 * VC-X-24 (api-design.md §58U; Entscheidung des Projektinhabers, 2026-11-06): `audit_record` becomes immutable but for
 * one write, the pseudonymisation of the personal values in an `AMENDED` record after its retention.
 *
 * - `audit_record.pseudonymised_at timestamptz NULL`: when the record's personal values were replaced. `NULL` on insert
 *   (no record is born pseudonymised), set once.
 * - `audit_metadata_pseudonymised(entity_type, old, new)`: the allow-list of `domains/audit/personal-fields.ts`, written
 *   out again (a Party's seven fields under `changes.<field>.{from,to}`; every other entity type: none). True iff the two
 *   documents are equal once every listed leaf of `new` is set back to its old value, at least one listed leaf differs,
 *   and every differing listed leaf was a non-null value and is now a string of the marker pattern `[entfernt:v<n>]`
 *   (no key exists: the marker is fixed, decision 4). Equality of the restored document covers keys added or removed
 *   and array lengths at every level.
 * - `audit_record_guard()`, four triggers: `DELETE` (row) and `TRUNCATE` (statement) refused; `INSERT` refused with
 *   `pseudonymised_at` set; `UPDATE` refused unless the record is `AMENDED`, not yet pseudonymised, gets
 *   `pseudonymised_at`, keeps every other column, and its metadata passes the function above.
 * - `audit_record_retention_idx`: the job's due records (`AMENDED`, not pseudonymised, by `occurred_at`).
 *
 * The guard protects against a bug or a careless statement in the service's own role, not against the database owner,
 * who can disable a trigger; a separate role without `UPDATE`/`DELETE` is a backlog row of its own (decision 8). `down`
 * is refused while a record is pseudonymised (the markers cannot be undone), then drops all of it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE audit_record ADD COLUMN pseudonymised_at timestamptz NULL`.execute(db);
  await sql`
    CREATE FUNCTION audit_metadata_pseudonymised(entity_type text, old_metadata jsonb, new_metadata jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE
      fields text[] := CASE entity_type
        WHEN 'Party' THEN ARRAY['displayName', 'firstName', 'lastName', 'legalName', 'registrationNumber', 'email', 'phone']
        ELSE ARRAY[]::text[] END;
      field text;
      side text;
      old_value jsonb;
      new_value jsonb;
      restored jsonb := new_metadata;
      changed integer := 0;
    BEGIN
      IF old_metadata IS NULL OR new_metadata IS NULL THEN
        RETURN false;
      END IF;
      FOREACH field IN ARRAY fields LOOP
        FOREACH side IN ARRAY ARRAY['from', 'to'] LOOP
          old_value := old_metadata #> ARRAY['changes', field, side];
          CONTINUE WHEN old_value IS NULL;
          new_value := new_metadata #> ARRAY['changes', field, side];
          IF new_value IS NULL THEN
            RETURN false;
          END IF;
          IF new_value IS DISTINCT FROM old_value THEN
            IF jsonb_typeof(old_value) = 'null' OR jsonb_typeof(new_value) <> 'string' OR (new_value #>> '{}') !~ '^[[]entfernt:v[1-9][0-9]*[]]$' THEN
              RETURN false;
            END IF;
            changed := changed + 1;
            restored := jsonb_set(restored, ARRAY['changes', field, side], old_value);
          END IF;
        END LOOP;
      END LOOP;
      RETURN changed > 0 AND restored = old_metadata;
    END
    $$
  `.execute(db);
  await sql`
    CREATE FUNCTION audit_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'AuditRecords cannot be truncated (VC-X-24)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AuditRecord % cannot be deleted (VC-X-24)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.pseudonymised_at IS NOT NULL THEN
          RAISE EXCEPTION 'AuditRecord % cannot be written pseudonymised (VC-X-24)', NEW.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.action = 'AMENDED'
        AND OLD.pseudonymised_at IS NULL
        AND NEW.pseudonymised_at IS NOT NULL
        AND (NEW.id, NEW.entity_type, NEW.entity_id, NEW.action, NEW.occurred_at, NEW.actor_type, NEW.actor_id, NEW.previous_version, NEW.new_version)
          IS NOT DISTINCT FROM (OLD.id, OLD.entity_type, OLD.entity_id, OLD.action, OLD.occurred_at, OLD.actor_type, OLD.actor_id, OLD.previous_version, OLD.new_version)
        AND audit_metadata_pseudonymised(OLD.entity_type, OLD.metadata, NEW.metadata)
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'AuditRecord % is immutable but for the pseudonymisation of its personal values after retention (VC-X-24)', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END
    $$
  `.execute(db);
  await sql`CREATE TRIGGER audit_record_update_guard BEFORE UPDATE ON audit_record FOR EACH ROW EXECUTE FUNCTION audit_record_guard()`.execute(db);
  await sql`CREATE TRIGGER audit_record_delete_guard BEFORE DELETE ON audit_record FOR EACH ROW EXECUTE FUNCTION audit_record_guard()`.execute(db);
  await sql`CREATE TRIGGER audit_record_insert_guard BEFORE INSERT ON audit_record FOR EACH ROW EXECUTE FUNCTION audit_record_guard()`.execute(db);
  await sql`CREATE TRIGGER audit_record_truncate_guard BEFORE TRUNCATE ON audit_record FOR EACH STATEMENT EXECUTE FUNCTION audit_record_guard()`.execute(db);
  await sql`CREATE INDEX audit_record_retention_idx ON audit_record (occurred_at) WHERE action = 'AMENDED' AND pseudonymised_at IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM audit_record WHERE pseudonymised_at IS NOT NULL) THEN
        RAISE EXCEPTION 'down of 0076 refused: an AuditRecord is pseudonymised, the markers cannot be undone (VC-X-24)' USING ERRCODE = 'check_violation';
      END IF;
    END
    $$
  `.execute(db);
  await sql`DROP INDEX audit_record_retention_idx`.execute(db);
  await sql`DROP TRIGGER audit_record_truncate_guard ON audit_record`.execute(db);
  await sql`DROP TRIGGER audit_record_insert_guard ON audit_record`.execute(db);
  await sql`DROP TRIGGER audit_record_delete_guard ON audit_record`.execute(db);
  await sql`DROP TRIGGER audit_record_update_guard ON audit_record`.execute(db);
  await sql`DROP FUNCTION audit_record_guard()`.execute(db);
  await sql`DROP FUNCTION audit_metadata_pseudonymised(text, jsonb, jsonb)`.execute(db);
  await sql`ALTER TABLE audit_record DROP COLUMN pseudonymised_at`.execute(db);
}

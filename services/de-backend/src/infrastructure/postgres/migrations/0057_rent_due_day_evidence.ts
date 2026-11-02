import { sql, type Kysely } from 'kysely';

/**
 * VC-X-39: the evidence of a recorded due day (api-design.md §58F "The rule"; owner decision 2026-11-02, „`rentDueDays`
 * genügt technisch als Nutzerangabe; Belegreferenz ermöglichen und empfehlen.“). Number 0057 as planned: 0056 is
 * VC-X-41 Part 1's, implemented in parallel.
 *
 * - `rental_contract_reference_due_days_valid` (0046) takes an optional third key of an entry, `evidenceReference`: a
 *   JSON string, trimmed, 1–500 characters. Every other check of 0046 is unchanged, so every stored list stays valid.
 * - Nothing else: the tax year and the flags stay derived on read (§58A). No backfill.
 * - `down` restores 0046's function; it refuses while an entry names an evidence (never dropped silently).
 */
const dueDaysValid = (withEvidence: boolean) => sql`
  CREATE OR REPLACE FUNCTION rental_contract_reference_due_days_valid(days jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
  DECLARE
    entry jsonb;
    valid_from date;
    previous date;
  BEGIN
    IF jsonb_typeof(days) IS DISTINCT FROM 'array' OR jsonb_array_length(days) > 20 THEN
      RETURN false;
    END IF;
    FOR entry IN SELECT e.value FROM jsonb_array_elements(days) WITH ORDINALITY AS e(value, n) ORDER BY e.n LOOP
      IF jsonb_typeof(entry) <> 'object' OR NOT (entry ?& ARRAY['validFrom', 'day']) THEN
        RETURN false;
      END IF;
      ${sql.raw(
        withEvidence
          ? `IF (SELECT count(*) FROM jsonb_object_keys(entry)) <> (CASE WHEN entry ? 'evidenceReference' THEN 3 ELSE 2 END) THEN
        RETURN false;
      END IF;
      IF entry ? 'evidenceReference' AND (jsonb_typeof(entry -> 'evidenceReference') <> 'string'
          OR length(entry ->> 'evidenceReference') NOT BETWEEN 1 AND 500
          OR btrim(entry ->> 'evidenceReference', E' \\t\\n\\r') <> (entry ->> 'evidenceReference')) THEN
        RETURN false;
      END IF;`
          : `IF (SELECT count(*) FROM jsonb_object_keys(entry)) <> 2 THEN
        RETURN false;
      END IF;`,
      )}
      IF jsonb_typeof(entry -> 'day') <> 'number' OR (entry ->> 'day') !~ '^[0-9]{1,2}$' OR (entry ->> 'day')::integer NOT BETWEEN 1 AND 31 THEN
        RETURN false;
      END IF;
      IF jsonb_typeof(entry -> 'validFrom') <> 'string' OR (entry ->> 'validFrom') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN false;
      END IF;
      BEGIN
        valid_from := (entry ->> 'validFrom')::date;
      EXCEPTION WHEN others THEN
        RETURN false;
      END;
      IF to_char(valid_from, 'YYYY-MM-DD') <> (entry ->> 'validFrom') OR (previous IS NOT NULL AND valid_from <= previous) THEN
        RETURN false;
      END IF;
      previous := valid_from;
    END LOOP;
    RETURN true;
  END $$
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await dueDaysValid(true).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM rental_contract_reference r, jsonb_array_elements(r.rent_due_days) AS e(value) WHERE e.value ? 'evidenceReference') THEN
        RAISE EXCEPTION 'rental_contract_reference: a due day names its evidence; never dropped silently (api-design §58F)' USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await dueDaysValid(false).execute(db);
}

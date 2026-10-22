import { sql, type Kysely } from 'kysely';

/**
 * VC-2-01: Party as minimal shared identity (data-model.md §7, api-design.md §19.1, phase-2-plan P2-D1).
 *
 * - Realm-scoped; `(id, mre_realm_id)` is unique so later tables (Ownership, external references) can reference a
 *   Party of their own Realm by composite foreign key, as the ledger does.
 * - The type rules hold in the database too: a PERSON carries no organization fields and vice versa.
 * - `status` and the deactivation fields go together; nothing in the schema dedupes Parties (no unique name): two
 *   Parties with one name are allowed, avoiding duplicates is a review task (§7.7).
 * - The list orders by `lower(display_name)`, then `id` (§19.1); the index serves that order per Realm.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE party (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL CHECK (mre_realm_id <> ''),
      party_type text NOT NULL CHECK (party_type IN ('PERSON', 'ORGANIZATION')),
      display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
      first_name text CHECK (length(first_name) BETWEEN 1 AND 200),
      last_name text CHECK (length(last_name) BETWEEN 1 AND 200),
      legal_name text CHECK (length(legal_name) BETWEEN 1 AND 200),
      registration_number text CHECK (length(registration_number) BETWEEN 1 AND 100),
      email text CHECK (length(email) BETWEEN 3 AND 254),
      phone text CHECK (length(phone) BETWEEN 1 AND 50),
      status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
      deactivated_at timestamptz,
      deactivation_reason text CHECK (length(deactivation_reason) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT party_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT party_type_fields CHECK (
        CASE party_type
          WHEN 'PERSON' THEN legal_name IS NULL AND registration_number IS NULL
          ELSE first_name IS NULL AND last_name IS NULL
        END
      ),
      CONSTRAINT party_deactivation CHECK (
        (status = 'INACTIVE') = (deactivated_at IS NOT NULL)
        AND (deactivated_at IS NULL) = (deactivation_reason IS NULL)
      )
    )
  `.execute(db);
  await sql`CREATE INDEX party_realm_name_idx ON party (mre_realm_id, lower(display_name), id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE party`.execute(db);
}

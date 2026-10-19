import { sql, type Kysely } from 'kysely';

/**
 * VC-1-03: FinancialAccount (data-model.md §16) and the generic idempotency key
 * store for commands with an `Idempotency-Key` (api-design.md §15).
 *
 * - `financial_account` belongs to a Realm, not to a PropertyReference. The IBAN
 *   is an external identifier only (data-model.md §6.5): no uniqueness, never a key.
 * - `idempotency_key`: one row per (Realm, command scope, key), claimed in the
 *   same transaction as the resource it creates; `request_fingerprint` tells a
 *   replay (same payload) from a conflict (different payload). `result` is the
 *   command's result as of that transaction: a replay answers with it, never
 *   with the resource's current state (api-design.md §15).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE financial_account (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL CHECK (mre_realm_id <> ''),
      account_type text NOT NULL
        CHECK (account_type IN ('BANK', 'SECURITY_DEPOSIT', 'LOAN_SETTLEMENT', 'CASH', 'OTHER')),
      display_name text NOT NULL CHECK (display_name <> ''),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      iban text CHECK (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
      status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT financial_account_closed_at CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX financial_account_realm_idx ON financial_account (mre_realm_id)`.execute(db);

  await sql`
    CREATE TABLE idempotency_key (
      mre_realm_id text NOT NULL,
      scope text NOT NULL,
      key text NOT NULL,
      request_fingerprint text NOT NULL,
      resource_id text,
      result jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (mre_realm_id, scope, key)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE idempotency_key`.execute(db);
  await sql`DROP TABLE financial_account`.execute(db);
}

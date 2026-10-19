import { sql, type Kysely } from 'kysely';

/**
 * VC-1-04: Transaction (data-model.md §17), table `ledger_transaction`.
 *
 * - Money column pair per coding-guidelines §8 (unconstrained NUMERIC + CHECK,
 *   never NUMERIC(p,s)), and non-negative: the sign lives only in `direction`
 *   (§17.4).
 * - Business dates are `date`, not timestamps (coding-guidelines §4).
 * - Realm isolation in the schema itself: the account and the optional
 *   PropertyReference are referenced together with the Realm, so a Transaction
 *   can never point at another Realm's account or property.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE financial_account ADD CONSTRAINT financial_account_realm_key UNIQUE (id, mre_realm_id)`.execute(db);
  await sql`ALTER TABLE property_reference ADD CONSTRAINT property_reference_realm_key UNIQUE (id, mre_realm_id)`.execute(db);

  await sql`
    CREATE TABLE ledger_transaction (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      financial_account_id uuid NOT NULL,
      amount numeric NOT NULL CHECK (scale(amount) <= 2 AND amount >= 0 AND amount < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      direction text NOT NULL CHECK (direction IN ('INFLOW', 'OUTFLOW')),
      booking_date date NOT NULL,
      value_date date,
      description text,
      property_reference_id uuid,
      provenance text NOT NULL CHECK (provenance IN ('MANUAL', 'BANK_CSV', 'BANK_API', 'MIGRATION', 'CORRECTION')),
      status text NOT NULL
        CHECK (status IN ('IMPORTED', 'UNREVIEWED', 'CLASSIFIED', 'CONFIRMED', 'RECONCILED', 'CORRECTED', 'IGNORED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT ledger_transaction_account_fk FOREIGN KEY (financial_account_id, mre_realm_id)
        REFERENCES financial_account (id, mre_realm_id),
      CONSTRAINT ledger_transaction_property_reference_fk FOREIGN KEY (property_reference_id, mre_realm_id)
        REFERENCES property_reference (id, mre_realm_id)
    )
  `.execute(db);
  await sql`CREATE INDEX ledger_transaction_account_idx ON ledger_transaction (financial_account_id, booking_date)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE ledger_transaction`.execute(db);
  await sql`ALTER TABLE property_reference DROP CONSTRAINT property_reference_realm_key`.execute(db);
  await sql`ALTER TABLE financial_account DROP CONSTRAINT financial_account_realm_key`.execute(db);
}

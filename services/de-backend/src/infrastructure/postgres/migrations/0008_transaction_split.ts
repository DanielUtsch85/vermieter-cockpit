import { sql, type Kysely } from 'kysely';

/**
 * VC-1-07: FinancialCategory (data-model.md §19) and TransactionSplit (§18).
 *
 * - Categories are a global system catalog in Phase 1 (no Realm): stable codes,
 *   seeded here; a code is never reused for another meaning, only deactivated.
 * - A split references its Transaction together with the Realm and the
 *   currency, so it can never belong to another Realm's Transaction nor carry
 *   another currency (no FX, §17.7). Its amount is non-negative; the direction
 *   is the Transaction's (§17.4). The exact sum is checked in the domain, under
 *   the Transaction's row lock (§18).
 * - Also: `import_batch.provenance` gets the CHECK every status-like column has
 *   (review note on #15).
 */
const CATEGORIES: readonly (readonly [code: string, name: string, type: string])[] = [
  ['RENT_BASE', 'Kaltmiete', 'INCOME'],
  ['RENT_OPERATING_COST_ADVANCE', 'Betriebskostenvorauszahlung', 'INCOME'],
  ['RENT_OPERATING_COST_SETTLEMENT', 'Betriebskostenabrechnung (Nachzahlung/Erstattung)', 'INCOME'],
  ['OTHER_INCOME', 'Sonstige Einnahmen', 'INCOME'],
  ['LOAN_INTEREST', 'Darlehenszinsen', 'FINANCING'],
  ['LOAN_PRINCIPAL', 'Darlehenstilgung', 'FINANCING'],
  ['WEG_RECOVERABLE', 'Hausgeld, umlagefähig', 'OPERATING_EXPENSE'],
  ['WEG_NON_RECOVERABLE', 'Hausgeld, nicht umlagefähig', 'OPERATING_EXPENSE'],
  ['WEG_RESERVE_CONTRIBUTION', 'Erhaltungsrücklage', 'OPERATING_EXPENSE'],
  ['MAINTENANCE', 'Instandhaltung', 'OPERATING_EXPENSE'],
  ['ADMINISTRATION', 'Verwaltung', 'OPERATING_EXPENSE'],
  ['INSURANCE', 'Versicherungen', 'OPERATING_EXPENSE'],
  ['PROPERTY_TAX', 'Grundsteuer', 'OPERATING_EXPENSE'],
  ['BANK_FEES', 'Kontoführung und Bankgebühren', 'OPERATING_EXPENSE'],
  ['OTHER_EXPENSE', 'Sonstige Ausgaben', 'OPERATING_EXPENSE'],
  ['SECURITY_DEPOSIT', 'Mietkaution', 'SECURITY_DEPOSIT'],
  ['ACQUISITION', 'Anschaffung', 'CAPITAL_MOVEMENT'],
  ['OWNER_CONTRIBUTION', 'Einlage', 'CAPITAL_MOVEMENT'],
  ['OWNER_WITHDRAWAL', 'Entnahme', 'CAPITAL_MOVEMENT'],
  ['TRANSFER', 'Umbuchung zwischen eigenen Konten', 'TRANSFER'],
  ['OTHER', 'Sonstiges', 'OTHER'],
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE financial_category (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      category_type text NOT NULL
        CHECK (category_type IN ('INCOME', 'OPERATING_EXPENSE', 'FINANCING', 'CAPITAL_MOVEMENT', 'SECURITY_DEPOSIT', 'TRANSFER', 'OTHER')),
      active boolean NOT NULL DEFAULT true
    )
  `.execute(db);
  for (const [code, name, type] of CATEGORIES) {
    await sql`INSERT INTO financial_category (code, name, category_type) VALUES (${code}, ${name}, ${type})`.execute(db);
  }

  await sql`
    ALTER TABLE ledger_transaction ADD CONSTRAINT ledger_transaction_split_key UNIQUE (id, mre_realm_id, currency)
  `.execute(db);
  await sql`
    CREATE TABLE transaction_split (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      transaction_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      position integer NOT NULL CHECK (position >= 1),
      amount numeric NOT NULL CHECK (scale(amount) <= 2 AND amount >= 0 AND amount < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      financial_category_id uuid NOT NULL REFERENCES financial_category (id),
      property_reference_id uuid,
      description text CHECK (length(description) <= 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      CONSTRAINT transaction_split_transaction_fk FOREIGN KEY (transaction_id, mre_realm_id, currency)
        REFERENCES ledger_transaction (id, mre_realm_id, currency),
      CONSTRAINT transaction_split_property_reference_fk FOREIGN KEY (property_reference_id, mre_realm_id)
        REFERENCES property_reference (id, mre_realm_id),
      CONSTRAINT transaction_split_position_key UNIQUE (transaction_id, position)
    )
  `.execute(db);

  await sql`
    ALTER TABLE import_batch ADD CONSTRAINT import_batch_provenance_check
      CHECK (provenance IN ('MANUAL', 'BANK_CSV', 'BANK_API', 'MIGRATION', 'CORRECTION'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE import_batch DROP CONSTRAINT import_batch_provenance_check`.execute(db);
  await sql`DROP TABLE transaction_split`.execute(db);
  await sql`ALTER TABLE ledger_transaction DROP CONSTRAINT ledger_transaction_split_key`.execute(db);
  await sql`DROP TABLE financial_category`.execute(db);
}

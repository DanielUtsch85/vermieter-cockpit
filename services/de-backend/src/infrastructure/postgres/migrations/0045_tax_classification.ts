import { sql, type Kysely } from 'kysely';

/**
 * VC-7-01: the TaxClassification of a split (data-model.md §36, api-design.md §55–§57, phase-7-plan P7-D1, P7-D2, P7-D9).
 *
 * - `tax_classification`: `source_type` (`TRANSACTION_SPLIT` in VC-7-01) with exactly one source column set by CHECK
 *   (`transaction_split_id`, a composite foreign key with the Realm; later items add their columns); the line, the
 *   treatment and their fit (CHECK); the stored review state (never `SUGGESTED`) with the advisor only when
 *   `ADVISOR_CONFIRMED`; the applied rule as `rule_code`, `rule_version` (the registry is code, P7-D1); notes and
 *   source references; the chain `supersedes_id` / `superseded_by` / `superseded_at` within one source; `version`.
 * - `UNIQUE (transaction_split_id) WHERE superseded_at IS NULL`: one current classification per split. So a supersede
 *   writes the old row's `superseded_*` first (its `superseded_by` foreign key deferred) and then inserts the new row.
 * - `tax_classification_initial` (before insert): only current, `version` 1, `USER_CONFIRMED` or `NEEDS_REVIEW`.
 * - `tax_classification_source_counts` (before insert): writes the split's Transaction (no-op), then requires it
 *   current (SOURCE_NOT_COUNTED): Transaction → classification, as every writer of P7-D9.
 * - `tax_classification_treatment` (before insert): TREATMENT_NOT_ALLOWED by the split's category type and code
 *   (DE_CATEGORY_DEFAULTS@1: `WEG_FUNDS`, `SECURITY_DEPOSIT`, `TRANSFER` only `NOT_RELEVANT`; `LOAN_PRINCIPAL` never
 *   `DEDUCTIBLE`; `ACQUISITION` never `CAPITALIZED`).
 * - `tax_classification_frozen` (before update or delete): content, source, rule and creation never change;
 *   `superseded_*` set once, and a superseded row is final; `review_state` only to the targets of §57; `version` + 1;
 *   the no-op passes; never deleted. `tax_classification_chain` (deferred): both directions of the chain agree.
 * - Nothing on `ledger_transaction` changes, and on `transaction_split` no column and no trigger: only the key
 *   `(id, mre_realm_id)` the composite foreign key needs. `down` drops the table, its functions and that key.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE transaction_split ADD CONSTRAINT transaction_split_realm_key UNIQUE (id, mre_realm_id)`.execute(db);
  // Its own text check (each 1–500), so Taxation does not depend on a WEG migration's function.
  await sql`
    CREATE FUNCTION tax_classification_texts_valid(texts text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT coalesce(bool_and(length(t) BETWEEN 1 AND 500), true) FROM unnest(texts) AS t
    $$
  `.execute(db);
  await sql`
    CREATE TABLE tax_classification (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      source_type text NOT NULL CHECK (source_type IN ('TRANSACTION_SPLIT')),
      transaction_split_id uuid,
      tax_category text NOT NULL CHECK (tax_category IN (
        'RENT', 'OPERATING_COST_ADVANCES', 'OPERATING_COST_SETTLEMENT', 'OTHER_INCOME', 'LOAN_INTEREST', 'FINANCING_COSTS', 'WEG_HAUSGELD',
        'WEG_SPENDING', 'MAINTENANCE', 'ADMINISTRATION', 'INSURANCE', 'PROPERTY_TAX', 'BANK_FEES', 'TAX_ADVICE', 'TRAVEL', 'OTHER_EXPENSE',
        'NOT_RELEVANT', 'UNCLASSIFIED')),
      treatment text CHECK (treatment IN ('INCOME', 'DEDUCTIBLE', 'CAPITALIZED', 'DISTRIBUTED_82B', 'NOT_RELEVANT')),
      review_state text NOT NULL CHECK (review_state IN ('USER_CONFIRMED', 'ADVISOR_CONFIRMED', 'NEEDS_REVIEW')),
      rule_code text NOT NULL CHECK (rule_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
      rule_version integer NOT NULL CHECK (rule_version >= 1),
      advisor_party_id uuid,
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      source_references text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_references) <= 20 AND tax_classification_texts_valid(source_references)),
      supersedes_id uuid,
      superseded_by uuid,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT tax_classification_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT tax_classification_split_fk FOREIGN KEY (transaction_split_id, mre_realm_id) REFERENCES transaction_split (id, mre_realm_id),
      CONSTRAINT tax_classification_advisor_fk FOREIGN KEY (advisor_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT tax_classification_one_source CHECK (
        num_nonnulls(transaction_split_id) = 1 AND (source_type = 'TRANSACTION_SPLIT') = (transaction_split_id IS NOT NULL)
      ),
      CONSTRAINT tax_classification_fit CHECK (
        CASE
          WHEN tax_category IN ('RENT', 'OPERATING_COST_ADVANCES', 'OPERATING_COST_SETTLEMENT', 'OTHER_INCOME') THEN treatment IS NOT DISTINCT FROM 'INCOME'
          WHEN tax_category = 'NOT_RELEVANT' THEN treatment IS NOT DISTINCT FROM 'NOT_RELEVANT'
          WHEN tax_category = 'UNCLASSIFIED' THEN treatment IS NULL
          ELSE treatment IS NOT NULL AND treatment <> 'INCOME'
        END
      ),
      CONSTRAINT tax_classification_advisor_state CHECK (advisor_party_id IS NULL OR review_state = 'ADVISOR_CONFIRMED'),
      CONSTRAINT tax_classification_superseded_fields CHECK ((superseded_at IS NULL) = (superseded_by IS NULL)),
      CONSTRAINT tax_classification_chain_key UNIQUE (id, transaction_split_id),
      CONSTRAINT tax_classification_supersedes_fk FOREIGN KEY (supersedes_id, transaction_split_id) REFERENCES tax_classification (id, transaction_split_id),
      CONSTRAINT tax_classification_superseded_by_fk FOREIGN KEY (superseded_by, transaction_split_id) REFERENCES tax_classification (id, transaction_split_id)
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT tax_classification_supersedes_key UNIQUE (supersedes_id),
      CONSTRAINT tax_classification_superseded_by_key UNIQUE (superseded_by)
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX tax_classification_current ON tax_classification (transaction_split_id) WHERE superseded_at IS NULL`.execute(db);
  await sql`CREATE INDEX tax_classification_split_idx ON tax_classification (transaction_split_id, created_at, id)`.execute(db);
  await sql`CREATE INDEX tax_classification_realm_idx ON tax_classification (mre_realm_id, created_at, id)`.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_initial() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.superseded_at IS NOT NULL OR NEW.superseded_by IS NOT NULL OR NEW.version <> 1 OR NEW.review_state NOT IN ('USER_CONFIRMED', 'NEEDS_REVIEW') THEN
        RAISE EXCEPTION 'TaxClassification: only inserted current with version 1, USER_CONFIRMED or NEEDS_REVIEW (api-design §56)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER tax_classification_initial BEFORE INSERT ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_initial()`.execute(
    db,
  );

  await sql`
    CREATE FUNCTION tax_classification_source_counts() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      tx record;
    BEGIN
      -- Transaction → classification (P7-D9): a correction or reversal of the Transaction waits, or this waits for it;
      -- under REPEATABLE READ the later one fails to serialise. Written, never only read (0013 allows the no-op).
      UPDATE ledger_transaction SET version = version
       WHERE id = (SELECT transaction_id FROM transaction_split WHERE id = NEW.transaction_split_id)
       RETURNING id, status, correction_role INTO tx;
      IF tx.id IS NULL THEN
        RETURN NEW; -- an unknown split is left to the foreign key
      END IF;
      IF tx.status NOT IN ('CONFIRMED', 'RECONCILED') OR tx.correction_role IS NOT DISTINCT FROM 'REVERSAL' THEN
        RAISE EXCEPTION 'TaxClassification: Transaction % is % (%), not current (SOURCE_NOT_COUNTED)', tx.id, tx.status, coalesce(tx.correction_role, '-')
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_source_counts BEFORE INSERT ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_source_counts()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_treatment() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      category record;
    BEGIN
      SELECT c.code, c.category_type INTO category FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id
       WHERE s.id = NEW.transaction_split_id;
      IF category.code IS NULL THEN
        RETURN NEW;
      END IF;
      -- DE_CATEGORY_DEFAULTS@1 (api-design §56): their tax meaning arises elsewhere (BFH IX R 19/24; A11, E6), and
      -- principal is never deductible (A1).
      IF category.category_type IN ('WEG_FUNDS', 'SECURITY_DEPOSIT', 'TRANSFER') AND NEW.treatment IS DISTINCT FROM 'NOT_RELEVANT' THEN
        RAISE EXCEPTION 'TaxClassification: a % split is only NOT_RELEVANT, not % (TREATMENT_NOT_ALLOWED)', category.category_type, coalesce(NEW.treatment, 'null')
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF category.code = 'LOAN_PRINCIPAL' AND NEW.treatment = 'DEDUCTIBLE' THEN
        RAISE EXCEPTION 'TaxClassification: LOAN_PRINCIPAL is never DEDUCTIBLE (TREATMENT_NOT_ALLOWED)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- The AfA basis comes from the Acquisition aggregate: capitalising the purchase payment would count it twice.
      IF category.code = 'ACQUISITION' AND NEW.treatment = 'CAPITALIZED' THEN
        RAISE EXCEPTION 'TaxClassification: ACQUISITION is never CAPITALIZED (TREATMENT_NOT_ALLOWED)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_treatment BEFORE INSERT ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_treatment()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TaxClassification %: never deleted; supersede it instead (api-design §55)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF OLD.superseded_at IS NOT NULL THEN
        RAISE EXCEPTION 'TaxClassification %: superseded is final (api-design §57)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.version <> OLD.version + 1
         OR (NEW.id, NEW.mre_realm_id, NEW.source_type, NEW.transaction_split_id, NEW.tax_category, NEW.treatment, NEW.rule_code, NEW.rule_version,
             NEW.notes, NEW.source_references, NEW.supersedes_id, NEW.created_at, NEW.created_by)
            IS DISTINCT FROM
            (OLD.id, OLD.mre_realm_id, OLD.source_type, OLD.transaction_split_id, OLD.tax_category, OLD.treatment, OLD.rule_code, OLD.rule_version,
             OLD.notes, OLD.source_references, OLD.supersedes_id, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'TaxClassification %: version + 1; content, source, rule and creation never change (api-design §55)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.superseded_at IS NOT NULL AND (NEW.review_state, NEW.advisor_party_id) IS DISTINCT FROM (OLD.review_state, OLD.advisor_party_id) THEN
        RAISE EXCEPTION 'TaxClassification %: a supersede changes nothing else (api-design §56)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.review_state IS DISTINCT FROM OLD.review_state
         AND NOT (NEW.review_state IN ('ADVISOR_CONFIRMED', 'NEEDS_REVIEW') OR (OLD.review_state = 'NEEDS_REVIEW' AND NEW.review_state = 'USER_CONFIRMED')) THEN
        RAISE EXCEPTION 'TaxClassification %: % does not move to % (api-design §57)', OLD.id, OLD.review_state, NEW.review_state
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_frozen BEFORE UPDATE OR DELETE ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_frozen()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_chain() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      cur record;
    BEGIN
      SELECT id, supersedes_id, superseded_by INTO cur FROM tax_classification WHERE id = NEW.id;
      IF cur.superseded_by IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tax_classification s WHERE s.id = cur.superseded_by AND s.supersedes_id = cur.id) THEN
        RAISE EXCEPTION 'TaxClassification %: superseded by %, which does not name it (api-design §56)', cur.id, cur.superseded_by
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF cur.supersedes_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tax_classification p WHERE p.id = cur.supersedes_id AND p.superseded_by = cur.id) THEN
        RAISE EXCEPTION 'TaxClassification %: supersedes %, which is not superseded by it (api-design §56)', cur.id, cur.supersedes_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER tax_classification_chain AFTER INSERT OR UPDATE ON tax_classification
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tax_classification_chain()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE tax_classification`.execute(db);
  await sql`DROP FUNCTION tax_classification_chain()`.execute(db);
  await sql`DROP FUNCTION tax_classification_frozen()`.execute(db);
  await sql`DROP FUNCTION tax_classification_treatment()`.execute(db);
  await sql`DROP FUNCTION tax_classification_source_counts()`.execute(db);
  await sql`DROP FUNCTION tax_classification_initial()`.execute(db);
  await sql`DROP FUNCTION tax_classification_texts_valid(text[])`.execute(db);
  await sql`ALTER TABLE transaction_split DROP CONSTRAINT transaction_split_realm_key`.execute(db);
}

import { sql, type Kysely } from 'kysely';

/**
 * VC-X-36: capitalised Loan interest in the AfA basis, Bauzeitzinsen (api-design.md §59E "In the database", data-model
 * `ConstructionPeriodInterest`; tax review of 2026-11-01, question 23, mündlich bestätigt durch den Steuerberater, laut
 * Projektinhaber am 2026-11-01). §59E planned "migration 0056"; 0053 is §59C's and 0054 §59D's, and the next free number
 * is taken by whichever is implemented next (Kysely's Migrator refuses a name sorting before an applied one), so this is
 * 0055 and §58E moves to 0056.
 *
 * - `construction_period_interest`: one record per financing of one Herstellung measure, of the Realm, with an optional
 *   Loan of the Realm (`(loan_id, mre_realm_id)`), the facts with their CHECKs (`buildingFundsShare` 0 < n ≤ d ≤ 10,000,
 *   the period ordered, the texts' lengths), `review_state` (as §59's asset; an advisor only with `ADVISOR_CONFIRMED`),
 *   `status` `VALID`/`VOID` with `voided_at` and `void_reason` exactly when `VOID`.
 * - `construction_period_interest_property`: its 1–50 PropertyReferences of the Realm (`(record_id, property_reference_id)`).
 * - Guards: `…_frozen` (never deleted; id, Realm, Loan and creation never change; version + 1; a `VOID` record never
 *   changes), `…_property_open` (a record's PropertyReferences change only while it is `VALID`, never updated),
 *   `…_property_count` (deferred: at commit a record has 1–50 PropertyReferences).
 * - `tax_classification.construction_period_interest_id` (composite key with the Realm; a split only; with `CAPITALIZED`
 *   or `DEDUCTIBLE` only), `tax_classification_construction_period` (before insert: the record `VALID`, of the split's
 *   Loan, naming a PropertyReference's split's PropertyReference, not deductible under `CAPITALIZED`; and
 *   `DE_CONSTRUCTION_PERIOD_INTEREST@1` literally: `CAPITALIZED` interest without a record is refused),
 *   `tax_classification_construction_period_fixed` (the link never changes). Classifications stored before keep no link.
 * - `depreciation_schedule_version_component` (0052) gains the Loan of a Loan interest source (`loan_id`,
 *   `allocation_set_id`, P's share) and `construction_period_interest_id`: all Loan columns null or all set, and only on
 *   an item component.
 * - 0047's `tax_classification_treatment_rule` takes `DE_CONSTRUCTION_PERIOD_INTEREST` as the second rule reference of a
 *   classification naming a record (and never with an anschaffungsnahe link).
 * - No backfill. `down` refuses while a record exists or a recorded component names a Loan (never dropped silently).
 */
const REVIEW_STATES = `'UNREVIEWED', 'CONFIRMED', 'ADVISOR_CONFIRMED', 'NEEDS_REVIEW'`;

/** 0047's `tax_classification_treatment_rule`, with (`up`) or without (`down`) the construction-period record's rule. */
const treatmentRuleCheck = (db: Kysely<unknown>, withRecord: boolean) =>
  sql`
    ALTER TABLE tax_classification
      DROP CONSTRAINT tax_classification_treatment_rule,
      ADD CONSTRAINT tax_classification_treatment_rule CHECK (
        (treatment_rule_code IS NULL) = (treatment_rule_version IS NULL)
          AND CASE
                WHEN treatment = 'DISTRIBUTED_82B' THEN treatment_rule_code IS NOT DISTINCT FROM 'DE_82B_DISTRIBUTION'
                WHEN anschaffungsnahe_acquisition_id IS NOT NULL THEN treatment_rule_code IS NOT DISTINCT FROM 'DE_ANSCHAFFUNGSNAHE'
                ${sql.raw(withRecord ? `WHEN construction_period_interest_id IS NOT NULL THEN treatment_rule_code IS NOT DISTINCT FROM 'DE_CONSTRUCTION_PERIOD_INTEREST'` : '')}
                ELSE treatment_rule_code IS NULL
              END
      )
  `.execute(db);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE construction_period_interest (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      loan_id uuid,
      measure text NOT NULL CHECK (length(measure) BETWEEN 1 AND 200),
      herstellung_from date NOT NULL,
      herstellung_until date,
      use_intent text NOT NULL CHECK (length(use_intent) BETWEEN 1 AND 1000),
      advance_expense_deductible boolean NOT NULL,
      building_funds_share_numerator bigint NOT NULL,
      building_funds_share_denominator bigint NOT NULL,
      earlier_years_treatment text NOT NULL CHECK (length(earlier_years_treatment) BETWEEN 1 AND 2000),
      source_references text[] NOT NULL CHECK (cardinality(source_references) BETWEEN 1 AND 20 AND array_position(source_references, NULL) IS NULL),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      review_state text NOT NULL CHECK (review_state IN (${sql.raw(REVIEW_STATES)})),
      advisor_party_id uuid,
      status text NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID', 'VOID')),
      voided_at timestamptz,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      CONSTRAINT construction_period_interest_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT construction_period_interest_loan_fk FOREIGN KEY (loan_id, mre_realm_id) REFERENCES loan (id, mre_realm_id),
      CONSTRAINT construction_period_interest_advisor_fk FOREIGN KEY (advisor_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT construction_period_interest_advisor_state CHECK (advisor_party_id IS NULL OR review_state = 'ADVISOR_CONFIRMED'),
      CONSTRAINT construction_period_interest_funds_share CHECK (
        building_funds_share_numerator > 0 AND building_funds_share_numerator <= building_funds_share_denominator
        AND building_funds_share_denominator <= 10000
      ),
      CONSTRAINT construction_period_interest_period CHECK (herstellung_until IS NULL OR herstellung_until >= herstellung_from),
      CONSTRAINT construction_period_interest_void CHECK ((status = 'VOID') = (voided_at IS NOT NULL AND void_reason IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX construction_period_interest_loan_idx ON construction_period_interest (loan_id)`.execute(db);

  await sql`
    CREATE TABLE construction_period_interest_property (
      record_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      property_reference_id uuid NOT NULL,
      CONSTRAINT construction_period_interest_property_key PRIMARY KEY (record_id, property_reference_id),
      CONSTRAINT construction_period_interest_property_record_fk FOREIGN KEY (record_id, mre_realm_id)
        REFERENCES construction_period_interest (id, mre_realm_id),
      CONSTRAINT construction_period_interest_property_reference_fk FOREIGN KEY (property_reference_id, mre_realm_id)
        REFERENCES property_reference (id, mre_realm_id)
    )
  `.execute(db);
  await sql`CREATE INDEX construction_period_interest_property_reference_idx ON construction_period_interest_property (property_reference_id)`.execute(db);

  await sql`
    CREATE FUNCTION construction_period_interest_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ConstructionPeriodInterest %: never deleted; void it instead (api-design §59E)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW; -- the no-op write that serialises a classification's create with amend and void
      END IF;
      IF OLD.status = 'VOID' THEN
        RAISE EXCEPTION 'ConstructionPeriodInterest %: a void record never changes (api-design §59E)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.version <> OLD.version + 1
         OR (NEW.id, NEW.mre_realm_id, NEW.loan_id, NEW.created_at, NEW.created_by) IS DISTINCT FROM (OLD.id, OLD.mre_realm_id, OLD.loan_id, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'ConstructionPeriodInterest %: version + 1; the Loan, the Realm and the creation never change (api-design §59E)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER construction_period_interest_frozen BEFORE UPDATE OR DELETE ON construction_period_interest
      FOR EACH ROW EXECUTE FUNCTION construction_period_interest_frozen()
  `.execute(db);

  await sql`
    CREATE FUNCTION construction_period_interest_property_open() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      record_status text;
      rid uuid;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'ConstructionPeriodInterest %: a PropertyReference entry is never changed, only added or removed (api-design §59E)', OLD.record_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'DELETE' THEN
        rid := OLD.record_id;
      ELSE
        rid := NEW.record_id;
      END IF;
      SELECT status INTO record_status FROM construction_period_interest WHERE id = rid;
      IF record_status IS DISTINCT FROM 'VALID' THEN
        RAISE EXCEPTION 'ConstructionPeriodInterest %: its PropertyReferences change only while it is VALID (api-design §59E)', rid
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER construction_period_interest_property_open BEFORE INSERT OR UPDATE OR DELETE ON construction_period_interest_property
      FOR EACH ROW EXECUTE FUNCTION construction_period_interest_property_open()
  `.execute(db);

  await sql`
    CREATE FUNCTION construction_period_interest_property_count() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      rid uuid;
      n integer;
    BEGIN
      IF TG_TABLE_NAME = 'construction_period_interest' THEN
        rid := NEW.id;
      ELSIF TG_OP = 'DELETE' THEN
        rid := OLD.record_id;
      ELSE
        rid := NEW.record_id;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM construction_period_interest WHERE id = rid) THEN
        RETURN NULL;
      END IF;
      SELECT count(*) INTO n FROM construction_period_interest_property WHERE record_id = rid;
      IF n < 1 OR n > 50 THEN
        RAISE EXCEPTION 'ConstructionPeriodInterest %: % PropertyReferences; 1 to 50 (api-design §59E)', rid, n USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER construction_period_interest_property_count AFTER INSERT ON construction_period_interest
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION construction_period_interest_property_count()
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER construction_period_interest_property_count AFTER INSERT OR DELETE ON construction_period_interest_property
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION construction_period_interest_property_count()
  `.execute(db);

  await sql`
    ALTER TABLE tax_classification
      ADD COLUMN construction_period_interest_id uuid,
      ADD CONSTRAINT tax_classification_construction_period_fk FOREIGN KEY (construction_period_interest_id, mre_realm_id)
        REFERENCES construction_period_interest (id, mre_realm_id),
      ADD CONSTRAINT tax_classification_construction_period_treatment CHECK (
        construction_period_interest_id IS NULL
        OR (source_type = 'TRANSACTION_SPLIT' AND treatment IN ('CAPITALIZED', 'DEDUCTIBLE') AND anschaffungsnahe_acquisition_id IS NULL)
      )
  `.execute(db);
  // 0047's second rule reference, with the record's: DE_CONSTRUCTION_PERIOD_INTEREST for a classification naming one.
  await treatmentRuleCheck(db, true);
  await sql`CREATE INDEX tax_classification_construction_period_idx ON tax_classification (construction_period_interest_id) WHERE construction_period_interest_id IS NOT NULL`.execute(
    db,
  );

  await sql`
    CREATE FUNCTION tax_classification_construction_period() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      split record;
      cpi record;
      interest boolean;
    BEGIN
      IF NEW.transaction_split_id IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT s.loan_id, s.property_reference_id, c.code INTO split
        FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id WHERE s.id = NEW.transaction_split_id;
      -- DE_CONSTRUCTION_PERIOD_INTEREST@1 (§59E), literally: interestCategoryCodes, interestTaxCategories, capitalizedRequiresRecord.
      interest := split.code = 'LOAN_INTEREST' OR NEW.tax_category IN ('LOAN_INTEREST', 'FINANCING_COSTS');
      IF NEW.construction_period_interest_id IS NULL THEN
        IF interest AND NEW.treatment = 'CAPITALIZED' THEN
          RAISE EXCEPTION 'TaxClassification: CAPITALIZED interest needs a construction-period record (CONSTRUCTION_PERIOD_INTEREST_REQUIRED, api-design §59E)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END IF;
      SELECT id, status, loan_id, advance_expense_deductible INTO cpi
        FROM construction_period_interest WHERE id = NEW.construction_period_interest_id AND mre_realm_id = NEW.mre_realm_id;
      IF cpi.id IS NULL THEN
        RETURN NEW; -- left to the foreign key
      END IF;
      IF NOT interest THEN
        RAISE EXCEPTION 'TaxClassification: a construction-period record only on interest (api-design §59E)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF cpi.status <> 'VALID' THEN
        RAISE EXCEPTION 'TaxClassification: construction-period record % is void (CONSTRUCTION_PERIOD_INTEREST_VOID)', cpi.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF cpi.loan_id IS DISTINCT FROM split.loan_id
         OR (split.property_reference_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM construction_period_interest_property WHERE record_id = cpi.id AND property_reference_id = split.property_reference_id)) THEN
        RAISE EXCEPTION 'TaxClassification: construction-period record % does not cover the split (CONSTRUCTION_PERIOD_INTEREST_MISMATCH)', cpi.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.treatment = 'CAPITALIZED' AND cpi.advance_expense_deductible THEN
        RAISE EXCEPTION 'TaxClassification: construction-period record % is deductible; no free choice (CONSTRUCTION_PERIOD_INTEREST_DEDUCTIBLE)', cpi.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_construction_period BEFORE INSERT ON tax_classification
      FOR EACH ROW EXECUTE FUNCTION tax_classification_construction_period()
  `.execute(db);
  await sql`
    CREATE FUNCTION tax_classification_construction_period_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.construction_period_interest_id IS DISTINCT FROM OLD.construction_period_interest_id THEN
        RAISE EXCEPTION 'TaxClassification %: its construction-period record never changes (api-design §59E)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_construction_period_fixed BEFORE UPDATE ON tax_classification
      FOR EACH ROW EXECUTE FUNCTION tax_classification_construction_period_fixed()
  `.execute(db);

  await sql`
    ALTER TABLE depreciation_schedule_version_component
      ADD COLUMN loan_id uuid,
      ADD COLUMN allocation_set_id uuid,
      ADD COLUMN share_numerator bigint,
      ADD COLUMN share_denominator bigint,
      ADD COLUMN construction_period_interest_id uuid,
      ADD CONSTRAINT depreciation_schedule_version_component_loan CHECK (
        ((loan_id, allocation_set_id, share_numerator, share_denominator) IS NULL
          OR ((loan_id, allocation_set_id, share_numerator, share_denominator) IS NOT NULL AND kind = 'CAPITALIZED_ITEM'
              AND share_numerator > 0 AND share_numerator <= share_denominator))
        AND (construction_period_interest_id IS NULL OR kind = 'CAPITALIZED_ITEM')
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is dropped: a person's statement and a recorded Loan component are never dropped silently.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM construction_period_interest) THEN
        RAISE EXCEPTION 'construction_period_interest: a record exists; it is never dropped silently (api-design §59E)' USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version_component WHERE loan_id IS NOT NULL OR construction_period_interest_id IS NOT NULL) THEN
        RAISE EXCEPTION 'depreciation_schedule_version_component: a recorded Loan interest component exists; never dropped silently (api-design §59E)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`
    ALTER TABLE depreciation_schedule_version_component
      DROP CONSTRAINT depreciation_schedule_version_component_loan,
      DROP COLUMN construction_period_interest_id,
      DROP COLUMN share_denominator,
      DROP COLUMN share_numerator,
      DROP COLUMN allocation_set_id,
      DROP COLUMN loan_id
  `.execute(db);
  await sql`DROP TRIGGER tax_classification_construction_period_fixed ON tax_classification`.execute(db);
  await sql`DROP TRIGGER tax_classification_construction_period ON tax_classification`.execute(db);
  await sql`DROP FUNCTION tax_classification_construction_period_fixed()`.execute(db);
  await sql`DROP FUNCTION tax_classification_construction_period()`.execute(db);
  await sql`DROP INDEX tax_classification_construction_period_idx`.execute(db);
  await treatmentRuleCheck(db, false);
  await sql`
    ALTER TABLE tax_classification
      DROP CONSTRAINT tax_classification_construction_period_treatment,
      DROP CONSTRAINT tax_classification_construction_period_fk,
      DROP COLUMN construction_period_interest_id
  `.execute(db);
  await sql`DROP TABLE construction_period_interest_property`.execute(db);
  await sql`DROP TABLE construction_period_interest`.execute(db);
  await sql`DROP FUNCTION construction_period_interest_property_count()`.execute(db);
  await sql`DROP FUNCTION construction_period_interest_property_open()`.execute(db);
  await sql`DROP FUNCTION construction_period_interest_frozen()`.execute(db);
}

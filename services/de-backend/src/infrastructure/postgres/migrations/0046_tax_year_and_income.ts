import { sql, type Kysely } from 'kysely';

/**
 * VC-7-02: the tax year and the income side (api-design.md §58A, phase-7-plan P7-D3, P7-D4, data-model §11, §36).
 *
 * - `tax_classification`:
 *   - `tax_year` and `refund_of_year` (smallint, 2000–2100); `tax_classification_tax_year` (before insert) keeps
 *     `tax_year` within the split's booking year ± 1 (TAX_YEAR_OUT_OF_RANGE: § 11 never moves cash further) and
 *     `refund_of_year` at most the latest year the split can count in (REFUND_YEAR_OUT_OF_RANGE);
 *   - `security_deposit_id`, the second source column (`DEPOSIT_CLOSING`, a composite foreign key with the Realm), with
 *     the closing it classifies (`deposit_closing_date`, `deposit_retained_amount`); exactly one source column set;
 *   - the `source_type`, `tax_category` and fit CHECKs gain the deposit and the three new lines;
 *   - `tax_classification_deposit_counts` (before insert): writes the deposit (no-op), then requires it `CLOSED` with a
 *     retained amount > 0, and the closing named by the row to be the deposit's (SOURCE_NOT_COUNTED);
 *   - `tax_classification_deposit_treatment` (before insert): the deposit's lines and treatments only
 *     (TREATMENT_NOT_ALLOWED);
 *   - one current classification per deposit; the chain stays within the deposit (`(id, security_deposit_id)` keys);
 *   - `tax_classification_source_fixed` (before update): the new columns never change (0045's frozen guard covers the
 *     others).
 * - `rental_contract_reference`: the minimal RentalContractReference (one per MRE Tenant and Realm) with
 *   `rent_due_days` as `jsonb`, checked by `rental_contract_reference_due_days_valid` (an array of at most 20
 *   `{ validFrom, day }`, each day 1–31, `validFrom` real dates, unique and strictly ascending); initial and frozen
 *   guards (Realm, Tenant and creation never change; `version` + 1; no delete).
 * - `weg_economic_plan.advance_due_day` (smallint 1–31, nullable); `weg_economic_plan_advance_due_day_fixed` keeps it
 *   fixed (a plan is never amended, §49.5).
 *
 * `down` restores 0045's CHECKs, drops the new columns, the table and the functions. It refuses while a deposit
 * classification exists (0045's CHECKs no longer hold for it).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tax_classification
      ADD COLUMN tax_year smallint CHECK (tax_year BETWEEN 2000 AND 2100),
      ADD COLUMN refund_of_year smallint CHECK (refund_of_year BETWEEN 2000 AND 2100),
      ADD COLUMN security_deposit_id uuid,
      ADD COLUMN deposit_closing_date date,
      ADD COLUMN deposit_retained_amount numeric CHECK (deposit_retained_amount > 0 AND scale(deposit_retained_amount) <= 2),
      DROP CONSTRAINT tax_classification_source_type_check,
      ADD CONSTRAINT tax_classification_source_type_check CHECK (source_type IN ('TRANSACTION_SPLIT', 'DEPOSIT_CLOSING')),
      DROP CONSTRAINT tax_classification_tax_category_check,
      ADD CONSTRAINT tax_classification_tax_category_check CHECK (tax_category IN (
        'RENT', 'OPERATING_COST_ADVANCES', 'OPERATING_COST_SETTLEMENT', 'OTHER_INCOME', 'REFUNDS_OF_EARLIER_YEARS', 'RETAINED_DEPOSIT_RENT',
        'RETAINED_DEPOSIT_DAMAGES', 'LOAN_INTEREST', 'FINANCING_COSTS', 'WEG_HAUSGELD', 'WEG_SPENDING', 'MAINTENANCE', 'ADMINISTRATION', 'INSURANCE',
        'PROPERTY_TAX', 'BANK_FEES', 'TAX_ADVICE', 'TRAVEL', 'OTHER_EXPENSE', 'NOT_RELEVANT', 'UNCLASSIFIED')),
      DROP CONSTRAINT tax_classification_one_source,
      ADD CONSTRAINT tax_classification_one_source CHECK (
        num_nonnulls(transaction_split_id, security_deposit_id) = 1
          AND (source_type = 'TRANSACTION_SPLIT') = (transaction_split_id IS NOT NULL)
          AND (source_type = 'DEPOSIT_CLOSING') = (security_deposit_id IS NOT NULL)
      ),
      DROP CONSTRAINT tax_classification_fit,
      ADD CONSTRAINT tax_classification_fit CHECK (
        CASE
          WHEN tax_category IN ('RENT', 'OPERATING_COST_ADVANCES', 'OPERATING_COST_SETTLEMENT', 'OTHER_INCOME', 'REFUNDS_OF_EARLIER_YEARS',
                                'RETAINED_DEPOSIT_RENT', 'RETAINED_DEPOSIT_DAMAGES') THEN treatment IS NOT DISTINCT FROM 'INCOME'
          WHEN tax_category = 'NOT_RELEVANT' THEN treatment IS NOT DISTINCT FROM 'NOT_RELEVANT'
          WHEN tax_category = 'UNCLASSIFIED' THEN treatment IS NULL
          ELSE treatment IS NOT NULL AND treatment <> 'INCOME'
        END
      ),
      ADD CONSTRAINT tax_classification_deposit_fields CHECK (
        (security_deposit_id IS NOT NULL) = (deposit_closing_date IS NOT NULL)
          AND (security_deposit_id IS NOT NULL) = (deposit_retained_amount IS NOT NULL)
          AND (security_deposit_id IS NULL OR (tax_year IS NULL AND refund_of_year IS NULL))
      ),
      ADD CONSTRAINT tax_classification_refund_year CHECK (refund_of_year IS NULL OR tax_year IS NULL OR refund_of_year <= tax_year),
      ADD CONSTRAINT tax_classification_deposit_fk FOREIGN KEY (security_deposit_id, mre_realm_id) REFERENCES security_deposit (id, mre_realm_id),
      ADD CONSTRAINT tax_classification_deposit_chain_key UNIQUE (id, security_deposit_id),
      ADD CONSTRAINT tax_classification_deposit_supersedes_fk FOREIGN KEY (supersedes_id, security_deposit_id)
        REFERENCES tax_classification (id, security_deposit_id),
      ADD CONSTRAINT tax_classification_deposit_superseded_by_fk FOREIGN KEY (superseded_by, security_deposit_id)
        REFERENCES tax_classification (id, security_deposit_id) DEFERRABLE INITIALLY DEFERRED
  `.execute(db);
  await sql`CREATE UNIQUE INDEX tax_classification_current_deposit ON tax_classification (security_deposit_id) WHERE superseded_at IS NULL`.execute(db);
  await sql`CREATE INDEX tax_classification_deposit_idx ON tax_classification (security_deposit_id, created_at, id)`.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_tax_year() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      booking_year integer;
    BEGIN
      SELECT extract(year FROM t.booking_date)::integer INTO booking_year
        FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id WHERE s.id = NEW.transaction_split_id;
      IF booking_year IS NULL THEN
        RETURN NEW; -- a deposit, or an unknown split left to the foreign key
      END IF;
      -- § 11 EStG moves cash across one year-end at most (api-design §58A).
      IF NEW.tax_year IS NOT NULL AND NEW.tax_year NOT BETWEEN booking_year - 1 AND booking_year + 1 THEN
        RAISE EXCEPTION 'TaxClassification: tax_year % is not within the booking year % ± 1 (TAX_YEAR_OUT_OF_RANGE)', NEW.tax_year, booking_year
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.refund_of_year IS NOT NULL AND NEW.refund_of_year > coalesce(NEW.tax_year, booking_year + 1) THEN
        RAISE EXCEPTION 'TaxClassification: refund_of_year % lies after the tax year (REFUND_YEAR_OUT_OF_RANGE)', NEW.refund_of_year
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER tax_classification_tax_year BEFORE INSERT ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_tax_year()`.execute(
    db,
  );

  await sql`
    CREATE FUNCTION tax_classification_deposit_counts() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      deposit record;
      retained numeric;
    BEGIN
      IF NEW.security_deposit_id IS NULL THEN
        RETURN NEW;
      END IF;
      -- Deposit → classification (P7-D9): a reopen waits, or this waits for it; under REPEATABLE READ the later one
      -- fails to serialise. Written, never only read (0037's frozen guard lets the no-op pass).
      UPDATE security_deposit SET version = version WHERE id = NEW.security_deposit_id AND mre_realm_id = NEW.mre_realm_id
       RETURNING id, status, closing_date, closing_reason, held_at_closing INTO deposit;
      IF deposit.id IS NULL THEN
        RETURN NEW; -- an unknown deposit, or one of another Realm, is left to the foreign key
      END IF;
      retained := CASE WHEN deposit.closing_reason = 'RETURNED' THEN 0 ELSE greatest(coalesce(deposit.held_at_closing, 0), 0) END;
      IF deposit.status <> 'CLOSED' OR retained <= 0 THEN
        RAISE EXCEPTION 'TaxClassification: security deposit % is % with % retained, not counted (SOURCE_NOT_COUNTED)', deposit.id, deposit.status, retained
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.deposit_closing_date, NEW.deposit_retained_amount) IS DISTINCT FROM (deposit.closing_date, retained) THEN
        RAISE EXCEPTION 'TaxClassification: the closing named (%, %) is not the deposit''s (%, %) (SOURCE_NOT_COUNTED)',
          NEW.deposit_closing_date, NEW.deposit_retained_amount, deposit.closing_date, retained USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_deposit_counts BEFORE INSERT ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_deposit_counts()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_deposit_treatment() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      -- DE_CATEGORY_DEFAULTS@1 (api-design §58A): a retained deposit is rent or damage compensation, or not relevant;
      -- never an expense (A11).
      IF NEW.security_deposit_id IS NOT NULL AND (
           NEW.tax_category NOT IN ('RETAINED_DEPOSIT_RENT', 'RETAINED_DEPOSIT_DAMAGES', 'NOT_RELEVANT')
           OR NEW.treatment IS NULL OR NEW.treatment NOT IN ('INCOME', 'NOT_RELEVANT')) THEN
        RAISE EXCEPTION 'TaxClassification: a retained deposit is not % / % (TREATMENT_NOT_ALLOWED)', NEW.tax_category, coalesce(NEW.treatment, 'null')
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_deposit_treatment BEFORE INSERT ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_deposit_treatment()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_source_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.tax_year, NEW.refund_of_year, NEW.security_deposit_id, NEW.deposit_closing_date, NEW.deposit_retained_amount)
         IS DISTINCT FROM (OLD.tax_year, OLD.refund_of_year, OLD.security_deposit_id, OLD.deposit_closing_date, OLD.deposit_retained_amount) THEN
        RAISE EXCEPTION 'TaxClassification %: the tax year, the refund year and the source never change (api-design §58A)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_source_fixed BEFORE UPDATE ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_source_fixed()
  `.execute(db);

  // The rent's due day over time (item 1 of the review on #159): each day 1–31; `validFrom` real dates, unique and
  // strictly ascending; at most 20 entries; nothing else in an entry.
  await sql`
    CREATE FUNCTION rental_contract_reference_due_days_valid(days jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE
      entry jsonb;
      valid_from date;
      previous date;
    BEGIN
      IF jsonb_typeof(days) IS DISTINCT FROM 'array' OR jsonb_array_length(days) > 20 THEN
        RETURN false;
      END IF;
      FOR entry IN SELECT e.value FROM jsonb_array_elements(days) WITH ORDINALITY AS e(value, n) ORDER BY e.n LOOP
        IF jsonb_typeof(entry) <> 'object' OR NOT (entry ?& ARRAY['validFrom', 'day']) OR (SELECT count(*) FROM jsonb_object_keys(entry)) <> 2 THEN
          RETURN false;
        END IF;
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
  `.execute(db);
  await sql`
    CREATE FUNCTION rental_contract_reference_texts_valid(texts text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT coalesce(bool_and(length(t) BETWEEN 1 AND 500), true) FROM unnest(texts) AS t
    $$
  `.execute(db);
  await sql`
    CREATE TABLE rental_contract_reference (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      mre_tenant_id text NOT NULL CHECK (mre_tenant_id ~ '^[0-9a-f]{24}$'),
      rent_due_days jsonb NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT rental_contract_reference_due_days CHECK (rental_contract_reference_due_days_valid(rent_due_days)),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      source_references text[] NOT NULL DEFAULT '{}'
        CHECK (cardinality(source_references) <= 10 AND rental_contract_reference_texts_valid(source_references)),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT rental_contract_reference_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT rental_contract_reference_tenant_key UNIQUE (mre_realm_id, mre_tenant_id)
    )
  `.execute(db);
  await sql`
    CREATE FUNCTION rental_contract_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'RentalContractReference %: never deleted; empty its rentDueDays instead (api-design §58A)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.version <> 1 THEN
          RAISE EXCEPTION 'RentalContractReference: only inserted with version 1' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.mre_tenant_id, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM (OLD.id, OLD.mre_realm_id, OLD.mre_tenant_id, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'RentalContractReference %: the Realm, the Tenant and the creation never change (api-design §58A)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- The no-op write (and any write leaving the row as it is) passes.
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'RentalContractReference %: every change raises version by exactly one (% → %)', OLD.id, OLD.version, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER rental_contract_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_contract_reference
      FOR EACH ROW EXECUTE FUNCTION rental_contract_reference_guard()
  `.execute(db);

  await sql`ALTER TABLE weg_economic_plan ADD COLUMN advance_due_day smallint CHECK (advance_due_day BETWEEN 1 AND 31)`.execute(db);
  await sql`
    CREATE FUNCTION weg_economic_plan_advance_due_day_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.advance_due_day IS DISTINCT FROM OLD.advance_due_day THEN
        RAISE EXCEPTION 'WegEconomicPlan %: advance_due_day never changes; a plan is never amended (api-design §49.5)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_economic_plan_advance_due_day_fixed BEFORE UPDATE ON weg_economic_plan
      FOR EACH ROW EXECUTE FUNCTION weg_economic_plan_advance_due_day_fixed()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER weg_economic_plan_advance_due_day_fixed ON weg_economic_plan`.execute(db);
  await sql`DROP FUNCTION weg_economic_plan_advance_due_day_fixed()`.execute(db);
  await sql`ALTER TABLE weg_economic_plan DROP COLUMN advance_due_day`.execute(db);

  await sql`DROP TABLE rental_contract_reference`.execute(db);
  await sql`DROP FUNCTION rental_contract_reference_guard()`.execute(db);
  await sql`DROP FUNCTION rental_contract_reference_texts_valid(text[])`.execute(db);
  await sql`DROP FUNCTION rental_contract_reference_due_days_valid(jsonb)`.execute(db);

  await sql`DROP TRIGGER tax_classification_source_fixed ON tax_classification`.execute(db);
  await sql`DROP TRIGGER tax_classification_deposit_treatment ON tax_classification`.execute(db);
  await sql`DROP TRIGGER tax_classification_deposit_counts ON tax_classification`.execute(db);
  await sql`DROP TRIGGER tax_classification_tax_year ON tax_classification`.execute(db);
  await sql`DROP FUNCTION tax_classification_source_fixed()`.execute(db);
  await sql`DROP FUNCTION tax_classification_deposit_treatment()`.execute(db);
  await sql`DROP FUNCTION tax_classification_deposit_counts()`.execute(db);
  await sql`DROP FUNCTION tax_classification_tax_year()`.execute(db);
  await sql`DROP INDEX tax_classification_deposit_idx`.execute(db);
  await sql`DROP INDEX tax_classification_current_deposit`.execute(db);
  await sql`
    ALTER TABLE tax_classification
      DROP CONSTRAINT tax_classification_deposit_superseded_by_fk,
      DROP CONSTRAINT tax_classification_deposit_supersedes_fk
  `.execute(db);
  // 0045's CHECKs, as 0045 wrote them; they fail while a deposit classification exists.
  await sql`
    ALTER TABLE tax_classification
      DROP CONSTRAINT tax_classification_deposit_chain_key,
      DROP CONSTRAINT tax_classification_deposit_fk,
      DROP CONSTRAINT tax_classification_refund_year,
      DROP CONSTRAINT tax_classification_deposit_fields,
      DROP CONSTRAINT tax_classification_fit,
      ADD CONSTRAINT tax_classification_fit CHECK (
        CASE
          WHEN tax_category IN ('RENT', 'OPERATING_COST_ADVANCES', 'OPERATING_COST_SETTLEMENT', 'OTHER_INCOME') THEN treatment IS NOT DISTINCT FROM 'INCOME'
          WHEN tax_category = 'NOT_RELEVANT' THEN treatment IS NOT DISTINCT FROM 'NOT_RELEVANT'
          WHEN tax_category = 'UNCLASSIFIED' THEN treatment IS NULL
          ELSE treatment IS NOT NULL AND treatment <> 'INCOME'
        END
      ),
      DROP CONSTRAINT tax_classification_one_source,
      ADD CONSTRAINT tax_classification_one_source CHECK (
        num_nonnulls(transaction_split_id) = 1 AND (source_type = 'TRANSACTION_SPLIT') = (transaction_split_id IS NOT NULL)
      ),
      DROP CONSTRAINT tax_classification_tax_category_check,
      ADD CONSTRAINT tax_classification_tax_category_check CHECK (tax_category IN (
        'RENT', 'OPERATING_COST_ADVANCES', 'OPERATING_COST_SETTLEMENT', 'OTHER_INCOME', 'LOAN_INTEREST', 'FINANCING_COSTS', 'WEG_HAUSGELD',
        'WEG_SPENDING', 'MAINTENANCE', 'ADMINISTRATION', 'INSURANCE', 'PROPERTY_TAX', 'BANK_FEES', 'TAX_ADVICE', 'TRAVEL', 'OTHER_EXPENSE',
        'NOT_RELEVANT', 'UNCLASSIFIED')),
      DROP CONSTRAINT tax_classification_source_type_check,
      ADD CONSTRAINT tax_classification_source_type_check CHECK (source_type IN ('TRANSACTION_SPLIT')),
      DROP COLUMN deposit_retained_amount,
      DROP COLUMN deposit_closing_date,
      DROP COLUMN security_deposit_id,
      DROP COLUMN refund_of_year,
      DROP COLUMN tax_year
  `.execute(db);
}

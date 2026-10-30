import { sql, type Kysely } from 'kysely';

/**
 * VC-7-03: WEG spending, Erhaltungsaufwand and § 82b (api-design.md §58B, phase-7-plan P7-D5, P7-D6, data-model §36).
 *
 * - `tax_classification`, the third and fourth source: `weg_annual_statement_id` + `weg_reserve_position` with the
 *   classified `weg_withdrawal_unit_share` (`WEG_RESERVE_WITHDRAWAL`), and `weg_special_assessment_id` +
 *   `weg_use_position` with the classified `weg_use_date` and `weg_use_unit_share` (`WEG_ASSESSMENT_USE`); composite
 *   foreign keys with the Realm; exactly one source column set.
 * - The new fields: `net_amount`, `annually_recurring`, `distribution_years`, `mostly_residential_confirmed`,
 *   `anschaffungsnahe_acquisition_id` (composite foreign key with the Realm) and the second rule reference
 *   `treatment_rule_code` / `treatment_rule_version`.
 * - The CHECKs repeat version 1 of the rules literally (§58B): `DE_WEG_SPENDING@1`'s lines and treatments,
 *   `DE_82B_DISTRIBUTION@1`'s 2–5 years and lines; a later version with other values needs a migration.
 * - One current classification per withdrawal and per use (partial unique indexes); the chain stays within its source.
 * - Guards (before insert, beside 0045's and 0046's, which return early for a source not theirs):
 *   `tax_classification_withdrawal_counts` and `tax_classification_use_counts` write their source row first (a no-op,
 *   P7-D9) and require it counting with the stored amount (SOURCE_NOT_COUNTED); `tax_classification_split_amounts`
 *   (NET_AMOUNT_EXCEEDS_GROSS, DISTRIBUTION_NOT_ALLOWED); `tax_classification_anschaffungsnahe` (the 3-year window,
 *   literally); `tax_classification_weg_source_fixed` (before update): the new columns never change.
 * - VC-X-26: `property_reference_realm_name_idx` and `financial_account_realm_name_idx` for the two name-ordered lists.
 *
 * Nothing on `weg_annual_statement`, `weg_special_assessment`, `acquisition`, `land_building_allocation`, `ownership`,
 * `transaction_split` or `ledger_transaction` changes. `down` refuses while a classification of a WEG source exists,
 * or one with a new field set, then restores 0046's CHECKs and drops what this added.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tax_classification
      ADD COLUMN weg_annual_statement_id uuid,
      ADD COLUMN weg_reserve_position integer CHECK (weg_reserve_position BETWEEN 1 AND 1000),
      ADD COLUMN weg_withdrawal_unit_share numeric CHECK (weg_withdrawal_unit_share > 0 AND scale(weg_withdrawal_unit_share) <= 2),
      ADD COLUMN weg_special_assessment_id uuid,
      ADD COLUMN weg_use_position integer CHECK (weg_use_position BETWEEN 1 AND 1000),
      ADD COLUMN weg_use_date date,
      ADD COLUMN weg_use_unit_share numeric CHECK (weg_use_unit_share > 0 AND scale(weg_use_unit_share) <= 2),
      ADD COLUMN net_amount numeric CHECK (net_amount > 0 AND scale(net_amount) <= 2),
      ADD COLUMN annually_recurring boolean NOT NULL DEFAULT false,
      ADD COLUMN distribution_years smallint,
      ADD COLUMN mostly_residential_confirmed boolean,
      ADD COLUMN anschaffungsnahe_acquisition_id uuid,
      ADD COLUMN treatment_rule_code text CHECK (treatment_rule_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
      ADD COLUMN treatment_rule_version integer CHECK (treatment_rule_version >= 1),
      DROP CONSTRAINT tax_classification_source_type_check,
      ADD CONSTRAINT tax_classification_source_type_check
        CHECK (source_type IN ('TRANSACTION_SPLIT', 'DEPOSIT_CLOSING', 'WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE')),
      DROP CONSTRAINT tax_classification_one_source,
      ADD CONSTRAINT tax_classification_one_source CHECK (
        num_nonnulls(transaction_split_id, security_deposit_id, weg_annual_statement_id, weg_special_assessment_id) = 1
          AND (source_type = 'TRANSACTION_SPLIT') = (transaction_split_id IS NOT NULL)
          AND (source_type = 'DEPOSIT_CLOSING') = (security_deposit_id IS NOT NULL)
          AND (source_type = 'WEG_RESERVE_WITHDRAWAL') = (weg_annual_statement_id IS NOT NULL)
          AND (source_type = 'WEG_ASSESSMENT_USE') = (weg_special_assessment_id IS NOT NULL)
      ),
      ADD CONSTRAINT tax_classification_weg_source_fields CHECK (
        (weg_annual_statement_id IS NOT NULL) = (weg_reserve_position IS NOT NULL)
          AND (weg_annual_statement_id IS NOT NULL) = (weg_withdrawal_unit_share IS NOT NULL)
          AND (weg_special_assessment_id IS NOT NULL) = (weg_use_position IS NOT NULL)
          AND (weg_special_assessment_id IS NOT NULL) = (weg_use_date IS NOT NULL)
          AND (weg_special_assessment_id IS NOT NULL) = (weg_use_unit_share IS NOT NULL)
          AND ((weg_annual_statement_id IS NULL AND weg_special_assessment_id IS NULL) OR refund_of_year IS NULL)
          AND (weg_special_assessment_id IS NULL OR tax_year IS NULL)
      ),
      -- DE_WEG_SPENDING@1 (§58B): WEG_SPENDING with DEDUCTIBLE, DISTRIBUTED_82B or CAPITALIZED, or NOT_RELEVANT with
      -- NOT_RELEVANT; WEG_SPENDING on a WEG source only.
      ADD CONSTRAINT tax_classification_weg_lines CHECK (
        CASE
          WHEN source_type IN ('WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE') THEN
            (tax_category = 'WEG_SPENDING' AND treatment IN ('DEDUCTIBLE', 'DISTRIBUTED_82B', 'CAPITALIZED'))
              OR (tax_category = 'NOT_RELEVANT' AND treatment = 'NOT_RELEVANT')
          ELSE tax_category <> 'WEG_SPENDING'
        END
      ),
      DROP CONSTRAINT tax_classification_fit,
      ADD CONSTRAINT tax_classification_fit CHECK (
        CASE
          WHEN tax_category IN ('RENT', 'OPERATING_COST_ADVANCES', 'OPERATING_COST_SETTLEMENT', 'OTHER_INCOME', 'REFUNDS_OF_EARLIER_YEARS',
                                'RETAINED_DEPOSIT_RENT', 'RETAINED_DEPOSIT_DAMAGES') THEN treatment IS NOT DISTINCT FROM 'INCOME'
          WHEN tax_category = 'NOT_RELEVANT' THEN treatment IS NOT DISTINCT FROM 'NOT_RELEVANT'
          WHEN tax_category = 'UNCLASSIFIED' THEN treatment IS NULL
          WHEN treatment = 'DISTRIBUTED_82B' THEN tax_category IN ('MAINTENANCE', 'WEG_SPENDING')
          ELSE treatment IS NOT NULL AND treatment <> 'INCOME'
        END
      ),
      -- DE_82B_DISTRIBUTION@1: 2 to 5 years, confirmed mostly residential, both exactly with the election.
      ADD CONSTRAINT tax_classification_distribution CHECK (
        (treatment IS NOT DISTINCT FROM 'DISTRIBUTED_82B') = (distribution_years IS NOT NULL)
          AND (treatment IS NOT DISTINCT FROM 'DISTRIBUTED_82B') = (mostly_residential_confirmed IS NOT NULL)
          AND (distribution_years IS NULL OR distribution_years BETWEEN 2 AND 5)
          AND (mostly_residential_confirmed IS NULL OR mostly_residential_confirmed)
      ),
      ADD CONSTRAINT tax_classification_erhaltung_fields CHECK (
        ((net_amount IS NULL AND NOT annually_recurring) OR tax_category IN ('MAINTENANCE', 'WEG_SPENDING'))
          AND (net_amount IS NULL OR net_amount <= coalesce(weg_withdrawal_unit_share, weg_use_unit_share, net_amount))
      ),
      ADD CONSTRAINT tax_classification_anschaffungsnahe_fields CHECK (
        anschaffungsnahe_acquisition_id IS NULL OR (treatment = 'CAPITALIZED' AND tax_category IN ('MAINTENANCE', 'WEG_SPENDING'))
      ),
      ADD CONSTRAINT tax_classification_treatment_rule CHECK (
        (treatment_rule_code IS NULL) = (treatment_rule_version IS NULL)
          AND CASE
                WHEN treatment = 'DISTRIBUTED_82B' THEN treatment_rule_code IS NOT DISTINCT FROM 'DE_82B_DISTRIBUTION'
                WHEN anschaffungsnahe_acquisition_id IS NOT NULL THEN treatment_rule_code IS NOT DISTINCT FROM 'DE_ANSCHAFFUNGSNAHE'
                ELSE treatment_rule_code IS NULL
              END
      ),
      ADD CONSTRAINT tax_classification_statement_fk FOREIGN KEY (weg_annual_statement_id, mre_realm_id)
        REFERENCES weg_annual_statement (id, mre_realm_id),
      ADD CONSTRAINT tax_classification_assessment_fk FOREIGN KEY (weg_special_assessment_id, mre_realm_id)
        REFERENCES weg_special_assessment (id, mre_realm_id),
      ADD CONSTRAINT tax_classification_acquisition_fk FOREIGN KEY (anschaffungsnahe_acquisition_id, mre_realm_id)
        REFERENCES acquisition (id, mre_realm_id),
      ADD CONSTRAINT tax_classification_withdrawal_chain_key UNIQUE (id, weg_annual_statement_id, weg_reserve_position),
      ADD CONSTRAINT tax_classification_withdrawal_supersedes_fk FOREIGN KEY (supersedes_id, weg_annual_statement_id, weg_reserve_position)
        REFERENCES tax_classification (id, weg_annual_statement_id, weg_reserve_position),
      ADD CONSTRAINT tax_classification_withdrawal_superseded_by_fk FOREIGN KEY (superseded_by, weg_annual_statement_id, weg_reserve_position)
        REFERENCES tax_classification (id, weg_annual_statement_id, weg_reserve_position) DEFERRABLE INITIALLY DEFERRED,
      ADD CONSTRAINT tax_classification_use_chain_key UNIQUE (id, weg_special_assessment_id, weg_use_position),
      ADD CONSTRAINT tax_classification_use_supersedes_fk FOREIGN KEY (supersedes_id, weg_special_assessment_id, weg_use_position)
        REFERENCES tax_classification (id, weg_special_assessment_id, weg_use_position),
      ADD CONSTRAINT tax_classification_use_superseded_by_fk FOREIGN KEY (superseded_by, weg_special_assessment_id, weg_use_position)
        REFERENCES tax_classification (id, weg_special_assessment_id, weg_use_position) DEFERRABLE INITIALLY DEFERRED
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX tax_classification_current_withdrawal ON tax_classification (weg_annual_statement_id, weg_reserve_position)
      WHERE superseded_at IS NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX tax_classification_current_use ON tax_classification (weg_special_assessment_id, weg_use_position) WHERE superseded_at IS NULL
  `.execute(db);
  await sql`CREATE INDEX tax_classification_withdrawal_idx ON tax_classification (weg_annual_statement_id, weg_reserve_position, created_at, id)`.execute(db);
  await sql`CREATE INDEX tax_classification_use_idx ON tax_classification (weg_special_assessment_id, weg_use_position, created_at, id)`.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_withdrawal_counts() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      st record;
      line jsonb;
      w numeric;
      n numeric;
      d numeric;
      s numeric;
    BEGIN
      IF NEW.weg_annual_statement_id IS NULL THEN
        RETURN NEW;
      END IF;
      -- Statement → classification (P7-D9): a confirm superseding it waits, or this waits for it; under REPEATABLE READ
      -- the later one fails to serialise. Written, never only read (0042's frozen guard lets the no-op pass).
      UPDATE weg_annual_statement SET version = version WHERE id = NEW.weg_annual_statement_id AND mre_realm_id = NEW.mre_realm_id
       RETURNING id, status, reserve, membership_id, period_from, period_until INTO st;
      IF st.id IS NULL THEN
        RETURN NEW; -- an unknown statement, or one of another Realm, is left to the foreign key
      END IF;
      IF st.status <> 'CONFIRMED' THEN
        RAISE EXCEPTION 'TaxClassification: WEG annual statement % is %, not current (SOURCE_NOT_COUNTED)', st.id, st.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT l INTO line FROM jsonb_array_elements(coalesce(st.reserve -> 'lines', '[]'::jsonb)) AS l
       WHERE (l ->> 'position')::integer = NEW.weg_reserve_position;
      IF line IS NULL OR line ->> 'kind' IS DISTINCT FROM 'WITHDRAWAL' OR jsonb_typeof(line -> 'withdrawal') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'TaxClassification: reserve line % of statement % is not a withdrawal (SOURCE_NOT_COUNTED)', NEW.weg_reserve_position, st.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT mea_numerator * 1000, mea_denominator * 1000 INTO n, d FROM weg_membership WHERE id = st.membership_id;
      w := (line -> 'withdrawal' ->> 'amount')::numeric * 100;
      s := NEW.weg_withdrawal_unit_share * 100;
      -- s is the half-up rounding of w·n/d exactly when (2s − 1)·d ≤ 2·w·n < (2s + 1)·d: no division rounds.
      IF w <= 0 OR NOT ((2 * s - 1) * d <= 2 * w * n AND 2 * w * n < (2 * s + 1) * d) THEN
        RAISE EXCEPTION 'TaxClassification: % is not the unit share of withdrawal % (SOURCE_NOT_COUNTED)', NEW.weg_withdrawal_unit_share, NEW.weg_reserve_position
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- An undated withdrawal's tax year: a calendar year its period touches; a dated one has its own.
      IF NEW.tax_year IS NOT NULL AND (line ? 'date' OR NEW.tax_year NOT IN (extract(year FROM st.period_from), extract(year FROM st.period_until))) THEN
        RAISE EXCEPTION 'TaxClassification: tax_year % is not a year of the period of an undated withdrawal (TAX_YEAR_OUT_OF_RANGE)', NEW.tax_year
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_withdrawal_counts BEFORE INSERT ON tax_classification
      FOR EACH ROW EXECUTE FUNCTION tax_classification_withdrawal_counts()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_use_counts() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      a record;
      used jsonb;
    BEGIN
      IF NEW.weg_special_assessment_id IS NULL THEN
        RETURN NEW;
      END IF;
      -- Assessment → classification (P7-D9): a replace of the uses or a void waits, or this waits for it. Written,
      -- never only read (0044's frozen guard lets the no-op pass).
      UPDATE weg_special_assessment SET version = version WHERE id = NEW.weg_special_assessment_id AND mre_realm_id = NEW.mre_realm_id
       RETURNING id, status, uses INTO a;
      IF a.id IS NULL THEN
        RETURN NEW;
      END IF;
      IF a.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'TaxClassification: WEG special assessment % is % (SOURCE_NOT_COUNTED)', a.id, a.status USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT u INTO used FROM jsonb_array_elements(a.uses) AS u WHERE (u ->> 'position')::integer = NEW.weg_use_position;
      IF used IS NULL OR (used ->> 'date')::date IS DISTINCT FROM NEW.weg_use_date
         OR (used -> 'unitShare' ->> 'amount')::numeric IS DISTINCT FROM NEW.weg_use_unit_share THEN
        RAISE EXCEPTION 'TaxClassification: use % of assessment % is not (%, %) (SOURCE_NOT_COUNTED)', NEW.weg_use_position, a.id, NEW.weg_use_date,
          NEW.weg_use_unit_share USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_use_counts BEFORE INSERT ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_use_counts()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_split_amounts() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      sp record;
    BEGIN
      IF NEW.transaction_split_id IS NULL OR (NEW.net_amount IS NULL AND NEW.treatment IS DISTINCT FROM 'DISTRIBUTED_82B') THEN
        RETURN NEW;
      END IF;
      SELECT s.amount, t.direction INTO sp FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id WHERE s.id = NEW.transaction_split_id;
      IF sp.amount IS NULL THEN
        RETURN NEW;
      END IF;
      IF NEW.net_amount > sp.amount THEN
        RAISE EXCEPTION 'TaxClassification: net_amount % exceeds the split''s gross amount % (NET_AMOUNT_EXCEEDS_GROSS)', NEW.net_amount, sp.amount
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.treatment = 'DISTRIBUTED_82B' AND sp.direction <> 'OUTFLOW' THEN
        RAISE EXCEPTION 'TaxClassification: only an OUTFLOW is distributed (DISTRIBUTION_NOT_ALLOWED)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_split_amounts BEFORE INSERT ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_split_amounts()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_anschaffungsnahe() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      acq record;
      source_reference uuid;
      source_date date;
      st record;
      line jsonb;
    BEGIN
      IF NEW.anschaffungsnahe_acquisition_id IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT id, status, property_reference_id, coalesce(economic_transfer_date, contract_date) AS transfer_date INTO acq
        FROM acquisition WHERE id = NEW.anschaffungsnahe_acquisition_id AND mre_realm_id = NEW.mre_realm_id;
      IF acq.id IS NULL THEN
        RETURN NEW; -- left to the foreign key
      END IF;
      IF NEW.transaction_split_id IS NOT NULL THEN
        SELECT s.property_reference_id, t.booking_date INTO source_reference, source_date
          FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id WHERE s.id = NEW.transaction_split_id;
      ELSIF NEW.weg_annual_statement_id IS NOT NULL THEN
        SELECT st0.reserve, st0.period_until, m.property_reference_id AS pr INTO st
          FROM weg_annual_statement st0 JOIN weg_membership m ON m.id = st0.membership_id WHERE st0.id = NEW.weg_annual_statement_id;
        SELECT l INTO line FROM jsonb_array_elements(coalesce(st.reserve -> 'lines', '[]'::jsonb)) AS l
         WHERE (l ->> 'position')::integer = NEW.weg_reserve_position;
        source_reference := st.pr;
        source_date := coalesce((line ->> 'date')::date, st.period_until);
      ELSIF NEW.weg_special_assessment_id IS NOT NULL THEN
        SELECT m.property_reference_id INTO source_reference
          FROM weg_special_assessment a JOIN weg_membership m ON m.id = a.membership_id WHERE a.id = NEW.weg_special_assessment_id;
        source_date := NEW.weg_use_date;
      END IF;
      -- DE_ANSCHAFFUNGSNAHE@1 (§58B): the window is the transfer date to three years later, both inclusive.
      IF acq.status <> 'CONFIRMED' OR acq.property_reference_id IS DISTINCT FROM source_reference
         OR source_date IS NULL OR source_date < acq.transfer_date OR source_date > acq.transfer_date + interval '3 years' THEN
        RAISE EXCEPTION 'TaxClassification: Acquisition % is % and does not hold the source of % (ANSCHAFFUNGSNAHE_NOT_APPLICABLE)', acq.id, acq.status, source_date
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_anschaffungsnahe BEFORE INSERT ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_anschaffungsnahe()
  `.execute(db);

  await sql`
    CREATE FUNCTION tax_classification_weg_source_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.weg_annual_statement_id, NEW.weg_reserve_position, NEW.weg_withdrawal_unit_share, NEW.weg_special_assessment_id, NEW.weg_use_position,
          NEW.weg_use_date, NEW.weg_use_unit_share, NEW.net_amount, NEW.annually_recurring, NEW.distribution_years, NEW.mostly_residential_confirmed,
          NEW.anschaffungsnahe_acquisition_id, NEW.treatment_rule_code, NEW.treatment_rule_version)
         IS DISTINCT FROM
         (OLD.weg_annual_statement_id, OLD.weg_reserve_position, OLD.weg_withdrawal_unit_share, OLD.weg_special_assessment_id, OLD.weg_use_position,
          OLD.weg_use_date, OLD.weg_use_unit_share, OLD.net_amount, OLD.annually_recurring, OLD.distribution_years, OLD.mostly_residential_confirmed,
          OLD.anschaffungsnahe_acquisition_id, OLD.treatment_rule_code, OLD.treatment_rule_version) THEN
        RAISE EXCEPTION 'TaxClassification %: the WEG source and the fields of §58B never change (api-design §58B)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tax_classification_weg_source_fixed BEFORE UPDATE ON tax_classification FOR EACH ROW EXECUTE FUNCTION tax_classification_weg_source_fixed()
  `.execute(db);

  // VC-X-26 (§23.3, §29.3): the order of the two lists, as party_realm_name_idx (0016) serves the Party list.
  await sql`CREATE INDEX property_reference_realm_name_idx ON property_reference (mre_realm_id, lower(display_name), created_at, id)`.execute(db);
  await sql`CREATE INDEX financial_account_realm_name_idx ON financial_account (mre_realm_id, lower(display_name), created_at, id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM tax_classification
         WHERE source_type IN ('WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE') OR net_amount IS NOT NULL OR annually_recurring
            OR distribution_years IS NOT NULL OR mostly_residential_confirmed IS NOT NULL OR anschaffungsnahe_acquisition_id IS NOT NULL
            OR treatment_rule_code IS NOT NULL OR treatment = 'DISTRIBUTED_82B' OR tax_category = 'WEG_SPENDING'
      ) THEN
        RAISE EXCEPTION 'down 0047: a classification of a WEG source, or with a field of §58B, exists; 0046 cannot hold it'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP INDEX financial_account_realm_name_idx`.execute(db);
  await sql`DROP INDEX property_reference_realm_name_idx`.execute(db);
  await sql`DROP TRIGGER tax_classification_weg_source_fixed ON tax_classification`.execute(db);
  await sql`DROP TRIGGER tax_classification_anschaffungsnahe ON tax_classification`.execute(db);
  await sql`DROP TRIGGER tax_classification_split_amounts ON tax_classification`.execute(db);
  await sql`DROP TRIGGER tax_classification_use_counts ON tax_classification`.execute(db);
  await sql`DROP TRIGGER tax_classification_withdrawal_counts ON tax_classification`.execute(db);
  await sql`DROP FUNCTION tax_classification_weg_source_fixed()`.execute(db);
  await sql`DROP FUNCTION tax_classification_anschaffungsnahe()`.execute(db);
  await sql`DROP FUNCTION tax_classification_split_amounts()`.execute(db);
  await sql`DROP FUNCTION tax_classification_use_counts()`.execute(db);
  await sql`DROP FUNCTION tax_classification_withdrawal_counts()`.execute(db);
  await sql`DROP INDEX tax_classification_use_idx`.execute(db);
  await sql`DROP INDEX tax_classification_withdrawal_idx`.execute(db);
  await sql`DROP INDEX tax_classification_current_use`.execute(db);
  await sql`DROP INDEX tax_classification_current_withdrawal`.execute(db);
  await sql`
    ALTER TABLE tax_classification
      DROP CONSTRAINT tax_classification_use_superseded_by_fk,
      DROP CONSTRAINT tax_classification_use_supersedes_fk,
      DROP CONSTRAINT tax_classification_withdrawal_superseded_by_fk,
      DROP CONSTRAINT tax_classification_withdrawal_supersedes_fk
  `.execute(db);
  // 0046's CHECKs, as 0046 wrote them.
  await sql`
    ALTER TABLE tax_classification
      DROP CONSTRAINT tax_classification_use_chain_key,
      DROP CONSTRAINT tax_classification_withdrawal_chain_key,
      DROP CONSTRAINT tax_classification_acquisition_fk,
      DROP CONSTRAINT tax_classification_assessment_fk,
      DROP CONSTRAINT tax_classification_statement_fk,
      DROP CONSTRAINT tax_classification_treatment_rule,
      DROP CONSTRAINT tax_classification_anschaffungsnahe_fields,
      DROP CONSTRAINT tax_classification_erhaltung_fields,
      DROP CONSTRAINT tax_classification_distribution,
      DROP CONSTRAINT tax_classification_weg_lines,
      DROP CONSTRAINT tax_classification_weg_source_fields,
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
      DROP CONSTRAINT tax_classification_one_source,
      ADD CONSTRAINT tax_classification_one_source CHECK (
        num_nonnulls(transaction_split_id, security_deposit_id) = 1
          AND (source_type = 'TRANSACTION_SPLIT') = (transaction_split_id IS NOT NULL)
          AND (source_type = 'DEPOSIT_CLOSING') = (security_deposit_id IS NOT NULL)
      ),
      DROP CONSTRAINT tax_classification_source_type_check,
      ADD CONSTRAINT tax_classification_source_type_check CHECK (source_type IN ('TRANSACTION_SPLIT', 'DEPOSIT_CLOSING')),
      DROP COLUMN treatment_rule_version,
      DROP COLUMN treatment_rule_code,
      DROP COLUMN anschaffungsnahe_acquisition_id,
      DROP COLUMN mostly_residential_confirmed,
      DROP COLUMN distribution_years,
      DROP COLUMN annually_recurring,
      DROP COLUMN net_amount,
      DROP COLUMN weg_use_unit_share,
      DROP COLUMN weg_use_date,
      DROP COLUMN weg_use_position,
      DROP COLUMN weg_special_assessment_id,
      DROP COLUMN weg_withdrawal_unit_share,
      DROP COLUMN weg_reserve_position,
      DROP COLUMN weg_annual_statement_id
  `.execute(db);
}

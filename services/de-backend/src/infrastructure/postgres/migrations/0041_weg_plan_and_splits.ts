import { sql, type Kysely } from 'kysely';

/**
 * VC-6-02: WEG splits name their unit, the category type `WEG_FUNDS`, and the Wirtschaftsplan (api-design.md
 * §49.3–§49.5, phase-6-plan P6-D2…D4, P6-D9).
 *
 * - `WEG_FUNDS` joins the `category_type` CHECK of 0008; `WEG_RESERVE_CONTRIBUTION` moves to it (P6-D3, retroactive on
 *   purpose: the type belongs to the category). `down` moves it back.
 * - `weg_membership_source_references`: every entry is 1–500 characters (review on #145), by an IMMUTABLE function.
 * - `ledger_transaction_weg_booking_date` (before update of `booking_date`, as 0029's Loan guard): the WEG splits a
 *   Transaction keeps need their unit's membership on the new date (review on #147).
 * - `transaction_split_weg` (before insert or update on `transaction_split`, after the other split guards by name):
 *   a split in a WEG category on a Transaction that is not a reversal names a unit (NO_WEG_MEMBERSHIP), first writes
 *   the unit's PropertyReference row (a no-op; Transaction → PropertyReference), then needs an `ACTIVE` membership of
 *   the unit on the booking date (NO_WEG_MEMBERSHIP).
 * - `weg_economic_plan`: the unit's Wirtschaftsplan per membership and `effective_from`; at most one `ACTIVE` per
 *   membership and day. `weg_economic_plan_membership` (before insert) first writes the PropertyReference, then the
 *   WEG (no-op; WEG_HAS_YEARS serialises with it, review on #147), then needs
 *   the membership `ACTIVE` and `effective_from` inside its period and inside the financial year.
 *   `weg_economic_plan_frozen`: only `ACTIVE` → `VOID`, with its fields and `version` + 1; P3-D8's no-op passes.
 * - `weg_membership_guard` (before update of `valid_until` or `status` on `weg_membership`): **first** writes the
 *   PropertyReference (0040's write runs AFTER, so a BEFORE check without it would read before waiting on a
 *   concurrent split or plan writer, review on #146), then refuses an end or void that leaves a WEG split of the unit
 *   (MEMBERSHIP_HAS_SPLITS) or an `ACTIVE` plan (MEMBERSHIP_HAS_PLANS) outside the remaining period.
 * - `weg_financial_year_held` (before update of `financial_year_start_month` on `weg`): refused while a membership of
 *   the WEG has an `ACTIVE` plan (WEG_HAS_YEARS); plans are filed by financial year.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE financial_category DROP CONSTRAINT financial_category_category_type_check`.execute(db);
  await sql`
    ALTER TABLE financial_category ADD CONSTRAINT financial_category_category_type_check
      CHECK (category_type IN ('INCOME', 'OPERATING_EXPENSE', 'FINANCING', 'CAPITAL_MOVEMENT', 'SECURITY_DEPOSIT', 'TRANSFER', 'WEG_FUNDS', 'OTHER'))
  `.execute(db);
  await sql`UPDATE financial_category SET category_type = 'WEG_FUNDS' WHERE code = 'WEG_RESERVE_CONTRIBUTION'`.execute(db);

  await sql`
    CREATE FUNCTION weg_texts_valid(texts text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT coalesce(bool_and(length(t) BETWEEN 1 AND 500), true) FROM unnest(texts) AS t
    $$
  `.execute(db);
  await sql`ALTER TABLE weg_membership ADD CONSTRAINT weg_membership_source_references_length CHECK (weg_texts_valid(source_references))`.execute(db);
  await sql`ALTER TABLE weg_membership ADD CONSTRAINT weg_membership_realm_key UNIQUE (id, mre_realm_id)`.execute(db);

  await sql`
    CREATE FUNCTION transaction_split_weg() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      category text;
      tx record;
    BEGIN
      SELECT code INTO category FROM financial_category WHERE id = NEW.financial_category_id;
      IF category NOT IN ('WEG_RECOVERABLE', 'WEG_NON_RECOVERABLE', 'WEG_RESERVE_CONTRIBUTION') THEN
        RETURN NEW;
      END IF;
      SELECT booking_date, correction_role INTO tx FROM ledger_transaction WHERE id = NEW.transaction_id;
      -- A reversal mirrors its original's splits, which may predate Phase 6 (§49.3).
      IF tx.correction_role IS NOT DISTINCT FROM 'REVERSAL' THEN
        RETURN NEW;
      END IF;
      IF NEW.property_reference_id IS NULL THEN
        RAISE EXCEPTION 'TransactionSplit: a % split names its unit (NO_WEG_MEMBERSHIP)', category USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- Transaction → PropertyReference: serialises with an end or void of the unit's membership (§49.3).
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      IF NOT EXISTS (
        SELECT 1 FROM weg_membership m
         WHERE m.property_reference_id = NEW.property_reference_id AND m.status = 'ACTIVE'
           AND tx.booking_date <@ daterange(m.valid_from, m.valid_until, '[]')
      ) THEN
        RAISE EXCEPTION 'TransactionSplit: unit % has no WEG membership on % (NO_WEG_MEMBERSHIP)', NEW.property_reference_id, tx.booking_date
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER transaction_split_weg BEFORE INSERT OR UPDATE ON transaction_split
      FOR EACH ROW EXECUTE FUNCTION transaction_split_weg()
  `.execute(db);

  await sql`
    CREATE FUNCTION ledger_transaction_weg_booking_date() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      unit uuid;
    BEGIN
      IF NEW.correction_role IS NOT DISTINCT FROM 'REVERSAL' THEN
        RETURN NEW;
      END IF;
      -- The kept WEG splits need their unit's membership on the new date (review on #147); units in id order, each
      -- written first (Transaction → PropertyReference), as transaction_split_weg does.
      FOR unit IN
        SELECT DISTINCT s.property_reference_id FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id
         WHERE s.transaction_id = NEW.id AND s.property_reference_id IS NOT NULL
           AND c.code IN ('WEG_RECOVERABLE', 'WEG_NON_RECOVERABLE', 'WEG_RESERVE_CONTRIBUTION')
         ORDER BY 1
      LOOP
        UPDATE property_reference SET version = version WHERE id = unit;
        IF NOT EXISTS (
          SELECT 1 FROM weg_membership m WHERE m.property_reference_id = unit AND m.status = 'ACTIVE'
             AND NEW.booking_date <@ daterange(m.valid_from, m.valid_until, '[]')
        ) THEN
          RAISE EXCEPTION 'Transaction %: unit % has no WEG membership on % (NO_WEG_MEMBERSHIP)', NEW.id, unit, NEW.booking_date
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_transaction_weg_booking_date BEFORE UPDATE OF booking_date ON ledger_transaction
      FOR EACH ROW WHEN (OLD.booking_date IS DISTINCT FROM NEW.booking_date) EXECUTE FUNCTION ledger_transaction_weg_booking_date()
  `.execute(db);

  await sql`
    CREATE TABLE weg_economic_plan (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      membership_id uuid NOT NULL,
      financial_year integer NOT NULL CHECK (financial_year BETWEEN 1900 AND 2200),
      effective_from date NOT NULL,
      resolution_date date,
      monthly_hausgeld numeric NOT NULL CHECK (scale(monthly_hausgeld) <= 2 AND monthly_hausgeld >= 0 AND monthly_hausgeld < 1e15),
      monthly_reserve_contribution numeric NOT NULL
        CHECK (scale(monthly_reserve_contribution) <= 2 AND monthly_reserve_contribution >= 0 AND monthly_reserve_contribution < 1e15),
      recoverable_costs numeric NOT NULL CHECK (scale(recoverable_costs) <= 2 AND recoverable_costs >= 0 AND recoverable_costs < 1e15),
      non_recoverable_costs numeric NOT NULL CHECK (scale(non_recoverable_costs) <= 2 AND non_recoverable_costs >= 0 AND non_recoverable_costs < 1e15),
      income numeric CHECK (scale(income) <= 2 AND income >= 0 AND income < 1e15),
      annual_reserve_contribution numeric
        CHECK (scale(annual_reserve_contribution) <= 2 AND annual_reserve_contribution >= 0 AND annual_reserve_contribution < 1e15),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      cost_lines jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(cost_lines) = 'array' AND jsonb_array_length(cost_lines) <= 100),
      status text NOT NULL CHECK (status IN ('ACTIVE', 'VOID')),
      voided_at timestamptz,
      voided_by text,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      source_references text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_references) <= 10 AND weg_texts_valid(source_references)),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT weg_economic_plan_membership_fk FOREIGN KEY (membership_id, mre_realm_id) REFERENCES weg_membership (id, mre_realm_id),
      CONSTRAINT weg_economic_plan_monthly CHECK (monthly_hausgeld > 0 OR monthly_reserve_contribution > 0),
      CONSTRAINT weg_economic_plan_void_fields CHECK (
        (status = 'VOID') = (voided_at IS NOT NULL) AND (status = 'VOID') = (voided_by IS NOT NULL) AND (status = 'VOID') = (void_reason IS NOT NULL)
      )
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX weg_economic_plan_day_key ON weg_economic_plan (membership_id, effective_from) WHERE status = 'ACTIVE'`.execute(db);
  await sql`CREATE INDEX weg_economic_plan_membership_idx ON weg_economic_plan (membership_id, effective_from, created_at, id)`.execute(db);

  await sql`
    CREATE FUNCTION weg_economic_plan_membership() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      m record;
      year_start date;
      start_month smallint;
    BEGIN
      SELECT wm.property_reference_id, wm.status, wm.valid_from, wm.valid_until, w.financial_year_start_month AS start_month INTO m
        FROM weg_membership wm JOIN weg w ON w.id = wm.weg_id WHERE wm.id = NEW.membership_id;
      IF m.property_reference_id IS NULL THEN
        RETURN NEW; -- an unknown membership is left to the foreign key
      END IF;
      -- First the unit, as every membership writer: an end or void of the membership waits, or this waits for it.
      UPDATE property_reference SET version = version WHERE id = m.property_reference_id;
      -- Then the WEG (a no-op), so a concurrent amend of the start month waits or is waited for (WEG_HAS_YEARS, review
      -- on #147); the start month is read under that lock.
      UPDATE weg SET version = version WHERE id = (SELECT weg_id FROM weg_membership WHERE id = NEW.membership_id)
        RETURNING financial_year_start_month INTO start_month;
      SELECT wm.status, wm.valid_from, wm.valid_until INTO m FROM weg_membership wm WHERE wm.id = NEW.membership_id;
      IF m.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'WegEconomicPlan: membership % is % (MEMBERSHIP_NOT_ACTIVE)', NEW.membership_id, m.status USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NOT (NEW.effective_from <@ daterange(m.valid_from, m.valid_until, '[]')) THEN
        RAISE EXCEPTION 'WegEconomicPlan: % is outside membership % (PLAN_OUTSIDE_MEMBERSHIP)', NEW.effective_from, NEW.membership_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      year_start := make_date(NEW.financial_year, start_month, 1);
      IF NOT (NEW.effective_from <@ daterange(year_start, (year_start + interval '1 year')::date, '[)')) THEN
        RAISE EXCEPTION 'WegEconomicPlan: % is outside the financial year % (EFFECTIVE_FROM_OUTSIDE_YEAR)', NEW.effective_from, NEW.financial_year
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_economic_plan_membership BEFORE INSERT ON weg_economic_plan FOR EACH ROW EXECUTE FUNCTION weg_economic_plan_membership()
  `.execute(db);

  await sql`
    CREATE FUNCTION weg_economic_plan_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'VOID' THEN
        RAISE EXCEPTION 'WegEconomicPlan %: VOID is final (api-design §49.5)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NOT (NEW.status = 'VOID' AND NEW.version = OLD.version + 1
              AND (NEW.id, NEW.mre_realm_id, NEW.membership_id, NEW.financial_year, NEW.effective_from, NEW.resolution_date, NEW.monthly_hausgeld,
                   NEW.monthly_reserve_contribution, NEW.recoverable_costs, NEW.non_recoverable_costs, NEW.income, NEW.annual_reserve_contribution,
                   NEW.currency, NEW.cost_lines, NEW.source_references, NEW.notes, NEW.created_at, NEW.created_by)
                  IS NOT DISTINCT FROM
                  (OLD.id, OLD.mre_realm_id, OLD.membership_id, OLD.financial_year, OLD.effective_from, OLD.resolution_date, OLD.monthly_hausgeld,
                   OLD.monthly_reserve_contribution, OLD.recoverable_costs, OLD.non_recoverable_costs, OLD.income, OLD.annual_reserve_contribution,
                   OLD.currency, OLD.cost_lines, OLD.source_references, OLD.notes, OLD.created_at, OLD.created_by)) THEN
        RAISE EXCEPTION 'WegEconomicPlan %: only ACTIVE → VOID, version + 1, nothing else changes (api-design §49.5)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER weg_economic_plan_frozen BEFORE UPDATE ON weg_economic_plan FOR EACH ROW EXECUTE FUNCTION weg_economic_plan_frozen()`.execute(db);
  await sql`CREATE TRIGGER weg_economic_plan_initial BEFORE INSERT ON weg_economic_plan FOR EACH ROW EXECUTE FUNCTION weg_initial()`.execute(db);
  await sql`CREATE TRIGGER weg_economic_plan_no_delete BEFORE DELETE ON weg_economic_plan FOR EACH ROW EXECUTE FUNCTION weg_no_delete()`.execute(db);

  await sql`
    CREATE FUNCTION weg_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      kept daterange;
      old_period daterange := daterange(OLD.valid_from, OLD.valid_until, '[]');
      held uuid;
    BEGIN
      IF OLD.status <> 'ACTIVE' OR (NEW.status, NEW.valid_until) IS NOT DISTINCT FROM (OLD.status, OLD.valid_until) THEN
        RETURN NEW;
      END IF;
      -- First the unit: a concurrent split or plan writer is waited for and seen (review on #146).
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      kept := CASE WHEN NEW.status = 'VOID' THEN 'empty'::daterange ELSE daterange(NEW.valid_from, NEW.valid_until, '[]') END;
      SELECT s.transaction_id INTO held FROM transaction_split s
        JOIN financial_category c ON c.id = s.financial_category_id
        JOIN ledger_transaction t ON t.id = s.transaction_id
       WHERE s.property_reference_id = NEW.property_reference_id
         AND c.code IN ('WEG_RECOVERABLE', 'WEG_NON_RECOVERABLE', 'WEG_RESERVE_CONTRIBUTION')
         AND t.booking_date <@ old_period AND NOT (t.booking_date <@ kept)
       LIMIT 1;
      IF held IS NOT NULL THEN
        RAISE EXCEPTION 'WegMembership %: Transaction % has a WEG split of the unit outside the remaining period (MEMBERSHIP_HAS_SPLITS)', OLD.id, held
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT p.id INTO held FROM weg_economic_plan p
       WHERE p.membership_id = OLD.id AND p.status = 'ACTIVE' AND NOT (p.effective_from <@ kept)
       LIMIT 1;
      IF held IS NOT NULL THEN
        RAISE EXCEPTION 'WegMembership %: plan % lies outside the remaining period (MEMBERSHIP_HAS_PLANS)', OLD.id, held
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_membership_guard BEFORE UPDATE OF valid_until, status ON weg_membership FOR EACH ROW EXECUTE FUNCTION weg_membership_guard()
  `.execute(db);

  await sql`
    CREATE FUNCTION weg_financial_year_held() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.financial_year_start_month IS DISTINCT FROM OLD.financial_year_start_month AND EXISTS (
        SELECT 1 FROM weg_economic_plan p JOIN weg_membership m ON m.id = p.membership_id WHERE m.weg_id = OLD.id AND p.status = 'ACTIVE'
      ) THEN
        RAISE EXCEPTION 'WEG %: plans are filed by financial year (WEG_HAS_YEARS)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_financial_year_held BEFORE UPDATE OF financial_year_start_month ON weg FOR EACH ROW EXECUTE FUNCTION weg_financial_year_held()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER weg_financial_year_held ON weg`.execute(db);
  await sql`DROP FUNCTION weg_financial_year_held()`.execute(db);
  await sql`DROP TRIGGER weg_membership_guard ON weg_membership`.execute(db);
  await sql`DROP FUNCTION weg_membership_guard()`.execute(db);
  await sql`DROP TABLE weg_economic_plan`.execute(db);
  await sql`DROP FUNCTION weg_economic_plan_frozen()`.execute(db);
  await sql`DROP FUNCTION weg_economic_plan_membership()`.execute(db);
  await sql`DROP TRIGGER ledger_transaction_weg_booking_date ON ledger_transaction`.execute(db);
  await sql`DROP FUNCTION ledger_transaction_weg_booking_date()`.execute(db);
  await sql`DROP TRIGGER transaction_split_weg ON transaction_split`.execute(db);
  await sql`DROP FUNCTION transaction_split_weg()`.execute(db);
  await sql`ALTER TABLE weg_membership DROP CONSTRAINT weg_membership_realm_key`.execute(db);
  await sql`ALTER TABLE weg_membership DROP CONSTRAINT weg_membership_source_references_length`.execute(db);
  await sql`DROP FUNCTION weg_texts_valid(text[])`.execute(db);
  await sql`UPDATE financial_category SET category_type = 'OPERATING_EXPENSE' WHERE code = 'WEG_RESERVE_CONTRIBUTION'`.execute(db);
  await sql`ALTER TABLE financial_category DROP CONSTRAINT financial_category_category_type_check`.execute(db);
  await sql`
    ALTER TABLE financial_category ADD CONSTRAINT financial_category_category_type_check
      CHECK (category_type IN ('INCOME', 'OPERATING_EXPENSE', 'FINANCING', 'CAPITAL_MOVEMENT', 'SECURITY_DEPOSIT', 'TRANSFER', 'OTHER'))
  `.execute(db);
}

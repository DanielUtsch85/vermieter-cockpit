import { sql, type Kysely } from 'kysely';

/** The statement's content: free to change while `DRAFT`, frozen from then on (api-design §50). */
const CONTENT = [
  'financial_year',
  'period_from',
  'period_until',
  'document_date',
  'resolution_date',
  'due_date',
  'supersedes_id',
  'recoverable_subtotal',
  'non_recoverable_subtotal',
  'total_costs',
  'hausgeld_requested',
  'hausgeld_paid',
  'reserve_requested',
  'reserve_paid',
  'settlement_peak',
  'settlement_result',
  'currency',
  'reserve',
  'source_references',
  'notes',
];
const content = (row: 'NEW' | 'OLD') => sql.raw(`(${CONTENT.map((c) => `${row}.${c}`).join(', ')})`);

/** A signed EUR amount: two decimals at most, below 10^15 in magnitude. */
const money = (column: string) => sql.raw(`CHECK (scale(${column}) <= 2 AND abs(${column}) < 1e15)`);

/**
 * VC-6-03: the Jahresabrechnung (data-model.md §30–§31, api-design.md §50, phase-6-plan P6-D5, P6-D8).
 *
 * - `weg_annual_statement`: per membership (composite foreign key) and financial year, the period (Nutzungszeitraum),
 *   the printed totals (signed Money), an optional reserve section (`jsonb`, shape checked by the API), the lifecycle
 *   `DRAFT` → `CONFIRMED` → `SUPERSEDED` and `DRAFT` → `VOID`, with `supersedes_id` / `superseded_by_id` in the same
 *   membership; at most one `CONFIRMED` per membership and year (partial unique index).
 * - `weg_statement_cost_line`: one row per printed line, Realm by composite foreign key; the classification with its
 *   source, resolved on write (P6-D8, review on #148).
 * - `weg_annual_statement_membership` (before insert, or update of the period, year or `supersedes_id`): first writes
 *   the PropertyReference, then the WEG (a no-op, reading `financial_year_start_month` under that lock, as §49.5's
 *   plan), then needs the membership `ACTIVE` and the period inside it and inside the financial year; `supersedes_id`
 *   names a statement of the same year (INVALID_SUPERSEDES).
 * - `weg_annual_statement_frozen`: Realm, membership and creation never change; content only while `DRAFT`; the steps
 *   `DRAFT` → `CONFIRMED` (a named predecessor already `SUPERSEDED` by it) | `VOID`, `CONFIRMED` → `SUPERSEDED` (by a
 *   `DRAFT` naming it); `version` + 1; P3-D8's no-op passes. Only inserted `DRAFT` with `version` 1; never deleted.
 * - `weg_annual_statement_successor` (constraint trigger, deferred to commit; review on #150): a `SUPERSEDED`
 *   statement's successor is `CONFIRMED` (or superseded itself since). So neither a void of the successor nor a
 *   commit without its confirm leaves a year without a valid one.
 * - `weg_statement_cost_line_frozen`: lines are inserted, changed or deleted only while their statement is `DRAFT`; the
 *   statement is written first (a no-op), so a concurrent confirm waits or is waited for.
 * - `weg_membership_statements` (after `weg_membership_guard` by name): an end or void that leaves a statement that is
 *   not `VOID` outside the remaining period (MEMBERSHIP_HAS_STATEMENTS).
 * - `weg_financial_year_statements` (after `weg_financial_year_held` by name): WEG_HAS_YEARS for a statement that is
 *   not `VOID`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE weg_annual_statement (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      membership_id uuid NOT NULL,
      financial_year integer NOT NULL CHECK (financial_year BETWEEN 1900 AND 2200),
      period_from date NOT NULL,
      period_until date NOT NULL,
      document_date date,
      resolution_date date,
      due_date date,
      supersedes_id uuid,
      superseded_by_id uuid,
      recoverable_subtotal numeric NOT NULL ${money('recoverable_subtotal')},
      non_recoverable_subtotal numeric NOT NULL ${money('non_recoverable_subtotal')},
      total_costs numeric NOT NULL ${money('total_costs')},
      hausgeld_requested numeric NOT NULL ${money('hausgeld_requested')},
      hausgeld_paid numeric NOT NULL ${money('hausgeld_paid')},
      reserve_requested numeric ${money('reserve_requested')},
      reserve_paid numeric ${money('reserve_paid')},
      settlement_peak numeric NOT NULL ${money('settlement_peak')},
      settlement_result numeric ${money('settlement_result')},
      currency text NOT NULL CHECK (currency IN ('EUR')),
      reserve jsonb CHECK (jsonb_typeof(reserve) = 'object'),
      status text NOT NULL CHECK (status IN ('DRAFT', 'CONFIRMED', 'SUPERSEDED', 'VOID')),
      confirmed_at timestamptz,
      confirmed_by text,
      voided_at timestamptz,
      voided_by text,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      source_references text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_references) <= 10 AND weg_texts_valid(source_references)),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT weg_annual_statement_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT weg_annual_statement_membership_key UNIQUE (id, membership_id),
      CONSTRAINT weg_annual_statement_membership_fk FOREIGN KEY (membership_id, mre_realm_id) REFERENCES weg_membership (id, mre_realm_id),
      CONSTRAINT weg_annual_statement_supersedes_fk FOREIGN KEY (supersedes_id, membership_id) REFERENCES weg_annual_statement (id, membership_id),
      CONSTRAINT weg_annual_statement_superseded_by_fk FOREIGN KEY (superseded_by_id, membership_id) REFERENCES weg_annual_statement (id, membership_id),
      CONSTRAINT weg_annual_statement_not_itself CHECK (supersedes_id <> id AND superseded_by_id <> id),
      CONSTRAINT weg_annual_statement_period CHECK (period_from <= period_until),
      CONSTRAINT weg_annual_statement_confirm_fields CHECK (
        (status IN ('CONFIRMED', 'SUPERSEDED')) = (confirmed_at IS NOT NULL) AND (status IN ('CONFIRMED', 'SUPERSEDED')) = (confirmed_by IS NOT NULL)
      ),
      CONSTRAINT weg_annual_statement_superseded_fields CHECK ((status = 'SUPERSEDED') = (superseded_by_id IS NOT NULL)),
      CONSTRAINT weg_annual_statement_void_fields CHECK (
        (status = 'VOID') = (voided_at IS NOT NULL) AND (status = 'VOID') = (voided_by IS NOT NULL) AND (status = 'VOID') = (void_reason IS NOT NULL)
      )
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX weg_annual_statement_confirmed_key ON weg_annual_statement (membership_id, financial_year) WHERE status = 'CONFIRMED'
  `.execute(db);
  await sql`CREATE INDEX weg_annual_statement_membership_idx ON weg_annual_statement (membership_id, financial_year, created_at, id)`.execute(db);

  await sql`
    CREATE TABLE weg_statement_cost_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      statement_id uuid NOT NULL,
      position integer NOT NULL CHECK (position BETWEEN 1 AND 1000),
      account text NOT NULL CHECK (length(account) BETWEEN 1 AND 200),
      cost_group text NOT NULL CHECK (cost_group IN ('RECOVERABLE', 'NON_RECOVERABLE')),
      allocation_key text NOT NULL CHECK (length(allocation_key) BETWEEN 1 AND 100),
      allocation_total numeric(15, 3) CHECK (allocation_total >= 0),
      allocation_share numeric(15, 3) CHECK (allocation_share >= 0),
      total_amount numeric NOT NULL ${money('total_amount')},
      unit_share numeric NOT NULL ${money('unit_share')},
      currency text NOT NULL CHECK (currency IN ('EUR')),
      classification text NOT NULL CHECK (classification IN ('RECOVERABLE', 'NON_RECOVERABLE', 'RESERVE')),
      classification_source text NOT NULL CHECK (classification_source IN ('USER', 'PREVIOUS_STATEMENT', 'PRINTED_GROUP')),
      CONSTRAINT weg_statement_cost_line_position_key UNIQUE (statement_id, position),
      CONSTRAINT weg_statement_cost_line_statement_fk FOREIGN KEY (statement_id, mre_realm_id) REFERENCES weg_annual_statement (id, mre_realm_id),
      CONSTRAINT weg_statement_cost_line_share CHECK (allocation_share IS NULL OR allocation_total IS NULL OR allocation_share <= allocation_total)
    )
  `.execute(db);

  await sql`
    CREATE FUNCTION weg_annual_statement_initial() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status <> 'DRAFT' OR NEW.version <> 1 THEN
        RAISE EXCEPTION 'WegAnnualStatement: only inserted DRAFT with version 1, not % / % (api-design §50)', NEW.status, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_annual_statement_initial BEFORE INSERT ON weg_annual_statement FOR EACH ROW EXECUTE FUNCTION weg_annual_statement_initial()
  `.execute(db);
  await sql`CREATE TRIGGER weg_annual_statement_no_delete BEFORE DELETE ON weg_annual_statement FOR EACH ROW EXECUTE FUNCTION weg_no_delete()`.execute(db);

  await sql`
    CREATE FUNCTION weg_annual_statement_membership() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      m record;
      unit uuid;
      start_month smallint;
      year_start date;
    BEGIN
      SELECT property_reference_id INTO unit FROM weg_membership WHERE id = NEW.membership_id;
      IF unit IS NULL OR NEW.period_from > NEW.period_until THEN
        RETURN NEW; -- an unknown membership is left to the foreign key, a reversed period to its CHECK
      END IF;
      -- First the unit, as every membership writer: an end or void of the membership waits, or this waits for it.
      UPDATE property_reference SET version = version WHERE id = unit;
      -- Then the WEG (a no-op): an amend of the start month waits or is waited for (WEG_HAS_YEARS), and the start month
      -- is read under that lock (as §49.5's plan, review on #147/#148).
      UPDATE weg SET version = version WHERE id = (SELECT weg_id FROM weg_membership WHERE id = NEW.membership_id)
        RETURNING financial_year_start_month INTO start_month;
      SELECT wm.status, wm.valid_from, wm.valid_until INTO m FROM weg_membership wm WHERE wm.id = NEW.membership_id;
      IF m.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'WegAnnualStatement: membership % is % (MEMBERSHIP_NOT_ACTIVE)', NEW.membership_id, m.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NOT (daterange(NEW.period_from, NEW.period_until, '[]') <@ daterange(m.valid_from, m.valid_until, '[]')) THEN
        RAISE EXCEPTION 'WegAnnualStatement: % – % is outside membership % (STATEMENT_OUTSIDE_MEMBERSHIP)', NEW.period_from, NEW.period_until, NEW.membership_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      year_start := make_date(NEW.financial_year, start_month, 1);
      IF NOT (daterange(NEW.period_from, NEW.period_until, '[]') <@ daterange(year_start, (year_start + interval '1 year')::date, '[)')) THEN
        RAISE EXCEPTION 'WegAnnualStatement: % – % is outside the financial year % (PERIOD_OUTSIDE_YEAR)', NEW.period_from, NEW.period_until, NEW.financial_year
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM weg_annual_statement s WHERE s.id = NEW.supersedes_id AND s.financial_year = NEW.financial_year
      ) THEN
        RAISE EXCEPTION 'WegAnnualStatement: % is not a statement of the year % (INVALID_SUPERSEDES)', NEW.supersedes_id, NEW.financial_year
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_annual_statement_membership BEFORE INSERT OR UPDATE OF period_from, period_until, financial_year, supersedes_id ON weg_annual_statement
      FOR EACH ROW EXECUTE FUNCTION weg_annual_statement_membership()
  `.execute(db);

  await sql`
    CREATE FUNCTION weg_annual_statement_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF NEW.version <> OLD.version + 1
         OR (NEW.id, NEW.mre_realm_id, NEW.membership_id, NEW.created_at, NEW.created_by)
            IS DISTINCT FROM (OLD.id, OLD.mre_realm_id, OLD.membership_id, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'WegAnnualStatement %: version + 1, identity never changes (api-design §50)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
        RETURN NEW;
      END IF;
      IF ${content('NEW')} IS DISTINCT FROM ${content('OLD')} THEN
        RAISE EXCEPTION 'WegAnnualStatement %: the content changes only while DRAFT (STATEMENT_NOT_DRAFT)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status = 'DRAFT' AND NEW.status = 'VOID' THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'DRAFT' AND NEW.status = 'CONFIRMED' THEN
        -- The predecessor is written first (api-design §50): it must already be SUPERSEDED by this one.
        IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM weg_annual_statement s WHERE s.id = NEW.supersedes_id AND s.status = 'SUPERSEDED' AND s.superseded_by_id = NEW.id
        ) THEN
          RAISE EXCEPTION 'WegAnnualStatement %: % is not superseded by it (INVALID_SUPERSEDES)', OLD.id, NEW.supersedes_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.status = 'CONFIRMED' AND NEW.status = 'SUPERSEDED' THEN
        IF NOT EXISTS (
          SELECT 1 FROM weg_annual_statement s
           WHERE s.id = NEW.superseded_by_id AND s.supersedes_id = OLD.id AND s.status = 'DRAFT' AND s.financial_year = OLD.financial_year
        ) THEN
          RAISE EXCEPTION 'WegAnnualStatement %: % does not supersede it (INVALID_SUPERSEDES)', OLD.id, NEW.superseded_by_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'WegAnnualStatement %: % → % is not a step (api-design §50)', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_annual_statement_frozen BEFORE UPDATE ON weg_annual_statement FOR EACH ROW EXECUTE FUNCTION weg_annual_statement_frozen()
  `.execute(db);

  // At commit (review on #150): a SUPERSEDED statement's successor is CONFIRMED (or itself superseded since). Deferred,
  // because the confirm writes the old one first; the frozen steps let a CONFIRMED successor go nowhere but SUPERSEDED.
  await sql`
    CREATE FUNCTION weg_annual_statement_successor() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      row record;
    BEGIN
      SELECT s.id, s.status, s.superseded_by_id, n.status AS successor_status INTO row
        FROM weg_annual_statement s LEFT JOIN weg_annual_statement n ON n.id = s.superseded_by_id WHERE s.id = NEW.id;
      IF row.status = 'SUPERSEDED' AND row.successor_status NOT IN ('CONFIRMED', 'SUPERSEDED') THEN
        RAISE EXCEPTION 'WegAnnualStatement %: superseded by %, which is % (UNCONFIRMED_SUCCESSOR)', row.id, row.superseded_by_id, row.successor_status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER weg_annual_statement_successor AFTER UPDATE ON weg_annual_statement DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION weg_annual_statement_successor()
  `.execute(db);

  await sql`
    CREATE FUNCTION weg_statement_cost_line_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      held text;
      statement uuid;
    BEGIN
      FOR statement IN SELECT DISTINCT unnest(ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.statement_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.statement_id END])
      LOOP
        CONTINUE WHEN statement IS NULL;
        -- A no-op write: a concurrent confirm or void waits, or this waits for it and sees its status.
        UPDATE weg_annual_statement SET version = version WHERE id = statement RETURNING status INTO held;
        IF held IS DISTINCT FROM 'DRAFT' AND held IS NOT NULL THEN
          RAISE EXCEPTION 'WegAnnualStatement %: lines change only while DRAFT, not % (STATEMENT_NOT_DRAFT)', statement, held
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_statement_cost_line_frozen BEFORE INSERT OR UPDATE OR DELETE ON weg_statement_cost_line
      FOR EACH ROW EXECUTE FUNCTION weg_statement_cost_line_frozen()
  `.execute(db);

  await sql`
    CREATE FUNCTION weg_membership_statements() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      kept daterange;
      held uuid;
    BEGIN
      IF OLD.status <> 'ACTIVE' OR (NEW.status, NEW.valid_until) IS NOT DISTINCT FROM (OLD.status, OLD.valid_until) THEN
        RETURN NEW;
      END IF;
      -- First the unit (weg_membership_guard did too): a concurrent statement writer is waited for and seen.
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      kept := CASE WHEN NEW.status = 'VOID' THEN 'empty'::daterange ELSE daterange(NEW.valid_from, NEW.valid_until, '[]') END;
      SELECT s.id INTO held FROM weg_annual_statement s
       WHERE s.membership_id = OLD.id AND s.status <> 'VOID' AND NOT (daterange(s.period_from, s.period_until, '[]') <@ kept)
       LIMIT 1;
      IF held IS NOT NULL THEN
        RAISE EXCEPTION 'WegMembership %: statement % lies outside the remaining period (MEMBERSHIP_HAS_STATEMENTS)', OLD.id, held
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_membership_statements BEFORE UPDATE OF valid_until, status ON weg_membership FOR EACH ROW EXECUTE FUNCTION weg_membership_statements()
  `.execute(db);

  await sql`
    CREATE FUNCTION weg_financial_year_statements() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.financial_year_start_month IS DISTINCT FROM OLD.financial_year_start_month AND EXISTS (
        SELECT 1 FROM weg_annual_statement s JOIN weg_membership m ON m.id = s.membership_id WHERE m.weg_id = OLD.id AND s.status <> 'VOID'
      ) THEN
        RAISE EXCEPTION 'WEG %: statements are filed by financial year (WEG_HAS_YEARS)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER weg_financial_year_statements BEFORE UPDATE OF financial_year_start_month ON weg
      FOR EACH ROW EXECUTE FUNCTION weg_financial_year_statements()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER weg_financial_year_statements ON weg`.execute(db);
  await sql`DROP FUNCTION weg_financial_year_statements()`.execute(db);
  await sql`DROP TRIGGER weg_membership_statements ON weg_membership`.execute(db);
  await sql`DROP FUNCTION weg_membership_statements()`.execute(db);
  await sql`DROP TABLE weg_statement_cost_line`.execute(db);
  await sql`DROP TABLE weg_annual_statement`.execute(db);
  await sql`DROP FUNCTION weg_statement_cost_line_frozen()`.execute(db);
  await sql`DROP FUNCTION weg_annual_statement_successor()`.execute(db);
  await sql`DROP FUNCTION weg_annual_statement_frozen()`.execute(db);
  await sql`DROP FUNCTION weg_annual_statement_membership()`.execute(db);
  await sql`DROP FUNCTION weg_annual_statement_initial()`.execute(db);
}

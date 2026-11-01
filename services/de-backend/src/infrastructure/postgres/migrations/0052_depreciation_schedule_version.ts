import { sql, type Kysely } from 'kysely';

/**
 * VC-8-04: recorded depreciation schedule versions (api-design.md §60 "In the database", data-model §39–§40, phase-8-plan
 * P8-D10). Eight tables, all Realm-bound, every child bound to its version by `(version_id, mre_realm_id)`; amounts
 * `numeric(14,2)` in the header's `currency`, fractions as two `bigint`s, months as the `date` of their first day.
 *
 * - `depreciation_schedule_version`: the header, the asset's facts, the fingerprints; `CURRENT` or `SUPERSEDED` with
 *   `superseded_by_id` and `superseded_at` set together exactly on `SUPERSEDED`; one `CURRENT` per asset (unique,
 *   partial); `created_txid` the inserting transaction (the supersede `UPDATE` changes `xmin`, review on #180).
 * - `…_rule`, `…_component`, `…_part`, `…_fraction`, `…_year`, `depreciation_schedule_entry`, `…_flag`: the inputs and
 *   the output as rows (AGENTS.md §28: no blob). A component's `property_reference_id` is bound to the header's, so its
 *   purchase (`acquisition_ownership_key`) is the asset's PropertyReference's. A part's `pool_key` (an addition to §60's
 *   list) names the pool its months run in (§59B), so the pooled end is recomputed from the rows.
 * - Guards: `…_insert` (the PropertyReference first, the asset `ACTIVE` and confirmed, `CURRENT` version 1, the next
 *   `version_number`, `created_txid` the transaction's), `…_frozen` (only `CURRENT` → `SUPERSEDED`; never deleted),
 *   `…_chain` (deferred: a successor of the same asset with `version_number` + 1, and a version > 1 supersedes its
 *   predecessor in its own transaction), `…_rows_append_only` on each child table (inserted only by the version's own
 *   transaction, read from `created_txid`, never `xmin`; no update, no delete).
 * - `down` refuses while a version exists (a recorded version is never dropped silently), else drops the tables and
 *   their functions; nothing else changes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE depreciation_schedule_version (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      asset_id uuid NOT NULL,
      property_reference_id uuid NOT NULL,
      version_number integer NOT NULL CHECK (version_number >= 1),
      status text NOT NULL CHECK (status IN ('CURRENT', 'SUPERSEDED')),
      superseded_by_id uuid,
      superseded_at timestamptz,
      from_year integer NOT NULL CHECK (from_year BETWEEN 2000 AND 2100),
      through_year integer NOT NULL CHECK (through_year BETWEEN 2000 AND 2100),
      computed_on date NOT NULL,
      calculation_version integer NOT NULL CHECK (calculation_version >= 1),
      currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      asset_type text NOT NULL CHECK (asset_type IN ('BUILDING', 'SEPARATE_ASSET')),
      depreciation_method text NOT NULL,
      building_completion_year integer,
      description text,
      useful_life_years integer,
      acquired_on date,
      asset_review_state text NOT NULL CHECK (asset_review_state IN ('CONFIRMED', 'ADVISOR_CONFIRMED')),
      asset_version integer NOT NULL,
      input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
      output_fingerprint text NOT NULL CHECK (output_fingerprint ~ '^[0-9a-f]{64}$'),
      reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
      recorded_at timestamptz NOT NULL DEFAULT now(),
      recorded_by text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_txid bigint NOT NULL DEFAULT txid_current(),
      CONSTRAINT depreciation_schedule_version_run CHECK (from_year <= through_year),
      CONSTRAINT depreciation_schedule_version_superseded CHECK (
        (status = 'SUPERSEDED') = (superseded_by_id IS NOT NULL) AND (status = 'SUPERSEDED') = (superseded_at IS NOT NULL)
      ),
      CONSTRAINT depreciation_schedule_version_asset_fk FOREIGN KEY (asset_id, mre_realm_id, property_reference_id)
        REFERENCES depreciation_asset (id, mre_realm_id, property_reference_id),
      CONSTRAINT depreciation_schedule_version_number_key UNIQUE (asset_id, version_number),
      CONSTRAINT depreciation_schedule_version_asset_key UNIQUE (id, asset_id),
      CONSTRAINT depreciation_schedule_version_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT depreciation_schedule_version_property_key UNIQUE (id, mre_realm_id, property_reference_id),
      CONSTRAINT depreciation_schedule_version_successor_fk FOREIGN KEY (superseded_by_id, asset_id)
        REFERENCES depreciation_schedule_version (id, asset_id) DEFERRABLE INITIALLY DEFERRED
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX depreciation_schedule_version_current ON depreciation_schedule_version (asset_id) WHERE status = 'CURRENT'`.execute(db);
  await sql`CREATE INDEX depreciation_schedule_version_asset_idx ON depreciation_schedule_version (asset_id, version_number DESC)`.execute(db);

  const child = (name: string) =>
    sql.raw(`CONSTRAINT ${name}_version_fk FOREIGN KEY (version_id, mre_realm_id) REFERENCES depreciation_schedule_version (id, mre_realm_id)`);
  await sql`
    CREATE TABLE depreciation_schedule_version_rule (
      version_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      rule_code text NOT NULL,
      rule_version integer NOT NULL CHECK (rule_version >= 1),
      rule_version_hash text NOT NULL CHECK (rule_version_hash ~ '^[0-9a-f]{64}$'),
      first_year integer NOT NULL,
      last_year integer NOT NULL,
      CONSTRAINT depreciation_schedule_version_rule_key PRIMARY KEY (version_id, rule_code, rule_version),
      CONSTRAINT depreciation_schedule_version_rule_years CHECK (first_year <= last_year),
      ${child('depreciation_schedule_version_rule')}
    )
  `.execute(db);
  await sql`CREATE INDEX depreciation_schedule_version_rule_ref_idx ON depreciation_schedule_version_rule (rule_code, rule_version)`.execute(db);

  await sql`
    CREATE TABLE depreciation_schedule_version_component (
      version_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      property_reference_id uuid NOT NULL,
      component_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('ACQUISITION', 'CAPITALIZED_ITEM')),
      position integer NOT NULL CHECK (position >= 0),
      basis_amount numeric(14, 2) NOT NULL,
      start_date date NOT NULL,
      start_date_source text NOT NULL,
      start_method text NOT NULL CHECK (start_method IN ('TRANSFER_DATE', 'START_OF_YEAR', 'MONTH_OF_DATE', 'MONTH_OF_ACQUISITION')),
      start_month date NOT NULL CHECK (extract(day FROM start_month) = 1),
      rate_kind text NOT NULL CHECK (rate_kind IN ('BAND', 'SHORTER_USEFUL_LIFE', 'USEFUL_LIFE')),
      useful_life_years integer CHECK (useful_life_years BETWEEN 1 AND 99),
      acquisition_id uuid,
      purchase_price numeric(14, 2),
      counted_cost_ids uuid[],
      counted_costs_total numeric(14, 2),
      excluded_cost_ids uuid[],
      excluded_costs_total numeric(14, 2),
      allocation_id uuid,
      allocation_review_state text,
      total_allocable_amount numeric(14, 2),
      building_amount numeric(14, 2),
      shorter_life_review_state text,
      source_type text CHECK (source_type IN ('TRANSACTION_SPLIT', 'WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE')),
      source_id uuid,
      source_position integer,
      classification_id uuid,
      classification_review_state text,
      tax_category text,
      item_date date,
      item_date_source text,
      item_tax_year integer,
      anschaffungsnahe_acquisition_id uuid,
      CONSTRAINT depreciation_schedule_version_component_key PRIMARY KEY (version_id, component_id),
      CONSTRAINT depreciation_schedule_version_component_version_fk FOREIGN KEY (version_id, mre_realm_id, property_reference_id)
        REFERENCES depreciation_schedule_version (id, mre_realm_id, property_reference_id),
      CONSTRAINT depreciation_schedule_version_component_acquisition_fk FOREIGN KEY (acquisition_id, mre_realm_id, property_reference_id)
        REFERENCES acquisition (id, mre_realm_id, property_reference_id),
      CONSTRAINT depreciation_schedule_version_component_allocation_fk FOREIGN KEY (allocation_id, acquisition_id)
        REFERENCES land_building_allocation (id, acquisition_id),
      CONSTRAINT depreciation_schedule_version_component_classification_fk FOREIGN KEY (classification_id, mre_realm_id)
        REFERENCES tax_classification (id, mre_realm_id),
      CONSTRAINT depreciation_schedule_version_component_acquisition_fields CHECK (
        (kind = 'ACQUISITION') = (acquisition_id IS NOT NULL AND purchase_price IS NOT NULL AND counted_cost_ids IS NOT NULL
          AND counted_costs_total IS NOT NULL AND excluded_cost_ids IS NOT NULL AND excluded_costs_total IS NOT NULL
          AND allocation_id IS NOT NULL AND allocation_review_state IS NOT NULL AND total_allocable_amount IS NOT NULL AND building_amount IS NOT NULL)
        AND (kind = 'ACQUISITION' OR (acquisition_id, purchase_price, counted_cost_ids, counted_costs_total, excluded_cost_ids, excluded_costs_total,
          allocation_id, allocation_review_state, total_allocable_amount, building_amount, shorter_life_review_state) IS NULL)
      ),
      CONSTRAINT depreciation_schedule_version_component_item_fields CHECK (
        (kind = 'CAPITALIZED_ITEM') = (source_type IS NOT NULL AND source_id IS NOT NULL AND classification_review_state IS NOT NULL
          AND tax_category IS NOT NULL AND item_date IS NOT NULL AND item_date_source IS NOT NULL AND item_tax_year IS NOT NULL)
        AND (kind = 'CAPITALIZED_ITEM' OR (source_type, source_id, source_position, classification_id, classification_review_state, tax_category,
          item_date, item_date_source, item_tax_year, anschaffungsnahe_acquisition_id) IS NULL)
        AND (source_type IS NULL OR (source_type = 'TRANSACTION_SPLIT') = (source_position IS NULL))
      )
    )
  `.execute(db);

  await sql`
    CREATE TABLE depreciation_schedule_version_part (
      version_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      component_id text NOT NULL,
      part_key text NOT NULL,
      owner_party_id uuid,
      ownership_ids uuid[] NOT NULL,
      share_numerator bigint NOT NULL CHECK (share_numerator > 0),
      share_denominator bigint NOT NULL CHECK (share_denominator > 0),
      weight_numerator bigint NOT NULL CHECK (weight_numerator > 0),
      weight_denominator bigint NOT NULL CHECK (weight_denominator > 0),
      basis_amount numeric(14, 2) NOT NULL,
      first_month date NOT NULL CHECK (extract(day FROM first_month) = 1),
      rate_kind text NOT NULL CHECK (rate_kind IN ('BAND', 'SHORTER_USEFUL_LIFE', 'USEFUL_LIFE')),
      useful_life_years integer CHECK (useful_life_years BETWEEN 1 AND 99),
      tenure_from date,
      last_day date,
      last_day_source text CHECK (last_day_source IN ('BUYER_ECONOMIC_TRANSFER_DATE', 'VALID_UNTIL')),
      pool_key text,
      CONSTRAINT depreciation_schedule_version_part_key PRIMARY KEY (version_id, component_id, part_key),
      CONSTRAINT depreciation_schedule_version_part_component_fk FOREIGN KEY (version_id, component_id)
        REFERENCES depreciation_schedule_version_component (version_id, component_id),
      CONSTRAINT depreciation_schedule_version_part_party_fk FOREIGN KEY (owner_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT depreciation_schedule_version_part_owner CHECK (
        (part_key = 'NOT_OWNED' AND owner_party_id IS NULL) OR (owner_party_id IS NOT NULL AND part_key = 'OWNER:' || owner_party_id::text)
      ),
      CONSTRAINT depreciation_schedule_version_part_last_day CHECK ((last_day IS NULL) = (last_day_source IS NULL)),
      ${child('depreciation_schedule_version_part')}
    )
  `.execute(db);

  await sql`
    CREATE TABLE depreciation_schedule_version_fraction (
      version_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      component_id text NOT NULL,
      part_key text NOT NULL,
      month date NOT NULL CHECK (extract(day FROM month) = 1),
      fraction_numerator bigint NOT NULL CHECK (fraction_numerator >= 0),
      fraction_denominator bigint NOT NULL CHECK (fraction_denominator > 0),
      CONSTRAINT depreciation_schedule_version_fraction_key PRIMARY KEY (version_id, component_id, part_key, month),
      CONSTRAINT depreciation_schedule_version_fraction_range CHECK (fraction_numerator <= fraction_denominator),
      CONSTRAINT depreciation_schedule_version_fraction_part_fk FOREIGN KEY (version_id, component_id, part_key)
        REFERENCES depreciation_schedule_version_part (version_id, component_id, part_key),
      ${child('depreciation_schedule_version_fraction')}
    )
  `.execute(db);

  await sql`
    CREATE TABLE depreciation_schedule_version_year (
      version_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      year integer NOT NULL,
      amount numeric(14, 2) NOT NULL,
      residual_value numeric(14, 2) NOT NULL,
      input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
      output_fingerprint text NOT NULL CHECK (output_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT depreciation_schedule_version_year_key PRIMARY KEY (version_id, year),
      ${child('depreciation_schedule_version_year')}
    )
  `.execute(db);

  await sql`
    CREATE TABLE depreciation_schedule_entry (
      version_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      year integer NOT NULL,
      component_id text NOT NULL,
      part_key text NOT NULL,
      months integer NOT NULL CHECK (months BETWEEN 0 AND 12),
      fraction_numerator bigint,
      fraction_denominator bigint CHECK (fraction_denominator > 0),
      amount numeric(14, 2) NOT NULL,
      cumulative numeric(14, 2) NOT NULL,
      residual_value numeric(14, 2) NOT NULL,
      CONSTRAINT depreciation_schedule_entry_key PRIMARY KEY (version_id, year, component_id, part_key),
      CONSTRAINT depreciation_schedule_entry_fraction CHECK ((fraction_numerator IS NULL) = (fraction_denominator IS NULL)),
      CONSTRAINT depreciation_schedule_entry_year_fk FOREIGN KEY (version_id, year) REFERENCES depreciation_schedule_version_year (version_id, year),
      CONSTRAINT depreciation_schedule_entry_part_fk FOREIGN KEY (version_id, component_id, part_key)
        REFERENCES depreciation_schedule_version_part (version_id, component_id, part_key),
      ${child('depreciation_schedule_entry')}
    )
  `.execute(db);

  await sql`
    CREATE TABLE depreciation_schedule_version_flag (
      version_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      year integer,
      component_id text,
      part_key text,
      code text NOT NULL CHECK (length(code) BETWEEN 1 AND 100),
      level text NOT NULL CHECK (level IN ('OPEN', 'INFORMATIVE')),
      ${child('depreciation_schedule_version_flag')}
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX depreciation_schedule_version_flag_key
      ON depreciation_schedule_version_flag (version_id, coalesce(year, 0), coalesce(component_id, ''), coalesce(part_key, ''), code)
  `.execute(db);

  await guards(db);
}

async function guards(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION depreciation_schedule_version_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      asset_status text;
      asset_review text;
      highest integer;
    BEGIN
      -- The PropertyReference first: the lock order of every writer of it (§26.1, §59).
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      SELECT status, review_state INTO asset_status, asset_review FROM depreciation_asset WHERE id = NEW.asset_id FOR SHARE;
      IF asset_status IS DISTINCT FROM 'ACTIVE' OR asset_review NOT IN ('CONFIRMED', 'ADVISOR_CONFIRMED') THEN
        RAISE EXCEPTION 'DepreciationScheduleVersion: the asset % is % / %; only an ACTIVE, confirmed asset is recorded (api-design §60)',
          NEW.asset_id, coalesce(asset_status, 'unknown'), coalesce(asset_review, 'unknown') USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status <> 'CURRENT' OR NEW.version <> 1 OR NEW.superseded_by_id IS NOT NULL OR NEW.superseded_at IS NOT NULL THEN
        RAISE EXCEPTION 'DepreciationScheduleVersion: only inserted CURRENT with version 1, not superseded (api-design §60)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT max(version_number) INTO highest FROM depreciation_schedule_version WHERE asset_id = NEW.asset_id;
      IF NEW.version_number <> coalesce(highest, 0) + 1 THEN
        RAISE EXCEPTION 'DepreciationScheduleVersion: version_number % is not the next one (%) of asset % (api-design §60)',
          NEW.version_number, coalesce(highest, 0) + 1, NEW.asset_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.created_txid <> txid_current() THEN
        RAISE EXCEPTION 'DepreciationScheduleVersion: created_txid is the inserting transaction''s, never given (api-design §60)'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER depreciation_schedule_version_insert BEFORE INSERT ON depreciation_schedule_version
      FOR EACH ROW EXECUTE FUNCTION depreciation_schedule_version_insert()
  `.execute(db);

  await sql`
    CREATE FUNCTION depreciation_schedule_version_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'DepreciationScheduleVersion %: never deleted (api-design §60)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status <> 'CURRENT' OR NEW.status <> 'SUPERSEDED' OR NEW.superseded_by_id IS NULL OR NEW.superseded_at IS NULL
         OR NEW.version <> OLD.version + 1
         OR (to_jsonb(NEW) - 'status' - 'superseded_by_id' - 'superseded_at' - 'version')
            IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'superseded_by_id' - 'superseded_at' - 'version') THEN
        RAISE EXCEPTION 'DepreciationScheduleVersion %: the only change is CURRENT → SUPERSEDED with its successor (api-design §60)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER depreciation_schedule_version_frozen BEFORE UPDATE OR DELETE ON depreciation_schedule_version
      FOR EACH ROW EXECUTE FUNCTION depreciation_schedule_version_frozen()
  `.execute(db);

  await sql`
    CREATE FUNCTION depreciation_schedule_version_chain() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      row depreciation_schedule_version;
    BEGIN
      SELECT * INTO row FROM depreciation_schedule_version WHERE id = NEW.id;
      IF row.status = 'SUPERSEDED' AND NOT EXISTS (
        SELECT 1 FROM depreciation_schedule_version s
        WHERE s.id = row.superseded_by_id AND s.asset_id = row.asset_id AND s.version_number = row.version_number + 1
      ) THEN
        RAISE EXCEPTION 'DepreciationScheduleVersion %: superseded without its successor % (api-design §60)', row.id, row.superseded_by_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF row.version_number > 1 AND NOT EXISTS (
        SELECT 1 FROM depreciation_schedule_version p
        WHERE p.asset_id = row.asset_id AND p.version_number = row.version_number - 1 AND p.status = 'SUPERSEDED' AND p.superseded_by_id = row.id
      ) THEN
        RAISE EXCEPTION 'DepreciationScheduleVersion %: version % does not supersede its predecessor (api-design §60)', row.id, row.version_number
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER depreciation_schedule_version_chain AFTER INSERT OR UPDATE ON depreciation_schedule_version
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION depreciation_schedule_version_chain()
  `.execute(db);

  await sql`
    CREATE FUNCTION depreciation_schedule_version_rows_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'DepreciationScheduleVersion: % rows are append-only, never changed or deleted (api-design §60)', TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- Never xmin: the supersede step gives the version row the superseding transaction's xmin (review on #180).
      IF NOT EXISTS (SELECT 1 FROM depreciation_schedule_version WHERE id = NEW.version_id AND created_txid = txid_current()) THEN
        RAISE EXCEPTION 'DepreciationScheduleVersion %: % rows are inserted only by the transaction that recorded the version (api-design §60)',
          NEW.version_id, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  for (const table of CHILD_TABLES) {
    await sql`
      CREATE TRIGGER ${sql.raw(`${table}_append_only`)} BEFORE INSERT OR UPDATE OR DELETE ON ${sql.table(table)}
        FOR EACH ROW EXECUTE FUNCTION depreciation_schedule_version_rows_append_only()
    `.execute(db);
  }
}

const CHILD_TABLES = [
  'depreciation_schedule_version_rule',
  'depreciation_schedule_version_component',
  'depreciation_schedule_version_part',
  'depreciation_schedule_version_fraction',
  'depreciation_schedule_version_year',
  'depreciation_schedule_entry',
  'depreciation_schedule_version_flag',
];

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is dropped: a recorded version is never dropped silently (api-design §60).
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM depreciation_schedule_version) THEN
        RAISE EXCEPTION 'depreciation_schedule_version: a recorded version exists; it is never dropped silently (api-design §60)' USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  for (const table of [...CHILD_TABLES].reverse()) await sql`DROP TABLE ${sql.table(table)}`.execute(db);
  await sql`DROP TABLE depreciation_schedule_version`.execute(db);
  await sql`DROP FUNCTION depreciation_schedule_version_rows_append_only()`.execute(db);
  await sql`DROP FUNCTION depreciation_schedule_version_chain()`.execute(db);
  await sql`DROP FUNCTION depreciation_schedule_version_frozen()`.execute(db);
  await sql`DROP FUNCTION depreciation_schedule_version_insert()`.execute(db);
}

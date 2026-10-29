import { sql, type Kysely } from 'kysely';

/**
 * VC-5-01: SecurityDeposit (data-model.md §26, api-design.md §47.1, phase-5-plan P5-D1/D2/D4).
 *
 * - `security_deposit`: Realm-bound; one MRE Tenant by id (the lease, P5-D1); `expected_amount` > 0 in EUR with at most
 *   two decimals and where it came from; an optional holding account by composite foreign key; status `ACTIVE` →
 *   `VOID` here (VC-5-04 adds `CLOSED`), `VOID` exactly with its time, actor and reason.
 * - A partial unique index: at most one deposit per Tenant that is not `VOID`.
 * - `security_deposit_holding_account`: the holding account is a `SECURITY_DEPOSIT` account (P5-D4), read `FOR SHARE`;
 *   `financial_account_type_held`: an account's type does not change while a deposit that is not `VOID` names it, so
 *   the check at write time stays true.
 * - `security_deposit_frozen`: Realm, Tenant, currency and creation never change; the amendable fields only while
 *   `ACTIVE`; every step with `version` + 1; `VOID` is final; P3-D8's no-op write passes. Only inserted `ACTIVE` with
 *   `version` 1; never deleted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE security_deposit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('ACTIVE', 'CLOSED', 'VOID')),
      mre_tenant_id text NOT NULL CHECK (mre_tenant_id ~ '^[0-9a-f]{24}$'),
      expected_amount numeric NOT NULL CHECK (scale(expected_amount) <= 2 AND expected_amount > 0 AND expected_amount < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      expected_amount_source text NOT NULL CHECK (expected_amount_source IN ('REQUEST', 'MRE_GUARANTY')),
      holding_financial_account_id uuid,
      interest_bearing boolean NOT NULL,
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      voided_at timestamptz,
      voided_by text,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT security_deposit_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT security_deposit_account_fk FOREIGN KEY (holding_financial_account_id, mre_realm_id) REFERENCES financial_account (id, mre_realm_id),
      CONSTRAINT security_deposit_void_fields CHECK (
        (status = 'VOID') = (voided_at IS NOT NULL) AND (status = 'VOID') = (voided_by IS NOT NULL) AND (status = 'VOID') = (void_reason IS NOT NULL)
      )
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX security_deposit_tenant_key ON security_deposit (mre_realm_id, mre_tenant_id) WHERE status <> 'VOID'`.execute(db);
  await sql`CREATE INDEX security_deposit_realm_idx ON security_deposit (mre_realm_id, created_at DESC, id)`.execute(db);
  await sql`
    CREATE INDEX security_deposit_account_idx ON security_deposit (holding_financial_account_id) WHERE holding_financial_account_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE FUNCTION security_deposit_holding_account() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      held_type text;
    BEGIN
      IF NEW.holding_financial_account_id IS NULL
         OR (TG_OP = 'UPDATE' AND NEW.holding_financial_account_id IS NOT DISTINCT FROM OLD.holding_financial_account_id) THEN
        RETURN NEW;
      END IF;
      SELECT account_type INTO held_type FROM financial_account
       WHERE id = NEW.holding_financial_account_id AND mre_realm_id = NEW.mre_realm_id FOR SHARE;
      -- An unknown or foreign account is left to the foreign key.
      IF held_type IS NOT NULL AND held_type <> 'SECURITY_DEPOSIT' THEN
        RAISE EXCEPTION 'SecurityDeposit: account % is %, not a SECURITY_DEPOSIT account (NOT_A_SECURITY_DEPOSIT_ACCOUNT)', NEW.holding_financial_account_id, held_type
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER security_deposit_holding_account BEFORE INSERT OR UPDATE OF holding_financial_account_id ON security_deposit
      FOR EACH ROW EXECUTE FUNCTION security_deposit_holding_account()
  `.execute(db);

  await sql`
    CREATE FUNCTION financial_account_type_held() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.account_type IS DISTINCT FROM OLD.account_type
         AND EXISTS (SELECT 1 FROM security_deposit WHERE holding_financial_account_id = OLD.id AND status <> 'VOID') THEN
        RAISE EXCEPTION 'FinancialAccount %: a security deposit holds it; its type stays SECURITY_DEPOSIT (api-design §47.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER financial_account_type_held BEFORE UPDATE OF account_type ON financial_account
      FOR EACH ROW EXECUTE FUNCTION financial_account_type_held()
  `.execute(db);

  await sql`
    CREATE FUNCTION security_deposit_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.id, NEW.mre_realm_id, NEW.mre_tenant_id, NEW.currency, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM (OLD.id, OLD.mre_realm_id, OLD.mre_tenant_id, OLD.currency, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'SecurityDeposit %: the Tenant never changes; void and create instead (api-design §47.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- The no-op write of P3-D8 (and any write leaving the row as it is) passes.
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'VOID' THEN
        RAISE EXCEPTION 'SecurityDeposit %: VOID is final (api-design §47.1)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status = OLD.status AND OLD.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'SecurityDeposit %: amended only while ACTIVE, not % (api-design §47.1)', OLD.id, OLD.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status <> OLD.status AND NOT (OLD.status = 'ACTIVE' AND NEW.status = 'VOID') THEN
        RAISE EXCEPTION 'SecurityDeposit %: % → % is not a step (api-design §47.1)', OLD.id, OLD.status, NEW.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status = 'VOID' AND (NEW.expected_amount, NEW.expected_amount_source, NEW.holding_financial_account_id, NEW.interest_bearing, NEW.notes)
         IS DISTINCT FROM (OLD.expected_amount, OLD.expected_amount_source, OLD.holding_financial_account_id, OLD.interest_bearing, OLD.notes) THEN
        RAISE EXCEPTION 'SecurityDeposit %: a void changes nothing else', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'SecurityDeposit %: every change raises version by exactly one (% → %)', OLD.id, OLD.version, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER security_deposit_frozen BEFORE UPDATE ON security_deposit FOR EACH ROW EXECUTE FUNCTION security_deposit_frozen()`.execute(db);

  await sql`
    CREATE FUNCTION security_deposit_initial() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status <> 'ACTIVE' OR NEW.version <> 1 THEN
        RAISE EXCEPTION 'SecurityDeposit: only inserted ACTIVE with version 1, not % / % (api-design §47.1)', NEW.status, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER security_deposit_initial BEFORE INSERT ON security_deposit FOR EACH ROW EXECUTE FUNCTION security_deposit_initial()`.execute(db);

  await sql`
    CREATE FUNCTION security_deposit_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'SecurityDeposit %: never deleted; void it instead (api-design §47.1)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER security_deposit_no_delete BEFORE DELETE ON security_deposit FOR EACH ROW EXECUTE FUNCTION security_deposit_no_delete()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER financial_account_type_held ON financial_account`.execute(db);
  await sql`DROP FUNCTION financial_account_type_held()`.execute(db);
  await sql`DROP TABLE security_deposit`.execute(db);
  await sql`DROP FUNCTION security_deposit_no_delete()`.execute(db);
  await sql`DROP FUNCTION security_deposit_initial()`.execute(db);
  await sql`DROP FUNCTION security_deposit_frozen()`.execute(db);
  await sql`DROP FUNCTION security_deposit_holding_account()`.execute(db);
}

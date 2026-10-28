import { sql, type Kysely } from 'kysely';

/**
 * VC-2-06: acquisition costs and payment links (data-model.md §14, api-design.md §27.2, phase-2-plan P2-D7).
 *
 * - `acquisition_cost`: an expected transaction cost of an Acquisition of the same Realm, > 0 in EUR; `ACTIVE` →
 *   `VOID` (final, with time and reason). The counterparty is a Party of the Realm.
 * - `acquisition_payment`: links part of a ledger Transaction to the price (`acquisition_cost_id` null) or to a cost
 *   of the same Acquisition; the Transaction is of the Realm and in the payment's currency (the ledger's existing
 *   `(id, mre_realm_id, currency)` key, so the ledger's tables are not altered). Its only step is the unlink.
 * - Frozen: a cost's and a payment's data never change and neither is deleted; `version` and `updated_at` move only
 *   with the step.
 * - Guards past the repository (P2-D11). Every insert or step of a cost or payment first writes its Acquisition's row
 *   (a no-op, as `ownership_invariants` touches the PropertyReference), so they serialise with each other and with
 *   cancel (`FOR UPDATE`): READ COMMITTED reads the other's committed result in the next statement, REPEATABLE READ
 *   fails with a serialization error instead of acting on a stale snapshot. On a `CANCELLED` Acquisition both are
 *   refused. A payment insert then writes its Transaction's row (the split trigger's touch of 0010, allowed by 0013)
 *   and refuses a Transaction that is not current or not `OUTFLOW`, then checks both caps: the live payments of the
 *   Transaction (not unlinked, Acquisition not cancelled) and the counting ones of the cost or price (live, Transaction
 *   current). A cost's void is refused while payments not unlinked are linked to it. Lock order: Acquisition, then
 *   Transaction; no other path takes them the other way round.
 */
const COST_CATEGORIES = `'REAL_ESTATE_TRANSFER_TAX', 'NOTARY', 'LAND_REGISTRY', 'BROKER', 'FINANCING_RELATED', 'OTHER'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE acquisition_cost (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      acquisition_id uuid NOT NULL,
      category text NOT NULL CHECK (category IN (${sql.raw(COST_CATEGORIES)})),
      amount numeric NOT NULL CHECK (scale(amount) <= 2 AND amount > 0 AND amount < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      incurred_date date,
      counterparty_party_id uuid,
      source_references text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_references) <= 10),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      status text NOT NULL CHECK (status IN ('ACTIVE', 'VOID')),
      voided_at timestamptz,
      void_reason text CHECK (length(void_reason) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT acquisition_cost_acquisition_fk FOREIGN KEY (acquisition_id, mre_realm_id) REFERENCES acquisition (id, mre_realm_id),
      CONSTRAINT acquisition_cost_counterparty_fk FOREIGN KEY (counterparty_party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT acquisition_cost_payment_key UNIQUE (id, acquisition_id),
      CONSTRAINT acquisition_cost_status_fields CHECK ((status = 'VOID') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX acquisition_cost_acquisition_idx ON acquisition_cost (acquisition_id, created_at, id)`.execute(db);

  await sql`
    CREATE TABLE acquisition_payment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      acquisition_id uuid NOT NULL,
      acquisition_cost_id uuid,
      transaction_id uuid NOT NULL,
      amount numeric NOT NULL CHECK (scale(amount) <= 2 AND amount > 0 AND amount < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      unlinked_at timestamptz,
      unlink_reason text CHECK (length(unlink_reason) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT acquisition_payment_acquisition_fk FOREIGN KEY (acquisition_id, mre_realm_id) REFERENCES acquisition (id, mre_realm_id),
      CONSTRAINT acquisition_payment_cost_fk FOREIGN KEY (acquisition_cost_id, acquisition_id) REFERENCES acquisition_cost (id, acquisition_id),
      CONSTRAINT acquisition_payment_transaction_fk FOREIGN KEY (transaction_id, mre_realm_id, currency)
        REFERENCES ledger_transaction (id, mre_realm_id, currency),
      CONSTRAINT acquisition_payment_unlink_fields CHECK ((unlinked_at IS NULL) = (unlink_reason IS NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX acquisition_payment_acquisition_idx ON acquisition_payment (acquisition_id, created_at, id)`.execute(db);
  await sql`CREATE INDEX acquisition_payment_transaction_idx ON acquisition_payment (transaction_id)`.execute(db);
  await sql`CREATE INDEX acquisition_payment_cost_idx ON acquisition_payment (acquisition_cost_id) WHERE acquisition_cost_id IS NOT NULL`.execute(db);

  await sql`
    CREATE FUNCTION acquisition_cost_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AcquisitionCost %: never deleted; void it instead (api-design §27.2)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.acquisition_id, NEW.category, NEW.amount, NEW.currency, NEW.incurred_date,
          NEW.counterparty_party_id, NEW.source_references, NEW.notes, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.acquisition_id, OLD.category, OLD.amount, OLD.currency, OLD.incurred_date,
          OLD.counterparty_party_id, OLD.source_references, OLD.notes, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'AcquisitionCost %: its data never changes; void it and enter it again (api-design §27.2)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status = 'VOID' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'AcquisitionCost %: VOID is final (api-design §27.2)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status = 'ACTIVE' AND (NEW.version, NEW.updated_at, NEW.voided_at, NEW.void_reason) IS DISTINCT FROM (OLD.version, OLD.updated_at, OLD.voided_at, OLD.void_reason) THEN
        RAISE EXCEPTION 'AcquisitionCost %: version and updated_at change only with the void (api-design §27.2)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER acquisition_cost_frozen BEFORE UPDATE OR DELETE ON acquisition_cost FOR EACH ROW EXECUTE FUNCTION acquisition_cost_frozen()`.execute(
    db,
  );

  await sql`
    CREATE FUNCTION acquisition_payment_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AcquisitionPayment %: never deleted; unlink it instead (api-design §27.2)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.acquisition_id, NEW.acquisition_cost_id, NEW.transaction_id, NEW.amount, NEW.currency,
          NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.acquisition_id, OLD.acquisition_cost_id, OLD.transaction_id, OLD.amount, OLD.currency,
          OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'AcquisitionPayment %: its data never changes; unlink it and link again (api-design §27.2)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.unlinked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'AcquisitionPayment %: an unlink is final (api-design §27.2)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.unlinked_at IS NULL AND (NEW.version, NEW.updated_at, NEW.unlink_reason) IS DISTINCT FROM (OLD.version, OLD.updated_at, OLD.unlink_reason) THEN
        RAISE EXCEPTION 'AcquisitionPayment %: version and updated_at change only with the unlink (api-design §27.2)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER acquisition_payment_frozen BEFORE UPDATE OR DELETE ON acquisition_payment FOR EACH ROW EXECUTE FUNCTION acquisition_payment_frozen()`.execute(
    db,
  );

  // Serialises on the Acquisition row and refuses a CANCELLED one; returns its status.
  await sql`
    CREATE FUNCTION acquisition_touch_open(target uuid) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE
      acquisition_status text;
    BEGIN
      UPDATE acquisition SET version = version WHERE id = target;
      SELECT status INTO acquisition_status FROM acquisition WHERE id = target;
      IF acquisition_status = 'CANCELLED' THEN
        RAISE EXCEPTION 'Acquisition % is CANCELLED: its costs and payments are closed (ACQUISITION_CANCELLED)', target
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN acquisition_status;
    END $$
  `.execute(db);

  await sql`
    CREATE FUNCTION acquisition_cost_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      payment uuid;
    BEGIN
      PERFORM acquisition_touch_open(NEW.acquisition_id);
      IF TG_OP = 'UPDATE' AND NEW.status = 'VOID' THEN
        SELECT p.id INTO payment FROM acquisition_payment p WHERE p.acquisition_cost_id = NEW.id AND p.unlinked_at IS NULL LIMIT 1;
        IF payment IS NOT NULL THEN
          RAISE EXCEPTION 'AcquisitionCost %: payment % is linked to it; unlink it first (COST_HAS_PAYMENTS)', NEW.id, payment
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER acquisition_cost_guard BEFORE INSERT OR UPDATE ON acquisition_cost
      FOR EACH ROW EXECUTE FUNCTION acquisition_cost_guard()
  `.execute(db);

  await sql`
    CREATE FUNCTION acquisition_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      cost record;
      tx record;
      cap numeric;
      linked numeric;
      paid numeric;
    BEGIN
      PERFORM acquisition_touch_open(NEW.acquisition_id);
      IF TG_OP = 'UPDATE' THEN
        RETURN NEW;
      END IF;

      IF NEW.acquisition_cost_id IS NOT NULL THEN
        SELECT c.status, c.amount INTO cost FROM acquisition_cost c WHERE c.id = NEW.acquisition_cost_id AND c.acquisition_id = NEW.acquisition_id;
        IF NOT FOUND THEN
          RETURN NEW; -- left to the foreign key
        END IF;
        IF cost.status = 'VOID' THEN
          RAISE EXCEPTION 'AcquisitionPayment: cost % is VOID (COST_VOID)', NEW.acquisition_cost_id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        cap := cost.amount;
      ELSE
        SELECT a.purchase_price INTO cap FROM acquisition a WHERE a.id = NEW.acquisition_id;
      END IF;

      UPDATE ledger_transaction SET version = version WHERE id = NEW.transaction_id;
      SELECT t.amount, t.status, t.direction, t.correction_role INTO tx FROM ledger_transaction t WHERE t.id = NEW.transaction_id;
      IF NOT FOUND THEN
        RETURN NEW; -- left to the foreign key
      END IF;
      IF tx.status NOT IN ('CONFIRMED', 'RECONCILED') OR tx.correction_role IS NOT DISTINCT FROM 'REVERSAL' THEN
        RAISE EXCEPTION 'AcquisitionPayment: Transaction % is not current (%, %) (TRANSACTION_NOT_CURRENT)', NEW.transaction_id, tx.status, tx.correction_role
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF tx.direction <> 'OUTFLOW' THEN
        RAISE EXCEPTION 'AcquisitionPayment: Transaction % is not an OUTFLOW (NOT_OUTFLOW)', NEW.transaction_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;

      SELECT coalesce(sum(p.amount), 0) INTO linked FROM acquisition_payment p JOIN acquisition a ON a.id = p.acquisition_id
       WHERE p.transaction_id = NEW.transaction_id AND p.unlinked_at IS NULL AND a.status <> 'CANCELLED';
      IF linked + NEW.amount > tx.amount THEN
        RAISE EXCEPTION 'AcquisitionPayment: Transaction % of % would have % linked (PAYMENT_EXCEEDS_TRANSACTION)', NEW.transaction_id, tx.amount, linked + NEW.amount
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;

      SELECT coalesce(sum(p.amount), 0) INTO paid FROM acquisition_payment p JOIN ledger_transaction t ON t.id = p.transaction_id
       WHERE p.acquisition_id = NEW.acquisition_id AND p.acquisition_cost_id IS NOT DISTINCT FROM NEW.acquisition_cost_id
         AND p.unlinked_at IS NULL AND t.status IN ('CONFIRMED', 'RECONCILED') AND t.correction_role IS DISTINCT FROM 'REVERSAL';
      IF paid + NEW.amount > cap THEN
        RAISE EXCEPTION 'AcquisitionPayment: % of % would be paid (%)', paid + NEW.amount, cap,
          CASE WHEN NEW.acquisition_cost_id IS NULL THEN 'PAYMENT_EXCEEDS_PRICE' ELSE 'PAYMENT_EXCEEDS_COST' END
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER acquisition_payment_guard BEFORE INSERT OR UPDATE ON acquisition_payment FOR EACH ROW EXECUTE FUNCTION acquisition_payment_guard()`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE acquisition_payment`.execute(db);
  await sql`DROP TABLE acquisition_cost`.execute(db);
  await sql`DROP FUNCTION acquisition_payment_guard()`.execute(db);
  await sql`DROP FUNCTION acquisition_cost_guard()`.execute(db);
  await sql`DROP FUNCTION acquisition_touch_open(uuid)`.execute(db);
  await sql`DROP FUNCTION acquisition_payment_frozen()`.execute(db);
  await sql`DROP FUNCTION acquisition_cost_frozen()`.execute(db);
}

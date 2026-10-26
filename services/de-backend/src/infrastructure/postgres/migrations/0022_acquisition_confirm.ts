import { sql, type Kysely } from 'kysely';

/**
 * VC-2-07: Acquisition confirmation (api-design.md §28.1, phase-2-plan P2-D8), and the review notes on #49.
 *
 * - `acquisition_step`: a status step raises `version` by exactly one (cancel and confirm); `DRAFT` → `CONFIRMED`
 *   checks requirements 1–6 of §28.1 again (`acquisition_confirmation_violation`), so a confirmation past the
 *   repository is held to the same rules. `acquisition_initial`: an Acquisition is only inserted as `DRAFT`, so the
 *   check cannot be bypassed by inserting a confirmed row (as 0011 refuses inserting `CORRECTED`).
 * - `ownership_acquisition_confirmed`: a void of an Ownership carrying an Acquisition writes the Acquisition row and is
 *   refused while it is `CONFIRMED`. `ownership_acquisition_draft` (0020) writes the row too instead of reading it
 *   `FOR SHARE`. A share lock alone does not abort a stale REPEATABLE READ snapshot, a write does (review on #50).
 * - Locks of the confirm check: it holds the Acquisition (the `UPDATE`) and reads the buyers `FOR SHARE`, but does not
 *   write the PropertyReference. Every concurrent write that confirmation forbids meets it on the Acquisition row
 *   (a new Ownership carrying the id, a void of one, a cancel) or on a buyer (`deactivate`, `FOR UPDATE`). Every
 *   other Ownership write stays allowed after confirmation and is equivalent to the serial order "confirm, then that
 *   write". The reverse order Acquisition → buyers cannot deadlock: share locks on Parties do not conflict, and
 *   `deactivate` never takes an Acquisition.
 * - From the review on #49: the cost's void and the payment's unlink raise `version` by exactly one; a cost is only
 *   inserted `ACTIVE`, a payment only not unlinked.
 */
const ownershipAcquisitionDraft = (writeRow: boolean) =>
  sql.raw(`
    CREATE OR REPLACE FUNCTION ownership_acquisition_draft() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      acquisition_status text;
    BEGIN
      ${
        writeRow
          ? `UPDATE acquisition SET version = version WHERE id = NEW.acquisition_id;
      SELECT status INTO acquisition_status FROM acquisition WHERE id = NEW.acquisition_id;`
          : `SELECT status INTO acquisition_status FROM acquisition WHERE id = NEW.acquisition_id FOR SHARE;`
      }
      -- An unknown id is left to the foreign key.
      IF acquisition_status IS DISTINCT FROM 'DRAFT' AND acquisition_status IS NOT NULL THEN
        RAISE EXCEPTION 'Ownership: Acquisition % is %, only a DRAFT takes new Ownerships (ACQUISITION_NOT_DRAFT)', NEW.acquisition_id, acquisition_status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `);

export async function up(db: Kysely<unknown>): Promise<void> {
  // The first requirement of §28.1 that the Acquisition fails, or NULL. Shares are summed exactly (`div` on numeric).
  await sql`
    CREATE FUNCTION acquisition_confirmation_violation(target uuid) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE
      a record;
      d date;
      row record;
      n numeric := 0;
      den numeric := 1;
      g numeric;
    BEGIN
      SELECT * INTO a FROM acquisition WHERE id = target;
      d := coalesce(a.economic_transfer_date, a.contract_date);
      -- 1: buyers active, read FOR SHARE in id order (a running deactivate is waited for).
      PERFORM 1 FROM party p JOIN acquisition_party ap ON ap.party_id = p.id
        WHERE ap.acquisition_id = target AND ap.role = 'BUYER' ORDER BY p.id FOR SHARE OF p;
      IF EXISTS (SELECT 1 FROM party p JOIN acquisition_party ap ON ap.party_id = p.id
                  WHERE ap.acquisition_id = target AND ap.role = 'BUYER' AND p.status <> 'ACTIVE') THEN
        RETURN 'BUYER_INACTIVE';
      END IF;
      -- 2: its Ownerships start on the transfer date.
      IF EXISTS (SELECT 1 FROM ownership o WHERE o.acquisition_id = target AND o.status = 'VALID' AND o.valid_from <> d) THEN
        RETURN 'OWNERSHIP_NOT_FROM_TRANSFER_DATE';
      END IF;
      -- 3: held by buyers.
      IF EXISTS (SELECT 1 FROM ownership o WHERE o.acquisition_id = target AND o.status = 'VALID'
                  AND NOT EXISTS (SELECT 1 FROM acquisition_party ap WHERE ap.acquisition_id = target AND ap.role = 'BUYER' AND ap.party_id = o.owner_party_id)) THEN
        RETURN 'OWNER_NOT_A_BUYER';
      END IF;
      -- 4: every buyer holds one.
      IF EXISTS (SELECT 1 FROM acquisition_party ap WHERE ap.acquisition_id = target AND ap.role = 'BUYER'
                  AND NOT EXISTS (SELECT 1 FROM ownership o WHERE o.acquisition_id = target AND o.status = 'VALID' AND o.owner_party_id = ap.party_id)) THEN
        RETURN 'BUYER_WITHOUT_OWNERSHIP';
      END IF;
      -- 5: their shares sum to acquiredShare.
      FOR row IN SELECT o.share_numerator, o.share_denominator FROM ownership o WHERE o.acquisition_id = target AND o.status = 'VALID' LOOP
        n := n * row.share_denominator + row.share_numerator * den;
        den := den * row.share_denominator;
        g := gcd(n, den);
        n := div(n, g);
        den := div(den, g);
      END LOOP;
      IF n * a.acquired_share_denominator <> a.acquired_share_numerator * den THEN
        RETURN 'SHARE_SUM_MISMATCH';
      END IF;
      -- 6: the PropertyReference is COMPLETE on the transfer date, over all its owners.
      n := 0;
      den := 1;
      FOR row IN SELECT o.share_numerator, o.share_denominator FROM ownership o
                  WHERE o.property_reference_id = a.property_reference_id AND o.status = 'VALID'
                    AND d <@ daterange(o.valid_from, o.valid_until, '[]') LOOP
        n := n * row.share_denominator + row.share_numerator * den;
        den := den * row.share_denominator;
        g := gcd(n, den);
        n := div(n, g);
        den := div(den, g);
      END LOOP;
      IF n <> den THEN
        RETURN 'OWNERSHIP_INCOMPLETE';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);

  await sql`
    CREATE FUNCTION acquisition_step() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      violation text;
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
          RAISE EXCEPTION 'Acquisition %: the step % -> % must raise version from % to %, not to % (api-design §16.1)',
            OLD.id, OLD.status, NEW.status, OLD.version, OLD.version + 1, NEW.version USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.status = 'CONFIRMED' THEN
          violation := acquisition_confirmation_violation(NEW.id);
          IF violation IS NOT NULL THEN
            RAISE EXCEPTION 'Acquisition %: cannot be confirmed (%)', NEW.id, violation USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER acquisition_step BEFORE UPDATE ON acquisition FOR EACH ROW EXECUTE FUNCTION acquisition_step()`.execute(db);

  await sql`
    CREATE FUNCTION acquisition_initial() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Acquisition: only a DRAFT is inserted, not % (api-design §28.1)', NEW.status USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER acquisition_initial BEFORE INSERT ON acquisition FOR EACH ROW EXECUTE FUNCTION acquisition_initial()`.execute(db);

  await sql`${ownershipAcquisitionDraft(true)}`.execute(db);
  await sql`
    CREATE FUNCTION ownership_acquisition_confirmed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      acquisition_status text;
    BEGIN
      UPDATE acquisition SET version = version WHERE id = OLD.acquisition_id;
      SELECT status INTO acquisition_status FROM acquisition WHERE id = OLD.acquisition_id;
      IF acquisition_status = 'CONFIRMED' THEN
        RAISE EXCEPTION 'Ownership %: Acquisition % is CONFIRMED; close it instead of voiding it (ACQUISITION_CONFIRMED)', OLD.id, OLD.acquisition_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ownership_acquisition_confirmed BEFORE UPDATE ON ownership
      FOR EACH ROW WHEN (OLD.status = 'VALID' AND NEW.status = 'VOID' AND OLD.acquisition_id IS NOT NULL)
      EXECUTE FUNCTION ownership_acquisition_confirmed()
  `.execute(db);

  // Review on #49: one step, by exactly one version; inserted only in the initial state.
  await sql`
    CREATE FUNCTION acquisition_cost_step() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'ACTIVE' THEN
          RAISE EXCEPTION 'AcquisitionCost: only inserted ACTIVE, not % (api-design §27.2)', NEW.status USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'AcquisitionCost %: the void must raise version from % to %, not to % (api-design §16.1)', OLD.id, OLD.version, OLD.version + 1, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER acquisition_cost_step BEFORE INSERT OR UPDATE ON acquisition_cost FOR EACH ROW EXECUTE FUNCTION acquisition_cost_step()`.execute(db);
  await sql`
    CREATE FUNCTION acquisition_payment_step() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.unlinked_at IS NOT NULL THEN
          RAISE EXCEPTION 'AcquisitionPayment: never inserted unlinked (api-design §27.2)' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      ELSIF NEW.unlinked_at IS DISTINCT FROM OLD.unlinked_at AND NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'AcquisitionPayment %: the unlink must raise version from % to %, not to % (api-design §16.1)', OLD.id, OLD.version, OLD.version + 1, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER acquisition_payment_step BEFORE INSERT OR UPDATE ON acquisition_payment FOR EACH ROW EXECUTE FUNCTION acquisition_payment_step()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER acquisition_payment_step ON acquisition_payment`.execute(db);
  await sql`DROP FUNCTION acquisition_payment_step()`.execute(db);
  await sql`DROP TRIGGER acquisition_cost_step ON acquisition_cost`.execute(db);
  await sql`DROP FUNCTION acquisition_cost_step()`.execute(db);
  await sql`DROP TRIGGER ownership_acquisition_confirmed ON ownership`.execute(db);
  await sql`DROP FUNCTION ownership_acquisition_confirmed()`.execute(db);
  await sql`${ownershipAcquisitionDraft(false)}`.execute(db);
  await sql`DROP TRIGGER acquisition_initial ON acquisition`.execute(db);
  await sql`DROP FUNCTION acquisition_initial()`.execute(db);
  await sql`DROP TRIGGER acquisition_step ON acquisition`.execute(db);
  await sql`DROP FUNCTION acquisition_step()`.execute(db);
  await sql`DROP FUNCTION acquisition_confirmation_violation(uuid)`.execute(db);
}

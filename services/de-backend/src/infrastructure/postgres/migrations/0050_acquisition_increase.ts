import { sql, type Kysely } from 'kysely';

/**
 * VC-X-30: an existing owner buying a further share (api-design.md §28.1A).
 *
 * - `acquisition_confirmation_violation` (0022) is replaced: steps 1–4 and 6 stay as they are, step 5 compares the
 *   buyers' **increases** with `acquired_share` instead of the full shares of their Ownerships. A buyer's increase is
 *   the sum of its `VALID` shares covering the transfer date `d` minus the sum covering `d − 1`, whatever Acquisition
 *   those rows carry; 5a refuses a buyer whose share does not rise (`BUYER_SHARE_NOT_INCREASED`), 5b a sum of the
 *   increases other than `acquired_share` (`SHARE_SUM_MISMATCH`). Both live in `acquisition_increase_violation`, so the
 *   legacy check below can ask for them alone. Sums are exact as in 0022: `numeric` numerators and denominators,
 *   cross-multiplied and reduced by `gcd`; a difference is a sum with a negated numerator.
 * - `ownership_predecessor_of_confirmed`: once a purchase is confirmed, its buyer's predecessor row (the `VALID` row of
 *   the owner ending the day before the owner's Ownership carrying the Acquisition) can no longer be voided, shortened
 *   or inserted. The trigger writes the PropertyReference first (the no-op of 0019), then the next row's Acquisition
 *   (the no-op of 0022), so a concurrent raw confirm and this write serialise: READ COMMITTED waits and sees, REPEATABLE
 *   READ fails with `40001`. `ownership_invariants` (0019) writes the PropertyReference too, but it is an `AFTER`
 *   trigger and fires after every `BEFORE` trigger, so this one takes it itself to keep the order PropertyReference →
 *   Acquisition. A `DRAFT` next Acquisition is touched and allowed.
 * - `up` reports, with `RAISE NOTICE`, every `CONFIRMED` Acquisition that fails 5a or 5b under the new rule (confirmed
 *   before 0050 with a buyer who already held a share, the `1/1` workaround); none is changed. `down` restores 0022's
 *   function body; an Acquisition confirmed under 0050 stays confirmed.
 */
const confirmationViolation = (increase: boolean) =>
  sql.raw(`
    CREATE OR REPLACE FUNCTION acquisition_confirmation_violation(target uuid) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE
      a record;
      d date;
      row record;
      n numeric := 0;
      den numeric := 1;
      g numeric;${increase ? '\n      violation text;' : ''}
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
${increase ? STEP_5_INCREASE : STEP_5_0022}
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
  `);

/** 0022's step 5, kept for `down`: the full shares of its Ownerships sum to `acquired_share`. */
const STEP_5_0022 = `      -- 5: their shares sum to acquiredShare.
      FOR row IN SELECT o.share_numerator, o.share_denominator FROM ownership o WHERE o.acquisition_id = target AND o.status = 'VALID' LOOP
        n := n * row.share_denominator + row.share_numerator * den;
        den := den * row.share_denominator;
        g := gcd(n, den);
        n := div(n, g);
        den := div(den, g);
      END LOOP;
      IF n * a.acquired_share_denominator <> a.acquired_share_numerator * den THEN
        RETURN 'SHARE_SUM_MISMATCH';
      END IF;`;

const STEP_5_INCREASE = `      -- 5 (§28.1A): 5a each buyer's share rises on the transfer date, 5b the increases sum to acquiredShare.
      violation := acquisition_increase_violation(target);
      IF violation IS NOT NULL THEN
        RETURN violation;
      END IF;`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // 5a and 5b of §28.1A for the buyers holding a VALID Ownership carrying `target` (a buyer without one is step 4's).
  await sql`
    CREATE FUNCTION acquisition_increase_violation(target uuid) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE
      a record;
      d date;
      buyer uuid;
      row record;
      day_n numeric;
      day_den numeric;
      before_n numeric;
      before_den numeric;
      inc_n numeric;
      inc_den numeric;
      n numeric := 0;
      den numeric := 1;
      g numeric;
    BEGIN
      SELECT * INTO a FROM acquisition WHERE id = target;
      d := coalesce(a.economic_transfer_date, a.contract_date);
      FOR buyer IN SELECT ap.party_id FROM acquisition_party ap WHERE ap.acquisition_id = target AND ap.role = 'BUYER'
                    AND EXISTS (SELECT 1 FROM ownership o WHERE o.acquisition_id = target AND o.status = 'VALID' AND o.owner_party_id = ap.party_id)
                    ORDER BY ap.party_id LOOP
        -- held on d and on d - 1: the buyer's VALID shares of the PropertyReference covering the day.
        day_n := 0;
        day_den := 1;
        FOR row IN SELECT o.share_numerator, o.share_denominator FROM ownership o
                    WHERE o.property_reference_id = a.property_reference_id AND o.owner_party_id = buyer AND o.status = 'VALID'
                      AND d <@ daterange(o.valid_from, o.valid_until, '[]') LOOP
          day_n := day_n * row.share_denominator + row.share_numerator * day_den;
          day_den := day_den * row.share_denominator;
          g := gcd(day_n, day_den);
          day_n := div(day_n, g);
          day_den := div(day_den, g);
        END LOOP;
        before_n := 0;
        before_den := 1;
        FOR row IN SELECT o.share_numerator, o.share_denominator FROM ownership o
                    WHERE o.property_reference_id = a.property_reference_id AND o.owner_party_id = buyer AND o.status = 'VALID'
                      AND d - 1 <@ daterange(o.valid_from, o.valid_until, '[]') LOOP
          before_n := before_n * row.share_denominator + row.share_numerator * before_den;
          before_den := before_den * row.share_denominator;
          g := gcd(before_n, before_den);
          before_n := div(before_n, g);
          before_den := div(before_den, g);
        END LOOP;
        -- The increase: held(d) + (-held(d - 1)).
        inc_n := day_n * before_den + (-before_n) * day_den;
        inc_den := day_den * before_den;
        g := gcd(inc_n, inc_den);
        inc_n := div(inc_n, g);
        inc_den := div(inc_den, g);
        -- 5a: a decrease (or no change) is not a purchase.
        IF inc_n <= 0 THEN
          RETURN 'BUYER_SHARE_NOT_INCREASED';
        END IF;
        n := n * inc_den + inc_n * den;
        den := den * inc_den;
        g := gcd(n, den);
        n := div(n, g);
        den := div(den, g);
      END LOOP;
      -- 5b: the increases, not the full shares, make up acquiredShare.
      IF n * a.acquired_share_denominator <> a.acquired_share_numerator * den THEN
        RETURN 'SHARE_SUM_MISMATCH';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db);
  // acquisition_step (0022) calls it unchanged, so a raw DRAFT -> CONFIRMED is held to the new rule.
  await sql`${confirmationViolation(true)}`.execute(db);

  await sql`
    CREATE FUNCTION ownership_predecessor_of_confirmed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      row_end date;
      successor record;
      acquisition_status text;
    BEGIN
      -- An insert of a VALID row with an end, a VALID -> VOID, or a moved end; the end is the old one on an update.
      -- (A WHEN clause cannot read OLD in a trigger that also fires on INSERT.)
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'VALID' OR NEW.valid_until IS NULL THEN
          RETURN NEW;
        END IF;
        row_end := NEW.valid_until;
      ELSE
        IF OLD.status <> 'VALID' OR OLD.valid_until IS NULL
           OR (NEW.status = OLD.status AND NEW.valid_until IS NOT DISTINCT FROM OLD.valid_until) THEN
          RETURN NEW;
        END IF;
        row_end := OLD.valid_until;
      END IF;
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      FOR successor IN SELECT o.id, o.acquisition_id FROM ownership o
                        WHERE o.property_reference_id = NEW.property_reference_id AND o.owner_party_id = NEW.owner_party_id
                          AND o.status = 'VALID' AND o.valid_from = row_end + 1 AND o.acquisition_id IS NOT NULL
                        ORDER BY o.acquisition_id, o.id LOOP
        UPDATE acquisition SET version = version WHERE id = successor.acquisition_id;
        SELECT status INTO acquisition_status FROM acquisition WHERE id = successor.acquisition_id;
        IF acquisition_status = 'CONFIRMED' THEN
          RAISE EXCEPTION 'Ownership %: the next Ownership % of its owner carries the CONFIRMED Acquisition %; its acquired share is fixed (ACQUISITION_CONFIRMED)',
            NEW.id, successor.id, successor.acquisition_id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ownership_predecessor_of_confirmed BEFORE INSERT OR UPDATE ON ownership
      FOR EACH ROW EXECUTE FUNCTION ownership_predecessor_of_confirmed()
  `.execute(db);

  // Legacy: confirmed before 0050 under the full-share rule, failing 5a or 5b now. Reported, never changed.
  await sql`
    DO $$
    DECLARE
      a record;
      violation text;
    BEGIN
      FOR a IN SELECT id FROM acquisition WHERE status = 'CONFIRMED' ORDER BY id LOOP
        violation := acquisition_increase_violation(a.id);
        IF violation IS NOT NULL THEN
          RAISE NOTICE 'VC-X-30: CONFIRMED Acquisition % fails requirement 5 of api-design §28.1A (%); it stays confirmed', a.id, violation;
        END IF;
      END LOOP;
    END $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER ownership_predecessor_of_confirmed ON ownership`.execute(db);
  await sql`DROP FUNCTION ownership_predecessor_of_confirmed()`.execute(db);
  await sql`${confirmationViolation(false)}`.execute(db);
  await sql`DROP FUNCTION acquisition_increase_violation(uuid)`.execute(db);
}

import { sql, type Kysely } from 'kysely';

/**
 * VC-X-57: the buyers' Ownerships from the economic transfer on confirm (api-design.md §58R "The guards"; ADR-044;
 * Entscheidung des Projektinhabers, 2026-11-06, §58R Fragen 1–10, all as proposed).
 *
 * - `acquisition.confirmed_ownership_start` (`NULL` until the transition to `CONFIRMED` stores `economic_transfer_date`);
 *   CHECK `acquisition_confirmed_ownership_start` holds it to a `CONFIRMED` row and to the date. No backfill: every row
 *   confirmed before keeps its `ownershipStart` (§58R rule 1, branches 2, 4 and 5).
 * - 0022's `acquisition_step` (as 0067 patched it): after requirement 0, `NEW.confirmed_ownership_start` := the date.
 * - 0020's `acquisition_frozen` (as 0067 and 0072 patched it): a writer never sets, changes or clears the column (the
 *   trigger fires before `acquisition_step`, so it sees the writer's value); 0072's alignment allowance holds only while
 *   `OLD.confirmed_ownership_start IS NULL` (`CONFIRMED_FROM_TRANSFER`, Frage 7). 0072's row CHECK is unchanged.
 * - 0050's `acquisition_confirmation_violation` and `acquisition_increase_violation` (their `d :=` lines as 0072 left
 *   them): rule 1 of §58R; inside the `BEFORE UPDATE` trigger the function reads the `DRAFT`, so `d` is the date.
 * - Requirement 7 (`SELLER_SHARE_CHANGED_BEFORE_TRANSFER`, Frage 3): `acquisition_seller_share_violation` after step 6
 *   of `acquisition_confirmation_violation`; every seller holds on `d − 1` what it held on `contract_date − 1`; skipped
 *   when `d` is the contract date (legacy rows, a transfer on the contract date).
 * - The functions are patched in place (`pg_get_functiondef`, the passage checked to occur exactly once); `down`
 *   replaces it back. `down` refuses while a row has `confirmed_ownership_start` and a date recorded later (§58N): its
 *   `ownershipStart` would fall back to the contract date under Ownerships from the transfer.
 */

/** (i) acquisition_step: the confirmation stores the day, after requirement 0. */
const STEP_FROM = `            RAISE EXCEPTION 'Acquisition %: cannot be confirmed (TRANSFER_DATE_MISSING)', NEW.id USING ERRCODE = 'integrity_constraint_violation';
          END IF;
`;
const STEP_TO = `            RAISE EXCEPTION 'Acquisition %: cannot be confirmed (TRANSFER_DATE_MISSING)', NEW.id USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          -- 0073 (api-design §58R, VC-X-57): the confirmation stores the day the buyers' Ownerships begin.
          NEW.confirmed_ownership_start := NEW.economic_transfer_date;
`;

/** (ii) acquisition_frozen: no writer touches the column; placed before 0072's alignment allowance. */
const FROZEN_FROM = `      -- 0072 (api-design §58Q, VC-X-55): the Ownerships aligned to the transfer, once, from NULL, with the act's evidence,
`;
const FROZEN_TO = `      -- 0073 (api-design §58R, VC-X-57): confirmed_ownership_start is set by acquisition_step on the transition only (this
      -- trigger fires before it and sees the writer's value); never written, changed or cleared by anyone else.
      IF NEW.confirmed_ownership_start IS DISTINCT FROM OLD.confirmed_ownership_start THEN
        RAISE EXCEPTION 'Acquisition %: confirmed_ownership_start is stored by the confirmation only and never changes (api-design §58R)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- 0072 (api-design §58Q, VC-X-55): the Ownerships aligned to the transfer, once, from NULL, with the act's evidence,
`;

/** (iii) acquisition_frozen: 0072's alignment allowance only before the confirmation stored the day. */
const ALIGN_FROM = `        IF NEW.status IS DISTINCT FROM OLD.status THEN
          RAISE EXCEPTION 'Acquisition %: the alignment is recorded without a status step (api-design §58Q)', OLD.id`;
const ALIGN_TO = `        -- 0073 (api-design §58R Frage 7): an Acquisition confirmed from the transfer has nothing to align.
        IF OLD.confirmed_ownership_start IS NOT NULL THEN
          RAISE EXCEPTION 'Acquisition %: confirmed from the transfer, nothing to align (CONFIRMED_FROM_TRANSFER, api-design §58R)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          RAISE EXCEPTION 'Acquisition %: the alignment is recorded without a status step (api-design §58Q)', OLD.id`;

/** (iv) `ownershipStart`: §58R rule 1. */
const D_FROM = `      d := CASE WHEN a.ownership_aligned_at IS NOT NULL THEN a.economic_transfer_date WHEN a.economic_transfer_recorded_at IS NOT NULL THEN a.contract_date ELSE coalesce(a.economic_transfer_date, a.contract_date) END;`;
const D_TO = `      d := CASE WHEN a.confirmed_ownership_start IS NOT NULL THEN a.confirmed_ownership_start WHEN a.ownership_aligned_at IS NOT NULL THEN a.economic_transfer_date WHEN a.status <> 'CONFIRMED' THEN coalesce(a.economic_transfer_date, a.contract_date) WHEN a.economic_transfer_recorded_at IS NOT NULL THEN a.contract_date ELSE coalesce(a.economic_transfer_date, a.contract_date) END;`;

/** (v) Requirement 7 after step 6 of acquisition_confirmation_violation. */
const SEVEN_FROM = `      IF n <> den THEN
        RETURN 'OWNERSHIP_INCOMPLETE';
      END IF;
      RETURN NULL;`;
const SEVEN_TO = `      IF n <> den THEN
        RETURN 'OWNERSHIP_INCOMPLETE';
      END IF;
      -- 7 (0073, api-design §58R): every seller holds on d - 1 what it held on the contract date - 1.
      RETURN acquisition_seller_share_violation(target, d);`;

const PATCHES = [
  { fn: 'acquisition_step()', from: STEP_FROM, to: STEP_TO },
  { fn: 'acquisition_frozen()', from: FROZEN_FROM, to: FROZEN_TO },
  { fn: 'acquisition_frozen()', from: ALIGN_FROM, to: ALIGN_TO },
  { fn: 'acquisition_confirmation_violation(uuid)', from: D_FROM, to: D_TO },
  { fn: 'acquisition_confirmation_violation(uuid)', from: SEVEN_FROM, to: SEVEN_TO },
  { fn: 'acquisition_increase_violation(uuid)', from: D_FROM, to: D_TO },
] as const;

/** Replaces `from` by `to` in the function's current definition, which must hold `from` exactly once (as 0067, 0072). */
async function patchFunction(db: Kysely<unknown>, fn: string, from: string, to: string): Promise<void> {
  const { rows } = await sql<{ def: string }>`SELECT pg_get_functiondef(${fn}::regprocedure) AS def`.execute(db);
  const def = rows[0]?.def ?? '';
  const count = def.split(from).length - 1;
  if (count !== 1) throw new Error(`0073: ${fn} holds the passage to replace ${count} times, expected once`);
  await sql.raw(def.replace(from, () => to)).execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE acquisition
      ADD COLUMN confirmed_ownership_start date,
      ADD CONSTRAINT acquisition_confirmed_ownership_start CHECK (
        confirmed_ownership_start IS NULL OR (status = 'CONFIRMED' AND confirmed_ownership_start = economic_transfer_date)
      )
  `.execute(db);
  // Requirement 7 (§58R rule 3): the exact sums of a seller's VALID shares of the PropertyReference in the Realm covering
  // the contract date - 1 and d - 1, cross-multiplied; the first seller by party id whose sums differ.
  await sql`
    CREATE FUNCTION acquisition_seller_share_violation(target uuid, d date) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE
      a record;
      seller uuid;
      row record;
      c_n numeric;
      c_den numeric;
      t_n numeric;
      t_den numeric;
      g numeric;
    BEGIN
      SELECT * INTO a FROM acquisition WHERE id = target;
      IF d IS NULL OR d = a.contract_date THEN
        RETURN NULL;
      END IF;
      FOR seller IN SELECT ap.party_id FROM acquisition_party ap WHERE ap.acquisition_id = target AND ap.role = 'SELLER' ORDER BY ap.party_id LOOP
        c_n := 0;
        c_den := 1;
        FOR row IN SELECT o.share_numerator, o.share_denominator FROM ownership o
                    WHERE o.property_reference_id = a.property_reference_id AND o.mre_realm_id = a.mre_realm_id
                      AND o.owner_party_id = seller AND o.status = 'VALID'
                      AND a.contract_date - 1 <@ daterange(o.valid_from, o.valid_until, '[]') LOOP
          c_n := c_n * row.share_denominator + row.share_numerator * c_den;
          c_den := c_den * row.share_denominator;
          g := gcd(c_n, c_den);
          c_n := div(c_n, g);
          c_den := div(c_den, g);
        END LOOP;
        t_n := 0;
        t_den := 1;
        FOR row IN SELECT o.share_numerator, o.share_denominator FROM ownership o
                    WHERE o.property_reference_id = a.property_reference_id AND o.mre_realm_id = a.mre_realm_id
                      AND o.owner_party_id = seller AND o.status = 'VALID'
                      AND d - 1 <@ daterange(o.valid_from, o.valid_until, '[]') LOOP
          t_n := t_n * row.share_denominator + row.share_numerator * t_den;
          t_den := t_den * row.share_denominator;
          g := gcd(t_n, t_den);
          t_n := div(t_n, g);
          t_den := div(t_den, g);
        END LOOP;
        IF c_n * t_den <> t_n * c_den THEN
          RETURN 'SELLER_SHARE_CHANGED_BEFORE_TRANSFER';
        END IF;
      END LOOP;
      RETURN NULL;
    END $$
  `.execute(db);
  for (const p of PATCHES) await patchFunction(db, p.fn, p.from, p.to);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is changed (api-design §58R "down"): such a row's ownershipStart would move back to the
  // contract date under Ownerships written from the transfer.
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM acquisition WHERE confirmed_ownership_start IS NOT NULL AND economic_transfer_recorded_at IS NOT NULL) THEN
        RAISE EXCEPTION 'acquisition: a confirmation from a transfer date recorded later exists; its ownershipStart cannot fall back to the contract date (api-design §58R)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  for (const p of [...PATCHES].reverse()) await patchFunction(db, p.fn, p.to, p.from);
  await sql`DROP FUNCTION acquisition_seller_share_violation(uuid, date)`.execute(db);
  await sql`
    ALTER TABLE acquisition
      DROP CONSTRAINT acquisition_confirmed_ownership_start,
      DROP COLUMN confirmed_ownership_start
  `.execute(db);
}

import { sql, type Kysely } from 'kysely';

/**
 * VC-X-43: a Loan partly used outside letting (api-design.md §58V; Entscheidung des Projektinhabers, 2026-11-07,
 * questions 1–5; Prüfbericht 2026-11-01, Frage 21, mündlich bestätigt durch den Steuerberater, laut Projektinhaber am
 * 2026-11-01). The part outside letting is an entry row of its own, so 0026's exact sum keeps counting every row and
 * the invariant `1/1` stays one check in one place (question 2).
 *
 * - `loan_allocation.property_reference_id` nullable; `use` `LETTING` (default) or `OUTSIDE_LETTING`, CHECKs
 *   `loan_allocation_use`, `loan_allocation_use_property` (a PropertyReference exactly on a `LETTING` row) and
 *   `loan_allocation_outside_letting_no_acquisition`; the partial unique index `loan_allocation_outside_letting_once`
 *   (one part per set: `UNIQUE (set_id, property_reference_id)` treats NULLs as distinct). The composite foreign keys
 *   are `MATCH SIMPLE` (0026), so the row without a PropertyReference checks neither; `(set_id, mre_realm_id)` keeps it in
 *   its set's Realm.
 * - `loan_allocation_set.use_evidence text[]`: `NULL`, or 1–10 texts of 1–500 characters after trimming
 *   (`loan_allocation_set_use_evidence`, by the IMMUTABLE `loan_allocation_set_texts_valid`).
 * - `loan_allocation_set_frozen` replaced: its column list gains `use_evidence`, so it never changes either.
 * - `loan_allocation_complete` replaced (deferred, at commit): the sum over every row unchanged; new, an
 *   `OUTSIDE_LETTING` row only on a `MANUAL` set (question 3), at least one `LETTING` row (question 4), and
 *   `use_evidence` with an `OUTSIDE_LETTING` row (question 5).
 * - **No backfill:** the default is a constant, so the column is added without rewriting a row and without firing
 *   `loan_allocation_frozen`; every existing row reads `LETTING`, every existing set `use_evidence NULL`.
 * - `down`: refused while an `OUTSIDE_LETTING` row or a `use_evidence` exists (no statement dropped silently); then 0026's
 *   functions verbatim, the CHECKs, the index and the columns dropped, `NOT NULL` restored.
 */

/** 0026's `loan_allocation_set_frozen` body, verbatim (restored by `down`). */
export const SET_FROZEN_0026 = `
    DECLARE
      later uuid;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'LoanAllocationSet %: never deleted; void it instead (api-design §41.3)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.loan_id, NEW.valid_from, NEW.basis, NEW.notes, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.loan_id, OLD.valid_from, OLD.basis, OLD.notes, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'LoanAllocationSet %: sets are never edited; void the last one and append (api-design §41.3)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      IF NOT (OLD.status = 'VALID' AND NEW.status = 'VOID') OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'LoanAllocationSet %: the only step is VALID → VOID with version + 1 (api-design §41.3)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      -- The Loan row first: a concurrent append behind this set meets the void there (as loan_terms_frozen).
      UPDATE loan SET version = version WHERE id = OLD.loan_id;
      SELECT id INTO later FROM loan_allocation_set
       WHERE loan_id = OLD.loan_id AND status = 'VALID' AND valid_from > OLD.valid_from LIMIT 1;
      IF later IS NOT NULL THEN
        RAISE EXCEPTION 'LoanAllocationSet %: set % follows it; only the last set is voided (ALLOCATION_NOT_LAST)', OLD.id, later
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END `;

/** 0026's `loan_allocation_complete` body, verbatim (restored by `down`). */
export const COMPLETE_0026 = `
    DECLARE
      target uuid;
      set_basis text;
      row record;
      n numeric := 0;
      d numeric := 1;
      g numeric;
    BEGIN
      -- Separate statements: a field of NEW is resolved only when its statement runs.
      IF TG_TABLE_NAME = 'loan_allocation_set' THEN
        target := NEW.id;
      ELSE
        target := NEW.set_id;
      END IF;
      SELECT basis INTO set_basis FROM loan_allocation_set WHERE id = target;
      FOR row IN SELECT share_numerator, share_denominator, acquisition_id FROM loan_allocation WHERE set_id = target LOOP
        IF (row.acquisition_id IS NOT NULL) <> (set_basis = 'PURCHASE_PRICE') THEN
          RAISE EXCEPTION 'LoanAllocationSet %: a % set carries an Acquisition exactly for PURCHASE_PRICE (api-design §41.3)', target, set_basis
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        n := n * row.share_denominator + row.share_numerator * d;
        d := d * row.share_denominator;
        g := gcd(n, d);
        n := n / g;
        d := d / g;
      END LOOP;
      IF n <> d THEN
        RAISE EXCEPTION 'LoanAllocationSet %: shares sum to %/%, not 1/1 (SHARE_SUM_NOT_ONE)', target, n, d
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END `;

/** 0077's `loan_allocation_set_frozen`: 0026's with `use_evidence` in both tuples. */
export const SET_FROZEN_0077 = SET_FROZEN_0026.replace(
  /NEW\.created_at, NEW\.created_by\)([\s\S]*?)OLD\.created_at, OLD\.created_by\)/,
  'NEW.created_at, NEW.created_by, NEW.use_evidence)$1OLD.created_at, OLD.created_by, OLD.use_evidence)',
);

/** 0077's `loan_allocation_complete`: the sum over every row as 0026's, then the part outside letting's three rules. */
export const COMPLETE_0077 = `
    DECLARE
      target uuid;
      set_basis text;
      set_evidence text[];
      row record;
      n numeric := 0;
      d numeric := 1;
      g numeric;
      letting integer := 0;
      outside integer := 0;
    BEGIN
      -- Separate statements: a field of NEW is resolved only when its statement runs.
      IF TG_TABLE_NAME = 'loan_allocation_set' THEN
        target := NEW.id;
      ELSE
        target := NEW.set_id;
      END IF;
      SELECT basis, use_evidence INTO set_basis, set_evidence FROM loan_allocation_set WHERE id = target;
      FOR row IN SELECT share_numerator, share_denominator, acquisition_id, use FROM loan_allocation WHERE set_id = target LOOP
        IF row.use = 'OUTSIDE_LETTING' THEN
          outside := outside + 1;
          IF set_basis <> 'MANUAL' THEN
            RAISE EXCEPTION 'LoanAllocationSet %: a part outside letting only on a MANUAL set (OUTSIDE_LETTING_NOT_ALLOWED_FOR_BASIS, api-design §58V)', target
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSE
          letting := letting + 1;
          IF (row.acquisition_id IS NOT NULL) <> (set_basis = 'PURCHASE_PRICE') THEN
            RAISE EXCEPTION 'LoanAllocationSet %: a % set carries an Acquisition exactly for PURCHASE_PRICE (api-design §41.3)', target, set_basis
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        END IF;
        n := n * row.share_denominator + row.share_numerator * d;
        d := d * row.share_denominator;
        g := gcd(n, d);
        n := n / g;
        d := d / g;
      END LOOP;
      IF n <> d THEN
        RAISE EXCEPTION 'LoanAllocationSet %: shares sum to %/%, not 1/1 (SHARE_SUM_NOT_ONE)', target, n, d
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF letting = 0 THEN
        RAISE EXCEPTION 'LoanAllocationSet %: at least one PropertyReference (OUTSIDE_LETTING_ONLY, api-design §58V)', target
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF outside > 0 AND set_evidence IS NULL THEN
        RAISE EXCEPTION 'LoanAllocationSet %: a part outside letting needs its use_evidence (USE_EVIDENCE_REQUIRED, api-design §58V)', target
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END `;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE loan_allocation
      ALTER COLUMN property_reference_id DROP NOT NULL,
      ADD COLUMN use text NOT NULL DEFAULT 'LETTING',
      ADD CONSTRAINT loan_allocation_use CHECK (use IN ('LETTING', 'OUTSIDE_LETTING')),
      ADD CONSTRAINT loan_allocation_use_property CHECK ((use = 'LETTING') = (property_reference_id IS NOT NULL)),
      ADD CONSTRAINT loan_allocation_outside_letting_no_acquisition CHECK (use = 'LETTING' OR acquisition_id IS NULL)
  `.execute(db);
  await sql`CREATE UNIQUE INDEX loan_allocation_outside_letting_once ON loan_allocation (set_id) WHERE use = 'OUTSIDE_LETTING'`.execute(db);
  await sql`
    CREATE FUNCTION loan_allocation_set_texts_valid(texts text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT coalesce(bool_and(length(btrim(t)) BETWEEN 1 AND 500 AND length(t) <= 500), true) FROM unnest(texts) AS t
    $$
  `.execute(db);
  await sql`
    ALTER TABLE loan_allocation_set
      ADD COLUMN use_evidence text[],
      ADD CONSTRAINT loan_allocation_set_use_evidence CHECK (
        use_evidence IS NULL
        OR (cardinality(use_evidence) BETWEEN 1 AND 10 AND array_position(use_evidence, NULL) IS NULL AND loan_allocation_set_texts_valid(use_evidence))
      )
  `.execute(db);
  await sql.raw(`CREATE OR REPLACE FUNCTION loan_allocation_set_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${SET_FROZEN_0077}$$`).execute(db);
  await sql.raw(`CREATE OR REPLACE FUNCTION loan_allocation_complete() RETURNS trigger LANGUAGE plpgsql AS $$${COMPLETE_0077}$$`).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      carrying uuid;
    BEGIN
      SELECT set_id INTO carrying FROM loan_allocation WHERE use = 'OUTSIDE_LETTING' LIMIT 1;
      IF carrying IS NULL THEN
        SELECT id INTO carrying FROM loan_allocation_set WHERE use_evidence IS NOT NULL LIMIT 1;
      END IF;
      IF carrying IS NOT NULL THEN
        RAISE EXCEPTION 'LoanAllocationSet %: carries a part outside letting or its evidence; 0077 cannot be rolled back without dropping it (api-design §58V)', carrying
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await sql.raw(`CREATE OR REPLACE FUNCTION loan_allocation_complete() RETURNS trigger LANGUAGE plpgsql AS $$${COMPLETE_0026}$$`).execute(db);
  await sql.raw(`CREATE OR REPLACE FUNCTION loan_allocation_set_frozen() RETURNS trigger LANGUAGE plpgsql AS $$${SET_FROZEN_0026}$$`).execute(db);
  await sql`
    ALTER TABLE loan_allocation_set
      DROP CONSTRAINT loan_allocation_set_use_evidence,
      DROP COLUMN use_evidence
  `.execute(db);
  await sql`DROP FUNCTION loan_allocation_set_texts_valid(text[])`.execute(db);
  await sql`DROP INDEX loan_allocation_outside_letting_once`.execute(db);
  await sql`
    ALTER TABLE loan_allocation
      DROP CONSTRAINT loan_allocation_outside_letting_no_acquisition,
      DROP CONSTRAINT loan_allocation_use_property,
      DROP CONSTRAINT loan_allocation_use,
      DROP COLUMN use,
      ALTER COLUMN property_reference_id SET NOT NULL
  `.execute(db);
}

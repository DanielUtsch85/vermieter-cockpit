import { sql, type Kysely } from 'kysely';

/**
 * VC-2-05: Acquisition drafts (data-model.md §13, api-design.md §27.1, phase-2-plan P2-D6/P2-D8).
 *
 * - `acquisition`: Realm- and PropertyReference-bound; price > 0 in EUR with at most two decimals (as the ledger's
 *   amounts); `acquired_share` reduced as `ownership`'s; the transfer dates not before the contract; status
 *   `DRAFT` → `CANCELLED` / `CONFIRMED`, each with its own timestamp (and the cancellation reason).
 * - `acquisition_party`: buyers and sellers in the order given; a Party at most once per Acquisition, so nobody is
 *   both buyer and seller.
 * - `acquisition_frozen`: id, Realm, PropertyReference, price and currency, share, dates, texts and creation never
 *   change; the status columns change only with a transition out of `DRAFT`, which is final; `version` and
 *   `updated_at` move with it. Parties are written with the Acquisition only: no change or delete, and no new row once
 *   it left `DRAFT`.
 * - `ownership.acquisition_id`: composite FK to `(id, mre_realm_id, property_reference_id)`, so an Ownership links an
 *   Acquisition of its own Realm and PropertyReference; fixed after creation (`ownership_frozen`). With it the
 *   invariant trigger reduces sums with `div`, so its message shows `n/d` integers (review on #45).
 */
const ownershipFrozen = (withAcquisition: boolean) =>
  sql.raw(`
    CREATE OR REPLACE FUNCTION ownership_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status = 'VOID' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Ownership %: VOID is final (api-design §26.1)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (NEW.id, NEW.mre_realm_id, NEW.property_reference_id, NEW.owner_party_id, NEW.share_numerator, NEW.share_denominator,
          NEW.valid_from, NEW.created_at, NEW.created_by${withAcquisition ? ', NEW.acquisition_id' : ''})
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.property_reference_id, OLD.owner_party_id, OLD.share_numerator, OLD.share_denominator,
          OLD.valid_from, OLD.created_at, OLD.created_by${withAcquisition ? ', OLD.acquisition_id' : ''}) THEN
        RAISE EXCEPTION 'Ownership %: share, owner, PropertyReference${withAcquisition ? ', Acquisition' : ''} and validFrom never change; void and create instead (api-design §26.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.valid_until IS NOT NULL AND (NEW.valid_until IS NULL OR NEW.valid_until > OLD.valid_until) THEN
        RAISE EXCEPTION 'Ownership %: validUntil is only set or moved earlier, never extended (api-design §26.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `);

const ownershipInvariants = (integerDivision: boolean) =>
  sql.raw(`
    CREATE OR REPLACE FUNCTION ownership_invariants() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      other uuid;
      day date;
      row record;
      n numeric;
      d numeric;
      g numeric;
    BEGIN
      UPDATE property_reference SET version = version WHERE id = NEW.property_reference_id;
      IF NEW.status <> 'VALID' THEN
        RETURN NULL;
      END IF;

      SELECT o.id INTO other FROM ownership o
       WHERE o.property_reference_id = NEW.property_reference_id AND o.owner_party_id = NEW.owner_party_id
         AND o.status = 'VALID' AND o.id <> NEW.id
         AND daterange(o.valid_from, o.valid_until, '[]') && daterange(NEW.valid_from, NEW.valid_until, '[]')
       LIMIT 1;
      IF other IS NOT NULL THEN
        RAISE EXCEPTION 'Ownership %: overlaps Ownership % of the same owner (OVERLAPPING_OWNERSHIP)', NEW.id, other
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;

      FOR day IN
        SELECT DISTINCT o.valid_from FROM ownership o
         WHERE o.property_reference_id = NEW.property_reference_id AND o.status = 'VALID'
           AND o.valid_from <@ daterange(NEW.valid_from, NEW.valid_until, '[]')
      LOOP
        n := 0;
        d := 1;
        FOR row IN
          SELECT o.share_numerator, o.share_denominator FROM ownership o
           WHERE o.property_reference_id = NEW.property_reference_id AND o.status = 'VALID'
             AND day <@ daterange(o.valid_from, o.valid_until, '[]')
        LOOP
          n := n * row.share_denominator + row.share_numerator * d;
          d := d * row.share_denominator;
          g := gcd(n, d);
          ${integerDivision ? 'n := div(n, g);\n          d := div(d, g);' : 'n := n / g;\n          d := d / g;'}
        END LOOP;
        IF n > d THEN
          RAISE EXCEPTION 'PropertyReference %: shares on % sum to %/% (OWNERSHIP_TOTAL_EXCEEDS_ONE)', NEW.property_reference_id, day, n, d
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END LOOP;
      RETURN NULL;
    END $$
  `);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE acquisition (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mre_realm_id text NOT NULL,
      property_reference_id uuid NOT NULL,
      status text NOT NULL CHECK (status IN ('DRAFT', 'CONFIRMED', 'CANCELLED')),
      purchase_price numeric NOT NULL CHECK (scale(purchase_price) <= 2 AND purchase_price > 0 AND purchase_price < 1e18),
      currency text NOT NULL CHECK (currency IN ('EUR')),
      acquired_share_numerator integer NOT NULL,
      acquired_share_denominator integer NOT NULL,
      contract_date date NOT NULL,
      economic_transfer_date date,
      land_registry_transfer_date date,
      source_references text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_references) <= 10),
      notes text CHECK (length(notes) BETWEEN 1 AND 2000),
      cancelled_at timestamptz,
      cancellation_reason text CHECK (length(cancellation_reason) BETWEEN 1 AND 500),
      confirmed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT acquisition_property_reference_fk FOREIGN KEY (property_reference_id, mre_realm_id)
        REFERENCES property_reference (id, mre_realm_id),
      CONSTRAINT acquisition_realm_key UNIQUE (id, mre_realm_id),
      CONSTRAINT acquisition_ownership_key UNIQUE (id, mre_realm_id, property_reference_id),
      CONSTRAINT acquisition_transfer_dates CHECK (economic_transfer_date >= contract_date AND land_registry_transfer_date >= contract_date),
      CONSTRAINT acquisition_share CHECK (
        acquired_share_numerator >= 1 AND acquired_share_numerator <= acquired_share_denominator
        AND acquired_share_denominator <= 10000 AND gcd(acquired_share_numerator, acquired_share_denominator) = 1
      ),
      CONSTRAINT acquisition_status_fields CHECK (
        (status = 'CANCELLED') = (cancelled_at IS NOT NULL) AND (cancelled_at IS NULL) = (cancellation_reason IS NULL)
        AND (status = 'CONFIRMED') = (confirmed_at IS NOT NULL)
      )
    )
  `.execute(db);
  await sql`CREATE INDEX acquisition_realm_idx ON acquisition (mre_realm_id, contract_date DESC, created_at DESC, id)`.execute(db);
  await sql`CREATE INDEX acquisition_property_reference_idx ON acquisition (property_reference_id, contract_date DESC, created_at DESC, id)`.execute(db);

  await sql`
    CREATE TABLE acquisition_party (
      acquisition_id uuid NOT NULL,
      mre_realm_id text NOT NULL,
      party_id uuid NOT NULL,
      role text NOT NULL CHECK (role IN ('BUYER', 'SELLER')),
      position integer NOT NULL CHECK (position >= 1),
      CONSTRAINT acquisition_party_acquisition_fk FOREIGN KEY (acquisition_id, mre_realm_id) REFERENCES acquisition (id, mre_realm_id),
      CONSTRAINT acquisition_party_party_fk FOREIGN KEY (party_id, mre_realm_id) REFERENCES party (id, mre_realm_id),
      CONSTRAINT acquisition_party_key PRIMARY KEY (acquisition_id, party_id),
      CONSTRAINT acquisition_party_position UNIQUE (acquisition_id, role, position)
    )
  `.execute(db);
  await sql`CREATE INDEX acquisition_party_party_idx ON acquisition_party (party_id)`.execute(db);

  await sql`
    CREATE FUNCTION acquisition_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.id, NEW.mre_realm_id, NEW.property_reference_id, NEW.purchase_price, NEW.currency, NEW.acquired_share_numerator,
          NEW.acquired_share_denominator, NEW.contract_date, NEW.economic_transfer_date, NEW.land_registry_transfer_date,
          NEW.source_references, NEW.notes, NEW.created_at, NEW.created_by)
         IS DISTINCT FROM
         (OLD.id, OLD.mre_realm_id, OLD.property_reference_id, OLD.purchase_price, OLD.currency, OLD.acquired_share_numerator,
          OLD.acquired_share_denominator, OLD.contract_date, OLD.economic_transfer_date, OLD.land_registry_transfer_date,
          OLD.source_references, OLD.notes, OLD.created_at, OLD.created_by) THEN
        RAISE EXCEPTION 'Acquisition %: its data never changes after creation (api-design §27.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status <> 'DRAFT' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Acquisition %: % is final (api-design §27.1)', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.status = 'DRAFT' AND (NEW.version, NEW.updated_at) IS DISTINCT FROM (OLD.version, OLD.updated_at) THEN
        RAISE EXCEPTION 'Acquisition %: version and updated_at change only with a status transition (api-design §27.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER acquisition_frozen BEFORE UPDATE ON acquisition FOR EACH ROW EXECUTE FUNCTION acquisition_frozen()`.execute(db);

  await sql`
    CREATE FUNCTION acquisition_party_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Acquisition %: buyers and sellers never change (api-design §27.1)', OLD.acquisition_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (SELECT status FROM acquisition WHERE id = NEW.acquisition_id) <> 'DRAFT' THEN
        RAISE EXCEPTION 'Acquisition %: buyers and sellers are written with the draft only (api-design §27.1)', NEW.acquisition_id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER acquisition_party_frozen BEFORE INSERT OR UPDATE OR DELETE ON acquisition_party
      FOR EACH ROW EXECUTE FUNCTION acquisition_party_frozen()
  `.execute(db);

  await sql`ALTER TABLE ownership ADD COLUMN acquisition_id uuid`.execute(db);
  await sql`
    ALTER TABLE ownership ADD CONSTRAINT ownership_acquisition_fk FOREIGN KEY (acquisition_id, mre_realm_id, property_reference_id)
      REFERENCES acquisition (id, mre_realm_id, property_reference_id)
  `.execute(db);
  await sql`CREATE INDEX ownership_acquisition_idx ON ownership (acquisition_id) WHERE acquisition_id IS NOT NULL`.execute(db);
  await sql`${ownershipFrozen(true)}`.execute(db);
  await sql`${ownershipInvariants(true)}`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`${ownershipInvariants(false)}`.execute(db);
  await sql`${ownershipFrozen(false)}`.execute(db);
  await sql`ALTER TABLE ownership DROP COLUMN acquisition_id`.execute(db);
  await sql`DROP TABLE acquisition_party`.execute(db);
  await sql`DROP FUNCTION acquisition_party_frozen()`.execute(db);
  await sql`DROP TABLE acquisition`.execute(db);
  await sql`DROP FUNCTION acquisition_frozen()`.execute(db);
}

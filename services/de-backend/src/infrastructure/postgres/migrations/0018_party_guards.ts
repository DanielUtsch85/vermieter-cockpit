import { sql, type Kysely } from 'kysely';

/**
 * Party guards (review on #39, before Ownership relies on `ACTIVE`; api-design.md §19.1, §26.1): `party_type` is fixed
 * after creation, and `INACTIVE` is final with its time and reason (no reactivation, P2-D1). The API never does
 * either; this keeps a direct SQL write from doing it, as the ledger's 0009/0013 do for Transactions.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION party_guards() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.party_type IS DISTINCT FROM OLD.party_type THEN
        RAISE EXCEPTION 'Party %: party_type is fixed after creation (api-design §19.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status = 'INACTIVE'
         AND (NEW.status, NEW.deactivated_at, NEW.deactivation_reason) IS DISTINCT FROM (OLD.status, OLD.deactivated_at, OLD.deactivation_reason) THEN
        RAISE EXCEPTION 'Party %: INACTIVE is final, with its time and reason (api-design §19.1)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`CREATE TRIGGER party_guards BEFORE UPDATE ON party FOR EACH ROW EXECUTE FUNCTION party_guards()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER party_guards ON party`.execute(db);
  await sql`DROP FUNCTION party_guards()`.execute(db);
}

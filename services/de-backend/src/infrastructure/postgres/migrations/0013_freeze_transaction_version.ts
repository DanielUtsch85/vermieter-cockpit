import { sql, type Kysely } from 'kysely';

/**
 * VC-X-22: `version` and `updated_at` of a confirmed Transaction are frozen too (review note on #27). `version` is
 * the `ETag` of api-design.md §16.1, so a write that changes it without a change of the Transaction could fake a
 * version conflict, and one that changes the Transaction's status without it could hide one.
 *
 * On a row that is already confirmed (`CONFIRMED`, `RECONCILED`, `CORRECTED`):
 *
 * - without a status step, `version` and `updated_at` stay as they are; a no-op write such as the touch of the
 *   split trigger (0010, `SET version = version`) is still fine;
 * - a status step (`RECONCILED`/`CORRECTED`, 0009/0011 decide which) raises `version` by exactly one;
 *   `updated_at` may then move.
 *
 * The step into `CONFIRMED` itself starts from an unconfirmed row and is not covered here.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION ledger_transaction_version_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        IF (NEW.version, NEW.updated_at) IS DISTINCT FROM (OLD.version, OLD.updated_at) THEN
          RAISE EXCEPTION 'confirmed Transaction %: version and updated_at change only with a status step (api-design §16.1)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      ELSIF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'confirmed Transaction %: the step % -> % must raise version from % to %, not to % (api-design §16.1)',
          OLD.id, OLD.status, NEW.status, OLD.version, OLD.version + 1, NEW.version
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_transaction_version_frozen
      BEFORE UPDATE ON ledger_transaction
      FOR EACH ROW WHEN (OLD.status IN ('CONFIRMED', 'RECONCILED', 'CORRECTED'))
      EXECUTE FUNCTION ledger_transaction_version_frozen()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER ledger_transaction_version_frozen ON ledger_transaction`.execute(db);
  await sql`DROP FUNCTION ledger_transaction_version_frozen()`.execute(db);
}

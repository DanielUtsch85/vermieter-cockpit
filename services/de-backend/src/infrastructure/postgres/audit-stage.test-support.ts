import type pg from 'pg';

/**
 * VC-X-24 (api-design.md §58U rule 6): tests stage histories by updating `audit_record` directly (an `occurred_at` moved
 * back, a metadata key edited), which 0076's guard refuses. `stageAudit` runs such an `UPDATE audit_record …` with the
 * update guard disabled for that one statement: `ALTER TABLE … DISABLE TRIGGER audit_record_update_guard`, the
 * statement, `ENABLE TRIGGER`, in one transaction. The `ALTER TABLE` holds the table's lock until the commit, so no
 * other session of the schema ever sees the guard disabled. Only `UPDATE audit_record` statements; the delete, insert
 * and truncate guards stay on. In a schema without 0076 (a test downed it) the statement runs as it is. Test support only.
 */
export async function stageAudit(pool: Pick<pg.Pool, 'connect'>, statement: string, params: readonly unknown[] = []): Promise<pg.QueryResult> {
  if (!/^\s*UPDATE audit_record\s/.test(statement)) throw new Error(`stageAudit runs UPDATE audit_record statements only: ${statement}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const guarded =
      (await client.query(`SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('audit_record') AND tgname = 'audit_record_update_guard' AND NOT tgisinternal`))
        .rowCount === 1;
    if (guarded) await client.query('ALTER TABLE audit_record DISABLE TRIGGER audit_record_update_guard');
    const result = await client.query(statement, [...params]);
    if (guarded) await client.query('ALTER TABLE audit_record ENABLE TRIGGER audit_record_update_guard');
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_MARKER, AUDIT_PERSONAL_FIELDS } from '../../domains/audit/index.js';
import { REALM, databaseUrl, useAuditDatabase } from './audit-retention.test-support.js';
import { createDatabase } from './database.js';
import { withMigrationLock } from './depreciation-asset.test-support.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * Migration 0076 (VC-X-24, api-design.md §58U rule 6) past the repository. Each statement runs in a rolled-back
 * transaction; every refusal has its counter-check (the trigger dropped in the same rolled-back transaction, the same
 * statement accepted), and the allowed shape is accepted for each of the fourteen listed paths alone. `down` is refused
 * while a record is pseudonymised, then restores 0075's `audit_record` (columns, triggers, indexes, no function left);
 * `up` again. Synthetic rows only.
 */
const migration = migrations['0076_audit_record_pseudonymisation'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
const M = AUDIT_MARKER;
const json = (value: unknown) => `'${JSON.stringify(value)}'::jsonb`;
const drop = (trigger: string) => `DROP TRIGGER ${trigger} ON audit_record`;

describe.skipIf(databaseUrl === undefined)('the guard of 0076 on audit_record (§58U)', () => {
  const { ctx, person, amend, raw } = useAuditDatabase('audit_guard_schema_test');
  let party: string;
  let amended: string;
  let created: string;
  let partial: string;
  let loan: string;
  const original = {
    changes: { displayName: { from: 'Erika Beispiel', to: 'Erika Muster' }, email: { from: 'erika.alt@example.org', to: 'erika.neu@example.org' } },
  };
  const markers = { changes: { displayName: { from: M, to: M }, email: { from: M, to: M } } };

  beforeAll(async () => {
    party = await person('Erika Beispiel');
    amended = await amend(party, { displayName: 'Erika Muster', email: 'erika.neu@example.org' });
    created = (await ctx.pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = 'CREATED'`, [party])).rows[0].id as string;
    // Pseudonymised once, `email.from` only (the guard does not require all at once; the job always replaces all).
    partial = await raw({ entityType: 'Party', entityId: party, action: 'AMENDED', occurredAt: '2025-03-05T09:00:00Z', metadata: original });
    await ctx.pool.query(`UPDATE audit_record SET metadata = jsonb_set(metadata, '{changes,email,from}', $2), pseudonymised_at = now() WHERE id = $1`, [
      partial,
      JSON.stringify(M),
    ]);
    loan = await raw({
      entityType: 'Loan',
      entityId: party,
      action: 'AMENDED',
      occurredAt: '2025-03-05T09:00:00Z',
      metadata: { changes: { notes: { from: 'a', to: 'b' } } },
    });
  });

  /** The statement in a rolled-back transaction after `setup`: `accepted`, else the SQLSTATE. */
  async function attempt(statement: string, setup: readonly string[] = []): Promise<string> {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of setup) await client.query(s);
      await client.query(statement);
      return 'accepted';
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  const pseudonymise = (id: string, metadata: unknown, extra = '') =>
    `UPDATE audit_record SET metadata = ${json(metadata)}, pseudonymised_at = now()${extra} WHERE id = '${id}'`;
  /** Refused by the guard, and accepted with the update trigger dropped. */
  const refused = async (statement: string) => [await attempt(statement), await attempt(statement, [drop('audit_record_update_guard')])];

  it('the pseudonymisation of an AMENDED record by the allowed shape is accepted', async () => {
    expect(await attempt(pseudonymise(amended, markers))).toBe('accepted');
    // A later marker version is the same pattern.
    expect(await attempt(pseudonymise(amended, { changes: { displayName: { from: '[entfernt:v2]', to: M }, email: { from: M, to: M } } }))).toBe('accepted');
  });

  it('each of the fourteen listed paths alone is accepted (the guard list is the code list)', async () => {
    const fields = AUDIT_PERSONAL_FIELDS['Party'] ?? [];
    expect(fields).toHaveLength(7);
    for (const field of fields) {
      const id = await raw({
        entityType: 'Party',
        entityId: party,
        action: 'AMENDED',
        occurredAt: '2025-03-05T09:00:00Z',
        metadata: { changes: { [field]: { from: 'alt (synthetisch)', to: 'neu (synthetisch)' } } },
      });
      for (const side of ['from', 'to']) {
        const statement = `UPDATE audit_record SET metadata = jsonb_set(metadata, '{changes,${field},${side}}', '"${M}"'), pseudonymised_at = now() WHERE id = '${id}'`;
        expect([field, side, await attempt(statement)]).toEqual([field, side, 'accepted']);
      }
    }
  });

  it('a second pseudonymisation is refused; counter-check: without the trigger it passes', async () => {
    const second = `UPDATE audit_record SET metadata = jsonb_set(metadata, '{changes,email,to}', '"${M}"'), pseudonymised_at = now() WHERE id = '${partial}'`;
    expect(await refused(second)).toEqual(['23000', 'accepted']);
  });

  it('a change of occurred_at, action, entity, actor or versions alongside is refused; counter-check without the trigger', async () => {
    for (const extra of [
      `, occurred_at = '2020-01-01T00:00:00Z'`,
      `, action = 'CREATED'`,
      `, entity_id = 'x'`,
      `, entity_type = 'Weg'`,
      `, actor_id = 'x'`,
      `, actor_type = 'SYSTEM'`,
      `, previous_version = 9`,
      `, new_version = 9`,
      `, id = gen_random_uuid()`,
    ]) {
      expect([extra, ...(await refused(pseudonymise(amended, markers, extra)))]).toEqual([extra, '23000', 'accepted']);
    }
  });

  it('a non-listed path changed, a key added or removed, an array length changed: refused; counter-check without the trigger', async () => {
    const withSource = await raw({
      entityType: 'Party',
      entityId: party,
      action: 'AMENDED',
      occurredAt: '2025-03-05T09:00:00Z',
      metadata: { ...original, source: 'API', list: [1, 2] },
    });
    for (const metadata of [
      { ...markers, source: M, list: [1, 2] },
      { ...markers, source: 'API', list: [1, 2], extra: M },
      { changes: markers.changes, list: [1, 2] },
      { ...markers, source: 'API', list: [1] },
      { changes: { displayName: { from: M, to: M }, email: { from: M } }, source: 'API', list: [1, 2] },
      { changes: { displayName: { from: M, to: M }, email: { from: M, to: M, note: M } }, source: 'API', list: [1, 2] },
    ]) {
      expect([metadata, ...(await refused(pseudonymise(withSource, metadata)))]).toEqual([metadata, '23000', 'accepted']);
    }
    // Counter-check: the same record with only the listed paths replaced passes.
    expect(await attempt(pseudonymise(withSource, { ...markers, source: 'API', list: [1, 2] }))).toBe('accepted');
  });

  it('a plain value, JSON null, a marker without version or a marker for a null value instead of the marker: refused', async () => {
    const withNull = await raw({
      entityType: 'Party',
      entityId: party,
      action: 'AMENDED',
      occurredAt: '2025-03-05T09:00:00Z',
      metadata: { changes: { email: { from: null, to: 'x@example.org' } } },
    });
    for (const [id, metadata] of [
      [amended, { changes: { displayName: { from: 'Erika Anders', to: M }, email: { from: M, to: M } } }],
      [amended, { changes: { displayName: { from: null, to: M }, email: { from: M, to: M } } }],
      [amended, { changes: { displayName: { from: '[entfernt]', to: M }, email: { from: M, to: M } } }],
      [amended, { changes: { displayName: { from: 1, to: M }, email: { from: M, to: M } } }],
      [withNull, { changes: { email: { from: M, to: M } } }],
    ] as const) {
      expect([metadata, ...(await refused(pseudonymise(id, metadata)))]).toEqual([metadata, '23000', 'accepted']);
    }
    expect(await attempt(pseudonymise(withNull, { changes: { email: { from: null, to: M } } }))).toBe('accepted');
  });

  it('a record not AMENDED, of another entity type, without a change, or without pseudonymised_at: refused', async () => {
    expect(await refused(pseudonymise(created, { partyType: M }))).toEqual(['23000', 'accepted']);
    expect(await refused(pseudonymise(loan, { changes: { notes: { from: M, to: M } } }))).toEqual(['23000', 'accepted']);
    expect(await refused(`UPDATE audit_record SET pseudonymised_at = now() WHERE id = '${amended}'`)).toEqual(['23000', 'accepted']);
    expect(await refused(`UPDATE audit_record SET metadata = ${json(markers)} WHERE id = '${amended}'`)).toEqual(['23000', 'accepted']);
    expect(await refused(`UPDATE audit_record SET occurred_at = occurred_at - interval '1 day' WHERE id = '${created}'`)).toEqual(['23000', 'accepted']);
  });

  it('an insert with pseudonymised_at is refused, one without accepted; counter-check without the insert trigger', async () => {
    const insert = (at: string) =>
      `INSERT INTO audit_record (entity_type, entity_id, action, actor_type, metadata, pseudonymised_at) VALUES ('Party', '${party}', 'AMENDED', 'USER', '{}', ${at})`;
    expect(await attempt(insert('now()'))).toBe('23000');
    expect(await attempt(insert('now()'), [drop('audit_record_insert_guard')])).toBe('accepted');
    expect(await attempt(insert('NULL'))).toBe('accepted');
  });

  it('DELETE and TRUNCATE are refused; counter-check: without their trigger each passes', async () => {
    const del = `DELETE FROM audit_record WHERE id = '${created}'`;
    expect([await attempt(del), await attempt(del, [drop('audit_record_delete_guard')])]).toEqual(['23000', 'accepted']);
    expect([await attempt('TRUNCATE audit_record'), await attempt('TRUNCATE audit_record', [drop('audit_record_truncate_guard')])]).toEqual([
      '23000',
      'accepted',
    ]);
    expect(Number((await ctx.pool.query(`SELECT count(*) AS n FROM audit_record WHERE id = $1`, [created])).rows[0].n)).toBe(1);
  });

  it('the job index covers the due records only: AMENDED, not pseudonymised, by occurred_at', async () => {
    const { rows } = await ctx.pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_record_retention_idx' AND schemaname = current_schema()`);
    expect(rows[0].indexdef).toMatch(/\(occurred_at\) WHERE \(\(action = 'AMENDED'::text\) AND \(pseudonymised_at IS NULL\)\)$/);
  });

  it('the service writes its records unchanged: a Party amendment is accepted with the guard on', async () => {
    const id = await amend(party, { phone: '+49 30 0000001' }, REALM);
    expect((await ctx.pool.query(`SELECT pseudonymised_at FROM audit_record WHERE id = $1`, [id])).rows[0].pseudonymised_at).toBeNull();
  });
});

describe.skipIf(databaseUrl === undefined)('the down of 0076 (§58U)', () => {
  it('refused while a record is pseudonymised; then restores 0075 audit_record and drops all of 0076; up again', { timeout: 120_000 }, async () => {
    const schema = testSchemaName('audit_guard_down_test');
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const down = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
    try {
      await migrateToLatest(down, { migrationTableSchema: schema });
      const db = () => createDatabase(down) as never;
      const shape = async () => ({
        columns: (
          await down.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'audit_record' ORDER BY ordinal_position`,
            [schema],
          )
        ).rows.map((r) => r.column_name as string),
        triggers: (await down.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = to_regclass('audit_record') AND NOT tgisinternal ORDER BY tgname`)).rows.map(
          (r) => r.tgname as string,
        ),
        indexes: (
          await down.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'audit_record' ORDER BY indexname`, [schema])
        ).rows.map((r) => r.indexname as string),
        functions: (
          await down.query(
            `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1 AND proname LIKE 'audit_%' ORDER BY proname`,
            [schema],
          )
        ).rows.map((r) => r.proname as string),
      });
      const before = ['id', 'entity_type', 'entity_id', 'action', 'occurred_at', 'actor_type', 'actor_id', 'metadata', 'previous_version', 'new_version'];
      expect(await shape()).toEqual({
        columns: [...before, 'pseudonymised_at'],
        triggers: ['audit_record_delete_guard', 'audit_record_insert_guard', 'audit_record_truncate_guard', 'audit_record_update_guard'],
        indexes: ['audit_record_entity_idx', 'audit_record_pkey', 'audit_record_retention_idx'],
        functions: ['audit_metadata_pseudonymised', 'audit_record_guard'],
      });
      const id = (
        await down.query(
          `INSERT INTO audit_record (entity_type, entity_id, action, actor_type, metadata) VALUES ('Party', 'p', 'AMENDED', 'USER', '{"changes":{"email":{"from":"a@example.org","to":null}}}') RETURNING id`,
        )
      ).rows[0].id as string;
      await down.query(`UPDATE audit_record SET metadata = '{"changes":{"email":{"from":"${M}","to":null}}}', pseudonymised_at = now() WHERE id = $1`, [id]);
      let refusal: unknown;
      await withMigrationLock(async () => {
        refusal = await migration.down(db()).catch((e: unknown) => e);
      });
      expect(refusal).toMatchObject({ code: '23514' });
      expect((await shape()).columns).toContain('pseudonymised_at');
      // Counter-check: the mark removed (update guard off), down runs.
      await down.query(`ALTER TABLE audit_record DISABLE TRIGGER audit_record_update_guard`);
      await down.query(`UPDATE audit_record SET pseudonymised_at = NULL WHERE id = $1`, [id]);
      await down.query(`ALTER TABLE audit_record ENABLE TRIGGER audit_record_update_guard`);
      await withMigrationLock(() => migration.down(db()));
      expect(await shape()).toEqual({ columns: before, triggers: [], indexes: ['audit_record_entity_idx', 'audit_record_pkey'], functions: [] });
      // 0075's table is free again: the row of before stays and can be deleted.
      expect((await down.query(`DELETE FROM audit_record WHERE id = $1`, [id])).rowCount).toBe(1);
      await withMigrationLock(() => migration.up(db()));
      expect((await shape()).triggers).toHaveLength(4);
    } finally {
      await down.end();
    }
  });
});

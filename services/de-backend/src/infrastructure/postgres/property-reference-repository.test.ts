import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewPropertyReference } from '../../domains/property-reference/index.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';

/**
 * VC-1-01 persistence: one PropertyReference per natural key, also under
 * concurrency, and exactly one AuditRecord per created reference. Runs in an
 * isolated, migrated schema.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;

function draft(mrePropertyId: string, mreRealmId = REALM): NewPropertyReference {
  return {
    mreRealmId,
    mrePropertyId,
    displayName: 'Wohnung 1',
    cachedAddress: { street1: 'Musterstraße 1', city: 'Berlin' },
    refreshedAt: new Date('2026-10-19T08:00:00Z'),
  };
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresPropertyReferenceRepository', () => {
  const schema = `property_reference_test_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let repository: PostgresPropertyReferenceRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    repository = new PostgresPropertyReferenceRepository(createDatabase(pool));
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });

  const audits = async (entityId: string) =>
    (
      await pool.query<{ action: string; actor_type: string; actor_id: string; metadata: unknown }>(
        `SELECT action, actor_type, actor_id, metadata FROM audit_record WHERE entity_type = 'PropertyReference' AND entity_id = $1`,
        [entityId],
      )
    ).rows;

  it('creates a reference with a generated id and writes one AuditRecord', async () => {
    const { reference, created } = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60701'), actor);
    expect(created).toBe(true);
    expect(reference.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(reference).toMatchObject({
      mreRealmId: REALM,
      mrePropertyId: '6512f0c2a1b2c3d4e5f60701',
      externalReferenceState: 'ACTIVE',
      displayName: 'Wohnung 1',
      cachedAddress: { street1: 'Musterstraße 1', city: 'Berlin' },
      lastRefreshedAt: new Date('2026-10-19T08:00:00Z'),
    });
    expect(reference.createdAt).toBeInstanceOf(Date);
    expect(await repository.findByMreIdentity(REALM, '6512f0c2a1b2c3d4e5f60701')).toEqual(reference);
    expect(await audits(reference.id)).toEqual([
      {
        action: 'LINKED',
        actor_type: 'USER',
        actor_id: 'anna@example.com',
        metadata: { mreRealmId: REALM, mrePropertyId: '6512f0c2a1b2c3d4e5f60701' },
      },
    ]);
  });

  it('a repeat returns the existing reference unchanged, without a second AuditRecord', async () => {
    const first = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60702'), actor);
    const repeat = await repository.linkOnce({ ...draft('6512f0c2a1b2c3d4e5f60702'), displayName: 'renamed' }, actor);
    expect(repeat).toEqual({ reference: first.reference, created: false });
    expect(await audits(first.reference.id)).toHaveLength(1);
  });

  it('concurrent links of the same MRE Property create exactly one reference', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60703'), actor)),
    );
    expect(outcomes.filter((o) => o.created)).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.reference.id)).size).toBe(1);
    expect(await audits(outcomes[0]?.reference.id ?? '')).toHaveLength(1);
  });

  it('a link racing a concurrent insert stays idempotent even when the session default is REPEATABLE READ', async () => {
    // A role or database may set default_transaction_isolation; linkOnce must not depend on it.
    const strict = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    strict.on('connect', (client) => {
      void client.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    });
    const mrePropertyId = '6512f0c2a1b2c3d4e5f60707';
    const other = await strict.connect();
    try {
      const level = await other.query<{ transaction_isolation: string }>('SHOW transaction_isolation');
      expect(level.rows[0]?.transaction_isolation).toBe('repeatable read');

      // Deterministic race: another transaction holds an uncommitted insert of the same key ...
      await other.query('BEGIN');
      const { rows } = await other.query<{ id: string }>(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by)
         VALUES ($1, $2, 'ACTIVE', 'other@example.com') RETURNING id`,
        [REALM, mrePropertyId],
      );
      const pending = new PostgresPropertyReferenceRepository(createDatabase(strict)).linkOnce(draft(mrePropertyId), actor);
      // ... linkOnce blocks on it ...
      await waitUntil(
        async () =>
          (
            await pool.query(
              `SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'insert into "property_reference"%'`,
            )
          ).rowCount !== 0,
      );
      // ... and must return that row once it commits, not fail with a serialization error.
      await other.query('COMMIT');
      const outcome = await pending;
      expect(outcome.created).toBe(false);
      expect(outcome.reference.id).toBe(rows[0]?.id);
      expect(await audits(outcome.reference.id)).toEqual([]);
    } finally {
      other.release();
      await strict.end();
    }
  });

  it('the same MRE Property id in another Realm is a separate reference (Realm isolation)', async () => {
    const a = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60704'), actor);
    const b = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60704', OTHER_REALM), actor);
    expect(b.created).toBe(true);
    expect(b.reference.id).not.toBe(a.reference.id);
    expect(await repository.findByMreIdentity(OTHER_REALM, '6512f0c2a1b2c3d4e5f60705')).toBeUndefined();
  });

  it('stores no cached address when MRE has none', async () => {
    const { reference } = await repository.linkOnce(
      { ...draft('6512f0c2a1b2c3d4e5f60706'), displayName: null, cachedAddress: null },
      actor,
    );
    expect(reference).toMatchObject({ displayName: null, cachedAddress: null });
  });

  it('the database rejects an mre_property_id that is not an ObjectId', async () => {
    await expect(repository.linkOnce(draft('not-an-object-id'), actor)).rejects.toThrow(/check constraint/);
  });
});

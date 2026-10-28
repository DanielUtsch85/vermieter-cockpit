import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MreObservation, NewPropertyReference } from '../../domains/property-reference/index.js';
import { ExactDecimal } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

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
    cachedSurface: ExactDecimal.of('64.5'),
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
  const schema = testSchemaName('property_reference_test');
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
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60703'), actor)));
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
    const { reference } = await repository.linkOnce({ ...draft('6512f0c2a1b2c3d4e5f60706'), displayName: null, cachedAddress: null }, actor);
    expect(reference).toMatchObject({ displayName: null, cachedAddress: null });
  });

  describe('refresh', () => {
    const found = (displayName: string, surface: string | null = '64.5'): MreObservation => ({
      kind: 'FOUND',
      observedAt: new Date('2026-10-20T09:00:00Z'),
      displayName,
      cachedAddress: { city: 'Berlin' },
      cachedSurface: surface === null ? null : ExactDecimal.of(surface),
    });
    const versions = async (entityId: string) =>
      (
        await pool.query<{ action: string; previous_version: number | null; new_version: number | null }>(
          `SELECT action, previous_version, new_version FROM audit_record WHERE entity_id = $1 ORDER BY new_version`,
          [entityId],
        )
      ).rows;

    it('persists a change with version bump and an AuditRecord carrying previous/new version', async () => {
      const { reference } = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60711'), actor);
      const refreshed = await repository.refresh(reference.id, REALM, found('Wohnung 1 (EG)', '65.25'), actor);
      expect(refreshed).toMatchObject({ displayName: 'Wohnung 1 (EG)', version: 2, cachedAddress: { city: 'Berlin' } });
      expect(refreshed?.cachedSurface?.toString()).toBe('65.25');
      expect(await repository.findById(reference.id, REALM)).toEqual(refreshed);
      expect(await versions(reference.id)).toEqual([
        { action: 'LINKED', previous_version: null, new_version: 1 },
        { action: 'REFRESHED', previous_version: 1, new_version: 2 },
      ]);
    });

    it('a refresh without news writes lastRefreshedAt only', async () => {
      const { reference } = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60712'), actor);
      const same = { ...found('Wohnung 1'), cachedAddress: reference.cachedAddress };
      const refreshed = await repository.refresh(reference.id, REALM, same, actor);
      expect(refreshed).toMatchObject({ version: 1, lastRefreshedAt: new Date('2026-10-20T09:00:00Z') });
      expect(await versions(reference.id)).toHaveLength(1);
    });

    it('surface is stored exactly as NUMERIC (no float rounding)', async () => {
      const { reference } = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60713'), actor);
      await repository.refresh(reference.id, REALM, found('Wohnung 1', '33.333333333333336'), actor);
      const row = await pool.query<{ cached_surface: string }>('SELECT cached_surface FROM property_reference WHERE id = $1', [reference.id]);
      expect(row.rows[0]?.cached_surface).toBe('33.333333333333336');
    });

    it('concurrent refreshes serialize on the row: the newest observation wins, versions have no gaps', async () => {
      const { reference } = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60714'), actor);
      const base = Date.parse('2026-10-20T09:00:00Z');
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => repository.refresh(reference.id, REALM, { ...found(`Name ${i}`), observedAt: new Date(base + i) }, actor)),
      );
      // Whatever order the row lock grants, an older observation never lands after a newer one.
      expect(await repository.findById(reference.id, REALM)).toMatchObject({
        displayName: 'Name 5',
        lastObservedAt: new Date(base + 5),
      });
      const trail = await versions(reference.id);
      trail.forEach((entry, i) => {
        expect(entry.new_version).toBe(i + 1);
        expect(entry.previous_version).toBe(i === 0 ? null : i);
      });
    });

    it('swapped commit order: a slow, older observation does not overwrite a newer one', async () => {
      const at = (ms: number) => new Date(Date.parse('2026-10-20T09:00:00Z') + ms);
      const { reference } = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60717'), actor);
      // B started later (t2) but commits first; A started earlier (t1) and commits after it.
      const b = await repository.refresh(reference.id, REALM, { ...found('NEU (B, t2)'), observedAt: at(2000) }, actor);
      const a = await repository.refresh(reference.id, REALM, { ...found('ALT (A, t1)'), observedAt: at(1000) }, actor);
      expect(a).toEqual(b);
      expect(await repository.findById(reference.id, REALM)).toMatchObject({
        displayName: 'NEU (B, t2)',
        lastRefreshedAt: at(2000),
        lastObservedAt: at(2000),
        version: 2,
      });
      expect((await versions(reference.id)).map((v) => v.action)).toEqual(['LINKED', 'REFRESHED']);
    });

    it('swapped commit order: an older FOUND does not revive a newer MISSING', async () => {
      const at = (ms: number) => new Date(Date.parse('2026-10-20T09:00:00Z') + ms);
      const { reference } = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60718'), actor);
      await repository.refresh(reference.id, REALM, { kind: 'NOT_FOUND', observedAt: at(2000) }, actor);
      const late = await repository.refresh(reference.id, REALM, { ...found('Wohnung 1'), observedAt: at(1000) }, actor);
      expect(late).toMatchObject({ externalReferenceState: 'MISSING', lastObservedAt: at(2000), version: 2 });
      expect((await versions(reference.id)).map((v) => v.action)).toEqual(['LINKED', 'MARKED_MISSING']);
    });

    it('is scoped to the Realm and ignores ids that are not UUIDs', async () => {
      const { reference } = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60715'), actor);
      expect(await repository.refresh(reference.id, OTHER_REALM, found('x'), actor)).toBeUndefined();
      expect(await repository.findById(reference.id, OTHER_REALM)).toBeUndefined();
      expect(await repository.findById('not-a-uuid', REALM)).toBeUndefined();
      expect(await repository.refresh('not-a-uuid' as typeof reference.id, REALM, found('x'), actor)).toBeUndefined();
      expect((await repository.findById(reference.id, REALM))?.version).toBe(1);
    });

    it('the database rejects a negative surface', async () => {
      const { reference } = await repository.linkOnce(draft('6512f0c2a1b2c3d4e5f60716'), actor);
      await expect(pool.query('UPDATE property_reference SET cached_surface = -1 WHERE id = $1', [reference.id])).rejects.toThrow(/check constraint/);
    });
  });

  it('the database rejects an mre_property_id that is not an ObjectId', async () => {
    await expect(repository.linkOnce(draft('not-an-object-id'), actor)).rejects.toThrow(/check constraint/);
  });
});

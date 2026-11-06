import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPropertyExportSnapshots } from './property-export-snapshot.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-X-04 (api-design.md §58S): the property export reads in one `REPEATABLE READ READ ONLY` snapshot. A repository read
 * that opens its own snapshot joins this one, so a write committed meanwhile is in none of its reads; nothing can be
 * written through it; the scope's id lists are of the Realm only. Synthetic data.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM = '64b0c0ffee00000000058d0a';
const OTHER = '64b0c0ffee00000000058d0b';

describe.skipIf(databaseUrl === undefined)('PostgresPropertyExportSnapshots (VC-X-04, 58S)', () => {
  const schema = testSchemaName('property_export_snapshot_test');
  let pool: pg.Pool;
  let snapshots: PostgresPropertyExportSnapshots;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    snapshots = new PostgresPropertyExportSnapshots(createDatabase(pool), () => new Date('2026-11-06T12:00:00Z'));
    for (const [key, realm, mre] of [
      ['p', REALM, '6b00000000000000000058d1'],
      ['foreign', OTHER, '6b00000000000000000058d2'],
    ] as const) {
      id[key] = (
        await pool.query(
          `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'seed') RETURNING id`,
          [realm, mre],
        )
      ).rows[0].id as string;
      id[`${key}Owner`] = (
        await pool.query(
          `INSERT INTO party (mre_realm_id, party_type, display_name, status, created_by) VALUES ($1, 'PERSON', 'Olga', 'ACTIVE', 'seed') RETURNING id`,
          [realm],
        )
      ).rows[0].id as string;
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  const ownership = (property: string, owner: string, realm = REALM) =>
    pool.query(
      `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, created_by)
       VALUES ($1, $2, $3, 1, 1, '2020-01-01', 'VALID', 'seed')`,
      [realm, property, owner],
    );

  it('one snapshot: an Ownership committed during the read is in none of the repository reads; generatedAt from the clock', async () => {
    const seen = await snapshots.read(async (reads, generatedAt) => {
      const before = await reads.ownerships.history(id['p'] as string, REALM, { page: 1, pageSize: 10 });
      await ownership(id['p'] as string, id['pOwner'] as string);
      const after = await reads.ownerships.history(id['p'] as string, REALM, { page: 1, pageSize: 10 });
      return { before: before?.total, after: after?.total, generatedAt: generatedAt.toISOString() };
    });
    expect(seen).toEqual({ before: 0, after: 0, generatedAt: '2026-11-06T12:00:00.000Z' });
    // Committed: the next snapshot sees it.
    expect(await snapshots.read(async (reads) => (await reads.ownerships.history(id['p'] as string, REALM, { page: 1, pageSize: 10 }))?.total)).toBe(1);
  });

  it('read only: a write through the snapshot fails in PostgreSQL', async () => {
    await expect(
      snapshots.read((reads) => reads.parties.amend(id['pOwner'] as never, REALM, { displayName: 'Olga B.' } as never, { actorType: 'USER', actorId: 'x' })),
    ).rejects.toThrow(/read-only transaction/);
  });

  it('the scope reads the Realm only: another Realm property and its records are neither found nor listed', async () => {
    await ownership(id['foreign'] as string, id['foreignOwner'] as string, OTHER);
    const found = await snapshots.read(async (reads) => ({
      reference: await reads.propertyReferences.findById(id['foreign'] as string, REALM),
      acquisitions: await reads.scope.acquisitionIds(id['foreign'] as string, REALM),
      loans: await reads.scope.loanIds(id['foreign'] as string, REALM),
      memberships: await reads.scope.membershipIds(id['foreign'] as string, REALM),
      deposits: await reads.scope.deposits(id['foreign'] as string, REALM),
      history: await reads.ownerships.history(id['foreign'] as string, REALM, { page: 1, pageSize: 10 }),
    }));
    expect(found).toEqual({
      reference: undefined,
      acquisitions: [],
      loans: [],
      memberships: [],
      deposits: { attributed: [], severalCandidates: [] },
      history: undefined,
    });
  });
});

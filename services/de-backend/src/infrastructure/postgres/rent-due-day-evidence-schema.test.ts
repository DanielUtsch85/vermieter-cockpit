import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * Migration 0057 past the repository (api-design.md §58F, VC-X-39): `rental_contract_reference_due_days_valid` takes an
 * optional `evidenceReference` per entry (a string, trimmed, 1–500 characters) and nothing else new; each rule with a
 * counter-check that the valid variant is accepted; the lists of 0046 stay valid; `down` refuses while an entry names
 * its evidence, and restores 0046's function without one. Synthetic data.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM = '64b0c0ffee0000000000e057';
let tenants = 0;
const nextTenant = () => `6512f0c2a1b2c3d4e5f6${String(++tenants).padStart(4, '0')}`;

async function withMigrationLock(work: () => Promise<unknown>): Promise<void> {
  const lock = new pg.Client({ connectionString: databaseUrl });
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    await work();
  } finally {
    await lock.end().catch(() => undefined);
  }
}

const messageOf = (p: Promise<unknown>) =>
  p.then(
    () => 'accepted',
    (e: unknown) => (e as Error).message,
  );

describe.skipIf(databaseUrl === undefined)('migration 0057 past the repository (§58F)', () => {
  const schema = testSchemaName('rent_due_day_evidence_test');
  let pool: pg.Pool;
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
  });
  afterAll(async () => {
    await pool.end();
  });
  const insert = (days: unknown, client: pg.Pool = pool) =>
    messageOf(
      client.query(`INSERT INTO rental_contract_reference (mre_realm_id, mre_tenant_id, rent_due_days, created_by) VALUES ($1, $2, $3, 'x')`, [
        REALM,
        nextTenant(),
        JSON.stringify(days),
      ]),
    );
  const entry = (extra: Record<string, unknown> = {}) => ({ validFrom: '2027-01-01', day: 3, ...extra });

  it('an entry with or without evidenceReference is accepted; 0046’s lists stay valid', async () => {
    expect(await insert([entry()])).toBe('accepted');
    expect(await insert([])).toBe('accepted');
    expect(await insert([entry({ evidenceReference: 'Mietvertrag § 4 (synthetisch)' })])).toBe('accepted');
    expect(await insert([entry({ evidenceReference: 'x'.repeat(500) }), { validFrom: '2028-01-01', day: 15 }])).toBe('accepted');
  });

  it('the evidence must be a trimmed string of 1–500 characters; no other key; the other rules of 0046 unchanged', async () => {
    for (const bad of [
      { evidenceReference: '' },
      { evidenceReference: ' Mietvertrag' },
      { evidenceReference: 'Mietvertrag ' },
      { evidenceReference: 'x'.repeat(501) },
      { evidenceReference: 42 },
      { evidenceReference: null },
      { evidence: 'Mietvertrag' },
      { evidenceReference: 'Mietvertrag', note: 'x' },
    ]) {
      expect(await insert([entry(bad)]), JSON.stringify(bad)).toMatch(/rental_contract_reference_due_days/);
    }
    // 0046's rules still hold, with the evidence beside them.
    expect(await insert([entry({ day: 32, evidenceReference: 'x' })])).toMatch(/rental_contract_reference_due_days/);
    expect(await insert([entry({ evidenceReference: 'x' }), entry({ evidenceReference: 'y' })])).toMatch(/rental_contract_reference_due_days/);
    expect(await insert([{ day: 3, evidenceReference: 'x' }])).toMatch(/rental_contract_reference_due_days/);
  });

  it('an update is checked the same way', async () => {
    const tenant = nextTenant();
    await pool.query(`INSERT INTO rental_contract_reference (mre_realm_id, mre_tenant_id, rent_due_days, created_by) VALUES ($1, $2, '[]', 'x')`, [
      REALM,
      tenant,
    ]);
    const update = (days: unknown) =>
      messageOf(
        pool.query(`UPDATE rental_contract_reference SET rent_due_days = $1, version = version + 1 WHERE mre_tenant_id = $2`, [JSON.stringify(days), tenant]),
      );
    expect(await update([entry({ evidenceReference: '' })])).toMatch(/rental_contract_reference_due_days/);
    expect(await update([entry({ evidenceReference: 'Mietvertrag' })])).toBe('accepted');
  });

  it('down refuses while an entry names its evidence; without one it restores 0046 (under MIGRATION_ADVISORY_LOCK)', { timeout: 120_000 }, async () => {
    const downSchema = testSchemaName('rent_due_day_evidence_down_test');
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${downSchema}"`);
    await admin.end();
    const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
    try {
      await migrateToLatest(downPool, { migrationTableSchema: downSchema });
      const down = async () => (await import('./migrations/0057_rent_due_day_evidence.js')).down(createDatabase(downPool) as never);
      expect(await insert([entry({ evidenceReference: 'Mietvertrag' })], downPool)).toBe('accepted');
      let refused = '';
      await withMigrationLock(async () => {
        refused = await messageOf(down());
      });
      expect(refused).toMatch(/a due day names its evidence; never dropped silently/);
      await downPool.query(`UPDATE rental_contract_reference SET rent_due_days = '[{"validFrom": "2027-01-01", "day": 3}]', version = version + 1`);
      await withMigrationLock(down);
      // 0046's function again: the evidence key is refused, a plain entry accepted.
      expect(await insert([entry({ evidenceReference: 'Mietvertrag' })], downPool)).toMatch(/rental_contract_reference_due_days/);
      expect(await insert([entry()], downPool)).toBe('accepted');
    } finally {
      await downPool.end();
    }
  });
});

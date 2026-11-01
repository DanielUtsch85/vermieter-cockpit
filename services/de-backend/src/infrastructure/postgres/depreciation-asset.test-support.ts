import pg from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';
import { DEPRECIATION_RULE_VERSIONS, type DepreciationAsset, type NewDepreciationAsset, type ShorterUsefulLife } from '../../domains/depreciation/index.js';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { PostgresDepreciationAssetRepository } from './depreciation-asset-repository.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * The shared setup of the DepreciationAsset repository tests (VC-8-01, api-design.md §59, migration 0049): one migrated
 * schema per test file, the fixtures (PropertyReferences, Parties, Acquisitions, buildings, entries), the raw inserts
 * past the repository and the lock helpers. `waitUntil`, `withMigrationLock`, `codeOf` and `messageOf` also serve the
 * separate asset's tests. Figures, names and texts are synthetic. Test support only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

export const REALM = '64b0c0ffee00000000000801';
export const OTHER_REALM = '64b0c0ffee00000000000802';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
export const day = (value: string) => value as BusinessDate;
export const eur = (amount: string) => Money.of(amount, 'EUR');
export const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
export const evidence = { source: 'Gutachten zur Restnutzungsdauer', date: day('2026-06-15'), documentReference: 'Gutachten Nr. 0000-SYN' };

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function withMigrationLock(work: () => Promise<unknown>): Promise<void> {
  const lock = new pg.Client({ connectionString: databaseUrl });
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    await work();
  } finally {
    await lock.end().catch(() => undefined);
  }
}

/** The SQLSTATE a statement fails with, or `accepted`. */
export const codeOf = (statement: Promise<unknown>) =>
  statement.then(
    () => 'accepted',
    (error: { code?: string }) => error.code,
  );
/** The message a statement fails with, or `accepted`. */
export const messageOf = (statement: Promise<unknown>) =>
  statement.then(
    () => 'accepted',
    (error: { message?: string }) => error.message,
  );

export interface DepreciationAssetContext {
  pool: pg.Pool;
  parties: PostgresPartyRepository;
  acquisitions: PostgresAcquisitionRepository;
  assets: PostgresDepreciationAssetRepository;
}

/**
 * Registers the schema's `beforeAll`/`afterAll` in the calling `describe` and returns the context (filled once
 * `beforeAll` has run) with the helpers bound to it.
 */
export function useDepreciationAssetDatabase(name: `${string}_test`) {
  const schema = testSchemaName(name);
  const ctx = {} as DepreciationAssetContext;
  let counter = 0;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    ctx.pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(ctx.pool, { migrationTableSchema: schema });
    const db = createDatabase(ctx.pool);
    ctx.parties = new PostgresPartyRepository(db);
    ctx.acquisitions = new PostgresAcquisitionRepository(db);
    ctx.assets = new PostgresDepreciationAssetRepository(db);
  });

  afterAll(async () => {
    await ctx.pool.end();
  });

  async function propertyReference(realm = REALM): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f80000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await ctx.pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function party(name = 'Steuerberatung S', realm = REALM): Promise<string> {
    const outcome = await ctx.parties.create(
      {
        mreRealmId: realm,
        partyType: 'PERSON',
        displayName: name,
        firstName: null,
        lastName: null,
        legalName: null,
        registrationNumber: null,
        email: null,
        phone: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  }
  /** A DRAFT Acquisition of the PropertyReference. */
  async function acquisition(pr: string, realm = REALM): Promise<string> {
    const outcome = await ctx.acquisitions.create(
      {
        mreRealmId: realm,
        propertyReferenceId: pr,
        purchasePrice: eur('250000.00'),
        acquiredShare: { numerator: 1, denominator: 2 },
        contractDate: day('2026-03-01'),
        economicTransferDate: day('2026-05-01'),
        landRegistryTransferDate: null,
        buyerPartyIds: [await party('Käuferin K', realm)],
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.acquisition.id;
  }
  async function cancel(acquisitionId: string, realm = REALM) {
    const outcome = await ctx.acquisitions.cancel(acquisitionId, realm, 'Rücktritt vom Vertrag', new Date('2026-10-30T10:00:00Z'), actor);
    expect(outcome.kind).toBe('CANCELLED');
  }
  const life = (acquisitionId: string, overrides: Partial<ShorterUsefulLife> = {}): ShorterUsefulLife => ({
    acquisitionId,
    usefulLifeYears: 30,
    evidence,
    reviewState: 'UNREVIEWED',
    advisorPartyId: null,
    ...overrides,
  });
  const building = (pr: string, overrides: Partial<NewDepreciationAsset> = {}): NewDepreciationAsset => ({
    mreRealmId: REALM,
    propertyReferenceId: pr,
    assetType: 'BUILDING',
    depreciationMethod: 'LINEAR_7_4',
    buildingCompletionYear: 1995,
    description: null,
    usefulLifeYears: null,
    usefulLifeBasis: null,
    acquiredOn: null,
    items: [],
    sourceReferences: ['Teilungserklärung, Baujahr laut Anlage 1'],
    reviewState: 'UNREVIEWED',
    advisorPartyId: null,
    shorterUsefulLives: [],
    purchaseMethods: [],
    notes: null,
    ...overrides,
  });
  async function created(asset: NewDepreciationAsset): Promise<DepreciationAsset> {
    const outcome = await ctx.assets.create(asset, actor);
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
    return outcome.asset;
  }
  const audit = async (id: string) =>
    (
      await ctx.pool.query(`SELECT action, metadata, actor_id, previous_version, new_version FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [
        id,
      ])
    ).rows as { action: string; metadata: Record<string, unknown>; actor_id: string; previous_version: number | null; new_version: number }[];
  const xminOf = async (assetId: string, acquisitionId: string) =>
    (await ctx.pool.query(`SELECT xmin::text AS x FROM depreciation_asset_useful_life WHERE asset_id = $1 AND acquisition_id = $2`, [assetId, acquisitionId]))
      .rows[0]?.x as string | undefined;

  /** A raw insert past the repository, with the defaults of a fresh `ACTIVE` building. */
  const insertAsset = (values: Record<string, unknown>, q: Queryable = ctx.pool) => {
    const v: Record<string, unknown> = {
      mre_realm_id: REALM,
      asset_type: 'BUILDING',
      status: 'ACTIVE',
      depreciation_method: 'LINEAR_7_4',
      review_state: 'UNREVIEWED',
      created_by: 'x',
      ...values,
    };
    const columns = Object.keys(v);
    return q.query(
      `INSERT INTO depreciation_asset (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(v),
    );
  };
  const insertLife = (values: Record<string, unknown>, q: Queryable = ctx.pool) => {
    const v: Record<string, unknown> = {
      mre_realm_id: REALM,
      useful_life_years: 30,
      evidence_source: 'Gutachten',
      evidence_date: '2026-06-15',
      review_state: 'UNREVIEWED',
      ...values,
    };
    const columns = Object.keys(v);
    return q.query(
      `INSERT INTO depreciation_asset_useful_life (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(v),
    );
  };
  /** The statements a connection's open transaction blocks (by its backend pid): unique to this test, whatever runs beside. */
  const blockedBy = async (holder: Queryable) => {
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    return async () =>
      (await ctx.pool.query(`SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid])).rows.map((r) => r.query as string);
  };
  /** An open transaction on its own connection; rolled back and released at the end whatever happened. */
  async function holding(work: (holder: pg.PoolClient) => Promise<void>): Promise<void> {
    const holder = await ctx.pool.connect();
    try {
      await holder.query('BEGIN');
      await work(holder);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }
  return { ctx, schema, propertyReference, party, acquisition, cancel, life, building, created, audit, xminOf, insertAsset, insertLife, blockedBy, holding };
}

import pg from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';
import {
  inputFingerprint,
  liveSchedule,
  planRecord,
  type NewScheduleVersion,
  type RecordOutcome,
  type RecordRequest,
  type ScheduleVersion,
} from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { sha256Fingerprinter } from '../hashing/index.js';
import { classifyAsTransfer } from './acquisition-cost-classification.test-support.js';
import { PostgresAcquisitionCostRepository } from './acquisition-cost-repository.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { PostgresDepreciationAssetRepository } from './depreciation-asset-repository.js';
import { PostgresDepreciationScheduleSource } from './depreciation-schedule-source.js';
import { PostgresScheduleVersionRepository } from './depreciation-schedule-version-repository.js';
import { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { standardMethod } from './depreciation-method.test-support.js';

/**
 * The shared setup of the recorded-version persistence tests (VC-8-04, api-design.md §60, migration 0052): one migrated
 * schema, ACC8's purchase (A 3/5, B 2/5 of W from 2026-07-01, confirmed, the building of 1995 confirmed), a record
 * through the repository with the domain's decision (the use case's switch is the application's; these tests run the
 * record path itself), and the row counts of 0052's tables. Figures, names and texts are synthetic. Test support only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
export const REALM = '64b0c0ffee00000000000841';
export const OTHER_REALM = '64b0c0ffee00000000000842';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
export const NOW = new Date('2028-01-20T10:00:00Z');
export const TODAY = day('2028-01-20');

export const VERSION_TABLES = [
  'depreciation_schedule_version',
  'depreciation_schedule_version_rule',
  'depreciation_schedule_version_component',
  'depreciation_schedule_version_part',
  'depreciation_schedule_version_fraction',
  'depreciation_schedule_version_year',
  'depreciation_schedule_entry',
  'depreciation_schedule_version_flag',
] as const;

/**
 * VC-X-35: a version read back from the database row by row equals the version the domain planned, field by field and in
 * order (inputs, components, parts, fractions, years, entries, flags, fingerprints), what the database assigns aside.
 */
export function expectStoredAsPlanned(stored: ScheduleVersion, planned: NewScheduleVersion, label = '') {
  const picked = Object.fromEntries(Object.keys(planned).map((key) => [key, stored[key as keyof ScheduleVersion]]));
  expect(Object.keys(planned).length, label).toBeGreaterThan(10);
  expect(picked, label).toStrictEqual(planned);
}

export function useScheduleVersionDatabase(name: `${string}_test`) {
  const schema = testSchemaName(name);
  const ctx = {} as {
    pool: pg.Pool;
    versions: PostgresScheduleVersionRepository;
    source: PostgresDepreciationScheduleSource;
    assets: PostgresDepreciationAssetRepository;
    allocations: PostgresLandBuildingAllocationRepository;
  };
  let counter = 0;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    ctx.pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 10 });
    await migrateToLatest(ctx.pool, { migrationTableSchema: schema });
    const db = createDatabase(ctx.pool);
    const capitalized = new PostgresTaxClassificationRepository(db).capitalizedSources;
    ctx.versions = new PostgresScheduleVersionRepository(db, capitalized, () => NOW);
    ctx.source = new PostgresDepreciationScheduleSource(db, capitalized, () => NOW);
    ctx.assets = new PostgresDepreciationAssetRepository(db);
    ctx.allocations = new PostgresLandBuildingAllocationRepository(db);
  });
  afterAll(async () => {
    await ctx.pool.end();
  });

  async function party(name: string, realm = REALM): Promise<string> {
    const outcome = await new PostgresPartyRepository(createDatabase(ctx.pool)).create(
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

  /** ACC8's purchase in `realm`, with its building asset (confirmed unless told otherwise). */
  async function acc8(realm = REALM, reviewState: 'CONFIRMED' | 'UNREVIEWED' = 'CONFIRMED') {
    const db = createDatabase(ctx.pool);
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fa0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const pr = (
      await ctx.pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
        [realm, mrePropertyId],
      )
    ).rows[0].id as string;
    const [a, b] = [await party('Käuferin A', realm), await party('Käufer B', realm)].sort() as [string, string];
    const created = await new PostgresAcquisitionRepository(db).create(
      {
        mreRealmId: realm,
        propertyReferenceId: pr,
        purchasePrice: eur('300000.00'),
        acquiredShare: { numerator: 1, denominator: 1 },
        contractDate: day('2026-05-15'),
        economicTransferDate: day('2026-07-01'),
        landRegistryTransferDate: null,
        buyerPartyIds: [a, b],
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const w = created.acquisition.id;
    const ownerships = new PostgresOwnershipRepository(db);
    for (const [owner, n] of [
      [a, 3],
      [b, 2],
    ] as const) {
      const own = await ownerships.create(
        {
          mreRealmId: realm,
          propertyReferenceId: pr,
          ownerPartyId: owner,
          share: { numerator: n, denominator: 5 },
          validFrom: day('2026-07-01'),
          validUntil: null,
          acquisitionId: w,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (own.kind !== 'CREATED') throw new Error(own.kind);
    }
    const costs = new PostgresAcquisitionCostRepository(db);
    for (const [category, amount] of [
      ['REAL_ESTATE_TRANSFER_TAX', '15000.00'],
      ['NOTARY', '3000.00'],
      ['FINANCING_RELATED', '1200.00'],
    ] as const) {
      const cost = await costs.createCost(
        {
          mreRealmId: realm,
          acquisitionId: w,
          category,
          amount: eur(amount),
          incurredDate: null,
          counterpartyPartyId: null,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (cost.kind !== 'CREATED') throw new Error(cost.kind);
      // §59D: the notary cost confirmed as a cost of the transfer, so the basis is unchanged.
      if (category === 'NOTARY') await classifyAsTransfer(db, { mreRealmId: realm, acquisitionId: w, costId: cost.cost.id, amount });
    }
    const allocation = await allocate(realm, w, null);
    expect((await new PostgresAcquisitionRepository(db).confirm(w, realm, NOW, actor)).kind).toBe('CONFIRMED');
    const asset = await ctx.assets.create(
      {
        mreRealmId: realm,
        propertyReferenceId: pr,
        assetType: 'BUILDING',
        depreciationMethod: 'LINEAR_7_4',
        buildingCompletionYear: 1995,
        description: null,
        usefulLifeYears: null,
        usefulLifeBasis: null,
        acquiredOn: null,
        items: [],
        sourceReferences: [],
        reviewState,
        advisorPartyId: null,
        shorterUsefulLives: [],
        purchaseMethods: [standardMethod(w)],
        notes: null,
      },
      actor,
    );
    if (asset.kind !== 'CREATED') throw new Error(asset.kind);
    return { pr, a, b, w, allocation, assetId: asset.asset.id };
  }

  /** A confirmed allocation of W (`supersedes` the previous one when given), the same amounts as ACC8's. */
  async function allocate(realm: string, acquisitionId: string, supersedes: string | null): Promise<string> {
    const outcome = await ctx.allocations.create(
      {
        mreRealmId: realm,
        acquisitionId,
        totalAllocableAmount: eur('318000.00'),
        landAmount: eur('63600.00'),
        buildingAmount: eur('254400.00'),
        method: 'PURCHASE_CONTRACT',
        reviewState: 'CONFIRMED',
        effectiveDate: null,
        advisorPartyId: null,
        sourceReferences: [],
        notes: null,
        supersedes,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.allocation.id;
  }

  /** The schedule's input fingerprint of `throughYear` as a read sees it now. */
  async function fingerprintOf(assetId: string, throughYear: number, realm = REALM): Promise<string> {
    const read = await ctx.source.read(assetId, realm, null);
    if (read === undefined) throw new Error('no read');
    return inputFingerprint(liveSchedule(read, TAX_RULES, sha256Fingerprinter, TODAY, throughYear).inputs, throughYear, sha256Fingerprinter);
  }

  /** A record through the repository with the domain's decision (the record path of §60, switch on). */
  async function record(
    assetId: string,
    request: Partial<RecordRequest> & { readonly throughYear: number },
    options: { realm?: string; key?: string } = {},
  ): Promise<RecordOutcome> {
    const realm = options.realm ?? REALM;
    const full: RecordRequest = {
      reason: 'AfA laut Einkommensteuererklärung (synthetisch)',
      expectedInputFingerprint: request.expectedInputFingerprint ?? (await fingerprintOf(assetId, request.throughYear, realm)),
      acceptChangedYears: [],
      ...request,
    };
    return ctx.versions.record({
      assetId,
      mreRealmId: realm,
      actor,
      ...(options.key === undefined ? {} : { idempotency: { key: options.key, fingerprint: JSON.stringify(full) } }),
      decide: (read) => planRecord(read, full, { registry: TAX_RULES, fingerprinter: sha256Fingerprinter, today: TODAY, recordedBy: actor.actorId }),
    });
  }

  /** The row counts of 0052's eight tables, `audit_record` and `idempotency_key`. */
  async function counts(): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const table of [...VERSION_TABLES, 'audit_record', 'idempotency_key']) {
      result[table] = Number((await ctx.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
    }
    return result;
  }

  return { ctx, schema, party, acc8, allocate, fingerprintOf, record, counts };
}

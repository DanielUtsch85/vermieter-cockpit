import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import type { AllocationComparison, NewAllocation } from '../../domains/acquisition/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * The shared setup of §58T's database tests (VC-X-44, migration 0075): one migrated schema per test file, an Acquisition
 * (DRAFT, transfer 2026-07-01) per call, the allocations of §58T's example (E1: 400,000.00 = 40,000.00 + 360,000.00) and
 * the comparison 120,000.00 / 280,000.00. Figures, names and texts are synthetic. Test support only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
export const REALM = '64b0c0ffee0000000000440a';
export const OTHER_REALM = '64b0c0ffee0000000000440b';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
export const eur = (amount: string) => Money.of(amount, 'EUR');
export const REASON = 'Bodenwert wegen Altlasten im Vertrag gemindert, Gutachten folgt (synthetisch)';
export const COMPARISON: AllocationComparison = {
  method: 'BMF_TOOL',
  landValue: eur('120000.00'),
  buildingValue: eur('280000.00'),
  sourceReferences: ['BMF-Arbeitshilfe, Ausdruck 2026-08-03 (synthetisch)'],
};

export interface PlausibilityContext {
  pool: pg.Pool;
  parties: PostgresPartyRepository;
  acquisitions: PostgresAcquisitionRepository;
  allocations: PostgresLandBuildingAllocationRepository;
}

export async function createSchema(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${name}"`);
  await admin.end();
}

/** Registers the schema's `beforeAll`/`afterAll` in the calling `describe` and returns the context and the helpers. */
export function usePlausibilityDatabase(name: `${string}_test`) {
  const schema = testSchemaName(name);
  const ctx = {} as PlausibilityContext;
  let counter = 0;

  beforeAll(async () => {
    await createSchema(schema);
    ctx.pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
    await migrateToLatest(ctx.pool, { migrationTableSchema: schema });
    const db = createDatabase(ctx.pool);
    ctx.parties = new PostgresPartyRepository(db);
    ctx.acquisitions = new PostgresAcquisitionRepository(db);
    ctx.allocations = new PostgresLandBuildingAllocationRepository(db);
  });

  afterAll(async () => {
    await ctx.pool.end();
  });

  async function party(displayName: string, realm = REALM): Promise<string> {
    const outcome = await ctx.parties.create(
      {
        mreRealmId: realm,
        partyType: 'PERSON',
        displayName,
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

  /** A DRAFT of 400,000.00 with the transfer date 2026-07-01. */
  async function acquisition(realm = REALM): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f44000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await ctx.pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    const outcome = await ctx.acquisitions.create(
      {
        mreRealmId: realm,
        propertyReferenceId: rows[0].id as string,
        purchasePrice: eur('400000.00'),
        acquiredShare: { numerator: 1, denominator: 1 },
        contractDate: '2026-05-15' as BusinessDate,
        economicTransferDate: '2026-07-01' as BusinessDate,
        landRegistryTransferDate: null,
        buyerPartyIds: [await party('Käuferin A (synthetisch)', realm)],
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.acquisition.id;
  }

  /** E1 of §58T's example, as entered; `overrides` replace any field. */
  const entered = (acquisitionId: string, supersedes: string | null, overrides: Partial<NewAllocation> = {}): NewAllocation => ({
    mreRealmId: REALM,
    acquisitionId,
    totalAllocableAmount: eur('400000.00'),
    landAmount: eur('40000.00'),
    buildingAmount: eur('360000.00'),
    method: 'PURCHASE_CONTRACT',
    reviewState: 'CONFIRMED',
    effectiveDate: null,
    advisorPartyId: null,
    sourceReferences: ['Kaufvertrag § 3 (synthetisch)'],
    notes: null,
    supersedes,
    ...overrides,
  });

  async function created(allocation: NewAllocation, idempotency?: { key: string; fingerprint: string }) {
    const outcome = await ctx.allocations.create(allocation, actor, idempotency);
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
    return outcome.allocation;
  }

  return { schema, ctx, party, acquisition, entered, created };
}

/** A raw row of `land_building_allocation` for E1 with the columns given (`null` for the rest of §58T's columns). */
export function rawRow(acquisitionId: string, columns: Record<string, string> = {}): string {
  const all: Record<string, string> = {
    mre_realm_id: `'${REALM}'`,
    acquisition_id: `'${acquisitionId}'`,
    total_allocable_amount: '400000.00',
    land_amount: '40000.00',
    building_amount: '360000.00',
    currency: `'EUR'`,
    method: `'PURCHASE_CONTRACT'`,
    review_state: `'CONFIRMED'`,
    effective_date: `'2026-07-01'`,
    created_by: `'x'`,
    ...columns,
  };
  return `INSERT INTO land_building_allocation (${Object.keys(all).join(', ')}) VALUES (${Object.values(all).join(', ')})`;
}

/** The comparison columns of E1 as SQL literals. */
export const COMPARISON_COLUMNS = {
  comparison_method: `'BMF_TOOL'`,
  comparison_land_value: '120000.00',
  comparison_building_value: '280000.00',
  comparison_source_references: `ARRAY['BMF-Arbeitshilfe (synthetisch)']`,
};

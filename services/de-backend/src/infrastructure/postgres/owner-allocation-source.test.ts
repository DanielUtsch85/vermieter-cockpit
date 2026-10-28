import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planOwnerAllocation } from '../../domains/acquisition/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionCostRepository } from './acquisition-cost-repository.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresOwnerAllocationSource } from './owner-allocation-source.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-2-09 (api-design.md §27.4): the read's inputs from one snapshot (its VALID Ownerships, ACTIVE costs per category,
 * the current allocation), and the domain's plan over them against the database.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;
let counter = 0;

describe.skipIf(databaseUrl === undefined)('PostgresOwnerAllocationSource', () => {
  const schema = testSchemaName('owner_allocation_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let acquisitions: PostgresAcquisitionRepository;
  let ownerships: PostgresOwnershipRepository;
  let costs: PostgresAcquisitionCostRepository;
  let allocations: PostgresLandBuildingAllocationRepository;
  let source: PostgresOwnerAllocationSource;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    acquisitions = new PostgresAcquisitionRepository(db);
    ownerships = new PostgresOwnershipRepository(db);
    costs = new PostgresAcquisitionCostRepository(db);
    allocations = new PostgresLandBuildingAllocationRepository(db);
    source = new PostgresOwnerAllocationSource(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function party(name: string): Promise<string> {
    const outcome = await parties.create(
      {
        mreRealmId: REALM,
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
  /** Two buyers with 1/2 each from the transfer date, confirmed; costs and an allocation as given. */
  async function scenario() {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fc0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [REALM, mrePropertyId],
    );
    const pr = rows[0].id as string;
    const [anna, ben] = [await party('Anna'), await party('Ben')].sort();
    const created = await acquisitions.create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        purchasePrice: eur('300000.01'),
        acquiredShare: { numerator: 1, denominator: 1 },
        contractDate: day('2026-06-15'),
        economicTransferDate: day('2026-08-01'),
        landRegistryTransferDate: null,
        buyerPartyIds: [anna ?? '', ben ?? ''],
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const id = created.acquisition.id;
    const owned = [];
    for (const owner of [anna ?? '', ben ?? '']) {
      const o = await ownerships.create(
        {
          mreRealmId: REALM,
          propertyReferenceId: pr,
          ownerPartyId: owner,
          share: { numerator: 1, denominator: 2 },
          validFrom: day('2026-08-01'),
          validUntil: null,
          acquisitionId: id,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (o.kind !== 'CREATED') throw new Error(o.kind);
      owned.push(o.ownership.id);
    }
    return { pr, id, anna: anna ?? '', ben: ben ?? '', owned };
  }
  const cost = async (acquisitionId: string, category: 'NOTARY' | 'BROKER', amount: string) => {
    const outcome = await costs.createCost(
      { mreRealmId: REALM, acquisitionId, category, amount: eur(amount), incurredDate: null, counterpartyPartyId: null, sourceReferences: [], notes: null },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.cost.id;
  };

  it('reads one snapshot: VALID Ownerships (a closed one too), ACTIVE costs summed per category, the current allocation', async () => {
    const s = await scenario();
    await cost(s.id, 'NOTARY', '1000.00');
    await cost(s.id, 'NOTARY', '500.01');
    const voided = await cost(s.id, 'BROKER', '9999.00');
    await costs.voidCost(s.id, voided, REALM, 'falsch', new Date(), actor);
    const entered = {
      mreRealmId: REALM,
      acquisitionId: s.id,
      method: 'BMF_TOOL',
      reviewState: 'UNREVIEWED',
      effectiveDate: null,
      advisorPartyId: null,
      sourceReferences: [],
      notes: null,
    } as const;
    const first = await allocations.create(
      { ...entered, totalAllocableAmount: eur('100.00'), landAmount: eur('20.00'), buildingAmount: eur('80.00'), supersedes: null },
      actor,
    );
    if (first.kind !== 'CREATED') throw new Error(first.kind);
    const current = await allocations.create(
      { ...entered, totalAllocableAmount: eur('301500.02'), landAmount: eur('60300.01'), buildingAmount: eur('241200.01'), supersedes: first.allocation.id },
      actor,
    );
    if (current.kind !== 'CREATED') throw new Error(current.kind);
    await acquisitions.confirm(s.id, REALM, new Date(), actor);
    await ownerships.close(s.owned[0] ?? '', REALM, day('2030-12-31'), actor);

    const input = await source.read(s.id, REALM);
    expect(input?.own.map((o) => o.id).sort()).toEqual([...s.owned].sort());
    expect([...(input?.costs ?? new Map())].map(([c, m]) => [c, m.amount])).toEqual([['NOTARY', '1500.01']]);
    expect(input?.allocation?.id).toBe(current.allocation.id);

    const result = planOwnerAllocation(input ?? (await Promise.reject(new Error('no input'))));
    if (result.kind !== 'ALLOCATED') throw new Error(result.kind);
    expect(result).toMatchObject({ basis: 'CONFIRMED', allocationId: current.allocation.id });
    // An odd cent goes to the smaller ownerPartyId (both remainders are 1/2).
    expect(
      result.owners.map((o) => [
        o.ownerPartyId,
        o.purchasePrice.amount,
        o.costs.get('NOTARY')?.amount,
        o.landAmount?.amount,
        o.buildingAmount?.amount,
        o.totalAllocableAmount?.amount,
      ]),
    ).toEqual([
      [s.anna, '150000.01', '750.01', '30150.01', '120600.01', '150750.02'],
      [s.ben, '150000.00', '750.00', '30150.00', '120600.00', '150750.00'],
    ]);
  });

  it('the status answers: a DRAFT is PROVISIONAL with its structure, else refused; CANCELLED refused; unknown and foreign not found', async () => {
    const s = await scenario();
    const plan = async () => {
      const input = await source.read(s.id, REALM);
      if (input === undefined) throw new Error('no input');
      return planOwnerAllocation(input);
    };
    expect(await plan()).toMatchObject({ kind: 'ALLOCATED', basis: 'PROVISIONAL' });
    await ownerships.void(s.owned[1] ?? '', REALM, 'Tippfehler', new Date(), actor);
    expect(await plan()).toMatchObject({
      kind: 'OWNERSHIP_BASIS_INCOMPLETE',
      violations: [{ code: 'BUYER_WITHOUT_OWNERSHIP', partyId: s.ben }, { code: 'SHARE_SUM_MISMATCH' }],
    });
    await ownerships.void(s.owned[0] ?? '', REALM, 'Tippfehler', new Date(), actor);
    await acquisitions.cancel(s.id, REALM, 'geplatzt', new Date(), actor);
    expect(await plan()).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    expect(await source.read(s.id, OTHER_REALM)).toBeUndefined();
    expect(await source.read('nope', REALM)).toBeUndefined();
  });
});

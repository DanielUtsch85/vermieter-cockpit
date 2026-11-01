import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import { getAnschaffungsnaheCheck, getDepreciationSchedule } from './application/index.js';
import {
  PostgresAcquisitionCostRepository,
  PostgresAcquisitionRepository,
  PostgresDepreciationAssetRepository,
  PostgresDepreciationScheduleSource,
  PostgresLandBuildingAllocationRepository,
  PostgresOwnershipRepository,
  PostgresPartyRepository,
  PostgresTaxClassificationRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { sha256Fingerprinter } from './infrastructure/hashing/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { Money, type BusinessDate } from './shared/index.js';
import { mrePrincipalVerifier } from './wiring.js';
import { reproductionFromDatabase } from './depreciation-reproduction.test-support.js';
import { standardMethod } from './infrastructure/postgres/depreciation-method.test-support.js';

/**
 * VC-8-02 end to end (api-design.md §59A), wired as in main.ts, with ACC8's purchase (synthetic): the response example
 * for 2026 and 2027 at both levels; the transfer on 2026-12-31 (424.00) and on 2027-01-01 (0.00 in 2026); no confirmed
 * allocation; a second Acquisition of a share with an unconfirmed allocation (PARTIAL); B selling to C on 2029-07-01,
 * with and without C's `economicTransferDate`; an existing owner buying a further share (§28.1A); the schedule's basis
 * equal to the anschaffungsnahe check's; `NOT_AN_OWNER`; Realm isolation. The clock is injected. VC-X-35: each scenario
 * with a schedule ends with its reproduction from the database (`depreciation-reproduction.test-support.ts`, the switch
 * on in test-only wiring, its own clock in 2033): a version recorded, read back, recomputed to its own entries and equal
 * to the schedule read; a scenario with a year without a figure is not recordable through that year.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee000000000000a9';
const REALM_B = '64b0c0ffee000000000000b9';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;
const AT = new Date('2026-10-30T10:00:00Z');
let counter = 0;

type Amount = { readonly amount: string; readonly currency: string } | null;
type Flag = { readonly code: string; readonly details: Record<string, unknown> };
type OwnerYear = {
  readonly ownerPartyId: string;
  readonly months: number | null;
  readonly amount: Amount;
  readonly calculationStatus: string;
  readonly reasons: Flag[];
  readonly flags: Flag[];
};
type Schedule = {
  readonly level: string;
  readonly status: string;
  readonly range: { readonly from: number; readonly to: number };
  readonly components: {
    readonly acquisitionId: string;
    readonly status: string;
    readonly reasons: Flag[];
    readonly basis: { readonly amount: Amount };
    readonly start: { readonly date: string; readonly month: string } | null;
    readonly owners: { readonly ownerPartyId: string; readonly acquiredShare: string; readonly weight: string }[];
    readonly years: { readonly year: number; readonly amount: Amount; readonly calculationStatus: string; readonly owners: OwnerYear[] }[];
  }[];
  readonly years: {
    readonly year: number;
    readonly status: string;
    readonly amount: Amount;
    readonly owners: { ownerPartyId: string; amount: Amount }[] | null;
    readonly flags: Flag[];
  }[];
  readonly error: { readonly code: string; readonly details: unknown };
};

// Each test ends with the reproduction from the database (VC-X-35): several versions recorded and read back, past
// Vitest's default of 5 s when the suite runs in parallel.
describe.skipIf(databaseUrl === undefined)('the schedule of the purchase (VC-8-02) end to end', { timeout: 30_000 }, () => {
  const schema = testSchemaName('depreciation_schedule_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let base: string;
  let parties: PostgresPartyRepository;
  let acquisitions: PostgresAcquisitionRepository;
  let ownerships: PostgresOwnershipRepository;
  let costs: PostgresAcquisitionCostRepository;
  let allocations: PostgresLandBuildingAllocationRepository;
  let assets: PostgresDepreciationAssetRepository;
  let reproduction: ReturnType<typeof reproductionFromDatabase>;
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
  const clock = { now: new Date('2026-10-30T10:00:00Z') };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    mre = await startFakeMre([
      { _id: REALM_A, name: 'A', members: member, applications: [], tenants: [] },
      { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    acquisitions = new PostgresAcquisitionRepository(db);
    ownerships = new PostgresOwnershipRepository(db);
    costs = new PostgresAcquisitionCostRepository(db);
    allocations = new PostgresLandBuildingAllocationRepository(db);
    assets = new PostgresDepreciationAssetRepository(db);
    reproduction = reproductionFromDatabase(db, () => new Date('2033-01-15T10:00:00Z'));
    const now = () => clock.now;
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        depreciationAssets: {
          schedule: getDepreciationSchedule({
            source: new PostgresDepreciationScheduleSource(db, new PostgresTaxClassificationRepository(db).capitalizedSources, now),
            now,
            recordingEnabled: false,
            fingerprinter: sha256Fingerprinter,
          }),
        },
        taxation: { anschaffungsnahe: getAnschaffungsnaheCheck({ repository: new PostgresTaxClassificationRepository(db), now }) },
      }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.end();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 300);
  const get = (path: string, realm = REALM_A) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, organizationid: realm } });
  const schedule = async (assetId: string, query = '', realm = REALM_A) => {
    const res = await get(`/depreciation-assets/${assetId}/schedule${query}`, realm);
    return { status: res.status, body: (await res.json()) as Schedule };
  };
  const ok = async (assetId: string, query = '', realm = REALM_A) => {
    const { status, body } = await schedule(assetId, query, realm);
    expect(status).toBe(200);
    return body;
  };
  const money = (a: Amount) => a?.amount ?? null;

  async function party(name: string, realm = REALM_A): Promise<string> {
    const outcome = await parties.create(
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
  async function propertyReference(realm = REALM_A): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5e90000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  interface Purchase {
    readonly pr: string;
    readonly buyers: readonly string[];
    readonly sellers?: readonly string[];
    readonly share: [number, number];
    readonly contract: string;
    readonly transfer: string | null;
    readonly price?: string;
    readonly building?: string;
    readonly reviewState?: 'CONFIRMED' | 'UNREVIEWED';
    readonly realm?: string;
  }
  /** A DRAFT with the ACC8 costs and an allocation; the Ownerships are the caller's. */
  async function purchase(p: Purchase): Promise<string> {
    const realm = p.realm ?? REALM_A;
    const created = await acquisitions.create(
      {
        mreRealmId: realm,
        propertyReferenceId: p.pr,
        purchasePrice: eur(p.price ?? '300000.00'),
        acquiredShare: { numerator: p.share[0], denominator: p.share[1] },
        contractDate: day(p.contract),
        economicTransferDate: p.transfer === null ? null : day(p.transfer),
        landRegistryTransferDate: null,
        buyerPartyIds: [...p.buyers],
        sellerPartyIds: [...(p.sellers ?? [])],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const id = created.acquisition.id;
    for (const [category, amount] of [
      ['REAL_ESTATE_TRANSFER_TAX', '15000.00'],
      ['NOTARY', '3000.00'],
      ['FINANCING_RELATED', '1200.00'],
    ] as const) {
      const c = await costs.createCost(
        {
          mreRealmId: realm,
          acquisitionId: id,
          category,
          amount: eur(amount),
          incurredDate: null,
          counterpartyPartyId: null,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (c.kind !== 'CREATED') throw new Error(c.kind);
    }
    const total = Number(p.price ?? '300000.00') + 18000;
    const building = p.building ?? (total * 0.8).toFixed(2);
    const allocation = await allocations.create(
      {
        mreRealmId: realm,
        acquisitionId: id,
        totalAllocableAmount: eur(total.toFixed(2)),
        landAmount: eur((total - Number(building)).toFixed(2)),
        buildingAmount: eur(building),
        method: 'PURCHASE_CONTRACT',
        reviewState: p.reviewState ?? 'CONFIRMED',
        effectiveDate: null,
        advisorPartyId: null,
        sourceReferences: [],
        notes: null,
        supersedes: null,
      },
      actor,
    );
    if (allocation.kind !== 'CREATED') throw new Error(allocation.kind);
    return id;
  }
  async function own(pr: string, owner: string, share: [number, number], from: string, acquisitionId: string | null, realm = REALM_A): Promise<string> {
    const outcome = await ownerships.create(
      {
        mreRealmId: realm,
        propertyReferenceId: pr,
        ownerPartyId: owner,
        share: { numerator: share[0], denominator: share[1] },
        validFrom: day(from),
        validUntil: null,
        acquisitionId,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.ownership.id;
  }
  async function confirm(acquisitionId: string, realm = REALM_A) {
    const outcome = await acquisitions.confirm(acquisitionId, realm, AT, actor);
    if (outcome.kind !== 'CONFIRMED') throw new Error(JSON.stringify(outcome));
  }
  /** §59C: a confirmed STANDARD method entry for each purchase named, so it computes. */
  async function building(pr: string, realm = REALM_A, purchases: readonly string[] = []): Promise<string> {
    const created = await assets.create(
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
        sourceReferences: ['Teilungserklärung, Baujahr laut Anlage 1'],
        reviewState: 'CONFIRMED',
        advisorPartyId: null,
        shorterUsefulLives: [],
        purchaseMethods: purchases.map((id) => standardMethod(id)),
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.asset.id;
  }
  /** §59C: a later purchase's confirmed STANDARD entry, added by an amend (the entries named are the whole list). */
  async function addMethod(assetId: string, acquisitionId: string, realm = REALM_A): Promise<void> {
    const read = await assets.find(assetId, realm);
    const purchaseMethods = [...(read?.asset.purchaseMethods ?? []), standardMethod(acquisitionId)];
    const amended = await assets.amend(assetId, realm, { purchaseMethods }, actor);
    if (amended.kind !== 'AMENDED') throw new Error(amended.kind);
  }
  /** ACC8: A 3/5 and B 2/5 of W (basis 254,400.00), the transfer as given. */
  async function acc8(transfer = '2026-07-01', options: { reviewState?: 'CONFIRMED' | 'UNREVIEWED'; realm?: string } = {}) {
    const realm = options.realm ?? REALM_A;
    const pr = await propertyReference(realm);
    const [a, b] = [await party('Käuferin A', realm), await party('Käufer B', realm)].sort() as [string, string];
    const w = await purchase({ pr, buyers: [a, b], share: [1, 1], contract: '2026-05-15', transfer, building: '254400.00', realm, ...options });
    const rows = [await own(pr, a, [3, 5], transfer, w, realm), await own(pr, b, [2, 5], transfer, w, realm)];
    await confirm(w, realm);
    return { pr, a, b, w, rows, assetId: await building(pr, realm, [w]) };
  }

  it('the response example: 2026 and 2027 at both levels; the basis equal to the anschaffungsnahe check’s', async () => {
    const s = await acc8();
    const body = await ok(s.assetId, '?from=2026&to=2027');
    expect([body.level, body.status, body.range]).toEqual(['PROPERTY', 'AVAILABLE', { from: 2026, to: 2027, truncated: false }]);
    expect(body.years.map((y) => [y.year, y.status, money(y.amount), y.owners?.map((o) => money(o.amount))])).toEqual([
      [2026, 'AVAILABLE', '2544.00', ['1526.40', '1017.60']],
      [2027, 'AVAILABLE', '5088.00', ['3052.80', '2035.20']],
    ]);
    const owner = await ok(s.assetId, `?from=2026&to=2027&ownerPartyId=${s.b}`);
    expect([owner.level, owner.years.map((y) => [money(y.amount), y.owners])]).toEqual([
      'OWNER',
      [
        ['1017.60', null],
        ['2035.20', null],
      ],
    ]);
    const check = (await (await get(`/acquisitions/${s.w}/anschaffungsnahe-herstellungskosten`)).json()) as { basis: { basisAmount: Amount } };
    expect(money(check.basis.basisAmount)).toBe(money(body.components[0]?.basis.amount ?? null));
    expect(money(check.basis.basisAmount)).toBe('254400.00');
    await reproduction.expectReproducible(s.assetId, 2027, REALM_A);
  });

  it('the variants: a transfer on 2026-12-31 gives 424.00 in 2026; one on 2027-01-01 gives 0.00 in 2026 and 5,088.00 in 2027', async () => {
    const late = await acc8('2026-12-31');
    expect((await ok(late.assetId, '?from=2026&to=2026')).years.map((y) => money(y.amount))).toEqual(['424.00']);
    const next = await acc8('2027-01-01');
    const body = await ok(next.assetId, '?from=2026&to=2027');
    expect(body.years.map((y) => [y.year, y.status, money(y.amount)])).toEqual([
      [2026, 'AVAILABLE', '0.00'],
      [2027, 'AVAILABLE', '5088.00'],
    ]);
    await reproduction.expectReproducible(late.assetId, 2026, REALM_A);
    await reproduction.expectReproducible(next.assetId, 2027, REALM_A);
  });

  it('no confirmed allocation: ALLOCATION_NOT_CONFIRMED, DEPRECIATION_NOT_AVAILABLE, the amounts null (never 0.00)', async () => {
    const s = await acc8('2026-07-01', { reviewState: 'UNREVIEWED' });
    const body = await ok(s.assetId, '?from=2026&to=2027');
    expect(body.status).toBe('DEPRECIATION_NOT_AVAILABLE');
    expect(body.components[0]?.reasons.map((r) => r.code)).toEqual(['ALLOCATION_NOT_CONFIRMED']);
    expect(money(body.components[0]?.basis.amount ?? null)).toBe('254400.00');
    expect(body.years.map((y) => [y.status, y.amount])).toEqual([
      ['DEPRECIATION_NOT_AVAILABLE', null],
      ['DEPRECIATION_NOT_AVAILABLE', null],
    ]);
    await reproduction.expectNotRecordable(s.assetId, 2027, REALM_A);
  });

  it('a second Acquisition of a share with an unconfirmed allocation: PARTIAL', async () => {
    const pr = await propertyReference();
    const [a, b] = [await party('Käuferin A'), await party('Käufer B')];
    const w = await purchase({ pr, buyers: [a], share: [3, 5], contract: '2026-05-15', transfer: '2026-07-01', price: '180000.00' });
    const x = await purchase({ pr, buyers: [b], share: [2, 5], contract: '2026-05-20', transfer: '2026-07-01', price: '120000.00', reviewState: 'UNREVIEWED' });
    await own(pr, a, [3, 5], '2026-07-01', w);
    await own(pr, b, [2, 5], '2026-07-01', x);
    await confirm(w);
    await confirm(x);
    const assetId = await building(pr, REALM_A, [w, x]);
    const body = await ok(assetId, '?from=2027&to=2027');
    expect(body.status).toBe('PARTIAL');
    // Both start on 2026-07-01, so they are ordered by acquisitionId (§59A "Order").
    expect(body.components.map((c) => [c.acquisitionId, c.status, c.reasons.map((r) => r.code)])).toEqual(
      [
        [w, 'COMPUTABLE', []],
        [x, 'NOT_COMPUTABLE', ['ALLOCATION_NOT_CONFIRMED']],
      ].sort(([p], [q]) => ((p as string) < (q as string) ? -1 : 1)),
    );
    expect(body.years[0]).toMatchObject({ status: 'PARTIAL', amount: null });
    await reproduction.expectNotRecordable(assetId, 2026, REALM_A);
  });

  /** B sells its 2/5 to C effective 2029-07-01 (§26.2), C's Acquisition X with or without `economicTransferDate`. */
  async function sale(economic: boolean) {
    const s = await acc8();
    const c = await party('Käuferin C');
    const x = await purchase({
      pr: s.pr,
      buyers: [c],
      sellers: [s.b],
      share: [2, 5],
      contract: '2029-07-01',
      transfer: economic ? '2029-07-01' : null,
      price: '110000.00',
    });
    const changed = await ownerships.change(
      {
        mreRealmId: REALM_A,
        propertyReferenceId: s.pr,
        effectiveDate: day('2029-07-01'),
        reason: 'Verkauf',
        close: [s.rows[1] as string],
        create: [{ ownerPartyId: c, share: { numerator: 2, denominator: 5 }, sourceReferences: [], notes: null }],
        acquisitionId: x,
      },
      actor,
    );
    if (changed.kind !== 'CHANGED') throw new Error(changed.kind);
    await confirm(x);
    await addMethod(s.assetId, x);
    return { ...s, c, x };
  }

  it('B sells to C on 2029-07-01: B’s 2029 is 1,017.60, CALCULATED, no DISPOSAL_YEAR_TO_VERIFY (confirmed); C’s component from July', async () => {
    const s = await sale(true);
    const body = await ok(s.assetId, '?from=2029&to=2030');
    const [w, x] = body.components;
    const b2029 = w?.years.find((y) => y.year === 2029)?.owners.find((o) => o.ownerPartyId === s.b);
    // Prüfbericht 01.11.2026, Frage 4 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01).
    expect([money(b2029?.amount ?? null), b2029?.calculationStatus, b2029?.flags.map((f) => f.code)]).toEqual(['1017.60', 'CALCULATED', []]);
    expect(w?.years.find((y) => y.year === 2030)?.owners.map((o) => o.ownerPartyId)).toEqual([s.a]);
    expect([x?.acquisitionId, x?.status, x?.start?.month]).toEqual([s.x, 'COMPUTABLE', '2029-07']);
    expect(body.years[0]?.owners?.map((o) => o.ownerPartyId).sort()).toEqual([s.a, s.b, s.c].sort());
    // B's disposal year is recorded (its flag confirmed away, Prüfbericht 01.11.2026), C's component from July.
    await reproduction.expectReproducible(s.assetId, 2030, REALM_A);
  });

  it('C’s Acquisition without economicTransferDate: B’s 2029 NOT_CALCULABLE with DISPOSAL_DATE_MISSING, C’s component TRANSFER_DATE_MISSING', async () => {
    const s = await sale(false);
    const body = await ok(s.assetId, '?from=2029&to=2029');
    const b2029 = body.components[0]?.years[0]?.owners.find((o) => o.ownerPartyId === s.b);
    expect(b2029).toMatchObject({ amount: null, calculationStatus: 'NOT_CALCULABLE' });
    expect(b2029?.reasons).toEqual([{ code: 'DISPOSAL_DATE_MISSING', details: { validUntil: '2029-06-30', buyerAcquisitionId: s.x } }]);
    expect(body.years[0]?.amount).toBeNull();
    // C's own component has no start (VC-X-33): not computable, never from the contract date of 2029-07-01.
    const x = body.components[1];
    expect([x?.acquisitionId, x?.status, x?.reasons, x?.start]).toEqual([
      s.x,
      'NOT_COMPUTABLE',
      [{ code: 'TRANSFER_DATE_MISSING', details: { contractDate: '2029-07-01' } }],
      null,
    ]);
    expect(x?.years.map((y) => [y.year, y.amount, y.calculationStatus])).toEqual([[2029, null, 'NOT_CALCULABLE']]);
    // Not recordable through 2029, nor through 2028 (the test below).
    await reproduction.expectNotRecordable(s.assetId, 2029, REALM_A);
  });

  /**
   * VC-X-35 finding, fixed: through 2028 every year has a figure, but C's component has no start (no
   * `economicTransferDate`, `firstYearOfComponent` is `null`), so whether it started by 2028 is unknown. It is never
   * stored ("As implemented (VC-8-04)" 3), so step 4 refuses the record (`SCHEDULE_NOT_COMPLETE`, the component named
   * with `TRANSFER_DATE_MISSING`) instead of a `23502` from 0052's NOT NULL; nothing is stored.
   */
  it('VC-X-35 finding: through 2028 the sale without a transfer date refuses the record, never a database error', async () => {
    const s = await sale(false);
    await reproduction.expectNotRecordable(s.assetId, 2028, REALM_A);
  });

  it('an existing owner buys a further share (§28.1A): W and X both computed, no BUYER_ALREADY_OWNER, no OWNER_WITHOUT_ACQUISITION', async () => {
    const pr = await propertyReference();
    const [a, b] = [await party('Käuferin A'), await party('Käufer B')];
    const w = await purchase({ pr, buyers: [a, b], share: [1, 1], contract: '2026-05-15', transfer: '2026-07-01', building: '254400.00' });
    const o1 = await own(pr, a, [1, 2], '2026-07-01', w);
    const o2 = await own(pr, b, [1, 2], '2026-07-01', w);
    await confirm(w);
    const x = await purchase({ pr, buyers: [a], sellers: [b], share: [1, 2], contract: '2028-06-01', transfer: '2028-07-01', price: '140000.00' });
    const changed = await ownerships.change(
      {
        mreRealmId: REALM_A,
        propertyReferenceId: pr,
        effectiveDate: day('2028-07-01'),
        reason: 'Zukauf',
        close: [o1, o2],
        create: [{ ownerPartyId: a, share: { numerator: 1, denominator: 1 }, sourceReferences: [], notes: null }],
        acquisitionId: x,
      },
      actor,
    );
    if (changed.kind !== 'CHANGED') throw new Error(changed.kind);
    await confirm(x);
    const assetId = await building(pr, REALM_A, [w, x]);
    const body = await ok(assetId, '?from=2028&to=2029');
    expect(body.components.map((c) => [c.acquisitionId, c.status, c.reasons])).toEqual([
      [w, 'COMPUTABLE', []],
      [x, 'COMPUTABLE', []],
    ]);
    expect(body.components[1]?.owners.map((o) => [o.ownerPartyId, o.acquiredShare, o.weight])).toEqual([[a, '1/2', '1/1']]);
    // A's half of W: 2,544.00 a year, through the row change.
    expect(body.components[0]?.years.map((y) => money(y.owners.find((o) => o.ownerPartyId === a)?.amount ?? null))).toEqual(['2544.00', '2544.00']);
    expect(body.years.flatMap((y) => y.flags.map((f) => f.code))).not.toContain('OWNER_WITHOUT_ACQUISITION');
    expect(body.status).toBe('AVAILABLE');
    await reproduction.expectReproducible(assetId, 2029, REALM_A);
  });

  it('NOT_AN_OWNER for a Party of the Realm that holds no share and bought none', async () => {
    const s = await acc8();
    const stranger = await party('Steuerberatung S');
    const { status, body } = await schedule(s.assetId, `?ownerPartyId=${stranger}`);
    expect([status, body.error.code, body.error.details]).toEqual([422, 'NOT_AN_OWNER', { ownerPartyId: stranger, propertyReferenceId: s.pr }]);
  });

  it('Realm isolation: another Realm’s asset or Party is 404; another Realm’s same-named setup never appears', async () => {
    const mine = await acc8();
    const theirs = await acc8('2026-07-01', { realm: REALM_B });
    expect((await schedule(mine.assetId, '', REALM_B)).status).toBe(404);
    expect((await schedule(theirs.assetId)).status).toBe(404);
    const foreign = await schedule(mine.assetId, `?ownerPartyId=${theirs.a}`);
    expect([foreign.status, foreign.body.error.details]).toEqual([404, { ownerPartyId: theirs.a }]);
    const body = await ok(mine.assetId, '?from=2026&to=2026');
    expect(body.components.map((c) => c.acquisitionId)).toEqual([mine.w]);
    expect(body.years[0]?.owners?.map((o) => o.ownerPartyId)).toEqual([mine.a, mine.b]);
    await reproduction.expectReproducible(theirs.assetId, 2027, REALM_B);
  });
});

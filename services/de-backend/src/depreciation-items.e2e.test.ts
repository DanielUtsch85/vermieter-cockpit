import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  confirmDepreciationAsset,
  createDepreciationAsset,
  getDepreciationAsset,
  getDepreciationSchedule,
  getTaxYearView,
  listPropertyDepreciationAssets,
  listTaxRules,
} from './application/index.js';
import type { NewTaxClassification } from './domains/taxation/index.js';
import { parseMea, type Mea } from './domains/weg/index.js';
import {
  PostgresAcquisitionCostRepository,
  PostgresAcquisitionRepository,
  PostgresDepreciationAssetRepository,
  PostgresDepreciationScheduleSource,
  PostgresFinancialAccountRepository,
  PostgresLandBuildingAllocationRepository,
  PostgresOwnershipRepository,
  PostgresPartyRepository,
  PostgresTaxClassificationRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegRepository,
  PostgresWegSpecialAssessmentRepository,
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
import { standardMethodBody } from './infrastructure/postgres/depreciation-method.test-support.js';

/**
 * VC-8-03 end to end (api-design.md §59B), wired as in main.ts, with ACC8 (synthetic): the purchase; the repair and the
 * Sonderumlage use DEDUCTIBLE with the check above 15 % (the schedule unchanged: the suggestion moves nothing); both
 * capitalised on the check (5,802.00 in 2027 and 5,982.00 in 2028 at both levels), each in `capitalized` of its year and
 * in no Werbungskosten line; the extension (240.00 from 2030); the Einbauküche as a separate asset (450.00, 600.00), not
 * in the building; a refund of 1,000.00 of the extension in 2031 (−20.00 a year); `GET /tax-rules`; Realm isolation.
 * VC-X-35: each stage of the scenario ends with its reproduction from the database (`depreciation-reproduction.test-support.ts`,
 * the switch on in test-only wiring, its own clock in 2033): a version recorded (superseding the stage before, its
 * changed years named), read back, recomputed to its own entries and equal to the schedule read.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee000000000000ab';
const REALM_B = '64b0c0ffee000000000000bb';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;
const AT = new Date('2026-10-30T10:00:00Z');
let counter = 0;

type Amount = { readonly amount: string; readonly currency: string } | null;
type Json = Record<string, unknown>;
type Schedule = {
  readonly components: { readonly componentId: string; readonly kind: string; readonly years: { readonly year: number; readonly amount: Amount }[] }[];
  readonly excludedItems: { readonly componentId: string; readonly separateAssetId: string }[] | null;
  readonly years: { readonly year: number; readonly amount: Amount; readonly owners: { ownerPartyId: string; amount: Amount }[] | null }[];
};

// Each test ends with the reproduction from the database (VC-X-35): several versions recorded and read back, past
// Vitest's default of 5 s when the suite runs in parallel.
describe.skipIf(databaseUrl === undefined)('capitalised items and a separate asset (VC-8-03) end to end', { timeout: 30_000 }, () => {
  const schema = testSchemaName('depreciation_items_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let base: string;
  let classifications: PostgresTaxClassificationRepository;
  let reproduction: ReturnType<typeof reproductionFromDatabase>;
  let giro = '';
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
  const now = () => new Date('2027-10-30T10:00:00Z');

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
    classifications = new PostgresTaxClassificationRepository(db);
    reproduction = reproductionFromDatabase(db, () => new Date('2033-01-15T10:00:00Z'));
    const assets = new PostgresDepreciationAssetRepository(db, { capitalizedSources: classifications.capitalizedSources, now });
    const account = await new PostgresFinancialAccountRepository(db).create(
      { mreRealmId: REALM_A, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null },
      actor,
    );
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    giro = account.account.id;
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        depreciationAssets: {
          create: createDepreciationAsset({ repository: assets }),
          confirm: confirmDepreciationAsset({ repository: assets }),
          get: getDepreciationAsset({ repository: assets, now }),
          listForPropertyReference: listPropertyDepreciationAssets({ repository: assets, now }),
          schedule: getDepreciationSchedule({
            source: new PostgresDepreciationScheduleSource(db, classifications.capitalizedSources, now),
            now,
            recordingEnabled: false,
            fingerprinter: sha256Fingerprinter,
          }),
        },
        taxation: { taxYear: getTaxYearView({ repository: classifications, now }), listRules: listTaxRules({ now }) },
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
  const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}, realm = REALM_A) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T = Json>(res: Response, status = 200): Promise<T> => {
    const body = (await res.json()) as T;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const schedule = (assetId: string, query: string) => call('GET', `/depreciation-assets/${assetId}/schedule${query}`).then((r) => json<Schedule>(r));
  const money = (a: Amount | undefined) => a?.amount ?? null;
  const db = () => createDatabase(pool);

  async function party(name: string): Promise<string> {
    const outcome = await new PostgresPartyRepository(db()).create(
      {
        mreRealmId: REALM_A,
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
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5eb0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  /** ACC8's purchase: A 3/5 and B 2/5 of W from 2026-07-01, basis 254,400.00; the building asset confirmed. */
  async function acc8() {
    const pr = await propertyReference();
    const [a, b] = [await party('Käuferin A'), await party('Käufer B')].sort() as [string, string];
    const acquisitions = new PostgresAcquisitionRepository(db());
    const created = await acquisitions.create(
      {
        mreRealmId: REALM_A,
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
    for (const [category, amount] of [
      ['REAL_ESTATE_TRANSFER_TAX', '15000.00'],
      ['NOTARY', '3000.00'],
      ['FINANCING_RELATED', '1200.00'],
    ] as const) {
      const c = await new PostgresAcquisitionCostRepository(db()).createCost(
        {
          mreRealmId: REALM_A,
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
      if (c.kind !== 'CREATED') throw new Error(c.kind);
    }
    const allocation = await new PostgresLandBuildingAllocationRepository(db()).create(
      {
        mreRealmId: REALM_A,
        acquisitionId: w,
        totalAllocableAmount: eur('318000.00'),
        landAmount: eur('63600.00'),
        buildingAmount: eur('254400.00'),
        method: 'PURCHASE_CONTRACT',
        reviewState: 'CONFIRMED',
        effectiveDate: null,
        advisorPartyId: null,
        sourceReferences: [],
        notes: null,
        supersedes: null,
      },
      actor,
    );
    if (allocation.kind !== 'CREATED') throw new Error(allocation.kind);
    for (const [owner, n] of [
      [a, 3],
      [b, 2],
    ] as const) {
      const o = await new PostgresOwnershipRepository(db()).create(
        {
          mreRealmId: REALM_A,
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
      if (o.kind !== 'CREATED') throw new Error(o.kind);
    }
    if ((await acquisitions.confirm(w, REALM_A, AT, actor)).kind !== 'CONFIRMED') throw new Error('confirm');
    const asset = await json<{ assetId: string }>(
      // §59C: W's confirmed STANDARD method entry, so the purchase computes.
      await call('POST', '/depreciation-assets', {
        propertyReferenceId: pr,
        buildingCompletionYear: 1995,
        reviewState: 'CONFIRMED',
        purchaseMethods: [standardMethodBody(w)],
      }),
      201,
    );
    return { pr, a, b, w, building: asset.assetId };
  }
  async function splitOf(pr: string, amount: string, date: string, direction: 'INFLOW' | 'OUTFLOW' = 'OUTFLOW') {
    const transactions = new PostgresTransactionRepository(db());
    const created = await transactions.createManual(
      {
        mreRealmId: REALM_A,
        financialAccountId: giro,
        amount: eur(amount),
        direction,
        bookingDate: day(date),
        valueDate: null,
        description: 'Rechnung (synthetisch)',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const replaced = await new PostgresTransactionSplitRepository(db()).replaceSplits(
      created.transaction.id,
      REALM_A,
      [{ amount: eur(amount), financialCategoryCode: 'MAINTENANCE', propertyReferenceId: pr, loanId: null, securityDepositId: null, description: null }],
      actor,
    );
    if (replaced.kind !== 'REPLACED') throw new Error(JSON.stringify(replaced));
    if ((await transactions.confirm(created.transaction.id, REALM_A, actor)).kind !== 'CONFIRMED') throw new Error('confirm');
    return (await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1`, [created.transaction.id])).rows[0].id as string;
  }
  async function classify(request: Partial<NewTaxClassification> & { sourceId: string }): Promise<string> {
    const outcome = await classifications.createClassification(
      {
        mreRealmId: REALM_A,
        sourceType: 'TRANSACTION_SPLIT',
        taxCategory: 'MAINTENANCE',
        treatment: 'CAPITALIZED',
        reviewState: 'USER_CONFIRMED',
        supersedes: null,
        notes: null,
        sourceReferences: [],
        ...request,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
    return outcome.classification.id;
  }
  /** A Sonderumlage of the unit with one use of 9,000.00 on 2028-02-15. */
  async function sonderumlage(pr: string): Promise<string> {
    const wegs = new PostgresWegRepository(db());
    const weg = await wegs.createWeg(
      { mreRealmId: REALM_A, displayName: `WEG ${++counter}`, administratorPartyId: null, financialYearStartMonth: 1, notes: null },
      actor,
    );
    if (weg.kind !== 'CREATED') throw new Error(weg.kind);
    const m = await wegs.createMembership(
      {
        mreRealmId: REALM_A,
        wegId: weg.weg.id,
        propertyReferenceId: pr,
        mea: (parseMea('125/1000') as { mea: Mea }).mea,
        validFrom: day('2020-01-01'),
        validUntil: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (m.kind !== 'CREATED') throw new Error(m.kind);
    const assessments = new PostgresWegSpecialAssessmentRepository(db());
    const today = day('2028-03-01');
    const a = await assessments.createAssessment(
      {
        mreRealmId: REALM_A,
        membershipId: m.membership.id,
        description: 'Fassadensanierung (synthetisch)',
        resolutionDate: day('2028-01-10'),
        purpose: 'MAINTENANCE',
        totalAmount: null,
        unitShare: eur('9000.00'),
        instalments: [{ position: 1, dueDate: day('2028-02-01'), amount: eur('9000.00') }],
        sourceReferences: [],
        notes: null,
      },
      actor,
      today,
    );
    if (a.kind !== 'CREATED') throw new Error(a.kind);
    const uses = await assessments.replaceUses(
      a.assessment.id,
      REALM_A,
      [{ position: 1, date: day('2028-02-15'), description: 'Fassade', unitShare: eur('9000.00') }],
      actor,
      today,
    );
    if (uses.kind !== 'AMENDED') throw new Error(uses.kind);
    return a.assessment.id;
  }

  it('ACC8 from the purchase to the separate asset and the refund, at both levels', async () => {
    const { pr, a, b, w, building } = await acc8();
    const repair = await splitOf(pr, '35700.00', '2027-03-10');
    const use = await sonderumlage(pr);
    // The repair and the use DEDUCTIBLE: the check is above 15 %, and the suggestion moves nothing.
    const repairDeductible = await classify({ sourceId: repair, treatment: 'DEDUCTIBLE', netAmount: eur('30000.00') });
    const useDeductible = await classify({
      sourceType: 'WEG_ASSESSMENT_USE',
      sourceId: use,
      sourcePosition: 1,
      taxCategory: 'WEG_SPENDING',
      treatment: 'DEDUCTIBLE',
    });
    expect((await classifications.anschaffungsnaheCheck(w, REALM_A, day('2028-03-01')))?.status).toBe('ABOVE_THRESHOLD');
    const before = await schedule(building, '?from=2027&to=2028');
    expect(before.components.map((c) => c.kind)).toEqual(['ACQUISITION']);
    expect(before.years.map((y) => money(y.amount))).toEqual(['5088.00', '5088.00']);
    await reproduction.expectReproducible(building, 2028, REALM_A);

    // Both capitalised on the check (the user's classification, P8-D2 (2)).
    await classify({ sourceId: repair, netAmount: eur('30000.00'), anschaffungsnaheAcquisitionId: w, supersedes: repairDeductible });
    await classify({
      sourceType: 'WEG_ASSESSMENT_USE',
      sourceId: use,
      sourcePosition: 1,
      taxCategory: 'WEG_SPENDING',
      anschaffungsnaheAcquisitionId: w,
      supersedes: useDeductible,
    });
    const after = await schedule(building, '?from=2027&to=2028');
    expect(after.components.map((c) => c.componentId)).toEqual([`ACQUISITION:${w}`, `TRANSACTION_SPLIT:${repair}`, `WEG_ASSESSMENT_USE:${use}:1`]);
    expect(after.years.map((y) => [y.year, money(y.amount), ...[a, b].map((p) => money(y.owners?.find((o) => o.ownerPartyId === p)?.amount))])).toEqual([
      [2027, '5802.00', '3481.20', '2320.80'],
      [2028, '5982.00', '3589.20', '2392.80'],
    ]);
    for (const [owner, amounts] of [
      [a, ['3481.20', '3589.20']],
      [b, ['2320.80', '2392.80']],
    ] as const) {
      expect((await schedule(building, `?from=2027&to=2028&ownerPartyId=${owner}`)).years.map((y) => money(y.amount))).toEqual(amounts);
    }
    await reproduction.expectReproducible(building, 2028, REALM_A, [2027, 2028]);
    // Each item in `capitalized` of its year and in no Werbungskosten line: never twice.
    for (const [year, source] of [
      [2027, repair],
      [2028, use],
    ] as const) {
      const view = await json<{ capitalized: { items: { sourceId: string }[] }; werbungskosten: { lines: { items: { sourceId: string }[] }[] } }>(
        await call('GET', `/property-references/${pr}/tax-years/${year}`),
      );
      expect(view.capitalized.items.map((i) => i.sourceId)).toEqual([source]);
      expect(view.werbungskosten.lines.flatMap((l) => l.items.map((i) => i.sourceId))).not.toContain(source);
    }

    // The Einbauküche as a separate asset: its own schedule, and not in the building.
    const kitchenSplit = await splitOf(pr, '6000.00', '2027-04-28');
    await classify({ sourceId: kitchenSplit, taxCategory: 'OTHER_EXPENSE' });
    const kitchen = await json<{ assetId: string; items: unknown[]; rate: null }>(
      await call(
        'POST',
        '/depreciation-assets',
        {
          propertyReferenceId: pr,
          assetType: 'SEPARATE_ASSET',
          description: 'Einbauküche, Wohnung 3 (synthetisch)',
          usefulLifeYears: 10,
          usefulLifeBasis: 'BFH IX R 14/15: Einbauküche als einheitliches Wirtschaftsgut, 10 Jahre (verification-checklist B8)',
          acquiredOn: '2027-04-20',
          items: [{ sourceType: 'TRANSACTION_SPLIT', sourceId: kitchenSplit, sourcePosition: null }],
          sourceReferences: ['Lieferschein 2027-04-20 (synthetisch)'],
        },
        { 'idempotency-key': `kitchen-${++counter}` },
      ),
      201,
    );
    await json(await call('POST', `/depreciation-assets/${kitchen.assetId}/confirm`, { reviewState: 'CONFIRMED' }, { 'if-match': '"1"' }));
    const read = await json<{ rate: Json }>(await call('GET', `/depreciation-assets/${kitchen.assetId}?year=2027`));
    expect(read.rate).toMatchObject({ rule: { ruleCode: 'DE_AFA_MOVABLE_LINEAR', version: 1 }, rate: '1/10', ratePercent: '10.0000', reasons: [] });
    const own = await schedule(kitchen.assetId, '?from=2027&to=2028');
    expect(own.years.map((y) => [money(y.amount), ...[a, b].map((p) => money(y.owners?.find((o) => o.ownerPartyId === p)?.amount))])).toEqual([
      ['450.00', '270.00', '180.00'],
      ['600.00', '360.00', '240.00'],
    ]);
    const withKitchen = await schedule(building, '?from=2027&to=2028');
    expect(withKitchen.years.map((y) => money(y.amount))).toEqual(['5802.00', '5982.00']);
    expect(withKitchen.excludedItems).toEqual([{ componentId: `TRANSACTION_SPLIT:${kitchenSplit}`, separateAssetId: kitchen.assetId }]);
    await reproduction.expectReproducible(kitchen.assetId, 2028, REALM_A);

    // The extension of 2030 (240.00 a year) and a refund of 1,000.00 of it in 2031 (−20.00 a year).
    const extension = await splitOf(pr, '12000.00', '2030-09-15');
    await classify({ sourceId: extension });
    const refund = await splitOf(pr, '1000.00', '2031-04-04', 'INFLOW');
    await classify({ sourceId: refund });
    const later = await schedule(building, '?from=2030&to=2032');
    const of = (id: string) => later.components.find((c) => c.componentId === `TRANSACTION_SPLIT:${id}`)?.years.map((y) => [y.year, money(y.amount)]);
    expect(of(extension)).toEqual([
      [2030, '240.00'],
      [2031, '240.00'],
      [2032, '240.00'],
    ]);
    expect(of(refund)).toEqual([
      [2031, '-20.00'],
      [2032, '-20.00'],
    ]);
    expect(later.years.map((y) => money(y.amount))).toEqual(['6222.00', '6202.00', '6202.00']);
    await reproduction.expectReproducible(building, 2032, REALM_A);
    await reproduction.expectReproducible(kitchen.assetId, 2032, REALM_A);
  });

  it('GET /tax-rules lists DE_AFA_MOVABLE_LINEAR @1 ACTIVE; Realm isolation: another Realm’s split as an item is 404', async () => {
    const rules = await json<{ items: { ruleCode: string; versions: { version: number; status: string }[] }[] }>(await call('GET', '/tax-rules'));
    expect(rules.items.find((r) => r.ruleCode === 'DE_AFA_MOVABLE_LINEAR')?.versions.map((v) => [v.version, v.status])).toEqual([[1, 'ACTIVE']]);
    const { pr } = await acc8();
    const foreignPr = await propertyReference(REALM_B);
    const { rows } = await pool.query(`SELECT gen_random_uuid() AS id`);
    // A source of another Realm (or none) is not found, whatever its PropertyReference.
    for (const sourceId of [rows[0].id as string, foreignPr]) {
      const res = await call('POST', '/depreciation-assets', {
        propertyReferenceId: pr,
        assetType: 'SEPARATE_ASSET',
        description: 'Küche',
        usefulLifeYears: 10,
        usefulLifeBasis: 'B8',
        acquiredOn: '2027-04-20',
        items: [{ sourceType: 'TRANSACTION_SPLIT', sourceId, sourcePosition: null }],
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({
        sourceType: 'TRANSACTION_SPLIT',
        sourceId,
        sourcePosition: null,
      });
    }
    expect((await call('GET', `/property-references/${pr}/depreciation-assets`, undefined, {}, REALM_B)).status).toBe(404);
  });
});

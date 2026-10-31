import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  amendDepreciationAsset,
  confirmDepreciationAsset,
  createDepreciationAsset,
  getDepreciationAsset,
  getTaxRule,
  listPropertyDepreciationAssets,
  listTaxRules,
  voidDepreciationAsset,
} from './application/index.js';
import {
  PostgresAcquisitionRepository,
  PostgresDepreciationAssetRepository,
  PostgresPartyRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { Money, type BusinessDate } from './shared/index.js';
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-8-01 end to end (api-design.md §59), wired as in main.ts: a building asset created, amended, confirmed and voided
 * over HTTP; its `rate` of 2005, 2022, 2023 and 2026 (2005 without a rule, 2022 with `@1` since VC-8-02, §59A) and the
 * default year from an injected clock; the shorter useful life of an Acquisition through its review; the per-property
 * list; `GET /tax-rules` with the new rule; and Realm isolation on every route. Names, figures and texts are synthetic.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee000000000000a8';
const REALM_B = '64b0c0ffee000000000000b8';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;
const evidence = { source: 'Gutachten zur Restnutzungsdauer', date: '2026-06-15', documentReference: 'Gutachten Nr. 0000-SYN' };
let counter = 0;

/** The fields this file reads of an answer: an asset, a list, an error or a rule. */
type Answer = {
  readonly assetId: string;
  readonly rate: { readonly year: number; readonly reasons: string[]; readonly shorterUsefulLives: unknown[] } & Record<string, unknown>;
  readonly error: { readonly code: string; readonly details?: unknown };
  readonly items: { readonly assetId: string; readonly ruleCode: string; readonly status: string; readonly rate: { readonly year: number } }[];
  readonly versions: {
    readonly parameters: { readonly bands: { readonly band: string; readonly shorterUsefulLife: { readonly shorterThanYears: number } }[] };
  }[];
} & Record<string, unknown>;

/** The routes of §59 under `/api/v1`, as `METHOD /path/:param`. */
const VC_8_01 = /^[A-Z]+ \/depreciation-assets\b|^[A-Z]+ \/property-references\/:propertyReferenceId\/depreciation-assets$/;

function routesOf(app: Express): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle: { stack?: Layer[] } };
  const walk = (stack: readonly Layer[]): string[] =>
    stack.flatMap((layer) => {
      if (layer.route !== undefined) return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route?.path}`);
      return layer.name === 'router' && layer.handle.stack !== undefined ? walk(layer.handle.stack) : [];
    });
  return walk((app as unknown as { _router: { stack: Layer[] } })._router.stack);
}

describe.skipIf(databaseUrl === undefined)('the DepreciationAsset (VC-8-01) end to end', () => {
  const schema = testSchemaName('depreciation_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let app: Express;
  let server: Server;
  let base: string;
  let parties: PostgresPartyRepository;
  let acquisitions: PostgresAcquisitionRepository;
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
  /** The injected clock of the reads: 2026-12-31 23:30 UTC is already 2027 in Europe/Berlin. */
  const clock = { now: new Date('2026-12-31T23:30:00Z') };

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
    const repository = new PostgresDepreciationAssetRepository(db);
    const now = () => clock.now;
    app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        depreciationAssets: {
          create: createDepreciationAsset({ repository }),
          get: getDepreciationAsset({ repository, now }),
          listForPropertyReference: listPropertyDepreciationAssets({ repository, now }),
          amend: amendDepreciationAsset({ repository }),
          confirm: confirmDepreciationAsset({ repository }),
          void: voidDepreciationAsset({ repository }),
        },
        taxation: { listRules: listTaxRules({ now }), getRule: getTaxRule({ now }) },
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
  const headersOf = (realm: string) => ({ authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json' });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}, realm = REALM_A) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { ...headersOf(realm), ...extra }, body: JSON.stringify(body) });
  const get = (path: string, realm = REALM_A) => fetch(`${base}${path}`, { headers: headersOf(realm) });
  const json = async (res: Response) => (await res.json()) as Answer;

  async function propertyReference(realm = REALM_A): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5e80000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function party(realm = REALM_A): Promise<string> {
    const outcome = await parties.create(
      {
        mreRealmId: realm,
        partyType: 'PERSON',
        displayName: 'Steuerberatung S',
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
  async function acquisition(pr: string, realm = REALM_A): Promise<string> {
    const outcome = await acquisitions.create(
      {
        mreRealmId: realm,
        propertyReferenceId: pr,
        purchasePrice: eur('250000.00'),
        acquiredShare: { numerator: 1, denominator: 1 },
        contractDate: day('2026-03-01'),
        economicTransferDate: day('2026-05-01'),
        landRegistryTransferDate: null,
        buyerPartyIds: [await party(realm)],
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.acquisition.id;
  }

  it('the routes of §59 are wired: create, read, amend, confirm, void and the per-property list', () => {
    expect(routesOf(app).filter((r) => VC_8_01.test(r))).toEqual([
      'POST /depreciation-assets',
      'GET /depreciation-assets/:assetId',
      'GET /property-references/:propertyReferenceId/depreciation-assets',
      'POST /depreciation-assets/:assetId/amend',
      'POST /depreciation-assets/:assetId/confirm',
      'POST /depreciation-assets/:assetId/void',
      // VC-8-02 (§59A): the schedule, on the same router.
      'GET /depreciation-assets/:assetId/schedule',
    ]);
  });

  it('GET /tax-rules lists DE_AFA_BUILDING_LINEAR @1 SUPERSEDED and @2 ACTIVE (§59A); GET /tax-rules/DE_AFA_BUILDING_LINEAR answers both with their bands', async () => {
    const list = (await (await get('/tax-rules')).json()) as { items: { ruleCode: string; versions: { version: number; status: string }[] }[] };
    expect(list.items.find((r) => r.ruleCode === 'DE_AFA_BUILDING_LINEAR')?.versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'ACTIVE'],
    ]);
    const [earlier, version] = (await json(await get('/tax-rules/DE_AFA_BUILDING_LINEAR'))).versions;
    expect(earlier).toMatchObject({ version: 1, effectiveFrom: '2006-01-01', effectiveTo: '2023-01-01', status: 'SUPERSEDED' });
    expect(earlier?.parameters.bands.map((b) => [b.band, b.shorterUsefulLife.shorterThanYears])).toEqual([
      ['A', 50],
      ['B', 40],
    ]);
    expect(version).toMatchObject({ version: 2, effectiveFrom: '2023-01-01', effectiveTo: null, status: 'ACTIVE' });
    expect(version?.parameters.bands.map((b) => [b.band, b.shorterUsefulLife.shorterThanYears])).toEqual([
      ['A', 33],
      ['B', 50],
      ['C', 40],
    ]);
  });

  it('a building through its life: create (201, ETag, Location, rate null), read with the rate of each year, confirm, amend, void, and a new one', async () => {
    const pr = await propertyReference();
    const acq = await acquisition(pr);
    const created = await post(
      '/depreciation-assets',
      {
        propertyReferenceId: pr,
        buildingCompletionYear: 1995,
        sourceReferences: ['Teilungserklärung, Baujahr laut Anlage 1'],
        shorterUsefulLives: [{ acquisitionId: acq, usefulLifeYears: 30, evidence, reviewState: 'NEEDS_REVIEW' }],
      },
      { 'idempotency-key': `e2e-${++counter}` },
    );
    expect(created.status).toBe(201);
    const asset = await json(created);
    expect(created.headers.get('etag')).toBe('"1"');
    expect(created.headers.get('location')).toBe(`/api/v1/depreciation-assets/${asset['assetId']}`);
    expect(asset).toMatchObject({ status: 'ACTIVE', reviewState: 'UNREVIEWED', version: 1, rate: null });
    const id = asset['assetId'];

    // Unconfirmed: the band is shown, not usable. 2005 has no rule (2022 until VC-8-02, §59A). The default year is the clock's, in Berlin.
    expect((await json(await get(`/depreciation-assets/${id}?year=2026`)))['rate']).toEqual({
      year: 2026,
      rule: { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 },
      band: 'B',
      ratePercent: '2',
      rate: '1/50',
      legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG',
      shorterThanYears: 50,
      reasons: ['ASSET_NOT_CONFIRMED'],
      shorterUsefulLives: [{ acquisitionId: acq, rate: '1/30', ratePercent: '3.3333', applies: false, reasons: ['USEFUL_LIFE_NOT_CONFIRMED'] }],
    });
    expect((await json(await get(`/depreciation-assets/${id}?year=2022`)))['rate']).toMatchObject({
      rule: { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 1 },
      band: 'A',
      ratePercent: '2',
      reasons: ['ASSET_NOT_CONFIRMED'],
    });
    expect((await json(await get(`/depreciation-assets/${id}?year=2005`)))['rate']).toMatchObject({
      rule: null,
      band: null,
      ratePercent: null,
      reasons: ['NO_APPLICABLE_RULE', 'ASSET_NOT_CONFIRMED'],
    });
    const defaulted = await get(`/depreciation-assets/${id}`);
    expect(defaulted.headers.get('etag')).toBe('"1"');
    expect((await json(defaulted))['rate'].year).toBe(2027);

    // Confirm the year; the entry still waits for its own review.
    const confirmed = await post(`/depreciation-assets/${id}/confirm`, { reviewState: 'CONFIRMED', note: 'Baujahr abgeglichen' }, { 'if-match': '"1"' });
    expect(confirmed.status).toBe(200);
    expect(await json(confirmed)).toMatchObject({ reviewState: 'CONFIRMED', version: 2, rate: null });
    expect((await json(await get(`/depreciation-assets/${id}?year=2023`)))['rate']).toMatchObject({
      band: 'B',
      reasons: [],
      shorterUsefulLives: [{ applies: false }],
    });
    // The entry confirmed by amend: the shorter life applies.
    const entryConfirmed = await post(
      `/depreciation-assets/${id}/amend`,
      { shorterUsefulLives: [{ acquisitionId: acq, usefulLifeYears: 30, evidence, reviewState: 'CONFIRMED' }] },
      { 'if-match': '"2"' },
    );
    expect(await json(entryConfirmed)).toMatchObject({ reviewState: 'CONFIRMED', version: 3, shorterUsefulLives: [{ reviewState: 'CONFIRMED' }] });
    expect((await json(await get(`/depreciation-assets/${id}?year=2026`)))['rate'].shorterUsefulLives).toEqual([
      { acquisitionId: acq, rate: '1/30', ratePercent: '3.3333', applies: true, reasons: [] },
    ]);
    // A changed fact is never carried under the old confirmation: the year resets the asset.
    const amended = await post(
      `/depreciation-assets/${id}/amend`,
      { buildingCompletionYear: 2023, sourceReferences: ['Grundbuchauszug'] },
      { 'if-match': '"3"' },
    );
    expect(await json(amended)).toMatchObject({ buildingCompletionYear: 2023, reviewState: 'UNREVIEWED', version: 4 });
    expect((await json(await get(`/depreciation-assets/${id}?year=2026`)))['rate']).toMatchObject({
      band: 'A',
      ratePercent: '3',
      shorterThanYears: 33,
      reasons: ['ASSET_NOT_CONFIRMED'],
      shorterUsefulLives: [{ applies: false, reasons: [] }],
    });
    // The no-op whatever If-Match says; a stale If-Match on a change is 412.
    expect((await post(`/depreciation-assets/${id}/amend`, { buildingCompletionYear: 2023 }, { 'if-match': '"1"' })).status).toBe(200);
    expect((await post(`/depreciation-assets/${id}/amend`, { notes: 'neu' }, { 'if-match': '"1"' })).status).toBe(412);
    // Two buildings for one unit are refused at the API.
    const second = await post('/depreciation-assets', { propertyReferenceId: pr });
    expect(second.status).toBe(409);
    expect((await json(second))['error'].details).toEqual({ reason: 'BUILDING_ASSET_EXISTS', assetId: id });
    // Void, the no-op keeping the first reason, then a new building.
    const voided = await post(`/depreciation-assets/${id}/void`, { reason: 'falsche Einheit' }, { 'if-match': '"4"' });
    expect(await json(voided)).toMatchObject({ status: 'VOID', voidReason: 'falsche Einheit', version: 5 });
    expect(await json(await post(`/depreciation-assets/${id}/void`, { reason: 'anderer Grund' }, { 'if-match': '"1"' }))).toMatchObject({
      voidReason: 'falsche Einheit',
      version: 5,
    });
    expect((await json(await get(`/depreciation-assets/${id}?year=2026`)))['rate'].reasons).toEqual(['ASSET_VOID', 'ASSET_NOT_CONFIRMED']);
    expect((await json(await post(`/depreciation-assets/${id}/amend`, { notes: 'x' })))['error'].details).toEqual({
      reason: 'ASSET_NOT_ACTIVE',
      assetId: id,
      status: 'VOID',
    });
    const renewed = await post('/depreciation-assets', { propertyReferenceId: pr, buildingCompletionYear: null });
    expect(renewed.status).toBe(201);
    const fresh = await json(renewed);
    expect((await json(await post(`/depreciation-assets/${fresh['assetId']}/confirm`, { reviewState: 'CONFIRMED' })))['error'].details).toEqual({
      reason: 'COMPLETION_YEAR_MISSING',
      assetId: fresh['assetId'],
    });
    // A completion year is never guessed: none recorded is COMPLETION_YEAR_MISSING with band null.
    expect((await json(await get(`/depreciation-assets/${fresh['assetId']}?year=2026`)))['rate']).toMatchObject({
      band: null,
      reasons: ['COMPLETION_YEAR_MISSING', 'ASSET_NOT_CONFIRMED'],
    });

    // The list: both, VOID included unless filtered, in creation order, each with its rate of the year.
    const all = await json(await get(`/property-references/${pr}/depreciation-assets?year=2026`));
    expect((all['items'] as { assetId: string; status: string; rate: { year: number } }[]).map((i) => [i.assetId, i.status, i.rate.year])).toEqual([
      [id, 'VOID', 2026],
      [fresh['assetId'], 'ACTIVE', 2026],
    ]);
    const active = await json(await get(`/property-references/${pr}/depreciation-assets?status=ACTIVE`));
    expect((active['items'] as { assetId: string; rate: { year: number } }[]).map((i) => [i.assetId, i.rate.year])).toEqual([[fresh['assetId'], 2027]]);
  });

  it('the order of checks on create over HTTP: 404 PropertyReference, 404 Party, 404/422/409 Acquisition', async () => {
    const pr = await propertyReference();
    const other = await propertyReference();
    const elsewhere = await acquisition(other);
    const cancelled = await acquisition(pr);
    expect((await acquisitions.cancel(cancelled, REALM_A, 'Rücktritt', new Date('2026-10-30T10:00:00Z'), actor)).kind).toBe('CANCELLED');
    const unknown = '0000aaaa-0000-4000-8000-0000000000ee';
    const errorOf = async (body: unknown) => {
      const res = await post('/depreciation-assets', body);
      return [res.status, (await json(res))['error']] as const;
    };
    expect(await errorOf({ propertyReferenceId: unknown })).toEqual([
      404,
      expect.objectContaining({ code: 'NOT_FOUND', details: { propertyReferenceId: unknown } }),
    ]);
    expect(await errorOf({ propertyReferenceId: pr, buildingCompletionYear: 1995, reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: unknown })).toEqual([
      404,
      expect.objectContaining({ details: { partyId: unknown } }),
    ]);
    const entryOf = (acquisitionId: string) => ({ propertyReferenceId: pr, shorterUsefulLives: [{ acquisitionId, usefulLifeYears: 30, evidence }] });
    expect(await errorOf(entryOf(unknown))).toEqual([404, expect.objectContaining({ details: { acquisitionId: unknown } })]);
    expect(await errorOf(entryOf(elsewhere))).toEqual([
      422,
      expect.objectContaining({ code: 'ACQUISITION_NOT_OF_PROPERTY', details: { acquisitionId: elsewhere, propertyReferenceId: other } }),
    ]);
    expect(await errorOf(entryOf(cancelled))).toEqual([
      409,
      expect.objectContaining({ code: 'CONFLICT', details: { reason: 'ACQUISITION_CANCELLED', acquisitionId: cancelled } }),
    ]);
    // A basis or a rate is not input.
    expect((await post('/depreciation-assets', { propertyReferenceId: pr, depreciationRate: '0.02' })).status).toBe(400);
    expect((await post('/depreciation-assets', { propertyReferenceId: pr, basisAmount: { amount: '100000.00', currency: 'EUR' } })).status).toBe(400);
  });

  it("Realm isolation: every route with another Realm's asset, PropertyReference, Party or Acquisition is 404; the list shows no foreign asset", async () => {
    const prB = await propertyReference(REALM_B);
    const acqB = await acquisition(prB, REALM_B);
    const partyB = await party(REALM_B);
    const assetB = (await json(await post('/depreciation-assets', { propertyReferenceId: prB, buildingCompletionYear: 1990 }, {}, REALM_B)))['assetId'];
    const prA = await propertyReference();
    const status = async (res: Promise<Response>) => (await res).status;
    expect(await status(get(`/depreciation-assets/${assetB}`))).toBe(404);
    expect(await status(post(`/depreciation-assets/${assetB}/amend`, { notes: 'x' }))).toBe(404);
    expect(await status(post(`/depreciation-assets/${assetB}/confirm`, { reviewState: 'CONFIRMED' }))).toBe(404);
    expect(await status(post(`/depreciation-assets/${assetB}/void`, { reason: 'x' }))).toBe(404);
    expect(await status(get(`/property-references/${prB}/depreciation-assets`))).toBe(404);
    expect(await status(post('/depreciation-assets', { propertyReferenceId: prB }))).toBe(404);
    expect(
      await status(
        post('/depreciation-assets', { propertyReferenceId: prA, buildingCompletionYear: 1990, reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: partyB }),
      ),
    ).toBe(404);
    expect(
      await status(post('/depreciation-assets', { propertyReferenceId: prA, shorterUsefulLives: [{ acquisitionId: acqB, usefulLifeYears: 30, evidence }] })),
    ).toBe(404);
    const assetA = (await json(await post('/depreciation-assets', { propertyReferenceId: prA, buildingCompletionYear: 1990 })))['assetId'];
    expect(await status(post(`/depreciation-assets/${assetA}/confirm`, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: partyB }))).toBe(404);
    expect(await status(post(`/depreciation-assets/${assetA}/amend`, { shorterUsefulLives: [{ acquisitionId: acqB, usefulLifeYears: 30, evidence }] }))).toBe(
      404,
    );
    expect((await json(await get(`/property-references/${prA}/depreciation-assets`)))['items'].map((i: { assetId: string }) => i.assetId)).toEqual([assetA]);
    // Realm B sees its own asset.
    expect(await status(get(`/depreciation-assets/${assetB}`, REALM_B))).toBe(200);
  });
});

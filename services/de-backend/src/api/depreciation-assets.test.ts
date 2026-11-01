import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcquisitionCancelledError,
  AcquisitionNotFoundError,
  AcquisitionNotOfPropertyError,
  AssetAdvisorConfirmedError,
  BuildingAssetExistsError,
  CompletionYearMissingError,
  DepreciationAssetNotActiveError,
  DepreciationAssetNotFoundError,
  IdempotencyKeyConflictError,
  PartyNotFoundError,
  PropertyReferenceNotFoundError,
  VersionConflictError,
  type AssetRate,
  type CreateDepreciationAssetInput,
  type DepreciationAsset,
  type PrincipalVerifier,
  type PurchaseMethodStatus,
} from '../application/index.js';
import type { BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/**
 * VC-8-01 HTTP contract of the DepreciationAsset (api-design.md §59): every 400 with its field code, the error mapping
 * of each row of §59's table, the DTO with `ETag` and `Location`, `rate: null` on command responses. Synthetic data.
 */
const REALM = '64b0c0ffee000000000000e7';
const ASSET = '6f1c2a9e-0000-4000-8000-000000000010';
const PR = '6f1c2a9e-0000-4000-8000-000000000001';
const ACQ = '6f1c2a9e-0000-4000-8000-000000000002';
const ADVISOR = '6f1c2a9e-0000-4000-8000-000000000003';

const asset: DepreciationAsset = {
  id: ASSET as DepreciationAsset['id'],
  mreRealmId: REALM,
  propertyReferenceId: PR,
  assetType: 'BUILDING',
  status: 'ACTIVE',
  buildingCompletionYear: 1995,
  description: null,
  usefulLifeYears: null,
  usefulLifeBasis: null,
  acquiredOn: null,
  items: [],
  sourceReferences: ['Teilungserklärung, Baujahr laut Anlage 1'],
  depreciationMethod: 'LINEAR_7_4',
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  shorterUsefulLives: [
    {
      acquisitionId: ACQ,
      usefulLifeYears: 30,
      evidence: { source: 'Gutachten zur Restnutzungsdauer', date: '2026-06-15' as BusinessDate, documentReference: 'Gutachten Nr. 0000-SYN' },
      reviewState: 'NEEDS_REVIEW',
      advisorPartyId: null,
    },
  ],
  purchaseMethods: [
    {
      acquisitionId: ACQ,
      consideration: 'PAID',
      method: 'DEGRESSIVE_7_5',
      specialDepreciation: [],
      subsidiesReceived: false,
      newBuildingByConversion: false,
      otherSpecialCase: false,
      otherSpecialCaseNote: null,
      evidence: { source: 'Anlage V 2025 (synthetisch)', date: '2026-06-15' as BusinessDate, documentReference: null },
      reviewState: 'CONFIRMED',
      advisorPartyId: null,
      notes: null,
    },
  ],
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2026-10-30T09:00:00.000Z'),
  version: 3,
};
const rate: AssetRate = {
  year: 2026,
  rule: { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 },
  band: 'B',
  ratePercent: '2',
  rate: '1/50',
  legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG',
  shorterThanYears: 50,
  reasons: [],
  shorterUsefulLives: [{ acquisitionId: ACQ, rate: '1/30', ratePercent: '3.3333', applies: false, reasons: ['USEFUL_LIFE_NOT_CONFIRMED'] }],
};
/** §59's response example. */
const dto = {
  assetId: ASSET,
  mreRealmId: REALM,
  propertyReferenceId: PR,
  assetType: 'BUILDING',
  status: 'ACTIVE',
  buildingCompletionYear: 1995,
  // §59B: a separate asset's fields, null on a building.
  description: null,
  usefulLifeYears: null,
  usefulLifeBasis: null,
  acquiredOn: null,
  items: null,
  sourceReferences: ['Teilungserklärung, Baujahr laut Anlage 1'],
  depreciationMethod: 'LINEAR_7_4',
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  shorterUsefulLives: [
    {
      acquisitionId: ACQ,
      usefulLifeYears: 30,
      evidence: { source: 'Gutachten zur Restnutzungsdauer', date: '2026-06-15', documentReference: 'Gutachten Nr. 0000-SYN' },
      reviewState: 'NEEDS_REVIEW',
      advisorPartyId: null,
    },
  ],
  // §59C: the entry with its derived status and causes.
  purchaseMethods: [
    {
      acquisitionId: ACQ,
      consideration: 'PAID',
      method: 'DEGRESSIVE_7_5',
      specialDepreciation: [],
      subsidiesReceived: false,
      newBuildingByConversion: false,
      otherSpecialCase: false,
      otherSpecialCaseNote: null,
      evidence: { source: 'Anlage V 2025 (synthetisch)', date: '2026-06-15', documentReference: null },
      reviewState: 'CONFIRMED',
      advisorPartyId: null,
      notes: null,
      methodStatus: 'NOT_SUPPORTED',
      causes: ['METHOD_DEGRESSIVE_7_5'],
    },
  ],
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: '2026-10-30T09:00:00.000Z',
  version: 3,
  rate: {
    year: 2026,
    rule: { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 },
    band: 'B',
    ratePercent: '2',
    rate: '1/50',
    legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG',
    shorterThanYears: 50,
    reasons: [],
    shorterUsefulLives: [{ acquisitionId: ACQ, rate: '1/30', ratePercent: '3.3333', applies: false, reasons: ['USEFUL_LIFE_NOT_CONFIRMED'] }],
  },
};

/** §59C: the status the application derives for the entry. */
const methods: PurchaseMethodStatus[] = [{ acquisitionId: ACQ, methodStatus: 'NOT_SUPPORTED', causes: ['METHOD_DEGRESSIVE_7_5'] }];

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });
let server: Server | undefined;

async function start(commands: CommandOverrides): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith(commands) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const headers = { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json' };
const post = (base: string, path: string, payload: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(payload) });
const get = (base: string, path: string) => fetch(`${base}/api/v1${path}`, { headers });
const fields = async (res: Response) => {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: { details: { fields: { field: string; code: string }[] } } }).error.details.fields;
};
const evidence = { source: 'Gutachten zur Restnutzungsdauer', date: '2026-06-15' };
const entry = (overrides: Record<string, unknown> = {}) => ({ acquisitionId: ACQ, usefulLifeYears: 30, evidence, ...overrides });

describe('POST /depreciation-assets (§59)', () => {
  it('201 with the DTO (rate null), ETag and Location; the defaults; the key passed; a replay marked', async () => {
    const seen: CreateDepreciationAssetInput[] = [];
    const base = await start({
      depreciationAssets: {
        create: async (input) => {
          seen.push(input);
          return { asset, replayed: input.idempotencyKey === 'again', methods };
        },
      },
    });
    const res = await post(base, '/depreciation-assets', { propertyReferenceId: PR.toUpperCase() }, { 'idempotency-key': 'k1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"3"');
    expect(res.headers.get('location')).toBe(`/api/v1/depreciation-assets/${ASSET}`);
    expect(await res.json()).toEqual({ ...dto, rate: null });
    expect(seen[0]).toMatchObject({
      propertyReferenceId: PR,
      assetType: 'BUILDING',
      buildingCompletionYear: null,
      sourceReferences: [],
      depreciationMethod: 'LINEAR_7_4',
      reviewState: 'UNREVIEWED',
      advisorPartyId: null,
      shorterUsefulLives: [],
      purchaseMethods: [],
      notes: null,
      idempotencyKey: 'k1',
      principal: { mreRealmId: REALM },
    });
    await post(base, '/depreciation-assets', {
      propertyReferenceId: PR,
      buildingCompletionYear: 1995,
      sourceReferences: ['  Teilungserklärung  ', ''],
      reviewState: 'ADVISOR_CONFIRMED',
      advisorPartyId: ADVISOR,
      shorterUsefulLives: [entry({ evidence: { ...evidence, documentReference: '  ' } })],
      notes: '   ',
    });
    expect(seen[1]).toMatchObject({
      sourceReferences: ['Teilungserklärung'],
      reviewState: 'ADVISOR_CONFIRMED',
      advisorPartyId: ADVISOR,
      shorterUsefulLives: [
        { acquisitionId: ACQ, usefulLifeYears: 30, evidence: { ...evidence, documentReference: null }, reviewState: 'UNREVIEWED', advisorPartyId: null },
      ],
      notes: null,
    });
    const replayed = await post(base, '/depreciation-assets', { propertyReferenceId: PR }, { 'idempotency-key': 'again' });
    expect(replayed.headers.get('idempotent-replayed')).toBe('true');
  });

  it('every 400 with its field code', async () => {
    const base = await start({});
    const send = (payload: unknown) => post(base, '/depreciation-assets', payload);
    const body = (extra: Record<string, unknown>) => send({ propertyReferenceId: PR, ...extra });
    expect(await fields(await send({}))).toEqual([{ field: 'propertyReferenceId', code: 'REQUIRED' }]);
    expect(await fields(await send({ propertyReferenceId: 'x' }))).toEqual([{ field: 'propertyReferenceId', code: 'INVALID_FORMAT' }]);
    // VC-8-03 lifted §59's NOT_SUPPORTED (§59B): a separate asset needs its four facts.
    expect(await fields(await body({ assetType: 'SEPARATE_ASSET' }))).toEqual([
      { field: 'description', code: 'REQUIRED' },
      { field: 'usefulLifeYears', code: 'REQUIRED' },
      { field: 'usefulLifeBasis', code: 'REQUIRED' },
      { field: 'acquiredOn', code: 'REQUIRED' },
    ]);
    expect(await fields(await body({ assetType: 'LAND' }))).toEqual([{ field: 'assetType', code: 'INVALID_FORMAT' }]);
    expect(await fields(await body({ buildingCompletionYear: 999 }))).toEqual([{ field: 'buildingCompletionYear', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await body({ buildingCompletionYear: 2101 }))).toEqual([{ field: 'buildingCompletionYear', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await body({ buildingCompletionYear: 1995.5 }))).toEqual([{ field: 'buildingCompletionYear', code: 'INVALID_FORMAT' }]);
    expect(await fields(await body({ buildingCompletionYear: '1995' }))).toEqual([{ field: 'buildingCompletionYear', code: 'INVALID_FORMAT' }]);
    expect(await fields(await body({ depreciationMethod: 'DEGRESSIVE_7_5A' }))).toEqual([{ field: 'depreciationMethod', code: 'INVALID_FORMAT' }]);
    expect(await fields(await body({ reviewState: 'SUGGESTED' }))).toEqual([{ field: 'reviewState', code: 'NOT_ALLOWED' }]);
    expect(await fields(await body({ reviewState: 'MAYBE' }))).toEqual([{ field: 'reviewState', code: 'INVALID_FORMAT' }]);
    expect(await fields(await body({ reviewState: 'CONFIRMED' }))).toEqual([{ field: 'reviewState', code: 'COMPLETION_YEAR_REQUIRED' }]);
    expect(await fields(await body({ reviewState: 'ADVISOR_CONFIRMED', buildingCompletionYear: null }))).toEqual([
      { field: 'reviewState', code: 'COMPLETION_YEAR_REQUIRED' },
    ]);
    expect(await fields(await body({ advisorPartyId: ADVISOR, reviewState: 'CONFIRMED', buildingCompletionYear: 1995 }))).toEqual([
      { field: 'advisorPartyId', code: 'NOT_ALLOWED' },
    ]);
    expect(await fields(await body({ documentIds: [ADVISOR] }))).toEqual([{ field: 'documentIds', code: 'NOT_SUPPORTED' }]);
    expect(await fields(await body({ notes: 'x'.repeat(2001) }))).toEqual([{ field: 'notes', code: 'INVALID_FORMAT' }]);
    expect(await fields(await body({ sourceReferences: ['x'.repeat(501)] }))).toEqual([{ field: 'sourceReferences.0', code: 'INVALID_FORMAT' }]);
    expect(await fields(await body({ sourceReferences: Array.from({ length: 21 }, (_, i) => `Quelle ${i}`) }))).toEqual([
      { field: 'sourceReferences', code: 'INVALID_FORMAT' },
    ]);
    // The entries.
    const lives = (shorterUsefulLives: unknown) => body({ shorterUsefulLives });
    expect(await fields(await lives([entry({ usefulLifeYears: 0 })]))).toEqual([{ field: 'shorterUsefulLives.0.usefulLifeYears', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await lives([entry({ usefulLifeYears: 100 })]))).toEqual([{ field: 'shorterUsefulLives.0.usefulLifeYears', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await lives([entry({ usefulLifeYears: 30.5 })]))).toEqual([{ field: 'shorterUsefulLives.0.usefulLifeYears', code: 'INVALID_FORMAT' }]);
    expect(await fields(await lives([entry({ evidence: { date: '2026-06-15' } })]))).toEqual([
      { field: 'shorterUsefulLives.0.evidence.source', code: 'REQUIRED' },
    ]);
    expect(await fields(await lives([entry({ evidence: { ...evidence, date: '2026-02-30' } })]))).toEqual([
      { field: 'shorterUsefulLives.0.evidence.date', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await lives([entry({ evidence: { ...evidence, documentId: ADVISOR } })]))).toEqual([
      { field: 'shorterUsefulLives.0.evidence.documentId', code: 'NOT_SUPPORTED' },
    ]);
    expect(await fields(await lives([entry({ reviewState: 'SUGGESTED' })]))).toEqual([{ field: 'shorterUsefulLives.0.reviewState', code: 'NOT_ALLOWED' }]);
    expect(await fields(await lives([entry({ advisorPartyId: ADVISOR, reviewState: 'CONFIRMED' })]))).toEqual([
      { field: 'shorterUsefulLives.0.advisorPartyId', code: 'NOT_ALLOWED' },
    ]);
    expect(await fields(await lives([entry(), entry({ acquisitionId: ACQ.toUpperCase() })]))).toEqual([
      { field: 'shorterUsefulLives.1.acquisitionId', code: 'DUPLICATE' },
    ]);
    const many = Array.from({ length: 21 }, (_, i) => entry({ acquisitionId: `6f1c2a9e-0000-4000-8000-0000000001${String(i).padStart(2, '0')}` }));
    expect(await fields(await lives(many))).toEqual([{ field: 'shorterUsefulLives', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await lives([{ ...entry(), extra: 1 }]))).toEqual([{ field: 'shorterUsefulLives.0', code: 'INVALID_FORMAT' }]);
  });

  it('not input: a basis, a rate, a start and the other former fields are unknown keys (400), and so is jurisdiction', async () => {
    const base = await start({});
    for (const key of [
      'basisAmount',
      'startDate',
      'depreciationRate',
      'landBuildingAllocationId',
      'acquisitionId',
      'taxRuleVersionId',
      'usefulLife',
      'ownershipBasis',
      'jurisdiction',
    ]) {
      const res = await post(base, '/depreciation-assets', {
        propertyReferenceId: PR,
        [key]: key === 'basisAmount' ? { amount: '1.00', currency: 'EUR' } : 'x',
      });
      expect(res.status, key).toBe(400);
    }
    expect((await post(base, '/depreciation-assets', 'not json', {})).status).toBe(400);
    expect(await fields(await post(base, '/depreciation-assets', { propertyReferenceId: PR }, { 'idempotency-key': ' ' }))).toEqual([
      { field: 'Idempotency-Key', code: 'INVALID_FORMAT' },
    ]);
  });
});

describe('amend, confirm, void (§59)', () => {
  it('amend: the fields passed as named, null clears, the whole list; 200 with rate null and the new ETag', async () => {
    const seen: unknown[] = [];
    const base = await start({
      depreciationAssets: {
        amend: async (input) => {
          seen.push(input);
          return { asset, changed: true, methods };
        },
      },
    });
    const res = await post(
      base,
      `/depreciation-assets/${ASSET}/amend`,
      { buildingCompletionYear: 1994, sourceReferences: null, notes: null, shorterUsefulLives: [entry()] },
      { 'if-match': '"2"' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"3"');
    expect(await res.json()).toEqual({ ...dto, rate: null });
    expect(seen[0]).toEqual({
      principal: expect.anything(),
      assetId: ASSET,
      buildingCompletionYear: 1994,
      sourceReferences: [],
      notes: null,
      shorterUsefulLives: [{ acquisitionId: ACQ, usefulLifeYears: 30, evidence: { ...evidence, documentReference: null } }],
      expectedVersions: [2],
    });
    await post(base, `/depreciation-assets/${ASSET}/amend`, { reviewState: 'NEEDS_REVIEW', shorterUsefulLives: null });
    expect(seen[1]).toEqual({ principal: expect.anything(), assetId: ASSET, reviewState: 'NEEDS_REVIEW', shorterUsefulLives: [] });
  });

  it('amend: every 400 (empty, NOT_AMENDABLE, the raising states NOT_ALLOWED, unknown keys, a malformed id or If-Match)', async () => {
    const base = await start({});
    const amend = (payload: unknown, extra: Record<string, string> = {}) => post(base, `/depreciation-assets/${ASSET}/amend`, payload, extra);
    expect(await fields(await amend({}))).toEqual([{ field: '(body)', code: 'REQUIRED' }]);
    for (const field of ['propertyReferenceId', 'assetType', 'depreciationMethod']) {
      expect(await fields(await amend({ [field]: 'x' }))).toEqual([{ field, code: 'NOT_AMENDABLE' }]);
    }
    for (const reviewState of ['CONFIRMED', 'ADVISOR_CONFIRMED', 'SUGGESTED'])
      expect(await fields(await amend({ reviewState }))).toEqual([{ field: 'reviewState', code: 'NOT_ALLOWED' }]);
    expect(await fields(await amend({ notes: 'x', advisorPartyId: ADVISOR }))).toEqual([{ field: '(body)', code: 'INVALID_FORMAT' }]);
    expect(await fields(await amend({ buildingCompletionYear: 3000 }))).toEqual([{ field: 'buildingCompletionYear', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await amend({ shorterUsefulLives: [entry(), entry()] }))).toEqual([{ field: 'shorterUsefulLives.1.acquisitionId', code: 'DUPLICATE' }]);
    expect(await fields(await amend({ notes: 'x' }, { 'if-match': 'nope' }))).toEqual([{ field: 'If-Match', code: 'INVALID_FORMAT' }]);
    expect(await fields(await post(base, '/depreciation-assets/x/amend', { notes: 'x' }))).toEqual([{ field: 'assetId', code: 'INVALID_FORMAT' }]);
  });

  it('confirm: the request as named; 400 for a missing or lowering state, an advisor without ADVISOR_CONFIRMED, a long note', async () => {
    const seen: unknown[] = [];
    const base = await start({
      depreciationAssets: {
        confirm: async (input) => {
          seen.push(input);
          return { asset, changed: true, methods };
        },
      },
    });
    const confirm = (payload: unknown) => post(base, `/depreciation-assets/${ASSET}/confirm`, payload, { 'if-match': '"3"' });
    const res = await confirm({ reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: ADVISOR, note: 'Baujahr mit Teilungserklärung abgeglichen' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rate: unknown }).rate).toBeNull();
    expect(seen[0]).toEqual({
      principal: expect.anything(),
      assetId: ASSET,
      reviewState: 'ADVISOR_CONFIRMED',
      advisorPartyId: ADVISOR,
      note: 'Baujahr mit Teilungserklärung abgeglichen',
      expectedVersions: [3],
    });
    await confirm({ reviewState: 'CONFIRMED' });
    expect(seen[1]).toMatchObject({ reviewState: 'CONFIRMED', advisorPartyId: null, note: null });
    expect(await fields(await confirm({}))).toEqual([{ field: 'reviewState', code: 'REQUIRED' }]);
    expect(await fields(await confirm({ reviewState: 'NEEDS_REVIEW' }))).toEqual([{ field: 'reviewState', code: 'NOT_ALLOWED' }]);
    expect(await fields(await confirm({ reviewState: 'CONFIRMED', advisorPartyId: ADVISOR }))).toEqual([{ field: 'advisorPartyId', code: 'NOT_ALLOWED' }]);
    expect(await fields(await confirm({ reviewState: 'CONFIRMED', note: 'x'.repeat(501) }))).toEqual([{ field: 'note', code: 'INVALID_FORMAT' }]);
  });

  it('void: the reason trimmed and required (1–500)', async () => {
    const seen: unknown[] = [];
    const base = await start({
      depreciationAssets: {
        void: async (input) => {
          seen.push(input);
          return {
            asset: { ...asset, status: 'VOID', voidedAt: new Date('2026-10-30T12:00:00Z'), voidReason: 'falsche Einheit', version: 4 },
            changed: true,
            methods,
          };
        },
      },
    });
    const res = await post(base, `/depreciation-assets/${ASSET}/void`, { reason: '  falsche Einheit ' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"4"');
    expect(await res.json()).toMatchObject({ status: 'VOID', voidedAt: '2026-10-30T12:00:00.000Z', voidReason: 'falsche Einheit', rate: null });
    expect(seen[0]).toEqual({ principal: expect.anything(), assetId: ASSET, reason: 'falsche Einheit' });
    expect(await fields(await post(base, `/depreciation-assets/${ASSET}/void`, { reason: ' ' }))).toEqual([{ field: 'reason', code: 'INVALID_FORMAT' }]);
    expect(await fields(await post(base, `/depreciation-assets/${ASSET}/void`, {}))).toEqual([{ field: 'reason', code: 'REQUIRED' }]);
  });
});

describe('reads (§59)', () => {
  it('GET one: the DTO with its rate and ETag; ?year passed; unknown parameters and a bad year 400', async () => {
    const seen: unknown[] = [];
    const base = await start({
      depreciationAssets: {
        get: async (input) => {
          seen.push(input);
          return { asset, rate, methods };
        },
      },
    });
    const res = await get(base, `/depreciation-assets/${ASSET}?year=2026`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"3"');
    expect(await res.json()).toEqual(dto);
    expect(seen[0]).toEqual({ principal: expect.anything(), assetId: ASSET, year: 2026 });
    await get(base, `/depreciation-assets/${ASSET}`);
    expect(seen[1]).toEqual({ principal: expect.anything(), assetId: ASSET });
    expect(await fields(await get(base, `/depreciation-assets/${ASSET}?year=1999`))).toEqual([{ field: 'year', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await get(base, `/depreciation-assets/${ASSET}?year=2101`))).toEqual([{ field: 'year', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await get(base, `/depreciation-assets/${ASSET}?year=20x6`))).toEqual([{ field: 'year', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, `/depreciation-assets/${ASSET}?yaer=2026`))).toEqual([{ field: '(body)', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, '/depreciation-assets/x'))).toEqual([{ field: 'assetId', code: 'INVALID_FORMAT' }]);
  });

  it('GET the per-property list: { items } with rates; ?status= as a comma list, ?year=; unknown parameters 400', async () => {
    const seen: unknown[] = [];
    const base = await start({
      depreciationAssets: {
        listForPropertyReference: async (input) => {
          seen.push(input);
          return [{ asset, rate, methods }];
        },
      },
    });
    const res = await get(base, `/property-references/${PR}/depreciation-assets?status=ACTIVE,VOID&year=2023`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [dto] });
    expect(seen[0]).toEqual({ principal: expect.anything(), propertyReferenceId: PR, statuses: ['ACTIVE', 'VOID'], year: 2023 });
    await get(base, `/property-references/${PR}/depreciation-assets`);
    expect(seen[1]).toEqual({ principal: expect.anything(), propertyReferenceId: PR, statuses: null });
    expect(await fields(await get(base, `/property-references/${PR}/depreciation-assets?status=OPEN`))).toEqual([
      { field: 'status.0', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await get(base, `/property-references/${PR}/depreciation-assets?assetType=BUILDING`))).toEqual([
      { field: '(body)', code: 'INVALID_FORMAT' },
    ]);
  });
});

describe('the error answers (§59)', () => {
  const failing = (error: Error): CommandOverrides => ({
    depreciationAssets: {
      create: () => Promise.reject(error),
      amend: () => Promise.reject(error),
      confirm: () => Promise.reject(error),
      void: () => Promise.reject(error),
      get: () => Promise.reject(error),
    },
  });
  const answer = async (error: Error, path = '/depreciation-assets', body: unknown = { propertyReferenceId: PR }) => {
    const base = await start(failing(error));
    const res = await post(base, path, body);
    const json = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    return { status: res.status, ...json.error };
  };

  it('each row of the table, and the existing answers reused', async () => {
    expect(await answer(new DepreciationAssetNotFoundError(ASSET), `/depreciation-assets/${ASSET}/void`, { reason: 'x' })).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Depreciation asset not found.',
      details: { assetId: ASSET },
    });
    expect(await answer(new BuildingAssetExistsError(ASSET))).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'The PropertyReference already has an active building asset.',
      details: { reason: 'BUILDING_ASSET_EXISTS', assetId: ASSET },
    });
    expect(await answer(new DepreciationAssetNotActiveError(ASSET, 'VOID'), `/depreciation-assets/${ASSET}/amend`, { notes: 'x' })).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'The depreciation asset is VOID.',
      details: { reason: 'ASSET_NOT_ACTIVE', assetId: ASSET, status: 'VOID' },
    });
    expect(await answer(new CompletionYearMissingError(ASSET), `/depreciation-assets/${ASSET}/confirm`, { reviewState: 'CONFIRMED' })).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: "The building's completion year is not recorded; nothing to confirm.",
      details: { reason: 'COMPLETION_YEAR_MISSING', assetId: ASSET },
    });
    expect(await answer(new AssetAdvisorConfirmedError(ASSET), `/depreciation-assets/${ASSET}/confirm`, { reviewState: 'CONFIRMED' })).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'A user cannot lower an advisor confirmation; amend the review state to NEEDS_REVIEW first.',
      details: { reason: 'ADVISOR_CONFIRMED', assetId: ASSET },
    });
    expect(await answer(new AcquisitionNotOfPropertyError(ACQ, PR))).toEqual({
      status: 422,
      code: 'ACQUISITION_NOT_OF_PROPERTY',
      message: 'The Acquisition belongs to another PropertyReference.',
      details: { acquisitionId: ACQ, propertyReferenceId: PR },
    });
    expect(await answer(new PropertyReferenceNotFoundError(PR))).toMatchObject({ status: 404, details: { propertyReferenceId: PR } });
    expect(await answer(new PartyNotFoundError(ADVISOR))).toMatchObject({ status: 404, details: { partyId: ADVISOR } });
    expect(await answer(new AcquisitionNotFoundError(ACQ))).toMatchObject({ status: 404, details: { acquisitionId: ACQ } });
    expect(await answer(new AcquisitionCancelledError(ACQ))).toMatchObject({ status: 409, details: { reason: 'ACQUISITION_CANCELLED', acquisitionId: ACQ } });
    expect(await answer(new VersionConflictError([2], 3), `/depreciation-assets/${ASSET}/void`, { reason: 'x' })).toMatchObject({
      status: 412,
      code: 'VERSION_CONFLICT',
      details: { expectedVersions: [2], currentVersion: 3 },
    });
    expect(await answer(new IdempotencyKeyConflictError('x'))).toMatchObject({ status: 409, code: 'CONFLICT' });
  });
});

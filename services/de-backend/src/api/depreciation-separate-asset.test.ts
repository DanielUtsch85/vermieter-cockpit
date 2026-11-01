import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AssetFieldNotAllowedError,
  CapitalizedItemNotFoundError,
  ItemAnschaffungsnaheError,
  ItemInOtherAssetError,
  ItemNotCapitalizedError,
  ItemNotOfPropertyError,
  type AmendDepreciationAsset,
  type AssetRate,
  type CreateDepreciationAssetInput,
  type DepreciationAsset,
  type PrincipalVerifier,
} from '../application/index.js';
import type { BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/**
 * VC-8-03 HTTP contract of a separate asset (api-design.md §59B): every `400` with its field code, the five error rows
 * and the `NOT_ALLOWED` of an amend, the DTO of a separate asset with its `rate`, the bodies passed to the use case.
 * Synthetic ids and texts; no personal data.
 */
const REALM = '64b0c0ffee000000000000e8';
const ASSET = '6f1c2a9e-0000-4000-8000-000000000011';
const PR = '6f1c2a9e-0000-4000-8000-000000000001';
const SPLIT = '6f1c2a9e-0000-4000-8000-000000000061';
const USE = '6f1c2a9e-0000-4000-8000-000000000091';
const ACQ = '6f1c2a9e-0000-4000-8000-000000000002';

const asset: DepreciationAsset = {
  id: ASSET as DepreciationAsset['id'],
  mreRealmId: REALM,
  propertyReferenceId: PR,
  assetType: 'SEPARATE_ASSET',
  status: 'ACTIVE',
  buildingCompletionYear: null,
  description: 'Einbauküche, Wohnung 3 (synthetisch)',
  usefulLifeYears: 10,
  usefulLifeBasis: 'BFH IX R 14/15: Einbauküche als einheitliches Wirtschaftsgut, 10 Jahre (verification-checklist B8)',
  acquiredOn: '2027-04-20' as BusinessDate,
  items: [{ sourceType: 'TRANSACTION_SPLIT', sourceId: SPLIT, sourcePosition: null }],
  sourceReferences: ['Lieferschein 2027-04-20 (synthetisch)'],
  depreciationMethod: 'LINEAR_7_1',
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  shorterUsefulLives: [],
  purchaseMethods: [],
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2027-04-21T09:00:00.000Z'),
  version: 2,
};
const rate: AssetRate = {
  year: 2027,
  rule: { ruleCode: 'DE_AFA_MOVABLE_LINEAR', version: 1 },
  band: null,
  ratePercent: '10.0000',
  rate: '1/10',
  legalBasis: '§ 7 Abs. 1 EStG',
  shorterThanYears: null,
  reasons: [],
  shorterUsefulLives: [],
};
/** §59B: the single read of a separate asset. */
const dto = {
  assetId: ASSET,
  mreRealmId: REALM,
  propertyReferenceId: PR,
  assetType: 'SEPARATE_ASSET',
  status: 'ACTIVE',
  buildingCompletionYear: null,
  description: 'Einbauküche, Wohnung 3 (synthetisch)',
  usefulLifeYears: 10,
  usefulLifeBasis: 'BFH IX R 14/15: Einbauküche als einheitliches Wirtschaftsgut, 10 Jahre (verification-checklist B8)',
  acquiredOn: '2027-04-20',
  items: [{ sourceType: 'TRANSACTION_SPLIT', sourceId: SPLIT, sourcePosition: null }],
  sourceReferences: ['Lieferschein 2027-04-20 (synthetisch)'],
  depreciationMethod: 'LINEAR_7_1',
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  shorterUsefulLives: [],
  purchaseMethods: [],
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: '2027-04-21T09:00:00.000Z',
  version: 2,
  rate: {
    year: 2027,
    rule: { ruleCode: 'DE_AFA_MOVABLE_LINEAR', version: 1 },
    band: null,
    ratePercent: '10.0000',
    rate: '1/10',
    legalBasis: '§ 7 Abs. 1 EStG',
    shorterThanYears: null,
    reasons: [],
    shorterUsefulLives: [],
  },
};

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
const fields = async (res: Response) => {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: { details: { fields: { field: string; code: string }[] } } }).error.details.fields;
};
const body = {
  propertyReferenceId: PR,
  assetType: 'SEPARATE_ASSET',
  description: '  Einbauküche, Wohnung 3 (synthetisch)  ',
  usefulLifeYears: 10,
  usefulLifeBasis: 'BFH IX R 14/15 (B8)',
  acquiredOn: '2027-04-20',
  items: [{ sourceType: 'TRANSACTION_SPLIT', sourceId: SPLIT, sourcePosition: null }],
};

describe('POST /depreciation-assets with a separate asset (§59B)', () => {
  it('201: the body passed (LINEAR_7_1 by default, the description trimmed), the DTO with the separate fields', async () => {
    const seen: CreateDepreciationAssetInput[] = [];
    const base = await start({
      depreciationAssets: {
        create: async (input) => {
          seen.push(input);
          return { asset, replayed: false, methods: [] };
        },
        get: async () => ({ asset, rate, methods: [] }),
      },
    });
    const res = await post(base, '/depreciation-assets', {
      ...body,
      items: [...body.items, { sourceType: 'WEG_ASSESSMENT_USE', sourceId: USE, sourcePosition: 1 }],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ...dto, rate: null });
    expect(seen[0]).toMatchObject({
      assetType: 'SEPARATE_ASSET',
      depreciationMethod: 'LINEAR_7_1',
      buildingCompletionYear: null,
      description: 'Einbauküche, Wohnung 3 (synthetisch)',
      usefulLifeYears: 10,
      acquiredOn: '2027-04-20',
      items: [
        { sourceType: 'TRANSACTION_SPLIT', sourceId: SPLIT, sourcePosition: null },
        { sourceType: 'WEG_ASSESSMENT_USE', sourceId: USE, sourcePosition: 1 },
      ],
      shorterUsefulLives: [],
    });
    const read = await fetch(`${base}/api/v1/depreciation-assets/${ASSET}?year=2027`, { headers });
    expect(await read.json()).toEqual(dto);
  });

  it('every 400 with its field code', async () => {
    const base = await start({});
    const send = async (extra: Record<string, unknown>) => fields(await post(base, '/depreciation-assets', { ...body, ...extra }));
    // The fields of the other type, the method of the other type.
    expect(await send({ buildingCompletionYear: 1995, shorterUsefulLives: [] })).toEqual([
      { field: 'buildingCompletionYear', code: 'NOT_ALLOWED' },
      { field: 'shorterUsefulLives', code: 'NOT_ALLOWED' },
    ]);
    expect(await send({ depreciationMethod: 'LINEAR_7_4' })).toEqual([{ field: 'depreciationMethod', code: 'NOT_ALLOWED' }]);
    expect(await fields(await post(base, '/depreciation-assets', { propertyReferenceId: PR, depreciationMethod: 'LINEAR_7_1' }))).toEqual([
      { field: 'depreciationMethod', code: 'NOT_ALLOWED' },
    ]);
    expect(
      await fields(
        await post(base, '/depreciation-assets', { propertyReferenceId: PR, description: 'x', usefulLifeYears: 10, acquiredOn: '2027-01-01', items: [] }),
      ),
    ).toEqual([
      { field: 'description', code: 'NOT_ALLOWED' },
      { field: 'usefulLifeYears', code: 'NOT_ALLOWED' },
      { field: 'acquiredOn', code: 'NOT_ALLOWED' },
      { field: 'items', code: 'NOT_ALLOWED' },
    ]);
    // A useful life is never guessed: REQUIRED.
    expect(await send({ usefulLifeYears: undefined, acquiredOn: null })).toEqual([
      { field: 'usefulLifeYears', code: 'REQUIRED' },
      { field: 'acquiredOn', code: 'REQUIRED' },
    ]);
    expect(await send({ usefulLifeYears: 0 })).toEqual([{ field: 'usefulLifeYears', code: 'OUT_OF_RANGE' }]);
    expect(await send({ usefulLifeYears: 100 })).toEqual([{ field: 'usefulLifeYears', code: 'OUT_OF_RANGE' }]);
    expect(await send({ usefulLifeYears: 9.5 })).toEqual([{ field: 'usefulLifeYears', code: 'INVALID_FORMAT' }]);
    // A text over its length is INVALID_FORMAT, as every text of the API (validation.ts).
    expect(await send({ description: 'x'.repeat(201) })).toEqual([{ field: 'description', code: 'INVALID_FORMAT' }]);
    expect(await send({ acquiredOn: '2027-02-30' })).toEqual([{ field: 'acquiredOn', code: 'INVALID_FORMAT' }]);
    const item = (overrides: Record<string, unknown>) => ({ sourceType: 'TRANSACTION_SPLIT', sourceId: SPLIT, sourcePosition: null, ...overrides });
    expect(
      await send({ items: Array.from({ length: 51 }, (_, i) => item({ sourceId: `6f1c2a9e-0000-4000-8000-0000000001${String(i).padStart(2, '0')}` })) }),
    ).toEqual([{ field: 'items', code: 'OUT_OF_RANGE' }]);
    expect(await send({ items: [item({}), item({})] })).toEqual([{ field: 'items.1', code: 'DUPLICATE' }]);
    expect(await send({ items: [item({ sourcePosition: 1 })] })).toEqual([{ field: 'items.0.sourcePosition', code: 'NOT_ALLOWED' }]);
    expect(await send({ items: [item({ sourceType: 'WEG_ASSESSMENT_USE' })] })).toEqual([{ field: 'items.0.sourcePosition', code: 'REQUIRED' }]);
    expect(await send({ items: [item({ sourceType: 'WEG_RESERVE_WITHDRAWAL', sourcePosition: 1001 })] })).toEqual([
      { field: 'items.0.sourcePosition', code: 'OUT_OF_RANGE' },
    ]);
    expect(await send({ items: [item({ sourceType: 'DEPOSIT_CLOSING' })] })).toEqual([{ field: 'items.0.sourceType', code: 'NOT_ALLOWED' }]);
    expect(await send({ items: [item({ sourceType: 'CASH' })] })).toEqual([{ field: 'items.0.sourceType', code: 'INVALID_FORMAT' }]);
    expect(await send({ items: [item({ sourceId: 'x' })] })).toEqual([{ field: 'items.0.sourceId', code: 'INVALID_FORMAT' }]);
    expect(await send({ items: [item({ cost: '100.00' })] })).toMatchObject([{ field: 'items.0' }]);
  });

  it('amend: the separate fields and the whole item list passed; never null', async () => {
    const seen: Parameters<AmendDepreciationAsset>[0][] = [];
    const base = await start({
      depreciationAssets: {
        amend: async (input) => {
          seen.push(input);
          return { asset, changed: true, methods: [] };
        },
      },
    });
    const res = await post(
      base,
      `/depreciation-assets/${ASSET}/amend`,
      { description: 'Küche', usefulLifeYears: 8, usefulLifeBasis: 'Herstellerangabe', acquiredOn: '2027-05-01', items: [] },
      { 'if-match': '"2"' },
    );
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      description: 'Küche',
      usefulLifeYears: 8,
      usefulLifeBasis: 'Herstellerangabe',
      acquiredOn: '2027-05-01',
      items: [],
      expectedVersions: [2],
    });
    expect(await fields(await post(base, `/depreciation-assets/${ASSET}/amend`, { usefulLifeYears: null, items: null }, { 'if-match': '"2"' }))).toEqual([
      { field: 'usefulLifeYears', code: 'INVALID_FORMAT' },
      { field: 'items', code: 'INVALID_FORMAT' },
    ]);
  });
});

describe('the error answers (§59B)', () => {
  const failing = (error: Error): CommandOverrides => ({
    depreciationAssets: { create: () => Promise.reject(error), amend: () => Promise.reject(error) },
  });
  const answer = async (error: Error, path = '/depreciation-assets', payload: unknown = body) => {
    const base = await start(failing(error));
    const res = await post(base, path, payload, path.endsWith('/amend') ? { 'if-match': '"2"' } : {});
    const json = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    return { status: res.status, ...json.error };
  };
  const item = { sourceType: 'TRANSACTION_SPLIT', sourceId: SPLIT, sourcePosition: null } as const;

  it('each of the five rows, and NOT_ALLOWED for an amend naming the other type’s fields', async () => {
    expect(await answer(new CapitalizedItemNotFoundError({ sourceType: 'WEG_ASSESSMENT_USE', sourceId: USE, sourcePosition: 2 }))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: "The capitalised item's source does not exist.",
      details: { sourceType: 'WEG_ASSESSMENT_USE', sourceId: USE, sourcePosition: 2 },
    });
    expect(await answer(new ItemNotOfPropertyError(item, PR))).toEqual({
      status: 422,
      code: 'ITEM_NOT_OF_PROPERTY',
      message: 'The item belongs to another PropertyReference.',
      details: { item, propertyReferenceId: PR },
    });
    expect(await answer(new ItemNotCapitalizedError(item, true, 'DEDUCTIBLE', 'USER_CONFIRMED'))).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'The item is not classified CAPITALIZED, or does not count.',
      details: { reason: 'ITEM_NOT_CAPITALIZED', item, counts: true, treatment: 'DEDUCTIBLE', reviewState: 'USER_CONFIRMED' },
    });
    expect(await answer(new ItemAnschaffungsnaheError(item, ACQ))).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'The item is anschaffungsnahe Herstellungskosten of the building.',
      details: { reason: 'ITEM_ANSCHAFFUNGSNAHE', item, acquisitionId: ACQ },
    });
    expect(await answer(new ItemInOtherAssetError(item, ASSET))).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'The item belongs to another active depreciation asset.',
      details: { reason: 'ITEM_IN_OTHER_ASSET', item, assetId: ASSET },
    });
    expect(
      await answer(new AssetFieldNotAllowedError(['buildingCompletionYear']), `/depreciation-assets/${ASSET}/amend`, { buildingCompletionYear: 1995 }),
    ).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      details: { fields: [{ field: 'buildingCompletionYear', code: 'NOT_ALLOWED' }] },
    });
  });
});

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateDepreciationAssetInput, DepreciationAsset, PrincipalVerifier, PurchaseMethod, PurchaseMethodStatus } from '../application/index.js';
import type { BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/**
 * VC-X-37 at the API boundary (api-design.md §59C "API (§59)"): `purchaseMethods` in the create and amend bodies with
 * every field error of §59C, the mapping to the commands (create's defaults, amend's `null` as every entry removed),
 * and the asset's DTO with each entry's derived `methodStatus` and `causes`. No new route. Synthetic data.
 */
const REALM = '64b0c0ffee000000000000e9';
const ASSET = '6f1c2a9e-0000-4000-8000-000000000012';
const PR = '6f1c2a9e-0000-4000-8000-000000000001';
const ACQ = '6f1c2a9e-0000-4000-8000-000000000002';
const ACQ_2 = '6f1c2a9e-0000-4000-8000-000000000004';
const ADVISOR = '6f1c2a9e-0000-4000-8000-000000000003';

const stored: PurchaseMethod = {
  acquisitionId: ACQ,
  consideration: 'PARTLY_PAID',
  method: 'LINEAR_7_4',
  specialDepreciation: ['SPECIAL_7B'],
  subsidiesReceived: false,
  newBuildingByConversion: false,
  otherSpecialCase: true,
  otherSpecialCaseNote: 'Sanierungsgebiet (synthetisch)',
  evidence: { source: 'Anlage V 2024 (synthetisch)', date: '2026-06-15' as BusinessDate, documentReference: 'S. 2' },
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  notes: 'vom Verkäufer übernommen',
};
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
  sourceReferences: [],
  depreciationMethod: 'LINEAR_7_4',
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  shorterUsefulLives: [],
  purchaseMethods: [stored],
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2026-11-01T09:00:00.000Z'),
  version: 2,
};
const methods: PurchaseMethodStatus[] = [{ acquisitionId: ACQ, methodStatus: 'NOT_SUPPORTED', causes: ['PARTLY_PAID', 'SPECIAL_7B', 'OTHER_SPECIAL_CASE'] }];

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
const post = (base: string, path: string, payload: unknown) => fetch(`${base}/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
const fields = async (res: Response) => {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: { details: { fields: { field: string; code: string }[] } } }).error.details.fields;
};
const evidence = { source: 'Kaufvertrag (synthetisch)', date: '2026-06-15' };
const entry = (overrides: Record<string, unknown> = {}) => ({
  acquisitionId: ACQ,
  consideration: 'PAID',
  method: 'LINEAR_7_4',
  specialDepreciation: [],
  subsidiesReceived: false,
  newBuildingByConversion: false,
  otherSpecialCase: false,
  evidence,
  ...overrides,
});
const without = (key: string) => {
  const e: Record<string, unknown> = entry();
  delete e[key];
  return e;
};

describe('purchaseMethods in the create body (§59C)', () => {
  it('201: the entries passed with the defaults (UNREVIEWED, no advisor, the note and notes null); the DTO with methodStatus and causes', async () => {
    const seen: CreateDepreciationAssetInput[] = [];
    const base = await start({
      depreciationAssets: {
        create: async (input) => {
          seen.push(input);
          return { asset, replayed: false, methods };
        },
      },
    });
    const res = await post(base, '/depreciation-assets', {
      propertyReferenceId: PR,
      purchaseMethods: [entry({ specialDepreciation: ['INCREASED_7H'], notes: '  ' })],
    });
    expect(res.status).toBe(201);
    expect(seen[0]?.purchaseMethods).toEqual([
      {
        acquisitionId: ACQ,
        consideration: 'PAID',
        method: 'LINEAR_7_4',
        specialDepreciation: ['INCREASED_7H'],
        subsidiesReceived: false,
        newBuildingByConversion: false,
        otherSpecialCase: false,
        otherSpecialCaseNote: null,
        evidence: { ...evidence, documentReference: null },
        notes: null,
        reviewState: 'UNREVIEWED',
        advisorPartyId: null,
      },
    ]);
    expect(((await res.json()) as { purchaseMethods: unknown }).purchaseMethods).toEqual([
      {
        acquisitionId: ACQ,
        consideration: 'PARTLY_PAID',
        method: 'LINEAR_7_4',
        specialDepreciation: ['SPECIAL_7B'],
        subsidiesReceived: false,
        newBuildingByConversion: false,
        otherSpecialCase: true,
        otherSpecialCaseNote: 'Sanierungsgebiet (synthetisch)',
        evidence: { source: 'Anlage V 2024 (synthetisch)', date: '2026-06-15', documentReference: 'S. 2' },
        reviewState: 'CONFIRMED',
        advisorPartyId: null,
        notes: 'vom Verkäufer übernommen',
        methodStatus: 'NOT_SUPPORTED',
        causes: ['PARTLY_PAID', 'SPECIAL_7B', 'OTHER_SPECIAL_CASE'],
      },
    ]);
    // Without the key the list is empty.
    await post(base, '/depreciation-assets', { propertyReferenceId: PR });
    expect(seen[1]?.purchaseMethods).toEqual([]);
  });

  it('every 400 at once with its field code', async () => {
    const base = await start({});
    const send = (list: unknown) => post(base, '/depreciation-assets', { propertyReferenceId: PR, purchaseMethods: list });
    for (const key of [
      'acquisitionId',
      'consideration',
      'method',
      'specialDepreciation',
      'subsidiesReceived',
      'newBuildingByConversion',
      'otherSpecialCase',
      'evidence',
    ]) {
      expect(await fields(await send([without(key)])), key).toEqual([{ field: `purchaseMethods.0.${key}`, code: 'REQUIRED' }]);
    }
    expect(await fields(await send([entry({ consideration: 'GIFT' })]))).toEqual([{ field: 'purchaseMethods.0.consideration', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send([entry({ method: 'UNKNOWN' })]))).toEqual([{ field: 'purchaseMethods.0.method', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send([entry({ specialDepreciation: ['SPECIAL_7X'] })]))).toEqual([
      { field: 'purchaseMethods.0.specialDepreciation.0', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await send([entry({ specialDepreciation: ['SPECIAL_7B', 'SPECIAL_7B'] })]))).toEqual([
      { field: 'purchaseMethods.0.specialDepreciation.1', code: 'DUPLICATE' },
    ]);
    expect(await fields(await send([entry({ subsidiesReceived: 'no' })]))).toEqual([{ field: 'purchaseMethods.0.subsidiesReceived', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send([entry(), entry()]))).toEqual([{ field: 'purchaseMethods.1.acquisitionId', code: 'DUPLICATE' }]);
    const many = Array.from({ length: 21 }, (_, i) => entry({ acquisitionId: `6f1c2a9e-0000-4000-8000-${String(100 + i).padStart(12, '0')}` }));
    expect(await fields(await send(many))).toEqual([{ field: 'purchaseMethods', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await send([entry({ otherSpecialCaseNote: 'Denkmal' })]))).toEqual([
      { field: 'purchaseMethods.0.otherSpecialCaseNote', code: 'NOT_ALLOWED' },
    ]);
    expect(await fields(await send([entry({ otherSpecialCase: true })]))).toEqual([{ field: 'purchaseMethods.0.otherSpecialCaseNote', code: 'REQUIRED' }]);
    expect(await fields(await send([entry({ otherSpecialCase: true, otherSpecialCaseNote: 'x'.repeat(501) })]))).toEqual([
      { field: 'purchaseMethods.0.otherSpecialCaseNote', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await send([entry({ reviewState: 'SUGGESTED' })]))).toEqual([{ field: 'purchaseMethods.0.reviewState', code: 'NOT_ALLOWED' }]);
    expect(await fields(await send([entry({ advisorPartyId: ADVISOR })]))).toEqual([{ field: 'purchaseMethods.0.advisorPartyId', code: 'NOT_ALLOWED' }]);
    expect(await fields(await send([entry({ evidence: { source: '', date: '2026-02-30' } })]))).toEqual([
      { field: 'purchaseMethods.0.evidence.source', code: 'INVALID_FORMAT' },
      { field: 'purchaseMethods.0.evidence.date', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await send([entry({ unknown: 1 })]))).toEqual([{ field: 'purchaseMethods.0', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send([entry({ acquisitionId: 'x' })]))).toEqual([{ field: 'purchaseMethods.0.acquisitionId', code: 'INVALID_FORMAT' }]);
    // A separate asset names none (§59C: building only).
    expect(
      await fields(
        await post(base, '/depreciation-assets', {
          propertyReferenceId: PR,
          assetType: 'SEPARATE_ASSET',
          description: 'Küche',
          usefulLifeYears: 10,
          usefulLifeBasis: 'B8',
          acquiredOn: '2027-04-20',
          purchaseMethods: [],
        }),
      ),
    ).toEqual([{ field: 'purchaseMethods', code: 'NOT_ALLOWED' }]);
    // Counter-check: the ADVISOR_CONFIRMED entry with its advisor and a note with the flag pass.
    const ok = await start({ depreciationAssets: { create: async () => ({ asset, replayed: false, methods }) } });
    const res = await post(ok, '/depreciation-assets', {
      propertyReferenceId: PR,
      purchaseMethods: [entry({ reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: ADVISOR, otherSpecialCase: true, otherSpecialCaseNote: 'Denkmal' })],
    });
    expect(res.status).toBe(201);
  });
});

describe('purchaseMethods in the amend body (§59C)', () => {
  it('the whole list passed (state and advisor only when named); null removes every entry; the field errors as on create', async () => {
    const seen: unknown[] = [];
    const base = await start({
      depreciationAssets: {
        amend: async (input) => {
          seen.push(input);
          return { asset, changed: true, methods };
        },
      },
    });
    const res = await post(base, `/depreciation-assets/${ASSET}/amend`, {
      purchaseMethods: [entry(), entry({ acquisitionId: ACQ_2, reviewState: 'CONFIRMED' })],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { purchaseMethods: { methodStatus: string }[] }).purchaseMethods.map((e) => e.methodStatus)).toEqual(['NOT_SUPPORTED']);
    expect(
      (seen[0] as { purchaseMethods: Record<string, unknown>[] }).purchaseMethods.map((e) => [e['acquisitionId'], e['reviewState'], 'advisorPartyId' in e]),
    ).toEqual([
      [ACQ, undefined, false],
      [ACQ_2, 'CONFIRMED', false],
    ]);
    await post(base, `/depreciation-assets/${ASSET}/amend`, { purchaseMethods: null });
    expect(seen[1]).toMatchObject({ purchaseMethods: [] });
    await post(base, `/depreciation-assets/${ASSET}/amend`, { notes: 'x' });
    expect(seen[2]).not.toHaveProperty('purchaseMethods');
    expect(await fields(await post(base, `/depreciation-assets/${ASSET}/amend`, { purchaseMethods: [entry({ method: 'DEGRESSIVE' })] }))).toEqual([
      { field: 'purchaseMethods.0.method', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await post(base, `/depreciation-assets/${ASSET}/amend`, { purchaseMethods: [entry(), entry()] }))).toEqual([
      { field: 'purchaseMethods.1.acquisitionId', code: 'DUPLICATE' },
    ]);
  });
});

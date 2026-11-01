import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DepreciationAssetNotFoundError,
  NotAnOwnerError,
  OwnerPartyNotFoundError,
  getDepreciationSchedule,
  type DepreciationAsset,
  type DepreciationScheduleSource,
  type PrincipalVerifier,
  type ScheduleRead,
} from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/**
 * VC-8-02 HTTP contract of the schedule (api-design.md §59A): every `400` with its field code, all at once; the `404`s
 * and `NOT_AN_OWNER`; the defaults of `from` and `to` from an injected clock; `truncated`; the DTO at both levels (the
 * response example, ACC8's purchase); no version `ETag`. The use case runs for real over a stubbed snapshot source.
 */
const REALM = '64b0c0ffee000000000008a2';
const ASSET = '6f1c2a9e-0000-4000-8000-000000000010';
const PR = '6f1c2a9e-0000-4000-8000-000000000001';
const W = '6f1c2a9e-0000-4000-8000-000000000002';
const A = '6f1c2a9e-0000-4000-8000-000000000021';
const B = '6f1c2a9e-0000-4000-8000-000000000022';
const D = '6f1c2a9e-0000-4000-8000-000000000029';
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;
/** A stand-in for the SHA-256 adapter (the API tests may not import infrastructure): the text's length as 64 hex. */
const FAKE_FINGERPRINTER = { sha256Hex: (text: string) => text.length.toString(16).padStart(64, '0') };

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
  shorterUsefulLives: [],
  // §59C: the purchase's confirmed STANDARD method entry (the example computes).
  purchaseMethods: [
    {
      acquisitionId: W,
      consideration: 'PAID',
      method: 'LINEAR_7_4',
      specialDepreciation: [],
      subsidiesReceived: false,
      newBuildingByConversion: false,
      otherSpecialCase: false,
      otherSpecialCaseNote: null,
      evidence: { source: 'Kaufvertrag (synthetisch)', date: '2026-05-15' as BusinessDate, documentReference: null },
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
/** §59A's example: ACC8's purchase, A 3/5 and B 2/5 from 2026-07-01, one cost not yet paid. */
const acc8: ScheduleRead = {
  asset,
  acquisitions: [
    {
      id: W,
      status: 'CONFIRMED',
      purchasePrice: eur('300000.00'),
      acquiredShare: { numerator: 1, denominator: 1 },
      contractDate: day('2026-05-15'),
      economicTransferDate: day('2026-07-01'),
      sellerPartyIds: [D],
      costs: [
        {
          id: '6f1c2a9e-0000-4000-8000-000000000051',
          category: 'REAL_ESTATE_TRANSFER_TAX',
          amount: eur('15000.00'),
          paymentStatus: 'EXPECTED',
          classification: null,
        },
        {
          id: '6f1c2a9e-0000-4000-8000-000000000052',
          category: 'NOTARY',
          amount: eur('3000.00'),
          paymentStatus: 'PAID',
          // §59D: confirmed as a cost of the transfer, so it counts.
          classification: {
            id: '6f1c2a9e-0000-4000-8000-000000000062',
            reviewState: 'CONFIRMED',
            parts: [{ purpose: 'OWNERSHIP_TRANSFER', amount: eur('3000.00') }],
          },
        },
        { id: '6f1c2a9e-0000-4000-8000-000000000053', category: 'FINANCING_RELATED', amount: eur('1200.00'), paymentStatus: 'PAID', classification: null },
      ],
      allocation: {
        id: '6f1c2a9e-0000-4000-8000-000000000030',
        method: 'PURCHASE_CONTRACT',
        reviewState: 'CONFIRMED',
        totalAllocableAmount: eur('318000.00'),
        buildingAmount: eur('254400.00'),
      },
    },
  ],
  ownerships: [
    {
      id: '6f1c2a9e-0000-4000-8000-000000000041',
      partyId: A,
      share: { numerator: 3, denominator: 5 },
      validFrom: day('2026-07-01'),
      validUntil: null,
      acquisitionId: W,
    },
    {
      id: '6f1c2a9e-0000-4000-8000-000000000042',
      partyId: B,
      share: { numerator: 2, denominator: 5 },
      validFrom: day('2026-07-01'),
      validUntil: null,
      acquisitionId: W,
    },
  ],
  capitalizedItems: [],
  links: [],
  ownerPartyFound: null,
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

const headers = { authorization: 'Bearer a.b.c', organizationid: REALM };
const get = (base: string, path: string) => fetch(`${base}/api/v1${path}`, { headers });
const fields = async (res: Response) => {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: { details: { fields: { field: string; code: string }[] } } }).error.details.fields;
};
/** The real use case over a stubbed snapshot source and a fixed clock. */
const real = (read: ScheduleRead | undefined, now = new Date('2026-10-30T10:00:00Z')) => {
  const calls: unknown[][] = [];
  const source: DepreciationScheduleSource = {
    read: async (...args) => {
      calls.push(args);
      return read === undefined ? undefined : { ...read, ownerPartyFound: args[2] === null ? null : (read.ownerPartyFound ?? true) };
    },
  };
  return {
    calls,
    commands: {
      depreciationAssets: { schedule: getDepreciationSchedule({ source, now: () => now, recordingEnabled: false, fingerprinter: FAKE_FINGERPRINTER }) },
    } satisfies CommandOverrides,
  };
};
const path = `/depreciation-assets/${ASSET}/schedule`;

describe('GET /depreciation-assets/{assetId}/schedule: 400 (§59A)', () => {
  it('every malformed field and an unknown parameter, all at once; `to` < `from` at `to`', async () => {
    const base = await start(real(acc8).commands);
    expect(await fields(await get(base, `${path}?from=20x6`))).toEqual([{ field: 'from', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, `${path}?from=-2026`))).toEqual([{ field: 'from', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, `${path}?from=1999`))).toEqual([{ field: 'from', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await get(base, `${path}?to=2101`))).toEqual([{ field: 'to', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await get(base, `${path}?from=2027&to=2026`))).toEqual([{ field: 'to', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await get(base, `${path}?ownerPartyId=x`))).toEqual([{ field: 'ownerPartyId', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, `${path}?year=2026`))).toEqual([{ field: '(body)', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, '/depreciation-assets/x/schedule?from=20x6&ownerPartyId=y'))).toEqual([
      { field: 'assetId', code: 'INVALID_FORMAT' },
      { field: 'from', code: 'INVALID_FORMAT' },
      { field: 'ownerPartyId', code: 'INVALID_FORMAT' },
    ]);
    // Equal years are a range of one.
    expect((await get(base, `${path}?from=2026&to=2026`)).status).toBe(200);
  });
});

describe('GET /depreciation-assets/{assetId}/schedule: 404 and 422 (§59A)', () => {
  const answer = async (commands: CommandOverrides, query = '') => {
    const base = await start(commands);
    const res = await get(base, `${path}${query}`);
    return { status: res.status, ...((await res.json()) as { error: object }).error };
  };

  it('the asset unknown or of another Realm → 404 with assetId; the Party unknown → 404 with ownerPartyId; not an owner → 422 NOT_AN_OWNER', async () => {
    expect(await answer(real(undefined).commands)).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Depreciation asset not found.',
      details: { assetId: ASSET },
    });
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    expect(await answer(real({ ...acc8, ownerPartyFound: false }).commands, `?ownerPartyId=${D}`)).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Party not found.',
      details: { ownerPartyId: D },
    });
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    expect(await answer(real(acc8).commands, `?ownerPartyId=${D}`)).toEqual({
      status: 422,
      code: 'NOT_AN_OWNER',
      message: "The Party holds no share of the asset's PropertyReference and bought none.",
      details: { ownerPartyId: D, propertyReferenceId: PR },
    });
  });

  it('the errors as thrown by any implementation map the same way', async () => {
    const failing = (error: Error): CommandOverrides => ({ depreciationAssets: { schedule: () => Promise.reject(error) } });
    expect(await answer(failing(new DepreciationAssetNotFoundError(ASSET)))).toMatchObject({ status: 404, details: { assetId: ASSET } });
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    expect(await answer(failing(new OwnerPartyNotFoundError(A)))).toMatchObject({ status: 404, details: { ownerPartyId: A } });
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    expect(await answer(failing(new NotAnOwnerError(A, PR)))).toMatchObject({ status: 422, code: 'NOT_AN_OWNER' });
  });
});

describe('GET /depreciation-assets/{assetId}/schedule: 200 (§59A)', () => {
  it('the response example at the property level (2026–2027), no version ETag; the source asked once, in the caller’s Realm', async () => {
    const { calls, commands } = real(acc8);
    const base = await start(commands);
    const res = await get(base, `${path}?from=2026&to=2027`);
    expect(res.status).toBe(200);
    // Express's own weak ETag only, never a version tag (a derived read, as §55 and §58C).
    expect(res.headers.get('etag') ?? 'W/').toMatch(/^W\//);
    expect(calls).toEqual([[ASSET, REALM, null]]);
    const body = (await res.json()) as Record<string, unknown>;
    const owners = (a: string, b: string, residualA: string, residualB: string, months: number) => [
      {
        ownerPartyId: A,
        months,
        fraction: '1/1',
        amount: { amount: a, currency: 'EUR' },
        residualValue: { amount: residualA, currency: 'EUR' },
        calculationStatus: 'CALCULATED',
        reasons: [],
        flags: [],
      },
      {
        ownerPartyId: B,
        months,
        fraction: '1/1',
        amount: { amount: b, currency: 'EUR' },
        residualValue: { amount: residualB, currency: 'EUR' },
        calculationStatus: 'CALCULATED',
        reasons: [],
        flags: [],
      },
    ];
    const rule = { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2, band: 'B', legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG' };
    const unpaid = { code: 'ACQUISITION_COST_UNPAID', details: { componentIds: [`ACQUISITION:${W}`] } };
    const notRecorded = {
      code: 'DEPRECIATION_SCHEDULE_NOT_RECORDED',
      details: { assetId: ASSET, assetType: 'BUILDING', currentVersionId: null, currentThroughYear: null },
    };
    expect(body).toEqual({
      assetId: ASSET,
      propertyReferenceId: PR,
      assetType: 'BUILDING',
      level: 'PROPERTY',
      ownerPartyId: null,
      computedOn: '2026-10-30',
      range: { from: 2026, to: 2027, truncated: false },
      status: 'AVAILABLE',
      reasons: [],
      // §59B: the schedule's own flags and the building's excluded items (none here).
      flags: [],
      asset: { status: 'ACTIVE', buildingCompletionYear: 1995, reviewState: 'CONFIRMED' },
      components: [
        {
          componentId: `ACQUISITION:${W}`,
          kind: 'ACQUISITION',
          acquisitionId: W,
          acquisitionStatus: 'CONFIRMED',
          status: 'COMPUTABLE',
          reasons: [],
          // §59C: the entry as stored (without the evidence), with its derived status.
          method: {
            consideration: 'PAID',
            method: 'LINEAR_7_4',
            specialDepreciation: [],
            subsidiesReceived: false,
            newBuildingByConversion: false,
            otherSpecialCase: false,
            otherSpecialCaseNote: null,
            reviewState: 'CONFIRMED',
            advisorPartyId: null,
            notes: null,
            methodStatus: 'STANDARD',
            causes: [],
          },
          basis: {
            amount: { amount: '254400.00', currency: 'EUR' },
            purchasePrice: { amount: '300000.00', currency: 'EUR' },
            acquisitionCosts: { amount: '18000.00', currency: 'EUR' },
            excludedCosts: [{ category: 'FINANCING_RELATED', purpose: null, amount: { amount: '1200.00', currency: 'EUR' } }],
            // §59D: nothing unclassified (the notary cost confirmed as a cost of the transfer): both bounds equal.
            unclassifiedCosts: [],
            basisAmountWithUnclassified: { amount: '254400.00', currency: 'EUR' },
            allocationId: '6f1c2a9e-0000-4000-8000-000000000030',
            allocationMethod: 'PURCHASE_CONTRACT',
            allocationReviewState: 'CONFIRMED',
            totalAllocableAmount: { amount: '318000.00', currency: 'EUR' },
            buildingAmount: { amount: '254400.00', currency: 'EUR' },
          },
          start: { date: '2026-07-01', dateSource: 'ECONOMIC_TRANSFER_DATE', month: '2026-07', firstYearMonths: 6 },
          rate: { kind: 'BAND', band: 'B', ratePercent: '2', rate: '1/50', usefulLifeYears: null, legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG' },
          end: { lastYear: 2076, lastMonth: '2076-06' },
          owners: [
            {
              ownerPartyId: A,
              ownershipId: '6f1c2a9e-0000-4000-8000-000000000041',
              share: '3/5',
              shareBefore: '0/1',
              acquiredShare: '3/5',
              weight: '3/5',
              basis: { amount: '152640.00', currency: 'EUR' },
              tenure: { from: '2026-07-01', lastDay: null, lastDaySource: null },
            },
            {
              ownerPartyId: B,
              ownershipId: '6f1c2a9e-0000-4000-8000-000000000042',
              share: '2/5',
              shareBefore: '0/1',
              acquiredShare: '2/5',
              weight: '2/5',
              basis: { amount: '101760.00', currency: 'EUR' },
              tenure: { from: '2026-07-01', lastDay: null, lastDaySource: null },
            },
          ],
          years: [
            {
              year: 2026,
              rule,
              months: 6,
              amount: { amount: '2544.00', currency: 'EUR' },
              cumulative: { amount: '2544.00', currency: 'EUR' },
              residualValue: { amount: '251856.00', currency: 'EUR' },
              calculationStatus: 'CALCULATED',
              reasons: [],
              owners: owners('1526.40', '1017.60', '151113.60', '100742.40', 6),
              notOwned: null,
              flags: [],
            },
            {
              year: 2027,
              rule,
              months: 12,
              amount: { amount: '5088.00', currency: 'EUR' },
              cumulative: { amount: '7632.00', currency: 'EUR' },
              residualValue: { amount: '246768.00', currency: 'EUR' },
              calculationStatus: 'CALCULATED',
              reasons: [],
              owners: owners('3052.80', '2035.20', '148060.80', '98707.20', 12),
              notOwned: null,
              flags: [],
            },
          ],
          flags: [{ code: 'ACQUISITION_COST_UNPAID', details: { costIds: ['6f1c2a9e-0000-4000-8000-000000000051'] } }],
        },
      ],
      excludedItems: [],
      years: [
        {
          year: 2026,
          status: 'AVAILABLE',
          calculationStatus: 'CALCULATED',
          amount: { amount: '2544.00', currency: 'EUR' },
          residualValue: { amount: '251856.00', currency: 'EUR' },
          owners: [
            { ownerPartyId: A, amount: { amount: '1526.40', currency: 'EUR' } },
            { ownerPartyId: B, amount: { amount: '1017.60', currency: 'EUR' } },
          ],
          notOwned: null,
          reasons: [],
          flags: [unpaid, notRecorded],
          inputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          recording: 'NOT_RECORDED',
        },
        {
          year: 2027,
          status: 'AVAILABLE',
          calculationStatus: 'CALCULATED',
          amount: { amount: '5088.00', currency: 'EUR' },
          residualValue: { amount: '246768.00', currency: 'EUR' },
          owners: [
            { ownerPartyId: A, amount: { amount: '3052.80', currency: 'EUR' } },
            { ownerPartyId: B, amount: { amount: '2035.20', currency: 'EUR' } },
          ],
          notOwned: null,
          reasons: [],
          flags: [unpaid, notRecorded],
          inputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          recording: 'NOT_RECORDED',
        },
      ],
      // §60: nothing recorded, so each year with AfA carries the open DEPRECIATION_SCHEDULE_NOT_RECORDED.
      review: { open: [{ code: 'DEPRECIATION_SCHEDULE_NOT_RECORDED', count: 2 }], info: [{ code: 'ACQUISITION_COST_UNPAID', count: 1 }] },
      ruleVersions: [
        {
          ruleCode: 'DE_AFA_BUILDING_LINEAR',
          version: 2,
          title: 'Lineare Gebäude-AfA im Privatvermögen (§ 7 Abs. 4 EStG)',
          legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 und S. 2 EStG',
          status: 'ACTIVE',
          years: [2026, 2027],
        },
      ],
      recordedVersion: null,
      recordingEnabled: false,
    });
  });

  it('the owner level: only that owner, owners and notOwned null', async () => {
    const { calls, commands } = real(acc8);
    const base = await start(commands);
    const body = (await (await get(base, `${path}?from=2026&to=2027&ownerPartyId=${A.toUpperCase()}`)).json()) as {
      level: string;
      ownerPartyId: string;
      components: { owners: { ownerPartyId: string }[] }[];
      years: { amount: { amount: string }; owners: unknown; notOwned: unknown }[];
    };
    expect(calls).toEqual([[ASSET, REALM, A]]);
    expect([body.level, body.ownerPartyId]).toEqual(['OWNER', A]);
    expect(body.components[0]?.owners.map((o) => o.ownerPartyId)).toEqual([A]);
    expect(body.years.map((y) => [y.amount.amount, y.owners, y.notOwned])).toEqual([
      ['1526.40', null, null],
      ['3052.80', null, null],
    ]);
  });

  it('the defaults from the injected clock: from the earliest start to the last year with AfA; without a component, the clock’s year in Berlin', async () => {
    const base = await start(real(acc8).commands);
    expect(((await (await get(base, path)).json()) as { range: object }).range).toEqual({ from: 2026, to: 2076, truncated: false });
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    // 23:30 UTC on 31 December is already 1 January in Berlin.
    const empty = await start(real({ ...acc8, acquisitions: [], ownerships: [] }, new Date('2026-12-31T23:30:00Z')).commands);
    const body = (await (await get(empty, path)).json()) as { range: object; computedOn: string; years: { year: number; amount: { amount: string } }[] };
    expect([body.range, body.computedOn, body.years.map((y) => [y.year, y.amount.amount])]).toEqual([
      { from: 2027, to: 2027, truncated: false },
      '2027-01-01',
      [[2027, '0.00']],
    ]);
  });

  it('truncated: a purchase whose AfA runs past 2100 clamps the default `to` and says so; an explicit `to` does not', async () => {
    const late: ScheduleRead = {
      ...acc8,
      acquisitions: acc8.acquisitions.map((a) => ({ ...a, contractDate: day('2090-01-01'), economicTransferDate: day('2090-01-01') })),
      ownerships: acc8.ownerships.map((o) => ({ ...o, validFrom: day('2090-01-01') })),
    };
    const base = await start(real(late).commands);
    expect(((await (await get(base, path)).json()) as { range: object }).range).toEqual({ from: 2090, to: 2100, truncated: true });
    expect(((await (await get(base, `${path}?to=2100`)).json()) as { range: object }).range).toEqual({ from: 2090, to: 2100, truncated: false });
  });
});

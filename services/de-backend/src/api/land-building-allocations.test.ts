import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcquisitionCancelledError,
  AcquisitionNotFoundError,
  CurrentAllocationChangedError,
  ReviewStateNotAllowedError,
  type LandBuildingAllocation,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { toDto } from './land-building-allocations.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-2-08 HTTP contract (api-design.md §27.3). */
const REALM = '64b0c0ffee0000000000000a';
const ACQ = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const OLD = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const NEW = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const eur = (amount: string) => Money.of(amount, 'EUR');
const allocation: LandBuildingAllocation = {
  id: NEW,
  mreRealmId: REALM,
  acquisitionId: ACQ,
  totalAllocableAmount: eur('330500.00'),
  landAmount: eur('66100.00'),
  buildingAmount: eur('264400.00'),
  method: 'BMF_TOOL',
  reviewState: 'UNREVIEWED',
  effectiveDate: '2026-08-01' as BusinessDate,
  advisorPartyId: null,
  sourceReferences: [],
  notes: null,
  supersedesId: OLD,
  supersededAt: null,
  supersededById: null,
  current: true,
  createdAt: new Date('2026-10-26T15:00:00Z'),
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
const call = (base: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1${path}`, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; details?: unknown } }).error;
const body = {
  totalAllocableAmount: { amount: '330500.00', currency: 'EUR' },
  landAmount: { amount: '66100.00', currency: 'EUR' },
  buildingAmount: { amount: '264400.00', currency: 'EUR' },
  method: 'BMF_TOOL',
  supersedes: OLD.toUpperCase(),
};

describe('POST /api/v1/acquisitions/{id}/land-building-allocation', () => {
  it('201 with the allocation and its derived shares; defaults passed on; a replay is marked', async () => {
    const seen: unknown[] = [];
    const base = await start({
      landBuildingAllocations: {
        create: async (input) => {
          seen.push(input);
          return { allocation, replayed: seen.length > 1 };
        },
      },
    });
    const res = await call(base, 'POST', `/acquisitions/${ACQ}/land-building-allocation`, body, { 'idempotency-key': 'k' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      allocationId: NEW,
      acquisitionId: ACQ,
      totalAllocableAmount: { amount: '330500.00', currency: 'EUR' },
      landAmount: { amount: '66100.00', currency: 'EUR' },
      buildingAmount: { amount: '264400.00', currency: 'EUR' },
      landShare: '0.2000',
      buildingShare: '0.8000',
      method: 'BMF_TOOL',
      reviewState: 'UNREVIEWED',
      effectiveDate: '2026-08-01',
      advisorPartyId: null,
      sourceReferences: [],
      notes: null,
      supersedesId: OLD,
      supersededAt: null,
      supersededById: null,
      current: true,
      createdAt: '2026-10-26T15:00:00.000Z',
      // §58T: additive; a BMF_TOOL split without a comparison carries no flag.
      comparison: null,
      deviationReason: null,
      flags: [],
    });
    expect(seen[0]).toMatchObject({
      acquisitionId: ACQ,
      reviewState: 'UNREVIEWED',
      effectiveDate: null,
      advisorPartyId: null,
      supersedes: OLD,
      idempotencyKey: 'k',
    });
    expect(
      (await call(base, 'POST', `/acquisitions/${ACQ}/land-building-allocation`, body, { 'idempotency-key': 'k' })).headers.get('idempotent-replayed'),
    ).toBe('true');
  });

  it('400: the exact sum, a zero total, SUGGESTED, a missing supersedes, documentIds, percentages', async () => {
    const base = await start({});
    const fields = async (b: unknown) => (await errorOf(await call(base, 'POST', `/acquisitions/${ACQ}/land-building-allocation`, b))).details;
    expect(await fields({ ...body, landAmount: { amount: '66100.01', currency: 'EUR' } })).toEqual({
      fields: [{ field: 'totalAllocableAmount', code: 'ALLOCATION_SUM_MISMATCH' }],
    });
    const zero = { amount: '0.00', currency: 'EUR' };
    expect(await fields({ ...body, totalAllocableAmount: zero, landAmount: zero, buildingAmount: zero })).toEqual({
      fields: [{ field: 'totalAllocableAmount.amount', code: 'NOT_POSITIVE' }],
    });
    expect(await fields({ ...body, reviewState: 'SUGGESTED' })).toMatchObject({ fields: [{ field: 'reviewState' }] });
    const { supersedes: _omitted, ...withoutSupersedes } = body;
    expect(await fields(withoutSupersedes)).toMatchObject({ fields: [{ field: 'supersedes' }] });
    expect(await fields({ ...body, documentIds: [OLD] })).toEqual({ fields: [{ field: 'documentIds', code: 'NOT_SUPPORTED' }] });
    expect(await fields({ ...body, landShare: '0.2' })).toMatchObject({ fields: [{ field: '(body)' }] });
  });

  it('a zero land part is allowed (Erbbaurecht); 404, 409 ACQUISITION_CANCELLED and CURRENT_ALLOCATION_CHANGED', async () => {
    const errors: unknown[] = [undefined, new AcquisitionNotFoundError(ACQ), new AcquisitionCancelledError(ACQ), new CurrentAllocationChangedError(NEW)];
    const base = await start({
      landBuildingAllocations: {
        create: async () => {
          const error = errors.shift();
          if (error !== undefined) throw error;
          return { allocation, replayed: false };
        },
      },
    });
    const path = `/acquisitions/${ACQ}/land-building-allocation`;
    const erbbau = { ...body, landAmount: { amount: '0.00', currency: 'EUR' }, buildingAmount: { amount: '330500.00', currency: 'EUR' } };
    expect((await call(base, 'POST', path, erbbau)).status).toBe(201);
    expect((await call(base, 'POST', path, body)).status).toBe(404);
    expect(await errorOf(await call(base, 'POST', path, body))).toMatchObject({ code: 'CONFLICT', details: { reason: 'ACQUISITION_CANCELLED' } });
    expect(await errorOf(await call(base, 'POST', path, body))).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'CURRENT_ALLOCATION_CHANGED', currentAllocationId: NEW },
    });
  });
});

describe('the advisor reason-only supersede over HTTP (§58T rule 3, decided 2026-11-06)', () => {
  it('422 REVIEW_STATE_NOT_ALLOWED at reviewState with the hint; the body passed on as sent, never downgraded', async () => {
    const seen: Json[] = [];
    const base = await start({
      landBuildingAllocations: {
        create: async (input) => {
          seen.push(input);
          throw new ReviewStateNotAllowedError(OLD);
        },
      },
    });
    const res = await call(base, 'POST', `/acquisitions/${ACQ}/land-building-allocation`, { ...body, reviewState: 'ADVISOR_CONFIRMED' });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toEqual({
      code: 'REVIEW_STATE_NOT_ALLOWED',
      message: 'ADVISOR_CONFIRMED is not allowed when the supersede changes only the reason.',
      details: {
        field: 'reviewState',
        reviewState: 'ADVISOR_CONFIRMED',
        supersededAllocationId: OLD,
        hint: 'An advisor-confirmed allocation needs no reason: send reviewState CONFIRMED, or leave deviationReason out.',
      },
    });
    expect(seen.map((input) => input.reviewState)).toEqual(['ADVISOR_CONFIRMED']);
  });
});

describe('GET /api/v1/acquisitions/{id}/land-building-allocations', () => {
  it('current and history; unknown parameters 400', async () => {
    const base = await start({
      landBuildingAllocations: {
        list: async () => ({ current: allocation, items: [allocation, { ...allocation, id: OLD, current: false, supersededById: NEW }] }),
      },
    });
    const res = await call(base, 'GET', `/acquisitions/${ACQ}/land-building-allocations`);
    expect(await res.json()).toMatchObject({
      current: { allocationId: NEW },
      items: [{ allocationId: NEW }, { allocationId: OLD, current: false, supersededById: NEW }],
    });
    expect((await call(base, 'GET', `/acquisitions/${ACQ}/land-building-allocations?page=1`)).status).toBe(400);
  });
});

/** §58T (VC-X-44): the comparison and the reason in the body, the DTO's `comparison`, `deviationReason` and `flags`. */
describe('the plausibility warning over HTTP (§58T)', () => {
  const comparison = {
    method: 'BMF_TOOL',
    landValue: { amount: '132200.00', currency: 'EUR' },
    buildingValue: { amount: '198300.00', currency: 'EUR' },
    sourceReferences: ['BMF-Arbeitshilfe (synthetisch)'],
  };
  const reason = 'Bodenwert laut Vertrag gemindert (synthetisch)';
  const stored: LandBuildingAllocation = {
    ...allocation,
    method: 'PURCHASE_CONTRACT',
    reviewState: 'CONFIRMED',
    comparison: { method: 'BMF_TOOL', landValue: eur('132200.00'), buildingValue: eur('198300.00'), sourceReferences: ['BMF-Arbeitshilfe (synthetisch)'] },
    deviationReason: null,
  };
  const flag = (level: string, closedBy: string | null, reasonGiven: boolean) => ({
    code: 'ALLOCATION_DEVIATES_FROM_COMPARISON',
    level,
    details: {
      allocationId: NEW,
      comparisonMethod: 'BMF_TOOL',
      allocationLandShare: '0.2000',
      comparisonLandShare: '0.4000',
      deviation: '0.2000',
      threshold: '0.10',
      direction: 'LAND_SHARE_LOWER',
      reasonGiven,
      reviewState: 'CONFIRMED',
      closedBy,
      rule: { ruleCode: 'DE_LAND_BUILDING_PLAUSIBILITY', version: 1 },
    },
  });

  it('201 of a conspicuous allocation carries the open flag at once; the comparison passed on, its landShare derived', async () => {
    const seen: unknown[] = [];
    const base = await start({
      landBuildingAllocations: {
        create: async (input) => {
          seen.push(input);
          return { allocation: stored, replayed: false };
        },
      },
    });
    const res = await call(base, 'POST', `/acquisitions/${ACQ}/land-building-allocation`, { ...body, method: 'PURCHASE_CONTRACT', comparison });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as Record<string, unknown>;
    expect([dto['comparison'], dto['deviationReason'], dto['flags']]).toEqual([{ ...comparison, landShare: '0.4000' }, null, [flag('OPEN', null, false)]]);
    expect(seen[0]).toMatchObject({ comparison: { method: 'BMF_TOOL', sourceReferences: comparison.sourceReferences }, deviationReason: null });
    expect((seen[0] as { comparison: { landValue: Money } }).comparison.landValue.amount).toBe('132200.00');
  });

  it('comparison.landShare is over landValue plus buildingValue, never over the total: 150000.00 / 350000.00 against 400000.00 is 0.3000', async () => {
    const odd: LandBuildingAllocation = {
      ...stored,
      totalAllocableAmount: eur('400000.00'),
      landAmount: eur('40000.00'),
      buildingAmount: eur('360000.00'),
      comparison: { method: 'APPRAISAL', landValue: eur('150000.00'), buildingValue: eur('350000.00'), sourceReferences: ['Gutachten (synthetisch)'] },
    };
    const base = await start({
      landBuildingAllocations: { create: async () => ({ allocation: odd, replayed: false }), list: async () => ({ current: odd, items: [odd] }) },
    });
    const created = (await (await call(base, 'POST', `/acquisitions/${ACQ}/land-building-allocation`, { ...body, comparison })).json()) as Json;
    const listed = (await (await call(base, 'GET', `/acquisitions/${ACQ}/land-building-allocations`)).json()) as { current: Json; items: Json[] };
    for (const dto of [created, listed.current, listed.items[0]]) {
      expect(dto['comparison']['landShare']).toBe('0.3000');
      expect(dto['flags'][0]['details']).toMatchObject({ comparisonLandShare: '0.3000', allocationLandShare: '0.1000', deviation: '0.2000' });
    }
    // The export renders the same DTO (api/exports.ts, propertyExportDto): the same landShare there.
    expect(toDto(odd).comparison?.landShare).toBe('0.3000');
  });

  it('both lists judge each allocation by its own data: the current with the reason INFORMATIVE, the superseded one OPEN', async () => {
    const withReason = { ...stored, deviationReason: reason };
    const old = { ...stored, id: OLD, current: false, supersededById: NEW };
    const base = await start({ landBuildingAllocations: { list: async () => ({ current: withReason, items: [withReason, old] }) } });
    const res = (await (await call(base, 'GET', `/acquisitions/${ACQ}/land-building-allocations`)).json()) as {
      current: Record<string, unknown>;
      items: Record<string, unknown>[];
    };
    expect([res.current['deviationReason'], res.current['flags']]).toEqual([reason, [flag('INFORMATIVE', 'DEVIATION_REASON', true)]]);
    expect(res.items.map((i) => (i['flags'] as { level: string }[]).map((f) => f.level))).toEqual([['INFORMATIVE'], ['OPEN']]);
  });

  it('400: comparison unknown key, method, negative value, sum 0, another currency, empty and missing sources, a reason without comparison, 2001 characters', async () => {
    const base = await start({});
    const fields = async (b: unknown) => (await errorOf(await call(base, 'POST', `/acquisitions/${ACQ}/land-building-allocation`, b))).details;
    const zero = { amount: '0.00', currency: 'EUR' };
    expect(await fields({ ...body, comparison: { ...comparison, landShare: '0.4' } })).toMatchObject({ fields: [{ field: 'comparison' }] });
    expect(await fields({ ...body, comparison: { ...comparison, method: 'PURCHASE_CONTRACT' } })).toMatchObject({ fields: [{ field: 'comparison.method' }] });
    expect(await fields({ ...body, comparison: { ...comparison, landValue: { amount: '-1.00', currency: 'EUR' } } })).toEqual({
      fields: [{ field: 'comparison.landValue.amount', code: 'NEGATIVE_AMOUNT' }],
    });
    expect(await fields({ ...body, comparison: { ...comparison, landValue: zero, buildingValue: zero } })).toEqual({
      fields: [{ field: 'comparison.landValue', code: 'NOT_POSITIVE' }],
    });
    // EUR only (data-model §17.4): another currency is UNSUPPORTED_CURRENCY before any CURRENCY_MISMATCH could arise.
    const usd = { amount: '1.00', currency: 'USD' };
    expect(await fields({ ...body, comparison: { ...comparison, buildingValue: usd } })).toEqual({
      fields: [{ field: 'comparison.buildingValue.currency', code: 'UNSUPPORTED_CURRENCY' }],
    });
    expect(await fields({ ...body, comparison: { ...comparison, sourceReferences: [] } })).toEqual({
      fields: [{ field: 'comparison.sourceReferences', code: 'REQUIRED' }],
    });
    const { sourceReferences: _none, ...withoutSources } = comparison;
    expect(await fields({ ...body, comparison: withoutSources })).toEqual({ fields: [{ field: 'comparison.sourceReferences', code: 'REQUIRED' }] });
    expect(await fields({ ...body, comparison: { ...comparison, sourceReferences: Array.from({ length: 11 }, (_, i) => `Q${i}`) } })).toMatchObject({
      fields: [{ field: 'comparison.sourceReferences' }],
    });
    expect(await fields({ ...body, deviationReason: reason })).toEqual({ fields: [{ field: 'deviationReason', code: 'NOT_SUPPORTED' }] });
    expect(await fields({ ...body, comparison: null, deviationReason: reason })).toEqual({ fields: [{ field: 'deviationReason', code: 'NOT_SUPPORTED' }] });
    expect(await fields({ ...body, comparison, deviationReason: 'x'.repeat(2001) })).toMatchObject({ fields: [{ field: 'deviationReason' }] });
  });

  it('accepted: 2000 characters, a comparison 0.00 / x, ten sources; a conspicuous input is never refused', async () => {
    const base = await start({ landBuildingAllocations: { create: async () => ({ allocation: stored, replayed: false }) } });
    const path = `/acquisitions/${ACQ}/land-building-allocation`;
    const ok = async (b: unknown) => (await call(base, 'POST', path, b)).status;
    expect(await ok({ ...body, comparison, deviationReason: 'x'.repeat(2000) })).toBe(201);
    expect(await ok({ ...body, comparison: { ...comparison, landValue: { amount: '0.00', currency: 'EUR' } } })).toBe(201);
    expect(await ok({ ...body, comparison: { ...comparison, sourceReferences: Array.from({ length: 10 }, (_, i) => `Q${i}`) } })).toBe(201);
    const far = { ...comparison, landValue: { amount: '330000.00', currency: 'EUR' }, buildingValue: { amount: '500.00', currency: 'EUR' } };
    expect(await ok({ ...body, comparison: far })).toBe(201);
  });
});

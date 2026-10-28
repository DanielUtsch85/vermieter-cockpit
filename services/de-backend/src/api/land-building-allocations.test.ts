import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcquisitionCancelledError,
  AcquisitionNotFoundError,
  CurrentAllocationChangedError,
  type LandBuildingAllocation,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
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
    });
    expect(seen[0]).toMatchObject({ acquisitionId: ACQ, reviewState: 'UNREVIEWED', effectiveDate: null, advisorPartyId: null, supersedes: OLD, idempotencyKey: 'k' });
    expect((await call(base, 'POST', `/acquisitions/${ACQ}/land-building-allocation`, body, { 'idempotency-key': 'k' })).headers.get('idempotent-replayed')).toBe('true');
  });

  it('400: the exact sum, a zero total, SUGGESTED, a missing supersedes, documentIds, percentages', async () => {
    const base = await start({});
    const fields = async (b: unknown) => (await errorOf(await call(base, 'POST', `/acquisitions/${ACQ}/land-building-allocation`, b))).details;
    expect(await fields({ ...body, landAmount: { amount: '66100.01', currency: 'EUR' } })).toEqual({ fields: [{ field: 'totalAllocableAmount', code: 'ALLOCATION_SUM_MISMATCH' }] });
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
    expect(await errorOf(await call(base, 'POST', path, body))).toMatchObject({ code: 'CONFLICT', details: { reason: 'CURRENT_ALLOCATION_CHANGED', currentAllocationId: NEW } });
  });
});

describe('GET /api/v1/acquisitions/{id}/land-building-allocations', () => {
  it('current and history; unknown parameters 400', async () => {
    const base = await start({
      landBuildingAllocations: { list: async () => ({ current: allocation, items: [allocation, { ...allocation, id: OLD, current: false, supersededById: NEW }] }) },
    });
    const res = await call(base, 'GET', `/acquisitions/${ACQ}/land-building-allocations`);
    expect(await res.json()).toMatchObject({ current: { allocationId: NEW }, items: [{ allocationId: NEW }, { allocationId: OLD, current: false, supersededById: NEW }] });
    expect((await call(base, 'GET', `/acquisitions/${ACQ}/land-building-allocations?page=1`)).status).toBe(400);
  });
});

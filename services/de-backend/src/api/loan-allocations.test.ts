import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcquisitionNotFoundError,
  AllocationNotLastError,
  AllocationRefusedError,
  IdempotencyKeyConflictError,
  LoanAllocationSetNotFoundError,
  LoanNotActiveError,
  LoanNotFoundError,
  PropertyReferenceNotFoundError,
  VersionConflictError,
  type CreateLoanAllocationInput,
  type LoanAllocationSetView,
  type PrincipalVerifier,
  type PropertyLoan,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-3-03 HTTP contract (api-design.md §41.3). */
const REALM = '64b0c0ffee0000000000000a';
const LOAN = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const SET = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const P1 = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const P2 = '3b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const A1 = '4b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const A2 = '5b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const f = (n: bigint, d: bigint) => ({ numerator: n, denominator: d });
const view = {
  id: SET,
  loanId: LOAN,
  mreRealmId: REALM,
  status: 'VALID',
  validFrom: '2026-09-01',
  validUntil: null,
  basis: 'PURCHASE_PRICE',
  allocations: [
    { propertyReferenceId: P1, share: f(10_000_001n, 20_000_000n), acquisitionId: A1 },
    { propertyReferenceId: P2, share: f(9_999_999n, 20_000_000n), acquisitionId: A2 },
  ],
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2026-08-20T10:00:00Z'),
  version: 1,
} as unknown as LoanAllocationSetView;

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
const manual = {
  validFrom: '2026-09-01',
  allocations: [
    { propertyReferenceId: P1, share: '2/6' },
    { propertyReferenceId: P2, share: '2/3' },
  ],
};
const byPrice = {
  validFrom: '2026-09-01',
  basis: 'PURCHASE_PRICE',
  allocations: [
    { propertyReferenceId: P1, acquisitionId: A1 },
    { propertyReferenceId: P2, acquisitionId: A2 },
  ],
};

describe('POST /api/v1/loans/{id}/allocations', () => {
  it('201 with the set, shares as reduced "n/d", ETag; MANUAL by default with reduced shares; a replay is marked', async () => {
    const seen: CreateLoanAllocationInput[] = [];
    let replayed = false;
    const base = await start({
      loanAllocations: {
        create: async (input) => {
          seen.push(input);
          const answer = { set: view, replayed };
          replayed = true;
          return answer;
        },
      },
    });
    const res = await call(base, 'POST', `/loans/${LOAN}/allocations`, { ...manual, notes: '  ' }, { 'idempotency-key': 'a1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.json()).toEqual({
      allocationSetId: SET,
      loanId: LOAN,
      status: 'VALID',
      validFrom: '2026-09-01',
      validUntil: null,
      basis: 'PURCHASE_PRICE',
      allocations: [
        { propertyReferenceId: P1, share: '10000001/20000000', acquisitionId: A1 },
        { propertyReferenceId: P2, share: '9999999/20000000', acquisitionId: A2 },
      ],
      notes: null,
      voidedAt: null,
      voidReason: null,
      createdAt: '2026-08-20T10:00:00.000Z',
      version: 1,
    });
    expect(seen[0]).toEqual({
      principal: expect.anything(),
      loanId: LOAN,
      validFrom: '2026-09-01',
      basis: 'MANUAL',
      allocations: [
        { propertyReferenceId: P1, share: f(1n, 3n), acquisitionId: null },
        { propertyReferenceId: P2, share: f(2n, 3n), acquisitionId: null },
      ],
      notes: null,
      idempotencyKey: 'a1',
    });
    expect((await call(base, 'POST', `/loans/${LOAN}/allocations`, manual, { 'idempotency-key': 'a1' })).headers.get('idempotent-replayed')).toBe('true');
    await call(base, 'POST', `/loans/${LOAN}/allocations`, byPrice);
    expect(seen[2]).toMatchObject({
      basis: 'PURCHASE_PRICE',
      allocations: [
        { propertyReferenceId: P1, share: null, acquisitionId: A1 },
        { share: null, acquisitionId: A2 },
      ],
    });
  });

  it('400 with the field codes', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', `/loans/${LOAN}/allocations`, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    const entry = (share: string) => ({ ...manual, allocations: [{ propertyReferenceId: P1, share }] });
    expect(
      await fieldsOf({
        ...manual,
        allocations: [
          { propertyReferenceId: P1, share: '1/3' },
          { propertyReferenceId: P2, share: '1/3' },
        ],
      }),
    ).toEqual([{ field: 'allocations', code: 'SHARE_SUM_NOT_ONE' }]);
    expect(
      await fieldsOf({
        ...manual,
        allocations: [
          { propertyReferenceId: P1, share: '1/3' },
          { propertyReferenceId: P2, share: '2/3' },
          { propertyReferenceId: A1, share: '1/10000' },
        ],
      }),
    ).toEqual([{ field: 'allocations', code: 'SHARE_SUM_NOT_ONE' }]);
    expect(await fieldsOf(entry('1/10001'))).toEqual([{ field: 'allocations.0.share', code: 'OUT_OF_RANGE' }]);
    expect(await fieldsOf(entry('2/1'))).toEqual([{ field: 'allocations.0.share', code: 'OUT_OF_RANGE' }]);
    expect(await fieldsOf(entry('0/1'))).toEqual([{ field: 'allocations.0.share', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf(entry('0.5'))).toEqual([{ field: 'allocations.0.share', code: 'INVALID_FORMAT' }]);
    expect(
      await fieldsOf({
        ...manual,
        allocations: [
          { propertyReferenceId: P1, share: '1/2' },
          { propertyReferenceId: P1.toUpperCase(), share: '1/2' },
        ],
      }),
    ).toEqual([{ field: 'allocations.1.propertyReferenceId', code: 'DUPLICATE' }]);
    expect(await fieldsOf({ ...manual, allocations: [{ propertyReferenceId: P1 }] })).toEqual([{ field: 'allocations.0.share', code: 'REQUIRED' }]);
    expect(await fieldsOf({ ...manual, allocations: [{ propertyReferenceId: P1, share: '1/1', acquisitionId: A1 }] })).toEqual([
      { field: 'allocations.0.acquisitionId', code: 'NOT_ALLOWED_FOR_BASIS' },
    ]);
    expect(await fieldsOf({ ...byPrice, allocations: [{ propertyReferenceId: P1, acquisitionId: A1, share: '1/1' }] })).toEqual([
      { field: 'allocations.0.share', code: 'NOT_ALLOWED_FOR_BASIS' },
    ]);
    expect(await fieldsOf({ ...byPrice, allocations: [{ propertyReferenceId: P1 }] })).toEqual([{ field: 'allocations.0.acquisitionId', code: 'REQUIRED' }]);
    expect(
      await fieldsOf({
        ...byPrice,
        allocations: [
          { propertyReferenceId: P1, acquisitionId: A1 },
          { propertyReferenceId: P2, acquisitionId: A1 },
        ],
      }),
    ).toEqual([{ field: 'allocations.1.acquisitionId', code: 'DUPLICATE' }]);
    expect(await fieldsOf({ ...manual, allocations: [] })).toEqual([{ field: 'allocations', code: 'INVALID_FORMAT' }]);
    const many = Array.from({ length: 51 }, (_, i) => ({
      propertyReferenceId: `${i.toString(16).padStart(8, '0')}-2f2c-4a8e-9d55-1f0d8c1e2a3b`,
      share: '1/51',
    }));
    expect(await fieldsOf({ ...manual, allocations: many })).toEqual([{ field: 'allocations', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf({ ...manual, basis: 'AREA' })).toEqual([{ field: 'basis', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf({ ...manual, allocations: [{ propertyReferenceId: 'x', share: '1/1' }] })).toEqual([
      { field: 'allocations.0.propertyReferenceId', code: 'INVALID_FORMAT' },
    ]);
    await fieldsOf({ ...manual, validFrom: 'x' });
    await fieldsOf({ ...manual, unknown: 1 });
    expect((await call(base, 'POST', '/loans/x/allocations', manual)).status).toBe(400);
  });

  it.each([
    [new LoanNotFoundError(LOAN), 404, 'NOT_FOUND', { loanId: LOAN }],
    [new PropertyReferenceNotFoundError(P2), 404, 'NOT_FOUND', { propertyReferenceId: P2 }],
    [new AcquisitionNotFoundError(A2), 404, 'NOT_FOUND', { acquisitionId: A2 }],
    [new LoanNotActiveError(LOAN, 'VOID'), 409, 'CONFLICT', { reason: 'LOAN_NOT_ACTIVE', status: 'VOID' }],
    [
      new AllocationRefusedError({ kind: 'ALLOCATION_BEFORE_DEBT', debtFrom: '2026-09-01' as never }),
      422,
      'ALLOCATION_BEFORE_DEBT',
      { debtFrom: '2026-09-01' },
    ],
    [
      new AllocationRefusedError({ kind: 'ALLOCATION_NOT_APPENDED', lastValidFrom: '2026-09-01' as never }),
      422,
      'ALLOCATION_NOT_APPENDED',
      { lastValidFrom: '2026-09-01' },
    ],
    [new AllocationRefusedError({ kind: 'ACQUISITION_CANCELLED', acquisitionId: A1 }), 422, 'ACQUISITION_CANCELLED', { acquisitionId: A1 }],
    [new IdempotencyKeyConflictError('x'), 409, 'CONFLICT', undefined],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ loanAllocations: { create: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', `/loans/${LOAN}/allocations`, manual);
    expect(res.status).toBe(status);
    const answer = await errorOf(res);
    expect(answer.code).toBe(code);
    expect(answer.details).toEqual(details);
  });
});

describe('POST /api/v1/loans/{id}/allocations/{setId}/void', () => {
  it('200 with the set; the reason is required; If-Match carries the versions', async () => {
    const seen: unknown[] = [];
    const base = await start({
      loanAllocations: {
        void: async (input) => {
          seen.push(input);
          return { set: { ...view, status: 'VOID', voidReason: input.reason, version: 2 } as LoanAllocationSetView, changed: true };
        },
      },
    });
    const res = await call(base, 'POST', `/loans/${LOAN}/allocations/${SET}/void`, { reason: ' falsch ' }, { 'if-match': '"1"' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(await res.json()).toMatchObject({ status: 'VOID', voidReason: 'falsch', version: 2 });
    expect(seen[0]).toMatchObject({ loanId: LOAN, allocationSetId: SET, expectedVersions: [1] });
    expect((await call(base, 'POST', `/loans/${LOAN}/allocations/${SET}/void`, {})).status).toBe(400);
    expect((await call(base, 'POST', `/loans/${LOAN}/allocations/x/void`, { reason: 'x' })).status).toBe(400);
  });

  it.each([
    [new LoanAllocationSetNotFoundError(SET), 404, 'NOT_FOUND', { allocationSetId: SET }],
    [new LoanNotActiveError(LOAN, 'CLOSED'), 409, 'CONFLICT', { reason: 'LOAN_NOT_ACTIVE', status: 'CLOSED' }],
    [new AllocationNotLastError(SET, LOAN), 409, 'CONFLICT', { reason: 'ALLOCATION_NOT_LAST', laterAllocationSetId: LOAN }],
    [new VersionConflictError([1], 2), 412, 'VERSION_CONFLICT', { expectedVersions: [1], currentVersion: 2 }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ loanAllocations: { void: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', `/loans/${LOAN}/allocations/${SET}/void`, { reason: 'x' });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});

describe('GET /api/v1/loans/{id}/allocations', () => {
  it('the history with ?status; the set on a day with ?asOf, null while unallocated; both together 400; an unknown Loan 404', async () => {
    const seen: unknown[] = [];
    const base = await start({
      loanAllocations: {
        list: async (input) => {
          seen.push(input);
          if (input.loanId !== LOAN) throw new LoanNotFoundError(input.loanId);
          return [view];
        },
        on: async (input) => {
          seen.push(input);
          return input.asOf < '2026-09-01' ? null : view;
        },
      },
    });
    const res = await call(base, 'GET', `/loans/${LOAN}/allocations?status=VALID`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ allocationSetId: SET, allocations: [{ share: '10000001/20000000' }, {}] }] });
    expect(seen[0]).toMatchObject({ loanId: LOAN, status: 'VALID' });
    expect(await (await call(base, 'GET', `/loans/${LOAN}/allocations?asOf=2026-09-01`)).json()).toMatchObject({
      asOf: '2026-09-01',
      set: { allocationSetId: SET },
    });
    expect(await (await call(base, 'GET', `/loans/${LOAN}/allocations?asOf=2026-08-31`)).json()).toEqual({ asOf: '2026-08-31', set: null });
    const both = await call(base, 'GET', `/loans/${LOAN}/allocations?asOf=2026-09-01&status=VALID`);
    expect(both.status).toBe(400);
    expect(((await errorOf(both)).details as { fields: unknown[] }).fields).toEqual([{ field: 'status', code: 'NOT_SUPPORTED' }]);
    expect((await call(base, 'GET', `/loans/${LOAN}/allocations?page=1`)).status).toBe(400);
    expect((await call(base, 'GET', `/loans/${LOAN}/allocations?asOf=x`)).status).toBe(400);
    expect((await call(base, 'GET', `/loans/${SET}/allocations`)).status).toBe(404);
  });
});

describe('GET /api/v1/property-references/{id}/loans', () => {
  it('the items with the property’s share; ?asOf reaches the read; unknown parameters 400; an unknown PropertyReference 404', async () => {
    const seen: unknown[] = [];
    const item: PropertyLoan = {
      loanId: LOAN,
      status: 'ACTIVE',
      lenderPartyId: A1,
      principalOriginal: Money.of('475000.00', 'EUR'),
      allocationSetId: SET,
      validFrom: '2026-09-01' as never,
      validUntil: null,
      basis: 'PURCHASE_PRICE',
      share: f(12n, 19n),
    };
    const base = await start({
      loanAllocations: {
        propertyLoans: async (input) => {
          seen.push(input);
          if (input.propertyReferenceId !== P1) throw new PropertyReferenceNotFoundError(input.propertyReferenceId);
          return [item];
        },
      },
    });
    const res = await call(base, 'GET', `/property-references/${P1}/loans?asOf=2026-09-01`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          loanId: LOAN,
          status: 'ACTIVE',
          lenderPartyId: A1,
          principalOriginal: { amount: '475000.00', currency: 'EUR' },
          allocationSetId: SET,
          validFrom: '2026-09-01',
          validUntil: null,
          basis: 'PURCHASE_PRICE',
          share: '12/19',
        },
      ],
    });
    expect(seen[0]).toMatchObject({ propertyReferenceId: P1, asOf: '2026-09-01' });
    await call(base, 'GET', `/property-references/${P1}/loans`);
    expect(seen[1]).not.toHaveProperty('asOf');
    expect((await call(base, 'GET', `/property-references/${P1}/loans?status=VALID`)).status).toBe(400);
    const missing = await call(base, 'GET', `/property-references/${P2}/loans`);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).details).toEqual({ propertyReferenceId: P2 });
    expect((await call(base, 'GET', `/property-references/x/loans`)).status).toBe(400);
  });
});

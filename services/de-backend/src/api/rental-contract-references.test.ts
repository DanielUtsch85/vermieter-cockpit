import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MreUnavailableError,
  RentalContractReferenceExistsError,
  RentalContractReferenceNotFoundError,
  RentalContractTenantNotFoundError,
  VersionConflictError,
  type CreateRentalContractReferenceInput,
  type PrincipalVerifier,
  type RentalContractReference,
} from '../application/index.js';
import type { BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-7-02 HTTP contract of the RentalContractReference (api-design.md §58A): every 400, the error mapping, the DTO. Figures are invented. */
const REALM = '64b0c0ffee000000000000c7';
const TENANT = '6512f0c2a1b2c3d4e5f6a7c1';
const REF = '7c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const OTHER = '8c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';

const reference: RentalContractReference = {
  id: REF as RentalContractReference['id'],
  mreRealmId: REALM,
  mreTenantId: TENANT,
  rentDueDays: [
    { validFrom: '2025-01-01' as BusinessDate, day: 3 },
    { validFrom: '2028-01-01' as BusinessDate, day: 15 },
  ],
  notes: 'Mietvertrag § 4',
  sourceReferences: ['Mietvertrag 2025'],
  createdAt: new Date('2026-10-30T10:00:00Z'),
  createdBy: 'anna@example.com',
  version: 2,
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
const get = (base: string, path: string) => fetch(`${base}/api/v1${path}`, { headers });
const fields = async (res: Response) => {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: { details: { fields: { field: string; code: string }[] } } }).error.details.fields;
};
const dto = {
  rentalContractReferenceId: REF,
  mreRealmId: REALM,
  mreTenantId: TENANT,
  rentDueDays: [
    { validFrom: '2025-01-01', day: 3 },
    { validFrom: '2028-01-01', day: 15 },
  ],
  notes: 'Mietvertrag § 4',
  sourceReferences: ['Mietvertrag 2025'],
  createdAt: '2026-10-30T10:00:00.000Z',
  createdBy: 'anna@example.com',
  version: 2,
};

describe('POST /rental-contract-references (§58A)', () => {
  it('201 with the DTO, ETag and Location; the defaults; the caller’s token and the key passed; a replay marked', async () => {
    const seen: CreateRentalContractReferenceInput[] = [];
    const base = await start({
      rentalContractReferences: {
        create: async (input) => {
          seen.push(input);
          return { reference, replayed: input.idempotencyKey === 'again' };
        },
      },
    });
    const body = { mreTenantId: TENANT, rentDueDays: dto.rentDueDays, notes: 'Mietvertrag § 4', sourceReferences: ['Mietvertrag 2025'] };
    const res = await post(base, '/rental-contract-references', body, { 'idempotency-key': 'k1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(res.headers.get('location')).toBe(`/api/v1/rental-contract-references/${REF}`);
    expect(await res.json()).toEqual(dto);
    expect(seen[0]).toMatchObject({ ...body, authorizationHeader: 'Bearer a.b.c', idempotencyKey: 'k1', principal: { mreRealmId: REALM } });
    expect((await post(base, '/rental-contract-references', { mreTenantId: TENANT })).status).toBe(201);
    expect(seen[1]).toMatchObject({ rentDueDays: [], notes: null, sourceReferences: [] });
    const replayed = await post(base, '/rental-contract-references', body, { 'idempotency-key': 'again' });
    expect(replayed.headers.get('idempotent-replayed')).toBe('true');
  });

  it('every 400: the Tenant id, the due days (day 1–31, validFrom a date, unique and ascending, at most 20), texts, unknown fields', async () => {
    const base = await start({});
    const send = (payload: unknown) => post(base, '/rental-contract-references', payload);
    expect(await fields(await send({}))).toEqual([{ field: 'mreTenantId', code: 'REQUIRED' }]);
    expect(await fields(await send({ mreTenantId: 'x' }))).toEqual([{ field: 'mreTenantId', code: 'INVALID_FORMAT' }]);
    const days = (rentDueDays: unknown) => send({ mreTenantId: TENANT, rentDueDays });
    expect(await fields(await days([{ validFrom: '2025-01-01', day: 0 }]))).toEqual([{ field: 'rentDueDays.0.day', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await days([{ validFrom: '2025-01-01', day: 32 }]))).toEqual([{ field: 'rentDueDays.0.day', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await days([{ validFrom: '2025-01-01', day: 3.5 }]))).toEqual([{ field: 'rentDueDays.0.day', code: 'INVALID_FORMAT' }]);
    expect(await fields(await days([{ validFrom: '2025-02-30', day: 3 }]))).toEqual([{ field: 'rentDueDays.0.validFrom', code: 'INVALID_FORMAT' }]);
    expect(await fields(await days([{ validFrom: '2025-01-01' }]))).toEqual([{ field: 'rentDueDays.0.day', code: 'REQUIRED' }]);
    expect(await fields(await days([{ validFrom: '2025-01-01', day: 3, note: 'x' }]))).toEqual([{ field: 'rentDueDays.0', code: 'INVALID_FORMAT' }]);
    expect(
      await fields(
        await days([
          { validFrom: '2028-01-01', day: 3 },
          { validFrom: '2025-01-01', day: 15 },
        ]),
      ),
    ).toEqual([{ field: 'rentDueDays.1.validFrom', code: 'NOT_ASCENDING' }]);
    expect(
      await fields(
        await days([
          { validFrom: '2025-01-01', day: 3 },
          { validFrom: '2025-01-01', day: 15 },
        ]),
      ),
    ).toEqual([{ field: 'rentDueDays.1.validFrom', code: 'NOT_ASCENDING' }]);
    expect(await fields(await days(Array.from({ length: 21 }, (_, i) => ({ validFrom: `${2000 + i}-01-01`, day: 1 }))))).toEqual([
      { field: 'rentDueDays', code: 'OUT_OF_RANGE' },
    ]);
    expect(await fields(await send({ mreTenantId: TENANT, notes: 'x'.repeat(2001) }))).toEqual([{ field: 'notes', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send({ mreTenantId: TENANT, sourceReferences: Array.from({ length: 11 }, (_, i) => `R${i}`) }))).toEqual([
      { field: 'sourceReferences', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await send({ mreTenantId: TENANT, mreLeaseDefinitionId: 'x' }))).toEqual([{ field: '(body)', code: 'INVALID_FORMAT' }]);
  });

  it('the error mapping of a create', async () => {
    const cases: [Error, number, Record<string, unknown>][] = [
      [new RentalContractTenantNotFoundError(TENANT), 422, { code: 'MRE_TENANT_NOT_FOUND', details: { mreTenantId: TENANT } }],
      [new MreUnavailableError('down'), 503, { code: 'EXTERNAL_SYSTEM_ERROR' }],
      [
        new RentalContractReferenceExistsError(REF),
        409,
        { code: 'CONFLICT', details: { reason: 'RENTAL_CONTRACT_REFERENCE_EXISTS', rentalContractReferenceId: REF } },
      ],
    ];
    for (const [error, status, answer] of cases) {
      const base = await start({ rentalContractReferences: { create: () => Promise.reject(error) } });
      const res = await post(base, '/rental-contract-references', { mreTenantId: TENANT });
      expect(res.status, error.name).toBe(status);
      expect(((await res.json()) as { error: unknown }).error).toMatchObject(answer);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});

describe('amend and reads (§58A)', () => {
  it('amend: the fields given, If-Match passed, ETag; mreTenantId NOT_AMENDABLE; 404 and 412', async () => {
    const seen: unknown[] = [];
    const base = await start({
      rentalContractReferences: {
        amend: async (input) => {
          if (input.rentalContractReferenceId !== REF) throw new RentalContractReferenceNotFoundError(input.rentalContractReferenceId);
          if (input.expectedVersions?.[0] === 1) throw new VersionConflictError([1], 2);
          seen.push(input);
          return { reference, changed: true };
        },
      },
    });
    const path = (id: string) => `/rental-contract-references/${id}/amend`;
    const res = await post(base, path(REF), { rentDueDays: [{ validFrom: '2025-01-01', day: 5 }] }, { 'if-match': '"2"' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(seen[0]).toMatchObject({ rentDueDays: [{ validFrom: '2025-01-01', day: 5 }], expectedVersions: [2] });
    expect(seen[0]).not.toHaveProperty('notes');
    await post(base, path(REF), { notes: '' });
    expect(seen[1]).toMatchObject({ notes: null });
    expect(await fields(await post(base, path(REF), { mreTenantId: TENANT }))).toEqual([{ field: 'mreTenantId', code: 'NOT_AMENDABLE' }]);
    expect(await fields(await post(base, path(REF), { rentDueDays: [{ validFrom: '2025-01-01', day: 40 }] }))).toEqual([
      { field: 'rentDueDays.0.day', code: 'OUT_OF_RANGE' },
    ]);
    expect(await fields(await post(base, path('x'), {}))).toEqual([{ field: 'rentalContractReferenceId', code: 'INVALID_FORMAT' }]);
    const missing = await post(base, path(OTHER), {});
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: unknown }).error).toMatchObject({ code: 'NOT_FOUND', details: { rentalContractReferenceId: OTHER } });
    expect((await post(base, path(REF), {}, { 'if-match': '"1"' })).status).toBe(412);
  });

  it('GET one with ETag; GET ?mreTenantId= one or none; their 400s and 404', async () => {
    const base = await start({
      rentalContractReferences: {
        get: async ({ rentalContractReferenceId }) => {
          if (rentalContractReferenceId !== REF) throw new RentalContractReferenceNotFoundError(rentalContractReferenceId);
          return reference;
        },
        list: async ({ mreTenantId }) => (mreTenantId === TENANT ? [reference] : []),
      },
    });
    const one = await get(base, `/rental-contract-references/${REF}`);
    expect(one.status).toBe(200);
    expect(one.headers.get('etag')).toBe('"2"');
    expect(await one.json()).toEqual(dto);
    expect((await get(base, `/rental-contract-references/${OTHER}`)).status).toBe(404);
    expect(await (await get(base, `/rental-contract-references?mreTenantId=${TENANT}`)).json()).toEqual({ items: [dto] });
    expect(await (await get(base, `/rental-contract-references?mreTenantId=6512f0c2a1b2c3d4e5f6a7ff`)).json()).toEqual({ items: [] });
    expect(await fields(await get(base, '/rental-contract-references'))).toEqual([{ field: 'mreTenantId', code: 'REQUIRED' }]);
    expect(await fields(await get(base, '/rental-contract-references?mreTenantId=x'))).toEqual([{ field: 'mreTenantId', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, `/rental-contract-references/x`))).toEqual([{ field: 'rentalContractReferenceId', code: 'INVALID_FORMAT' }]);
  });
});

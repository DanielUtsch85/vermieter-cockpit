import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcquisitionCancelledError,
  AcquisitionConfirmedError,
  ConfirmationBlockedError,
  AcquisitionHasValidOwnershipsError,
  AcquisitionNotFoundError,
  IdempotencyKeyConflictError,
  OwnerInactiveError,
  PartyNotFoundError,
  PropertyReferenceNotFoundError,
  VersionConflictError,
  type Acquisition,
  type CreateAcquisitionInput,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-2-05 HTTP contract (api-design.md §27.1). */
const REALM = '64b0c0ffee0000000000000a';
const ID = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const PR = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const BUYER = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const SELLER = '3b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const acquisition = {
  id: ID,
  mreRealmId: REALM,
  propertyReferenceId: PR,
  status: 'DRAFT',
  purchasePrice: Money.of('350000.00', 'EUR'),
  acquiredShare: { numerator: 1, denominator: 2 },
  contractDate: '2026-06-15',
  economicTransferDate: null,
  landRegistryTransferDate: null,
  buyerPartyIds: [BUYER],
  sellerPartyIds: [SELLER],
  sourceReferences: [],
  notes: null,
  cancelledAt: null,
  cancellationReason: null,
  confirmedAt: null,
  createdAt: new Date('2026-10-25T08:00:00Z'),
  version: 1,
} as unknown as Acquisition;

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
  propertyReferenceId: PR,
  purchasePrice: { amount: '350000.00', currency: 'EUR' },
  acquiredShare: '2/4',
  contractDate: '2026-06-15',
  buyerPartyIds: [BUYER.toUpperCase()],
  sellerPartyIds: [SELLER],
};

describe('POST /api/v1/acquisitions', () => {
  it('201 with the draft, its transferDate and ETag; the share reduced, the default share 1/1; a replay is marked', async () => {
    const seen: CreateAcquisitionInput[] = [];
    let replayed = false;
    const base = await start({
      acquisitions: {
        create: async (input) => {
          seen.push(input);
          const answer = { acquisition, replayed };
          replayed = true;
          return answer;
        },
      },
    });
    const res = await call(base, 'POST', '/acquisitions', body, { 'idempotency-key': 'a1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.json()).toEqual({
      acquisitionId: ID,
      mreRealmId: REALM,
      propertyReferenceId: PR,
      status: 'DRAFT',
      purchasePrice: { amount: '350000.00', currency: 'EUR' },
      acquiredShare: '1/2',
      contractDate: '2026-06-15',
      economicTransferDate: null,
      landRegistryTransferDate: null,
      transferDate: '2026-06-15',
      buyerPartyIds: [BUYER],
      sellerPartyIds: [SELLER],
      sourceReferences: [],
      notes: null,
      cancelledAt: null,
      cancellationReason: null,
      confirmedAt: null,
      createdAt: '2026-10-25T08:00:00.000Z',
      version: 1,
    });
    expect(seen[0]).toMatchObject({ acquiredShare: { numerator: 1, denominator: 2 }, buyerPartyIds: [BUYER], sellerPartyIds: [SELLER], idempotencyKey: 'a1' });
    expect((await call(base, 'POST', '/acquisitions', body, { 'idempotency-key': 'a1' })).headers.get('idempotent-replayed')).toBe('true');
    const { acquiredShare: _share, sellerPartyIds: _sellers, ...minimal } = body;
    await call(base, 'POST', '/acquisitions', minimal);
    expect(seen[2]).toMatchObject({ acquiredShare: { numerator: 1, denominator: 1 }, sellerPartyIds: [], economicTransferDate: null });
  });

  it('400 with the field codes', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', '/acquisitions', payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({ ...body, purchasePrice: { amount: '0.00', currency: 'EUR' } })).toEqual([{ field: 'purchasePrice.amount', code: 'NOT_POSITIVE' }]);
    expect(await fieldsOf({ ...body, purchasePrice: { amount: '-1.00', currency: 'EUR' } })).toEqual([{ field: 'purchasePrice.amount', code: 'NEGATIVE_AMOUNT' }]);
    expect(await fieldsOf({ ...body, economicTransferDate: '2026-06-14' })).toEqual([{ field: 'economicTransferDate', code: 'BEFORE_CONTRACT_DATE' }]);
    expect(await fieldsOf({ ...body, landRegistryTransferDate: '2026-06-14' })).toEqual([{ field: 'landRegistryTransferDate', code: 'BEFORE_CONTRACT_DATE' }]);
    expect(await fieldsOf({ ...body, buyerPartyIds: [BUYER, BUYER] })).toEqual([{ field: 'buyerPartyIds.1', code: 'DUPLICATE' }]);
    expect(await fieldsOf({ ...body, sellerPartyIds: [BUYER] })).toEqual([{ field: 'sellerPartyIds.0', code: 'BUYER_IS_SELLER' }]);
    expect(await fieldsOf({ ...body, buyerPartyIds: [] })).toEqual([{ field: 'buyerPartyIds', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf({ ...body, notarialDocumentId: ID })).toEqual([{ field: 'notarialDocumentId', code: 'NOT_SUPPORTED' }]);
    expect(await fieldsOf({ ...body, acquiredShare: '3/2' })).toEqual([{ field: 'acquiredShare', code: 'OUT_OF_RANGE' }]);
    for (const bad of [{ ...body, possessionTransferDate: '2026-08-01' }, { ...body, contractDate: 'x' }, { ...body, purchasePrice: 1000 }]) await fieldsOf(bad);
  });

  it.each([
    [new PropertyReferenceNotFoundError(PR), 404, 'NOT_FOUND', { propertyReferenceId: PR }],
    [new PartyNotFoundError(BUYER), 404, 'NOT_FOUND', { partyId: BUYER }],
    [new OwnerInactiveError(BUYER), 422, 'PARTY_INACTIVE', { partyId: BUYER }],
    [new IdempotencyKeyConflictError('x'), 409, 'CONFLICT', undefined],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ acquisitions: { create: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', '/acquisitions', body);
    expect(res.status).toBe(status);
    const answer = await errorOf(res);
    expect(answer.code).toBe(code);
    if (details !== undefined) expect(answer.details).toEqual(details);
  });
});

describe('POST /api/v1/acquisitions/{id}/confirm', () => {
  it('200 with the confirmed Acquisition and its ETag; a no-op is marked; If-Match passed on; 409, 422 with the violations, 400', async () => {
    const seen: unknown[] = [];
    const outcomes: unknown[] = [
      { acquisition: { ...acquisition, status: 'CONFIRMED', confirmedAt: new Date('2026-10-26T10:00:00Z'), version: 2 }, changed: true },
      { acquisition: { ...acquisition, status: 'CONFIRMED', version: 2 }, changed: false },
      new AcquisitionCancelledError(ID),
      new ConfirmationBlockedError(ID, [
        { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: BUYER },
        { code: 'SHARE_SUM_MISMATCH', expected: { numerator: 1n, denominator: 2n }, actual: { numerator: 3n, denominator: 8n } },
        { code: 'OWNERSHIP_INCOMPLETE', date: '2026-08-01' as never, shareSum: { numerator: 1n, denominator: 8n } },
      ]),
      new VersionConflictError([1], 2),
    ];
    const base = await start({
      acquisitions: {
        confirm: async (input) => {
          seen.push(input);
          const next = outcomes.shift();
          if (next instanceof Error) throw next;
          return next as never;
        },
      },
    });
    const ok = await call(base, 'POST', `/acquisitions/${ID}/confirm`, undefined, { 'if-match': '"1"' });
    expect([ok.status, ok.headers.get('etag'), ok.headers.get('idempotent-replayed')]).toEqual([200, '"2"', null]);
    expect(await ok.json()).toMatchObject({ status: 'CONFIRMED', confirmedAt: '2026-10-26T10:00:00.000Z' });
    expect(seen[0]).toEqual({ principal: expect.anything(), acquisitionId: ID, expectedVersions: [1] });
    expect((await call(base, 'POST', `/acquisitions/${ID}/confirm`, {})).headers.get('idempotent-replayed')).toBe('true');
    expect(await errorOf(await call(base, 'POST', `/acquisitions/${ID}/confirm`))).toMatchObject({ code: 'CONFLICT', details: { reason: 'ACQUISITION_CANCELLED' } });
    const blocked = await call(base, 'POST', `/acquisitions/${ID}/confirm`);
    expect(blocked.status).toBe(422);
    expect(await errorOf(blocked)).toEqual({
      code: 'CONFIRMATION_BLOCKED',
      message: 'The Acquisition does not meet the requirements of confirmation.',
      details: {
        violations: [
          { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: BUYER },
          { code: 'SHARE_SUM_MISMATCH', expected: '1/2', actual: '3/8' },
          { code: 'OWNERSHIP_INCOMPLETE', date: '2026-08-01', shareSum: '1/8' },
        ],
      },
    });
    expect((await call(base, 'POST', `/acquisitions/${ID}/confirm`)).status).toBe(412);
    expect((await call(base, 'POST', `/acquisitions/${ID}/confirm`, { force: true })).status).toBe(400);
  });
});

describe('cancel and reads', () => {
  it('cancel passes the reason and If-Match; 409 for confirmed or carried by Ownerships; 404; 412', async () => {
    const seen: unknown[] = [];
    const base = await start({
      acquisitions: {
        cancel: async (input) => {
          seen.push(input);
          if (input.reason === 'confirmed') throw new AcquisitionConfirmedError(ID);
          if (input.reason === 'owned') throw new AcquisitionHasValidOwnershipsError(ID, [PR]);
          if (input.expectedVersions?.includes(7)) throw new VersionConflictError([7], 1);
          if (input.acquisitionId !== ID) throw new AcquisitionNotFoundError(input.acquisitionId);
          return { acquisition: { ...acquisition, status: 'CANCELLED', cancellationReason: input.reason, cancelledAt: new Date('2026-10-25T09:00:00Z') }, changed: true };
        },
      },
    });
    const res = await call(base, 'POST', `/acquisitions/${ID}/cancel`, { reason: ' geplatzt ' }, { 'if-match': '"1"' });
    expect(await res.json()).toMatchObject({ status: 'CANCELLED', cancellationReason: 'geplatzt', cancelledAt: '2026-10-25T09:00:00.000Z' });
    expect(seen[0]).toEqual(expect.objectContaining({ acquisitionId: ID, reason: 'geplatzt', expectedVersions: [1] }));
    expect(await errorOf(await call(base, 'POST', `/acquisitions/${ID}/cancel`, { reason: 'confirmed' }))).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'ACQUISITION_CONFIRMED' },
    });
    expect(await errorOf(await call(base, 'POST', `/acquisitions/${ID}/cancel`, { reason: 'owned' }))).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'ACQUISITION_HAS_VALID_OWNERSHIPS', ownershipIds: [PR] },
    });
    expect((await call(base, 'POST', `/acquisitions/${ID}/cancel`, { reason: 'x' }, { 'if-match': '"7"' })).status).toBe(412);
    expect((await call(base, 'POST', `/acquisitions/${PR}/cancel`, { reason: 'x' })).status).toBe(404);
    for (const bad of [{}, { reason: ' ' }, { reason: 'x', extra: 1 }]) expect((await call(base, 'POST', `/acquisitions/${ID}/cancel`, bad)).status).toBe(400);
  });

  it('get with ETag; lists with their filters and paging; the PropertyReference list is 404 for an unknown one', async () => {
    const seen: unknown[] = [];
    const base = await start({
      acquisitions: {
        get: async ({ acquisitionId }) => {
          if (acquisitionId !== ID) throw new AcquisitionNotFoundError(acquisitionId);
          return acquisition;
        },
        list: async (input) => {
          seen.push(input);
          return { items: [acquisition], page: input.page.page, pageSize: input.page.pageSize, total: 1 };
        },
        listForPropertyReference: async (input) => {
          seen.push(input);
          if (input.propertyReferenceId !== PR) throw new PropertyReferenceNotFoundError(input.propertyReferenceId);
          return { items: [], page: 1, pageSize: 50, total: 0 };
        },
      },
    });
    expect((await call(base, 'GET', `/acquisitions/${ID}`)).headers.get('etag')).toBe('"1"');
    expect((await call(base, 'GET', `/acquisitions/${PR}`)).status).toBe(404);
    const list = await call(base, 'GET', `/acquisitions?status=DRAFT&propertyReferenceId=${PR}&partyId=${BUYER}&page=2&pageSize=5`);
    expect(await list.json()).toMatchObject({ items: [{ acquisitionId: ID, transferDate: '2026-06-15' }], page: 2, pageSize: 5, total: 1 });
    expect(seen[0]).toMatchObject({ filter: { status: 'DRAFT', propertyReferenceId: PR, partyId: BUYER }, page: { page: 2, pageSize: 5 } });
    await call(base, 'GET', '/acquisitions');
    expect(seen[1]).toMatchObject({ filter: {}, page: { page: 1, pageSize: 50 } });
    expect((await call(base, 'GET', `/property-references/${PR}/acquisitions?status=CANCELLED`)).status).toBe(200);
    expect(seen[2]).toMatchObject({ propertyReferenceId: PR, filter: { status: 'CANCELLED' } });
    expect((await call(base, 'GET', `/property-references/${ID}/acquisitions`)).status).toBe(404);
    for (const query of ['status=PLANNED', 'pageSize=201', 'buyer=x', 'partyId=x']) expect((await call(base, 'GET', `/acquisitions?${query}`)).status, query).toBe(400);
    expect((await call(base, 'GET', `/property-references/${PR}/acquisitions?partyId=${BUYER}`)).status).toBe(400);
  });
});

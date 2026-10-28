import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcquisitionNotDraftError,
  AcquisitionNotFoundError,
  IdempotencyKeyConflictError,
  InvalidOwnershipError,
  OverlappingOwnershipError,
  OwnerInactiveError,
  OwnershipIncompleteError,
  OwnershipNotFoundError,
  OwnershipOfConfirmedAcquisitionError,
  OwnershipTotalExceedsOneError,
  PartyNotFoundError,
  PropertyReferenceNotFoundError,
  VersionConflictError,
  type ChangeOwnershipInput,
  type CreateOwnershipInput,
  type Ownership,
  type PrincipalVerifier,
} from '../application/index.js';
import type { BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-2-03 HTTP contract (api-design.md §26.1). */
const REALM = '64b0c0ffee0000000000000a';
const ID = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const PR = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const PARTY = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const ownership = {
  id: ID,
  mreRealmId: REALM,
  propertyReferenceId: PR,
  ownerPartyId: PARTY,
  share: { numerator: 1, denominator: 2 },
  validFrom: '2026-08-01',
  validUntil: null,
  status: 'VALID',
  voidedAt: null,
  voidReason: null,
  acquisitionId: null,
  sourceReferences: ['Grundbuch Blatt 1234'],
  notes: null,
  createdAt: new Date('2026-10-22T08:00:00Z'),
  version: 3,
} as unknown as Ownership;

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
const body = { propertyReferenceId: PR, ownerPartyId: PARTY, share: '2/4', validFrom: '2026-08-01' };

describe('POST /api/v1/ownerships', () => {
  it('201 with the Ownership and its ETag; the share is reduced; texts trimmed, empty ones dropped; a replay is marked', async () => {
    const seen: CreateOwnershipInput[] = [];
    let replayed = false;
    const base = await start({
      ownerships: {
        create: async (input) => {
          seen.push(input);
          const answer = { ownership, replayed };
          replayed = true;
          return answer;
        },
      },
    });
    const res = await call(
      base,
      'POST',
      '/ownerships',
      { ...body, propertyReferenceId: PR.toUpperCase(), validUntil: null, sourceReferences: [' Grundbuch Blatt 1234 ', ' '], notes: '  ' },
      { 'idempotency-key': 'k1' },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"3"');
    expect(await res.json()).toEqual({
      ownershipId: ID,
      mreRealmId: REALM,
      propertyReferenceId: PR,
      ownerPartyId: PARTY,
      share: '1/2',
      validFrom: '2026-08-01',
      validUntil: null,
      status: 'VALID',
      voidedAt: null,
      voidReason: null,
      acquisitionId: null,
      sourceReferences: ['Grundbuch Blatt 1234'],
      notes: null,
      createdAt: '2026-10-22T08:00:00.000Z',
      version: 3,
    });
    expect(seen[0]).toMatchObject({
      propertyReferenceId: PR,
      share: { numerator: 1, denominator: 2 },
      validUntil: null,
      sourceReferences: ['Grundbuch Blatt 1234'],
      notes: null,
      acquisitionId: null,
      idempotencyKey: 'k1',
    });
    expect((await call(base, 'POST', '/ownerships', body, { 'idempotency-key': 'k1' })).headers.get('idempotent-replayed')).toBe('true');
  });

  it('400 with the field codes: share format and range, dates, validUntil before validFrom, a malformed acquisitionId, unknown keys', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', '/ownerships', payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({ ...body, share: '0.5' })).toEqual([{ field: 'share', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf({ ...body, share: '3/2' })).toEqual([{ field: 'share', code: 'OUT_OF_RANGE' }]);
    expect(await fieldsOf({ ...body, share: '1/10001' })).toEqual([{ field: 'share', code: 'OUT_OF_RANGE' }]);
    expect(await fieldsOf({ ...body, validFrom: '2026-02-30' })).toEqual([{ field: 'validFrom', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf({ ...body, validUntil: '2026-07-31' })).toEqual([{ field: 'validUntil', code: 'BEFORE_VALID_FROM' }]);
    expect(await fieldsOf({ ...body, acquisitionId: 'x' })).toEqual([{ field: 'acquisitionId', code: 'INVALID_FORMAT' }]);
    for (const bad of [{ ...body, ownershipType: 'x' }, { ...body, sourceDocumentId: PR }, { ...body, ownerPartyId: 'x' }, { ...body, sourceReferences: Array(11).fill('x') }]) {
      await fieldsOf(bad);
    }
  });

  it.each([
    [new PropertyReferenceNotFoundError(PR), 404, 'NOT_FOUND', { propertyReferenceId: PR }],
    [new PartyNotFoundError(PARTY), 404, 'NOT_FOUND', { partyId: PARTY }],
    [new OwnerInactiveError(PARTY), 422, 'PARTY_INACTIVE', { partyId: PARTY }],
    [new OverlappingOwnershipError(ID), 422, 'OVERLAPPING_OWNERSHIP', { ownershipId: ID }],
    [new OwnershipTotalExceedsOneError('2027-01-01' as BusinessDate, { numerator: 13n, denominator: 12n }), 422, 'OWNERSHIP_TOTAL_EXCEEDS_ONE', { date: '2027-01-01', shareSum: '13/12' }],
    [new AcquisitionNotFoundError(ID), 404, 'NOT_FOUND', { acquisitionId: ID }],
    [new AcquisitionNotDraftError(ID, 'CANCELLED'), 422, 'ACQUISITION_NOT_DRAFT', { acquisitionId: ID, status: 'CANCELLED' }],
    [new IdempotencyKeyConflictError('x'), 409, 'CONFLICT', undefined],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ ownerships: { create: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', '/ownerships', body);
    expect(res.status).toBe(status);
    const answer = await errorOf(res);
    expect(answer.code).toBe(code);
    if (details !== undefined) expect(answer.details).toEqual(details);
  });
});

describe('GET /api/v1/ownerships/{id}, close and void', () => {
  it('get: one Ownership with ETag; 404 unknown; 400 malformed', async () => {
    const base = await start({
      ownerships: {
        get: async ({ ownershipId }) => {
          if (ownershipId !== ID) throw new OwnershipNotFoundError(ownershipId);
          return ownership;
        },
      },
    });
    const res = await call(base, 'GET', `/ownerships/${ID}`);
    expect(res.headers.get('etag')).toBe('"3"');
    expect((await call(base, 'GET', `/ownerships/${PR}`)).status).toBe(404);
    expect((await call(base, 'GET', '/ownerships/nope')).status).toBe(400);
  });

  it('close passes validUntil and If-Match; INVALID_OWNERSHIP with its reason; 412; bad bodies are 400', async () => {
    const seen: unknown[] = [];
    const base = await start({
      ownerships: {
        close: async (input) => {
          seen.push(input);
          if (input.expectedVersions?.includes(1)) throw new VersionConflictError([1], 3);
          if (input.validUntil === '2040-01-01') throw new InvalidOwnershipError(ID, 'ALREADY_ENDED');
          return { ownership: { ...ownership, validUntil: input.validUntil }, changed: true };
        },
      },
    });
    const res = await call(base, 'POST', `/ownerships/${ID}/close`, { validUntil: '2030-12-31' }, { 'if-match': '"3"' });
    expect(await res.json()).toMatchObject({ validUntil: '2030-12-31' });
    expect(seen[0]).toEqual(expect.objectContaining({ ownershipId: ID, validUntil: '2030-12-31', expectedVersions: [3] }));
    const invalid = await call(base, 'POST', `/ownerships/${ID}/close`, { validUntil: '2040-01-01' });
    expect(invalid.status).toBe(422);
    expect(await errorOf(invalid)).toMatchObject({ code: 'INVALID_OWNERSHIP', details: { ownershipId: ID, reason: 'ALREADY_ENDED' } });
    expect((await call(base, 'POST', `/ownerships/${ID}/close`, { validUntil: '2030-12-31' }, { 'if-match': '"1"' })).status).toBe(412);
    for (const bad of [{}, { validUntil: 'x' }, { validUntil: '2030-12-31', reason: 'x' }]) {
      expect((await call(base, 'POST', `/ownerships/${ID}/close`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('void needs a reason (1–500), passes If-Match; 404 and 412 map', async () => {
    const seen: unknown[] = [];
    const base = await start({
      ownerships: {
        void: async (input) => {
          seen.push(input);
          if (input.expectedVersions?.includes(1)) throw new VersionConflictError([1], 3);
          if (input.reason === 'confirmed') throw new OwnershipOfConfirmedAcquisitionError(ID, PR);
          if (input.ownershipId !== ID) throw new OwnershipNotFoundError(input.ownershipId);
          return { ownership: { ...ownership, status: 'VOID', voidReason: input.reason, voidedAt: new Date('2026-10-22T09:00:00Z') }, changed: true };
        },
      },
    });
    const res = await call(base, 'POST', `/ownerships/${ID}/void`, { reason: ' Tippfehler ' }, { 'if-match': '"3"' });
    expect(await res.json()).toMatchObject({ status: 'VOID', voidReason: 'Tippfehler', voidedAt: '2026-10-22T09:00:00.000Z' });
    expect(seen[0]).toEqual(expect.objectContaining({ reason: 'Tippfehler', expectedVersions: [3] }));
    for (const bad of [{}, { reason: ' ' }, { reason: 'x'.repeat(501) }]) {
      expect((await call(base, 'POST', `/ownerships/${ID}/void`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(base, 'POST', `/ownerships/${PR}/void`, { reason: 'x' })).status).toBe(404);
    expect((await call(base, 'POST', `/ownerships/${ID}/void`, { reason: 'x' }, { 'if-match': '"1"' })).status).toBe(412);
    const confirmed = await call(base, 'POST', `/ownerships/${ID}/void`, { reason: 'confirmed' });
    expect([confirmed.status, await errorOf(confirmed)]).toMatchObject([409, { code: 'CONFLICT', details: { reason: 'ACQUISITION_CONFIRMED', acquisitionId: PR } }]);
  });
});

describe('GET /api/v1/property-references/{id}/ownerships', () => {
  it('asOf: the day with completeness and shareSum (no total); without: the paged history; bad parameters 400; unknown 404', async () => {
    const seen: unknown[] = [];
    const base = await start({
      ownerships: {
        read: async (input) => {
          seen.push(input);
          if (input.propertyReferenceId !== PR) throw new PropertyReferenceNotFoundError(input.propertyReferenceId);
          return 'asOf' in input
            ? { day: { asOf: input.asOf, completeness: 'INCOMPLETE', shareSum: { numerator: 1n, denominator: 2n }, items: [ownership] } }
            : { history: { items: [ownership], page: input.page.page, pageSize: input.page.pageSize, total: 1 } };
        },
      },
    });
    const dayRes = await call(base, 'GET', `/property-references/${PR}/ownerships?asOf=2030-01-01`);
    expect(await dayRes.json()).toEqual({
      propertyReferenceId: PR,
      asOf: '2030-01-01',
      completeness: 'INCOMPLETE',
      shareSum: '1/2',
      items: [expect.objectContaining({ ownershipId: ID, share: '1/2' })],
    });
    const history = await call(base, 'GET', `/property-references/${PR}/ownerships?page=2&pageSize=5`);
    expect(await history.json()).toMatchObject({ items: [{ ownershipId: ID }], page: 2, pageSize: 5, total: 1 });
    await call(base, 'GET', `/property-references/${PR}/ownerships`);
    expect(seen[2]).toMatchObject({ page: { page: 1, pageSize: 50 } });
    for (const query of ['asOf=2030-13-01', 'asOf=2030-01-01&page=1', 'pageSize=201', 'status=VALID']) {
      expect((await call(base, 'GET', `/property-references/${PR}/ownerships?${query}`)).status, query).toBe(400);
    }
    expect((await call(base, 'GET', `/property-references/${ID}/ownerships`)).status).toBe(404);
  });
});

describe('POST /api/v1/property-references/{id}/ownership-changes', () => {
  const changeBody = { effectiveDate: '2030-01-01', reason: ' Verkauf ', close: [ID.toUpperCase()], create: [{ ownerPartyId: PARTY, share: '2/4' }] };
  const result = {
    propertyReferenceId: PR,
    effectiveDate: '2030-01-01',
    reason: 'Verkauf',
    closed: [{ ...ownership, validUntil: '2029-12-31' }],
    created: [ownership],
    completeness: 'COMPLETE',
    shareSum: { numerator: 1n, denominator: 1n },
  } as never;

  it('201 with closed, created, completeness and shareSum; 200 for the no-op; a replay is marked; the body is normalized', async () => {
    const seen: ChangeOwnershipInput[] = [];
    const statuses = ['CREATED', 'REPLAYED', 'UNCHANGED'] as const;
    const base = await start({
      ownerships: {
        change: async (input) => {
          seen.push(input);
          return { result, status: statuses[seen.length - 1] ?? 'CREATED' };
        },
      },
    });
    const res = await call(base, 'POST', `/property-references/${PR}/ownership-changes`, changeBody, { 'idempotency-key': 'c1' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      propertyReferenceId: PR,
      effectiveDate: '2030-01-01',
      reason: 'Verkauf',
      closed: [expect.objectContaining({ ownershipId: ID, validUntil: '2029-12-31' })],
      created: [expect.objectContaining({ ownershipId: ID, share: '1/2' })],
      completeness: 'COMPLETE',
      shareSum: '1/1',
    });
    expect(seen[0]).toMatchObject({
      propertyReferenceId: PR,
      reason: 'Verkauf',
      close: [ID],
      create: [{ ownerPartyId: PARTY, share: { numerator: 1, denominator: 2 }, sourceReferences: [], notes: null }],
      idempotencyKey: 'c1',
    });
    expect((await call(base, 'POST', `/property-references/${PR}/ownership-changes`, changeBody)).headers.get('idempotent-replayed')).toBe('true');
    expect((await call(base, 'POST', `/property-references/${PR}/ownership-changes`, changeBody)).status).toBe(200);
  });

  it('400 with the field codes: nothing to do, duplicates, a malformed acquisitionId, bad share or date, unknown keys', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', `/property-references/${PR}/ownership-changes`, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({ effectiveDate: '2030-01-01', reason: 'x' })).toEqual([{ field: 'create', code: 'REQUIRED' }]);
    expect(await fieldsOf({ ...changeBody, close: [ID, ID.toUpperCase()] })).toEqual([{ field: 'close.1', code: 'DUPLICATE' }]);
    expect(await fieldsOf({ ...changeBody, create: [{ ownerPartyId: PARTY, share: '1/4' }, { ownerPartyId: PARTY, share: '1/4' }] })).toEqual([
      { field: 'create.1.ownerPartyId', code: 'DUPLICATE' },
    ]);
    expect(await fieldsOf({ ...changeBody, acquisitionId: 'x' })).toEqual([{ field: 'acquisitionId', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf({ ...changeBody, create: [{ ownerPartyId: PARTY, share: '3/2' }] })).toEqual([{ field: 'create.0.share', code: 'OUT_OF_RANGE' }]);
    // Wrong types do not crash the refinements (400, never 500).
    for (const bad of [{ ...changeBody, close: 'x' }, { ...changeBody, create: 'x' }, { ...changeBody, create: [null] }]) await fieldsOf(bad);
    for (const bad of [{ ...changeBody, reason: ' ' }, { ...changeBody, effectiveDate: 'x' }, { ...changeBody, create: [{ ownerPartyId: PARTY, share: '1/2', validFrom: '2030-01-01' }] }, { ...changeBody, extra: 1 }]) {
      await fieldsOf(bad);
    }
    expect((await call(base, 'POST', '/property-references/nope/ownership-changes', changeBody)).status).toBe(400);
  });

  it.each([
    [new PropertyReferenceNotFoundError(PR), 404, 'NOT_FOUND', { propertyReferenceId: PR }],
    [new InvalidOwnershipError(ID, 'NOT_FOUND'), 422, 'INVALID_OWNERSHIP', { ownershipId: ID, reason: 'NOT_FOUND' }],
    [new PartyNotFoundError(PARTY), 404, 'NOT_FOUND', { partyId: PARTY }],
    [new OwnerInactiveError(PARTY), 422, 'PARTY_INACTIVE', { partyId: PARTY }],
    [new OverlappingOwnershipError(ID), 422, 'OVERLAPPING_OWNERSHIP', { ownershipId: ID }],
    [new OwnershipIncompleteError('2030-01-01' as BusinessDate, { numerator: 5n, denominator: 6n }), 422, 'OWNERSHIP_INCOMPLETE', { date: '2030-01-01', shareSum: '5/6' }],
    [new IdempotencyKeyConflictError('x'), 409, 'CONFLICT', undefined],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ ownerships: { change: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', `/property-references/${PR}/ownership-changes`, changeBody);
    expect(res.status).toBe(status);
    const answer = await errorOf(res);
    expect(answer.code).toBe(code);
    if (details !== undefined) expect(answer.details).toEqual(details);
  });
});

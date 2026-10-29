import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdministratorInactiveError,
  IdempotencyKeyConflictError,
  InvalidMembershipError,
  MembershipNotActiveError,
  OverlappingWegMembershipError,
  PartyNotFoundError,
  PropertyReferenceNotFoundError,
  VersionConflictError,
  WegHasMembershipsError,
  WegMembershipNotFoundError,
  WegNotActiveError,
  WegNotFoundError,
  type CreateMembershipInput,
  type CreateWegInput,
  type PrincipalVerifier,
  type Weg,
  type WegMembership,
} from '../application/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-6-01 HTTP contract (api-design.md §49.1–§49.2). */
const REALM = '64b0c0ffee0000000000000a';
const WEG = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const MEMBERSHIP = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const UNIT = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const PARTY = '3b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const created = new Date('2026-10-29T10:00:00Z');

const weg = {
  id: WEG,
  mreRealmId: REALM,
  status: 'ACTIVE',
  displayName: 'Musterstraße 1',
  administratorPartyId: PARTY,
  financialYearStartMonth: 1,
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: created,
  version: 1,
} as unknown as Weg;

const membership = {
  id: MEMBERSHIP,
  mreRealmId: REALM,
  wegId: WEG,
  propertyReferenceId: UNIT,
  mea: { numerator: '125.5', denominator: '10000' },
  validFrom: '2024-01-01',
  validUntil: null,
  status: 'ACTIVE',
  voidedAt: null,
  voidReason: null,
  sourceReferences: ['TE Nr. 4'],
  notes: null,
  createdAt: created,
  version: 2,
} as unknown as WegMembership;

const wegDto = {
  wegId: WEG,
  mreRealmId: REALM,
  status: 'ACTIVE',
  displayName: 'Musterstraße 1',
  administratorPartyId: PARTY,
  financialYearStartMonth: 1,
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: '2026-10-29T10:00:00.000Z',
  version: 1,
};

const membershipDto = {
  membershipId: MEMBERSHIP,
  mreRealmId: REALM,
  wegId: WEG,
  propertyReferenceId: UNIT,
  miteigentumsanteil: '125.5/10000',
  validFrom: '2024-01-01',
  validUntil: null,
  status: 'ACTIVE',
  voidedAt: null,
  voidReason: null,
  sourceReferences: ['TE Nr. 4'],
  notes: null,
  createdAt: '2026-10-29T10:00:00.000Z',
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
const call = (base: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1${path}`, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; details?: unknown } }).error;
const fieldsOf = async (base: string, path: string, payload: unknown) => {
  const res = await call(base, 'POST', path, payload);
  expect(res.status, JSON.stringify(payload)).toBe(400);
  return ((await errorOf(res)).details as { fields: unknown[] }).fields;
};

describe('POST /api/v1/wegs', () => {
  it('201 with the WEG and ETag; the default month, trimmed texts and the key passed; a replay is marked', async () => {
    const seen: CreateWegInput[] = [];
    let replayed = false;
    const base = await start({
      wegs: {
        createWeg: async (input) => {
          seen.push(input);
          const answer = { weg, replayed };
          replayed = true;
          return answer;
        },
      },
    });
    const res = await call(
      base,
      'POST',
      '/wegs',
      { displayName: ' Musterstraße 1 ', administratorPartyId: PARTY.toUpperCase(), notes: ' ' },
      { 'idempotency-key': 'k1' },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.json()).toEqual(wegDto);
    expect(seen[0]).toMatchObject({
      displayName: 'Musterstraße 1',
      administratorPartyId: PARTY,
      financialYearStartMonth: 1,
      notes: null,
      idempotencyKey: 'k1',
    });
    const again = await call(base, 'POST', '/wegs', { displayName: 'x' }, { 'idempotency-key': 'k1' });
    expect(again.headers.get('idempotent-replayed')).toBe('true');
  });

  it('400: name, month, unknown keys, and a contract document NOT_SUPPORTED', async () => {
    const base = await start({});
    expect(await fieldsOf(base, '/wegs', {})).toEqual([{ field: 'displayName', code: 'REQUIRED' }]);
    expect(await fieldsOf(base, '/wegs', { displayName: 'x', financialYearStartMonth: 13 })).toEqual([
      { field: 'financialYearStartMonth', code: 'INVALID_FORMAT' },
    ]);
    expect(await fieldsOf(base, '/wegs', { displayName: 'x', administratorContractDocumentId: PARTY })).toEqual([
      { field: 'administratorContractDocumentId', code: 'NOT_SUPPORTED' },
    ]);
    for (const key of ['address', 'externalReferences', 'status']) await fieldsOf(base, '/wegs', { displayName: 'x', [key]: 'y' });
    await fieldsOf(base, '/wegs', { displayName: 'x', administratorPartyId: 'nope' });
  });

  it.each([
    [new PartyNotFoundError(PARTY), 404, 'NOT_FOUND', { partyId: PARTY }],
    [new AdministratorInactiveError(PARTY), 409, 'CONFLICT', { reason: 'PARTY_INACTIVE', partyId: PARTY }],
    [new IdempotencyKeyConflictError('x'), 409, 'CONFLICT', undefined],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ wegs: { createWeg: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', '/wegs', { displayName: 'x' });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject(details === undefined ? { code } : { code, details });
  });
});

describe('WEG reads, amend and void', () => {
  it('GET list passes the filters and the page; GET one answers with ETag; an unknown WEG is 404', async () => {
    const seen: unknown[] = [];
    const base = await start({
      wegs: {
        listWegs: async (input) => (seen.push(input), { items: [weg], page: 2, pageSize: 10, total: 11 }),
        getWeg: async ({ wegId }) => (wegId === WEG ? weg : Promise.reject(new WegNotFoundError(wegId))),
      },
    });
    const list = await call(base, 'GET', `/wegs?status=ACTIVE,VOID&administratorPartyId=${PARTY}&propertyReferenceId=${UNIT}&page=2&pageSize=10`);
    expect(await list.json()).toEqual({ items: [wegDto], page: 2, pageSize: 10, total: 11 });
    expect(seen[0]).toMatchObject({
      filter: { statuses: ['ACTIVE', 'VOID'], administratorPartyId: PARTY, propertyReferenceId: UNIT },
      page: { page: 2, pageSize: 10 },
    });
    expect((await call(base, 'GET', '/wegs?status=CLOSED')).status).toBe(400);
    expect((await call(base, 'GET', '/wegs?foo=1')).status).toBe(400);
    const one = await call(base, 'GET', `/wegs/${WEG}`);
    expect(one.headers.get('etag')).toBe('"1"');
    expect(await one.json()).toEqual(wegDto);
    const missing = await call(base, 'GET', `/wegs/${MEMBERSHIP}`);
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toMatchObject({ code: 'NOT_FOUND', details: { wegId: MEMBERSHIP } });
    expect((await call(base, 'GET', '/wegs/nope')).status).toBe(400);
  });

  it('amend: the given fields, null clears; If-Match passed; an empty body is 400', async () => {
    const seen: unknown[] = [];
    const base = await start({ wegs: { amendWeg: async (input) => (seen.push(input), { weg, changed: true }) } });
    const res = await call(base, 'POST', `/wegs/${WEG}/amend`, { administratorPartyId: null, financialYearStartMonth: 7 }, { 'if-match': '"1"' });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ wegId: WEG, changes: { administratorPartyId: null, financialYearStartMonth: 7 }, expectedVersions: [1] });
    expect(await fieldsOf(base, `/wegs/${WEG}/amend`, {})).toEqual([{ field: '(body)', code: 'REQUIRED' }]);
    expect(await fieldsOf(base, `/wegs/${WEG}/amend`, { displayName: null })).toEqual([{ field: 'displayName', code: 'INVALID_FORMAT' }]);
  });

  it.each([
    [new WegNotActiveError(WEG, 'VOID'), 409, 'CONFLICT', { reason: 'WEG_NOT_ACTIVE', wegId: WEG, status: 'VOID' }],
    [new VersionConflictError([1], 2), 412, 'VERSION_CONFLICT', { expectedVersions: [1], currentVersion: 2 }],
  ])('amend %s → %i %s', async (error, status, code, details) => {
    const base = await start({ wegs: { amendWeg: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', `/wegs/${WEG}/amend`, { notes: 'x' });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });

  it('void: the reason passed; WEG_HAS_MEMBERSHIPS answers the memberships', async () => {
    const seen: unknown[] = [];
    const base = await start({
      wegs: {
        voidWeg: async (input) => {
          seen.push(input);
          if (seen.length > 1) throw new WegHasMembershipsError(WEG, [MEMBERSHIP]);
          return { weg, changed: true };
        },
      },
    });
    expect((await call(base, 'POST', `/wegs/${WEG}/void`, { reason: ' Fehler ' })).status).toBe(200);
    expect(seen[0]).toMatchObject({ wegId: WEG, reason: 'Fehler' });
    const refused = await call(base, 'POST', `/wegs/${WEG}/void`, { reason: 'x' });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toMatchObject({ code: 'CONFLICT', details: { reason: 'WEG_HAS_MEMBERSHIPS', membershipIds: [MEMBERSHIP] } });
    expect(await fieldsOf(base, `/wegs/${WEG}/void`, {})).toEqual([{ field: 'reason', code: 'REQUIRED' }]);
  });
});

describe('memberships', () => {
  const path = `/wegs/${WEG}/memberships`;
  const body = { propertyReferenceId: UNIT, miteigentumsanteil: '125.500/10000.000', validFrom: '2024-01-01' };

  it('201 with the membership: the MEA normalized, the WEG from the path, the references trimmed; a replay is marked', async () => {
    const seen: CreateMembershipInput[] = [];
    let replayed = false;
    const base = await start({
      wegs: {
        createMembership: async (input) => {
          seen.push(input);
          const answer = { membership, replayed };
          replayed = true;
          return answer;
        },
      },
    });
    const res = await call(base, 'POST', path, { ...body, sourceReferences: [' TE Nr. 4 ', ''] }, { 'idempotency-key': 'k' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(await res.json()).toEqual(membershipDto);
    expect(seen[0]).toMatchObject({
      wegId: WEG,
      propertyReferenceId: UNIT,
      mea: { numerator: '125.5', denominator: '10000' },
      validFrom: '2024-01-01',
      validUntil: null,
      sourceReferences: ['TE Nr. 4'],
      notes: null,
      idempotencyKey: 'k',
    });
    expect((await call(base, 'POST', path, body, { 'idempotency-key': 'k' })).headers.get('idempotent-replayed')).toBe('true');
  });

  it('400: the MEA codes, the period, unknown keys, a source document NOT_SUPPORTED', async () => {
    const base = await start({});
    expect(await fieldsOf(base, path, { ...body, miteigentumsanteil: '125,5/10.000' })).toEqual([{ field: 'miteigentumsanteil', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf(base, path, { ...body, miteigentumsanteil: '0/10000' })).toEqual([{ field: 'miteigentumsanteil', code: 'NOT_POSITIVE' }]);
    expect(await fieldsOf(base, path, { ...body, miteigentumsanteil: '2/1' })).toEqual([{ field: 'miteigentumsanteil', code: 'OUT_OF_RANGE' }]);
    expect(await fieldsOf(base, path, { ...body, validUntil: '2023-12-31' })).toEqual([{ field: 'validUntil', code: 'BEFORE_VALID_FROM' }]);
    expect(await fieldsOf(base, path, { ...body, sourceDocumentId: UNIT })).toEqual([{ field: 'sourceDocumentId', code: 'NOT_SUPPORTED' }]);
    for (const key of ['allocationUnit', 'wegId', 'status']) await fieldsOf(base, path, { ...body, [key]: 'x' });
    expect(await fieldsOf(base, path, { validFrom: '2024-01-01' })).toEqual([
      { field: 'propertyReferenceId', code: 'REQUIRED' },
      { field: 'miteigentumsanteil', code: 'REQUIRED' },
    ]);
  });

  it.each([
    [new WegNotFoundError(WEG), 404, 'NOT_FOUND', { wegId: WEG }],
    [new WegNotActiveError(WEG, 'VOID'), 409, 'CONFLICT', { reason: 'WEG_NOT_ACTIVE', wegId: WEG, status: 'VOID' }],
    [new PropertyReferenceNotFoundError(UNIT), 404, 'NOT_FOUND', { propertyReferenceId: UNIT }],
    [new OverlappingWegMembershipError(MEMBERSHIP, WEG), 409, 'CONFLICT', { reason: 'OVERLAPPING_WEG_MEMBERSHIP', membershipId: MEMBERSHIP, wegId: WEG }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ wegs: { createMembership: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', path, body);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });

  it('GET the WEG list and one membership; an unknown one is 404', async () => {
    const seen: unknown[] = [];
    const base = await start({
      wegs: {
        listMemberships: async (input) => (seen.push(input), { items: [membership], page: 1, pageSize: 50, total: 1 }),
        getMembership: async ({ membershipId }) => (membershipId === MEMBERSHIP ? membership : Promise.reject(new WegMembershipNotFoundError(membershipId))),
      },
    });
    expect(await (await call(base, 'GET', `${path}?status=VOID&propertyReferenceId=${UNIT}`)).json()).toEqual({
      items: [membershipDto],
      page: 1,
      pageSize: 50,
      total: 1,
    });
    expect(seen[0]).toMatchObject({ wegId: WEG, filter: { statuses: ['VOID'], propertyReferenceId: UNIT } });
    expect(await (await call(base, 'GET', `/weg-memberships/${MEMBERSHIP}`)).json()).toEqual(membershipDto);
    const missing = await call(base, 'GET', `/weg-memberships/${WEG}`);
    expect(await errorOf(missing)).toMatchObject({ code: 'NOT_FOUND', details: { membershipId: WEG } });
  });

  it('the unit lookup: asOf answers one membership or null, without asOf the paged history; paging with asOf is 400', async () => {
    const seen: unknown[] = [];
    const base = await start({
      wegs: {
        readUnitMemberships: async (input) => {
          seen.push(input);
          if ('asOf' in input) return { membership: input.asOf === '2024-06-01' ? membership : null };
          return { history: { items: [membership], page: 1, pageSize: 50, total: 1 } };
        },
      },
    });
    const unitPath = `/property-references/${UNIT}/weg-memberships`;
    expect(await (await call(base, 'GET', `${unitPath}?asOf=2024-06-01`)).json()).toEqual({
      propertyReferenceId: UNIT,
      asOf: '2024-06-01',
      membership: membershipDto,
    });
    expect(await (await call(base, 'GET', `${unitPath}?asOf=2019-01-01`)).json()).toEqual({ propertyReferenceId: UNIT, asOf: '2019-01-01', membership: null });
    expect(await (await call(base, 'GET', unitPath)).json()).toEqual({ items: [membershipDto], page: 1, pageSize: 50, total: 1 });
    expect(seen[2]).toMatchObject({ page: { page: 1, pageSize: 50 } });
    expect((await call(base, 'GET', `${unitPath}?asOf=2024-06-01&page=2`)).status).toBe(400);
    expect((await call(base, 'GET', `${unitPath}?asOf=2024-13-01`)).status).toBe(400);
  });

  it('amend: references and notes; fixed fields are NOT_AMENDABLE; null clears the references', async () => {
    const seen: unknown[] = [];
    const base = await start({ wegs: { amendMembership: async (input) => (seen.push(input), { membership, changed: true }) } });
    const amendPath = `/weg-memberships/${MEMBERSHIP}/amend`;
    expect((await call(base, 'POST', amendPath, { sourceReferences: null, notes: ' n ' }, { 'if-match': '"2"' })).status).toBe(200);
    expect(seen[0]).toMatchObject({ membershipId: MEMBERSHIP, changes: { sourceReferences: [], notes: 'n' }, expectedVersions: [2] });
    expect(await fieldsOf(base, amendPath, { miteigentumsanteil: '1/2', validUntil: '2025-01-01' })).toEqual([
      { field: 'miteigentumsanteil', code: 'NOT_AMENDABLE' },
      { field: 'validUntil', code: 'NOT_AMENDABLE' },
    ]);
    expect(await fieldsOf(base, amendPath, {})).toEqual([{ field: '(body)', code: 'REQUIRED' }]);
  });

  it.each([
    [new MembershipNotActiveError(MEMBERSHIP), 409, 'CONFLICT', { reason: 'MEMBERSHIP_NOT_ACTIVE', membershipId: MEMBERSHIP }],
    [new InvalidMembershipError(MEMBERSHIP, 'ALREADY_ENDED'), 422, 'INVALID_MEMBERSHIP', { membershipId: MEMBERSHIP, reason: 'ALREADY_ENDED' }],
    [new WegMembershipNotFoundError(MEMBERSHIP), 404, 'NOT_FOUND', { membershipId: MEMBERSHIP }],
  ])('end %s → %i %s', async (error, status, code, details) => {
    const base = await start({ wegs: { endMembership: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', `/weg-memberships/${MEMBERSHIP}/end`, { validUntil: '2025-06-30' });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });

  it('end and void pass their bodies and If-Match', async () => {
    const seen: unknown[] = [];
    const base = await start({
      wegs: {
        endMembership: async (input) => (seen.push(input), { membership, changed: true }),
        voidMembership: async (input) => (seen.push(input), { membership, changed: true }),
      },
    });
    await call(base, 'POST', `/weg-memberships/${MEMBERSHIP}/end`, { validUntil: '2025-06-30' }, { 'if-match': '"2"' });
    await call(base, 'POST', `/weg-memberships/${MEMBERSHIP}/void`, { reason: 'falscher MEA' });
    expect(seen).toMatchObject([
      { membershipId: MEMBERSHIP, validUntil: '2025-06-30', expectedVersions: [2] },
      { membershipId: MEMBERSHIP, reason: 'falscher MEA' },
    ]);
    expect(await fieldsOf(base, `/weg-memberships/${MEMBERSHIP}/end`, { validUntil: '2025-02-30' })).toEqual([{ field: 'validUntil', code: 'INVALID_FORMAT' }]);
  });
});

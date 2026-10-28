import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessError,
  ConcurrentUpdateError,
  ExternalReferenceInUseError,
  ExternalReferenceNotFoundError,
  MreTenantNotFoundError,
  MreUnavailableError,
  PartyInactiveError,
  PartyNotFoundError,
  VersionConflictError,
  type PartyExternalReference,
  type PrincipalVerifier,
} from '../application/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-2-02 HTTP contract (api-design.md §20.1). */
const REALM = '64b0c0ffee0000000000000a';
const PARTY = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const REF = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const OTHER = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
const reference = {
  id: REF,
  partyId: PARTY,
  system: 'MRE',
  mreRealmId: REALM,
  entityType: 'tenant',
  externalId: TENANT,
  status: 'ACTIVE',
  endedAt: null,
  createdAt: new Date('2026-10-22T08:00:00Z'),
  version: 1,
} as PartyExternalReference;

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
const body = { system: 'MRE', entityType: 'tenant', mreRealmId: REALM, externalId: TENANT };

describe('POST /api/v1/parties/{id}/external-references', () => {
  it("201 when created, 200 on a repeat, with the reference and its ETag; the caller's Authorization goes along", async () => {
    const seen: unknown[] = [];
    let created = true;
    const base = await start({
      externalReferences: {
        create: async (input) => {
          seen.push(input);
          const answer = { reference, created };
          created = false;
          return answer;
        },
      },
    });
    const res = await call(base, 'POST', `/parties/${PARTY.toUpperCase()}/external-references`, body);
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.json()).toEqual({
      externalReferenceId: REF,
      partyId: PARTY,
      system: 'MRE',
      mreRealmId: REALM,
      entityType: 'tenant',
      externalId: TENANT,
      status: 'ACTIVE',
      endedAt: null,
      createdAt: '2026-10-22T08:00:00.000Z',
      version: 1,
    });
    expect(seen[0]).toMatchObject({ authorizationHeader: 'Bearer a.b.c', partyId: PARTY, mreRealmId: REALM, externalId: TENANT });
    expect((await call(base, 'POST', `/parties/${PARTY}/external-references`, body)).status).toBe(200);
  });

  it('400 for another system or entity type, a malformed externalId, unknown keys (metadata) or a malformed partyId', async () => {
    const base = await start({});
    for (const bad of [
      { ...body, system: 'DATEV' },
      { ...body, entityType: 'owner' },
      { ...body, externalId: '6512F0C2A1B2C3D4E5F60A01' },
      { ...body, externalId: 'x' },
      { ...body, mreRealmId: '' },
      { ...body, metadata: {} },
      { system: 'MRE', entityType: 'tenant', externalId: TENANT },
    ]) {
      expect((await call(base, 'POST', `/parties/${PARTY}/external-references`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(base, 'POST', '/parties/nope/external-references', body)).status).toBe(400);
  });

  it.each([
    [new PartyNotFoundError(PARTY), 404, 'NOT_FOUND', { partyId: PARTY }],
    [new MreTenantNotFoundError(TENANT), 404, 'NOT_FOUND', { externalId: TENANT }],
    [new ExternalReferenceInUseError(OTHER), 409, 'CONFLICT', { reason: 'REFERENCE_IN_USE', partyId: OTHER }],
    [new PartyInactiveError(PARTY), 409, 'CONFLICT', { reason: 'PARTY_INACTIVE', partyId: PARTY }],
    [new AccessError('FORBIDDEN', 'x'), 403, 'FORBIDDEN', undefined],
    [new MreUnavailableError('x'), 503, 'EXTERNAL_SYSTEM_ERROR', undefined],
    [new ConcurrentUpdateError('x'), 503, 'CONCURRENT_UPDATE', undefined],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ externalReferences: { create: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', `/parties/${PARTY}/external-references`, body);
    expect(res.status).toBe(status);
    const answer = await errorOf(res);
    expect(answer.code).toBe(code);
    if (details !== undefined) expect(answer.details).toEqual(details);
  });
});

describe('POST /api/v1/parties/{id}/external-references/{refId}/end', () => {
  it('200 with the ended reference; passes If-Match; refusals map to 404/412; ids must be UUIDs', async () => {
    const seen: unknown[] = [];
    const base = await start({
      externalReferences: {
        end: async (input) => {
          seen.push(input);
          if (input.expectedVersions?.includes(7)) throw new VersionConflictError([7], 1);
          if (input.externalReferenceId !== REF) throw new ExternalReferenceNotFoundError(input.externalReferenceId);
          return { reference: { ...reference, status: 'ENDED', endedAt: new Date('2026-10-22T09:00:00Z'), version: 2 }, changed: true };
        },
      },
    });
    const res = await call(base, 'POST', `/parties/${PARTY}/external-references/${REF}/end`, undefined, { 'if-match': '"1"' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(await res.json()).toMatchObject({ status: 'ENDED', endedAt: '2026-10-22T09:00:00.000Z', version: 2 });
    expect(seen[0]).toEqual(expect.objectContaining({ partyId: PARTY, externalReferenceId: REF, expectedVersions: [1] }));
    const stale = await call(base, 'POST', `/parties/${PARTY}/external-references/${REF}/end`, undefined, { 'if-match': '"7"' });
    expect(stale.status).toBe(412);
    expect(await errorOf(stale)).toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersions: [7], currentVersion: 1 } });
    const missing = await call(base, 'POST', `/parties/${PARTY}/external-references/${OTHER}/end`);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).details).toEqual({ externalReferenceId: OTHER });
    expect((await call(base, 'POST', `/parties/${PARTY}/external-references/nope/end`)).status).toBe(400);
    expect((await call(base, 'POST', `/parties/${PARTY}/external-references/${REF}/end`, undefined, { 'if-match': '1' })).status).toBe(400);
  });
});

describe('GET /api/v1/parties/{id}/external-references and the Party list filter', () => {
  it('a page with the status filter; defaults 1 / 50; bad parameters are 400; an unknown Party is 404', async () => {
    const seen: unknown[] = [];
    const base = await start({
      externalReferences: {
        list: async (input) => {
          seen.push(input);
          if (input.partyId !== PARTY) throw new PartyNotFoundError(input.partyId);
          return { items: [reference], page: input.page.page, pageSize: input.page.pageSize, total: 1 };
        },
      },
    });
    const res = await call(base, 'GET', `/parties/${PARTY}/external-references?status=ACTIVE&page=2&pageSize=5`);
    expect(await res.json()).toMatchObject({ items: [{ externalReferenceId: REF }], page: 2, pageSize: 5, total: 1 });
    expect(seen[0]).toMatchObject({ partyId: PARTY, filter: { status: 'ACTIVE' }, page: { page: 2, pageSize: 5 } });
    await call(base, 'GET', `/parties/${PARTY}/external-references`);
    expect(seen[1]).toMatchObject({ filter: {}, page: { page: 1, pageSize: 50 } });
    for (const query of ['status=OPEN', 'pageSize=0', 'system=MRE']) {
      expect((await call(base, 'GET', `/parties/${PARTY}/external-references?${query}`)).status, query).toBe(400);
    }
    expect((await call(base, 'GET', `/parties/${OTHER}/external-references`)).status).toBe(404);
  });

  it('GET /parties?externalSystem=MRE&externalId=… passes the reference filter; the two come together and are validated', async () => {
    const seen: unknown[] = [];
    const base = await start({
      parties: {
        list: async (input) => {
          seen.push(input);
          return { items: [], page: 1, pageSize: 50, total: 0 };
        },
      },
    });
    expect((await call(base, 'GET', `/parties?externalSystem=MRE&externalId=${TENANT}&status=ACTIVE`)).status).toBe(200);
    expect(seen[0]).toMatchObject({ filter: { status: 'ACTIVE', externalReference: { system: 'MRE', externalId: TENANT } } });
    for (const query of [`externalId=${TENANT}`, 'externalSystem=MRE', `externalSystem=DATEV&externalId=${TENANT}`, 'externalSystem=MRE&externalId=x']) {
      expect((await call(base, 'GET', `/parties?${query}`)).status, query).toBe(400);
    }
  });
});

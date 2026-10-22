import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IdempotencyKeyConflictError,
  PartyFieldNotAllowedError,
  PartyNotFoundError,
  VersionConflictError,
  type CreatePartyInput,
  type Party,
  type PrincipalVerifier,
} from '../application/index.js';
import { createApp, type AppDependencies } from './app.js';
import { unusedCommands } from './app.test-support.js';

/** VC-2-01 HTTP contract (api-design.md §19.1). */
const REALM = '64b0c0ffee0000000000000a';
const ID = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const party = {
  id: ID,
  mreRealmId: REALM,
  partyType: 'PERSON',
  displayName: 'Anna Schmidt',
  firstName: 'Anna',
  lastName: 'Schmidt',
  legalName: null,
  registrationNumber: null,
  email: null,
  phone: null,
  status: 'ACTIVE',
  deactivatedAt: null,
  deactivationReason: null,
  createdAt: new Date('2026-10-22T08:00:00Z'),
  version: 3,
} as Party;

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });

let server: Server | undefined;

async function start(commands: Partial<AppDependencies>): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...unusedCommands, ...commands }).listen(0, '127.0.0.1');
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

describe('POST /api/v1/parties', () => {
  it('201 with the Party and its ETag; trimmed, empty optional strings become null; a replay is marked', async () => {
    const seen: CreatePartyInput[] = [];
    let replayed = false;
    const base = await start({
      createParty: async (input) => {
        seen.push(input);
        const answer = { party, replayed };
        replayed = true;
        return answer;
      },
    });
    const body = { partyType: 'PERSON', displayName: '  Anna Schmidt ', firstName: 'Anna', lastName: 'Schmidt', email: ' ', phone: null };
    const res = await call(base, 'POST', '/parties', body, { 'idempotency-key': 'k1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"3"');
    const dto = await res.json();
    expect(dto).toEqual({
      partyId: ID,
      mreRealmId: REALM,
      partyType: 'PERSON',
      displayName: 'Anna Schmidt',
      firstName: 'Anna',
      lastName: 'Schmidt',
      email: null,
      phone: null,
      status: 'ACTIVE',
      deactivatedAt: null,
      deactivationReason: null,
      createdAt: '2026-10-22T08:00:00.000Z',
      version: 3,
    });
    expect(seen[0]).toMatchObject({
      partyType: 'PERSON',
      displayName: 'Anna Schmidt',
      firstName: 'Anna',
      legalName: null,
      email: null,
      phone: null,
      idempotencyKey: 'k1',
    });
    expect((await call(base, 'POST', '/parties', body, { 'idempotency-key': 'k1' })).headers.get('idempotent-replayed')).toBe('true');
  });

  it('400 for missing or bad fields, unknown keys (organizationType, dateOfBirth), fields of the other type; 409 on a reused key', async () => {
    const base = await start({
      createParty: async (input) => {
        if (input.legalName !== null) throw new PartyFieldNotAllowedError('PERSON', ['legalName']);
        throw new IdempotencyKeyConflictError('x');
      },
    });
    for (const body of [
      {},
      { partyType: 'COMPANY', displayName: 'X' },
      { partyType: 'PERSON', displayName: ' ' },
      { partyType: 'PERSON', displayName: 'X', email: 'no-at-sign' },
      { partyType: 'PERSON', displayName: 'X', phone: 'x'.repeat(51) },
      { partyType: 'ORGANIZATION', displayName: 'X', organizationType: 'GMBH' },
      { partyType: 'PERSON', displayName: 'X', dateOfBirth: '1970-01-01' },
    ]) {
      expect((await call(base, 'POST', '/parties', body)).status, JSON.stringify(body)).toBe(400);
    }
    const wrongType = await call(base, 'POST', '/parties', { partyType: 'PERSON', displayName: 'X', legalName: 'X GmbH' });
    expect(wrongType.status).toBe(400);
    expect((await errorOf(wrongType)).details).toEqual({ fields: [{ field: 'legalName', code: 'NOT_ALLOWED_FOR_TYPE' }] });
    expect((await call(base, 'POST', '/parties', { partyType: 'PERSON', displayName: 'X' })).status).toBe(409);
  });
});

describe('GET /api/v1/parties(/{id})', () => {
  it('one Party with its ETag; 404 when unknown or foreign, 400 for a malformed id', async () => {
    const base = await start({
      getParty: async ({ partyId }) => {
        if (partyId !== ID) throw new PartyNotFoundError(partyId);
        return party;
      },
    });
    const res = await call(base, 'GET', `/parties/${ID.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"3"');
    const other = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
    const missing = await call(base, 'GET', `/parties/${other}`);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).details).toEqual({ partyId: other });
    expect((await call(base, 'GET', '/parties/nope')).status).toBe(400);
  });

  it('a page with the filters as given; defaults page 1 / 50; unknown or bad parameters are 400', async () => {
    const seen: unknown[] = [];
    const base = await start({
      listParties: async (input) => {
        seen.push(input);
        return { items: [party], page: input.page.page, pageSize: input.page.pageSize, total: 1 };
      },
    });
    const res = await call(base, 'GET', '/parties?partyType=PERSON&status=ACTIVE&name=100%25&page=2&pageSize=5');
    expect(await res.json()).toMatchObject({ items: [{ partyId: ID }], page: 2, pageSize: 5, total: 1 });
    expect(seen[0]).toMatchObject({ filter: { partyType: 'PERSON', status: 'ACTIVE', name: '100%' }, page: { page: 2, pageSize: 5 } });
    await call(base, 'GET', '/parties');
    expect(seen[1]).toMatchObject({ filter: {}, page: { page: 1, pageSize: 50 } });
    for (const query of ['type=PERSON', 'status=DELETED', 'name=', 'pageSize=201', 'externalSystem=MRE']) {
      expect((await call(base, 'GET', `/parties?${query}`)).status, query).toBe(400);
    }
  });
});

describe('POST /api/v1/parties/{id}/amend and /deactivate', () => {
  it('amend passes the changes and If-Match; partyType and an empty body are 400; refusals map to 400/404/412', async () => {
    const seen: unknown[] = [];
    const base = await start({
      amendParty: async (input) => {
        seen.push(input);
        if (input.changes.legalName !== undefined) throw new PartyFieldNotAllowedError('PERSON', ['legalName']);
        if (input.expectedVersions?.includes(1)) throw new VersionConflictError([1], 3);
        if (input.partyId !== ID) throw new PartyNotFoundError(input.partyId);
        return { party, changed: true };
      },
    });
    const res = await call(base, 'POST', `/parties/${ID}/amend`, { email: 'a@b.de', phone: '' }, { 'if-match': '"3"' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"3"');
    expect(seen[0]).toEqual(expect.objectContaining({ partyId: ID, changes: { email: 'a@b.de', phone: null }, expectedVersions: [3] }));
    for (const body of [{}, { partyType: 'ORGANIZATION' }, { displayName: null }, { email: 'x' }]) {
      expect((await call(base, 'POST', `/parties/${ID}/amend`, body)).status, JSON.stringify(body)).toBe(400);
    }
    const wrongType = await call(base, 'POST', `/parties/${ID}/amend`, { legalName: 'X GmbH' });
    expect((await errorOf(wrongType)).details).toEqual({ fields: [{ field: 'legalName', code: 'NOT_ALLOWED_FOR_TYPE' }] });
    const stale = await call(base, 'POST', `/parties/${ID}/amend`, { phone: '1' }, { 'if-match': '"1"' });
    expect(stale.status).toBe(412);
    expect(await errorOf(stale)).toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersions: [1], currentVersion: 3 } });
    expect((await call(base, 'POST', '/parties/1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b/amend', { phone: '1' })).status).toBe(404);
    expect((await call(base, 'POST', `/parties/${ID}/amend`, { phone: '1' }, { 'if-match': '3' })).status).toBe(400);
  });

  it('deactivate needs a reason (1–500) and passes If-Match; refusals map to 404/412', async () => {
    const seen: unknown[] = [];
    const base = await start({
      deactivateParty: async (input) => {
        seen.push(input);
        if (input.expectedVersions?.includes(1)) throw new VersionConflictError([1], 3);
        if (input.partyId !== ID) throw new PartyNotFoundError(input.partyId);
        return { party: { ...party, status: 'INACTIVE', deactivationReason: 'verstorben' }, changed: true };
      },
    });
    const res = await call(base, 'POST', `/parties/${ID}/deactivate`, { reason: ' verstorben ' }, { 'if-match': '"3"' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'INACTIVE', deactivationReason: 'verstorben' });
    expect(seen[0]).toEqual(expect.objectContaining({ partyId: ID, reason: 'verstorben', expectedVersions: [3] }));
    for (const body of [{}, { reason: ' ' }, { reason: 'x'.repeat(501) }, { reason: 'x', extra: 1 }]) {
      expect((await call(base, 'POST', `/parties/${ID}/deactivate`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(base, 'POST', `/parties/${ID}/deactivate`, { reason: 'x' }, { 'if-match': '"1"' })).status).toBe(412);
    expect((await call(base, 'POST', '/parties/1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b/deactivate', { reason: 'x' })).status).toBe(404);
  });
});

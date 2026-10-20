import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessError,
  MrePropertyNotFoundError,
  MreUnavailableError,
  type LinkPropertyReference,
  type LinkPropertyReferenceInput,
  type PrincipalVerifier,
  PropertyReferenceNotFoundError,
  type PropertyReference,
  type RefreshPropertyReference,
  type RefreshPropertyReferenceInput,
} from '../application/index.js';
import { ExactDecimal } from '../shared/index.js';
import { createApp } from './app.js';
import { unusedCommands } from './app.test-support.js';

const REALM = '64b0c0ffee0000000000000a';
const PROPERTY = '6512f0c2a1b2c3d4e5f60718';

const reference = {
  id: '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b',
  mreRealmId: REALM,
  mrePropertyId: PROPERTY,
  externalReferenceState: 'ACTIVE',
  displayName: 'Wohnung 1',
  cachedAddress: { city: 'Berlin' },
  cachedSurface: ExactDecimal.of('64.50'),
  lastRefreshedAt: new Date('2026-10-19T08:00:00Z'),
  lastObservedAt: new Date('2026-10-19T08:00:00Z'),
  createdAt: new Date('2026-10-19T08:00:01Z'),
  version: 1,
} as PropertyReference;

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({
  email: 'anna@example.com',
  mreRealmId: mreRealmId ?? '',
  mreRole: 'administrator',
});

let server: Server | undefined;

const unused = () => Promise.reject(new Error('not used in this test'));

async function start(
  link: LinkPropertyReference,
  verifyPrincipal: PrincipalVerifier = admin,
  refresh: RefreshPropertyReference = unused,
): Promise<string> {
  server = createApp({
    isReady: async () => true,
    verifyPrincipal,
    ...unusedCommands,
    linkPropertyReference: link,
    refreshPropertyReference: refresh,
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function post(base: string, body: unknown, contentType = 'application/json') {
  return fetch(`${base}/api/v1/property-references/link`, {
    method: 'POST',
    headers: { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/v1/property-references/link', () => {
  it('201 with the new PropertyReference; the use case gets principal, token and body', async () => {
    const seen: LinkPropertyReferenceInput[] = [];
    const base = await start(async (input) => (seen.push(input), { reference, created: true }));
    const res = await post(base, { mreRealmId: REALM, mrePropertyId: PROPERTY, extra: 'ignored' });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      propertyReferenceId: reference.id,
      mreRealmId: REALM,
      mrePropertyId: PROPERTY,
      externalReferenceState: 'ACTIVE',
      displayName: 'Wohnung 1',
      cachedAddress: { city: 'Berlin' },
      cachedSurface: '64.5',
      lastRefreshedAt: '2026-10-19T08:00:00.000Z',
      lastObservedAt: '2026-10-19T08:00:00.000Z',
      createdAt: '2026-10-19T08:00:01.000Z',
      version: 1,
    });
    expect(seen).toEqual([
      {
        principal: { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' },
        authorizationHeader: 'Bearer a.b.c',
        mreRealmId: REALM,
        mrePropertyId: PROPERTY,
      },
    ]);
  });

  it('200 with the existing PropertyReference on a repeat (never 409)', async () => {
    const base = await start(async () => ({ reference, created: false }));
    const res = await post(base, { mreRealmId: REALM, mrePropertyId: PROPERTY });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ propertyReferenceId: reference.id });
  });

  it.each([
    ['missing mrePropertyId', { mreRealmId: REALM }, [{ field: 'mrePropertyId', code: 'REQUIRED' }]],
    ['missing mreRealmId', { mrePropertyId: PROPERTY }, [{ field: 'mreRealmId', code: 'REQUIRED' }]],
    ['uppercase ObjectId', { mreRealmId: REALM, mrePropertyId: PROPERTY.toUpperCase() }, [{ field: 'mrePropertyId', code: 'INVALID_FORMAT' }]],
    ['too short', { mreRealmId: REALM, mrePropertyId: PROPERTY.slice(1) }, [{ field: 'mrePropertyId', code: 'INVALID_FORMAT' }]],
    ['not a string', { mreRealmId: REALM, mrePropertyId: 42 }, [{ field: 'mrePropertyId', code: 'INVALID_FORMAT' }]],
    ['empty mreRealmId', { mreRealmId: '', mrePropertyId: PROPERTY }, [{ field: 'mreRealmId', code: 'INVALID_FORMAT' }]],
    ['not an object', [], [{ field: '(body)', code: 'INVALID_FORMAT' }]],
  ])('400 VALIDATION_ERROR: %s — the use case is not called', async (_label, body, fields) => {
    let called = false;
    const base = await start(async () => ((called = true), { reference, created: true }));
    const res = await post(base, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed.', details: { fields } },
    });
    expect(called).toBe(false);
  });

  it('400 for malformed JSON and for a non-JSON content type', async () => {
    const base = await start(async () => ({ reference, created: true }));
    const malformed = await post(base, '{"mreRealmId":');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.' } });
    expect((await post(base, `mreRealmId=${REALM}`, 'application/x-www-form-urlencoded')).status).toBe(400);
  });

  it('413 for an oversized body', async () => {
    const base = await start(async () => ({ reference, created: true }));
    const res = await post(base, { mreRealmId: REALM, mrePropertyId: PROPERTY, padding: 'x'.repeat(20_000) });
    expect(res.status).toBe(413);
  });

  it('the access guard runs first: no valid identity → 401 even for an invalid body', async () => {
    const base = await start(
      async () => ({ reference, created: true }),
      async () => {
        throw new AccessError('UNAUTHENTICATED', 'no token');
      },
    );
    const res = await post(base, { mrePropertyId: 'x' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it.each([
    ['Realm mismatch / MRE refuses', new AccessError('FORBIDDEN', 'x'), 403, 'FORBIDDEN'],
    ['MRE rejects the token', new AccessError('UNAUTHENTICATED', 'x'), 401, 'UNAUTHORIZED'],
    ['MRE Property not found', new MrePropertyNotFoundError(REALM, PROPERTY), 404, 'NOT_FOUND'],
    ['MRE unavailable', new MreUnavailableError('down'), 503, 'EXTERNAL_SYSTEM_ERROR'],
    ['unexpected (e.g. database down)', new Error('connection refused'), 500, 'INTERNAL_ERROR'],
  ])('%s → %i %s', async (_label, error, status, code) => {
    const base = await start(() => Promise.reject(error));
    const res = await post(base, { mreRealmId: REALM, mrePropertyId: PROPERTY });
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain('connection refused');
    if (status === 404) expect(body.error.details).toEqual({ mreRealmId: REALM, mrePropertyId: PROPERTY });
  });
});

describe('POST /api/v1/property-references/{id}/refresh', () => {
  const refreshUrl = (base: string, id: string) => `${base}/api/v1/property-references/${id}/refresh`;
  const call = (base: string, id: string) =>
    fetch(refreshUrl(base, id), { method: 'POST', headers: { authorization: 'Bearer a.b.c', organizationid: REALM } });

  it('200 with the refreshed PropertyReference; the use case gets principal, token and id', async () => {
    const seen: RefreshPropertyReferenceInput[] = [];
    const base = await start(unused, admin, async (input) => (seen.push(input), { ...reference, version: 2 }));
    const res = await call(base, reference.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ propertyReferenceId: reference.id, cachedSurface: '64.5', version: 2 });
    expect(seen).toEqual([
      {
        principal: { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' },
        authorizationHeader: 'Bearer a.b.c',
        propertyReferenceId: reference.id,
      },
    ]);
  });

  it('400 for an id that is not a UUID — the use case is not called', async () => {
    let called = false;
    const base = await start(unused, admin, async () => ((called = true), reference));
    const res = await call(base, 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed.',
        details: { fields: [{ field: 'propertyReferenceId', code: 'INVALID_FORMAT' }] },
      },
    });
    expect(called).toBe(false);
  });

  it.each([
    ['unknown or other Realm', new PropertyReferenceNotFoundError(reference.id), 404, 'NOT_FOUND'],
    ['MRE refuses', new AccessError('FORBIDDEN', 'x'), 403, 'FORBIDDEN'],
    ['MRE unavailable', new MreUnavailableError('down'), 503, 'EXTERNAL_SYSTEM_ERROR'],
    ['unexpected', new Error('connection refused'), 500, 'INTERNAL_ERROR'],
  ])('%s → %i %s', async (_label, error, status, code) => {
    const base = await start(unused, admin, () => Promise.reject(error));
    const res = await call(base, reference.id);
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe(code);
    if (status === 404) expect(body.error.details).toEqual({ propertyReferenceId: reference.id });
  });

  it('the access guard runs first', async () => {
    const base = await start(
      unused,
      async () => {
        throw new AccessError('UNAUTHENTICATED', 'no token');
      },
      async () => reference,
    );
    expect((await call(base, 'not-a-uuid')).status).toBe(401);
  });
});

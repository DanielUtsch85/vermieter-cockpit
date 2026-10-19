import { describe, expect, it, beforeAll } from 'vitest';
import { z } from 'zod';
import { HttpMreClient } from './http-mre-client.js';

/**
 * VC-0-09 — contract test against the REAL MRE landlord API of the pinned
 * baseline (479d0ad, ADR-036), started by docker-compose.yml. It pins the
 * upstream shapes and behaviours DE relies on (mre-integration.md §47.1, §21):
 * if an MRE upgrade changes them, this suite fails before DE code does.
 *
 * Runs only when MRE_CONTRACT_API_URL is set (CI job compose-smoke); with
 * REQUIRE_MRE_CONTRACT=1 a missing URL is an error, so it cannot be skipped there.
 *
 * The suite creates accounts, Realms and properties: never point
 * MRE_CONTRACT_API_URL at a shared or production MRE — only at a throwaway stack.
 */
const apiUrl = process.env['MRE_CONTRACT_API_URL'];
if (apiUrl === undefined && process.env['REQUIRE_MRE_CONTRACT'] === '1') {
  throw new Error('MRE_CONTRACT_API_URL must be set when REQUIRE_MRE_CONTRACT=1');
}

/** Fields of an MRE Property that DE reads (PropertyReference cache, data-model.md §9). */
const propertyContract = z.object({
  _id: z.string().regex(/^[0-9a-f]{24}$/),
  name: z.string(),
  surface: z.number().optional(),
  address: z
    .object({
      street1: z.string().optional(),
      zipCode: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
});

const realmContract = z.object({
  _id: z.string().regex(/^[0-9a-f]{24}$/),
  name: z.string(),
  members: z.array(z.object({ email: z.string(), role: z.enum(['administrator', 'renter']) })),
});

describe.skipIf(apiUrl === undefined)('MRE landlord API contract (pinned baseline)', () => {
  const base = apiUrl ?? '';
  const run = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const email = `contract-${run}@example.com`;
  const password = `Contract-${run}`;
  let realmA = '';
  let realmB = '';

  async function call(path: string, init: { method?: string; token?: string; realm?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (init.token !== undefined) headers['authorization'] = `Bearer ${init.token}`;
    if (init.realm !== undefined) headers['organizationid'] = init.realm;
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  /** Access tokens live 30 s; fetch a fresh one per step. */
  async function token(): Promise<string> {
    const { status, json } = await call('/authenticator/landlord/signin', { method: 'POST', body: { email, password } });
    expect(status).toBe(200);
    return z.object({ accessToken: z.string() }).parse(json).accessToken;
  }

  const realmBody = (name: string) => ({
    name,
    currency: 'EUR',
    locale: 'de-DE',
    members: [{ name: 'Contract', email, role: 'administrator', registered: true }],
  });

  beforeAll(async () => {
    const signup = await call('/authenticator/landlord/signup', {
      method: 'POST',
      body: { firstname: 'Contract', lastname: 'Test', email, password },
    });
    expect(signup.status).toBe(201);
    const t = await token();
    realmA = realmContract.parse((await call('/realms', { method: 'POST', token: t, body: realmBody(`A ${run}`) })).json)._id;
    realmB = realmContract.parse((await call('/realms', { method: 'POST', token: t, body: realmBody(`B ${run}`) })).json)._id;
  });

  it('access token: HS256 JWT with { account: { email } }, no role, 30 s lifetime', async () => {
    const [headerPart = '', payloadPart = ''] = (await token()).split('.');
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());
    const header = decode(headerPart);
    const payload = decode(payloadPart);
    expect(header).toMatchObject({ alg: 'HS256' });
    expect(payload.account.email).toBe(email);
    expect(payload.account.role).toBeUndefined();
    expect(payload.account.password).toBeUndefined();
    expect(payload.exp - payload.iat).toBe(30);
  });

  it('GET /realms lists exactly the caller\'s Realms with member roles (what HttpMreClient reads)', async () => {
    const { status, json } = await call('/realms', { token: await token() });
    expect(status).toBe(200);
    const realms = z.array(realmContract).parse(json);
    expect(realms.map((r) => r._id).sort()).toEqual([realmA, realmB].sort());
    expect(realms[0]?.members).toContainEqual({ email, role: 'administrator' });

    const viaClient = await new HttpMreClient({ apiBaseUrl: base, timeoutMs: 5000 }).listRealms(await token());
    expect(viaClient.find((r) => r.mreRealmId === realmA)?.members).toEqual([{ email, role: 'administrator' }]);
  });

  it('a forged token is rejected with 401', async () => {
    const [h, p] = (await token()).split('.');
    expect((await call('/realms', { token: `${h}.${p}.forged-signature` })).status).toBe(401);
  });

  describe('properties (needed for PropertyReference link/refresh, VC-1-01/02)', () => {
    let propertyId = '';

    beforeAll(async () => {
      const { status, json } = await call('/properties', {
        method: 'POST',
        token: await token(),
        realm: realmA,
        body: {
          type: 'apartment',
          name: 'Wohnung 1',
          surface: 64.5,
          address: { street1: 'Musterstraße 1', zipCode: '10115', city: 'Berlin', country: 'DE' },
        },
      });
      expect(status).toBe(200);
      propertyId = propertyContract.parse(json)._id;
    });

    it('GET /properties/:id returns the fields DE caches', async () => {
      const { status, json } = await call(`/properties/${propertyId}`, { token: await token(), realm: realmA });
      expect(status).toBe(200);
      expect(propertyContract.parse(json)).toMatchObject({
        _id: propertyId,
        name: 'Wohnung 1',
        surface: 64.5,
        address: { street1: 'Musterstraße 1', zipCode: '10115', city: 'Berlin', country: 'DE' },
      });
    });

    it('GET /properties lists the Realm\'s properties', async () => {
      const { status, json } = await call('/properties', { token: await token(), realm: realmA });
      expect(status).toBe(200);
      expect(z.array(propertyContract).parse(json).map((p) => p._id)).toContain(propertyId);
    });

    it('Realm isolation: the property is not visible in another Realm of the same user', async () => {
      const list = await call('/properties', { token: await token(), realm: realmB });
      expect(list.status).toBe(200);
      expect(z.array(propertyContract).parse(list.json).map((p) => p._id)).not.toContain(propertyId);
    });

    it('HttpMreClient.listProperties (used by link, VC-1-01) finds the property only in its Realm', async () => {
      const client = new HttpMreClient({ apiBaseUrl: base, timeoutMs: 5000 });
      const inA = await client.listProperties(await token(), realmA);
      expect(inA.find((p) => p.mrePropertyId === propertyId)?.surface?.toString()).toBe('64.5');
      expect(inA.find((p) => p.mrePropertyId === propertyId)).toMatchObject({
        mrePropertyId: propertyId,
        name: 'Wohnung 1',
        address: { street1: 'Musterstraße 1', zipCode: '10115', city: 'Berlin', country: 'DE' },
      });
      const inB = await client.listProperties(await token(), realmB);
      expect(inB.map((p) => p.mrePropertyId)).not.toContain(propertyId);
    });

    // Pinned quirk: MRE does not answer 404 for an unknown or foreign-Realm id on
    // GET /properties/:id — the handler fails on the missing document. DE must not
    // treat this status as "not found"; resolve existence via GET /properties.
    it('quirk: GET /properties/:id for a foreign-Realm id is a server error, not 404', async () => {
      const { status } = await call(`/properties/${propertyId}`, { token: await token(), realm: realmB });
      expect(status).toBe(500);
    });

    it('a missing organizationid header is answered with 404', async () => {
      expect((await call(`/properties/${propertyId}`, { token: await token() })).status).toBe(404);
    });
  });
});

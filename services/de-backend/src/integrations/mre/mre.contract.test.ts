import { describe, expect, it, beforeAll } from 'vitest';
import { z } from 'zod';
import { dePayment, markerIn, removalBody, storedPayments, verifyRemoved, verifyWritten, writeBody } from '../../domains/rent-reconciliation/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
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

  describe('tenants (needed for the Party external reference, VC-2-02)', () => {
    let tenantId = '';

    beforeAll(async () => {
      const { status, json } = await call('/tenants', { method: 'POST', token: await token(), realm: realmA, body: { name: 'Mieterin Contract' } });
      expect(status).toBe(200);
      tenantId = z.object({ _id: z.string().regex(/^[0-9a-f]{24}$/) }).parse(json)._id;
    });

    it('GET /tenants lists the Realm\'s Tenants by _id and ignores a filter: every Tenant comes back (mre-integration.md §20.1)', async () => {
      const { status, json } = await call('/tenants?_id=000000000000000000000000', { token: await token(), realm: realmA });
      expect(status).toBe(200);
      expect(z.array(z.object({ _id: z.string() }).passthrough()).parse(json).map((t) => t._id)).toContain(tenantId);
    });

    it('HttpMreClient.listTenantIds (used by the reference check) finds the Tenant only in its Realm', async () => {
      const client = new HttpMreClient({ apiBaseUrl: base, timeoutMs: 5000 });
      const inA = await client.listTenantIds(await token(), realmA);
      expect(inA).toContain(tenantId);
      // A valid but unknown id in a Realm WITH Tenants is not in the list: DE answers 404 (§20.1).
      expect(inA).not.toContain('000000000000000000000000');
      expect(await client.listTenantIds(await token(), realmB)).not.toContain(tenantId);
    });

    // Pinned quirk, as for properties: GET /tenants/:id answers no 404 for an unknown id.
    it('quirk: GET /tenants/:id for an unknown id is not a 404', async () => {
      const { status } = await call('/tenants/000000000000000000000000', { token: await token(), realm: realmA });
      expect(status).not.toBe(404);
      expect(status).toBeGreaterThanOrEqual(500);
    });
  });

  describe('rent terms (needed for the rent reconciliation, VC-4-01)', () => {
    let tenantId = '';

    beforeAll(async () => {
      const t = await token();
      const property = await call('/properties', { method: 'POST', token: t, realm: realmA, body: { type: 'apartment', name: 'Wohnung Miete', price: 800 } });
      expect(property.status).toBe(200);
      const propertyId = propertyContract.parse(property.json)._id;
      // A Tenant with a lease from 01/01/2027 to 31/12/2027: MRE generates its monthly rent terms (`Contract.create`).
      const { status, json } = await call('/tenants', {
        method: 'POST',
        token: t,
        realm: realmA,
        body: { name: 'Mieter Miete', beginDate: '01/01/2027', endDate: '31/12/2027', properties: [{ propertyId, rent: 800, expenses: [] }] },
      });
      expect(status).toBe(200);
      tenantId = z.object({ _id: z.string().regex(/^[0-9a-f]{24}$/) }).parse(json)._id;
    });

    it('GET /rents/tenant/:id/:term returns the term with its key as a number', async () => {
      const { status, json } = await call(`/rents/tenant/${tenantId}/2027010100`, { token: await token(), realm: realmA });
      expect(status).toBe(200);
      expect(z.object({ term: z.number() }).parse(json).term).toBe(2027010100);
    });

    it('an unknown term, an unknown Tenant and a Tenant of another Realm are all 404 (api-design.md §37.1)', async () => {
      const t = await token();
      expect((await call(`/rents/tenant/${tenantId}/2028010100`, { token: t, realm: realmA })).status).toBe(404);
      expect((await call('/rents/tenant/000000000000000000000000/2027010100', { token: t, realm: realmA })).status).toBe(404);
      expect((await call(`/rents/tenant/${tenantId}/2027010100`, { token: t, realm: realmB })).status).toBe(404);
    });

    it('HttpMreClient.rentTermExists (used by the manual match) finds the term only for its Tenant and Realm', async () => {
      const client = new HttpMreClient({ apiBaseUrl: base, timeoutMs: 5000 });
      expect(await client.rentTermExists(await token(), realmA, tenantId, '2027010100')).toBe(true);
      expect(await client.rentTermExists(await token(), realmA, tenantId, '2027120100')).toBe(true);
      expect(await client.rentTermExists(await token(), realmA, tenantId, '2028010100')).toBe(false);
      expect(await client.rentTermExists(await token(), realmB, tenantId, '2027010100')).toBe(false);
    });

    it('the term carries totalWithoutBalanceAmount and payments; a payment written through MRE comes back with date, amount, type and reference (VC-4-02)', async () => {
      const t = await token();
      const raw = await call(`/rents/tenant/${tenantId}/2027030100`, { token: t, realm: realmA });
      expect(raw.status).toBe(200);
      expect(z.object({ totalWithoutBalanceAmount: z.number(), payments: z.array(z.unknown()) }).parse(raw.json)).toMatchObject({ totalWithoutBalanceAmount: 800, payments: [] });
      // MRE's own form writes a payment this way (PaymentTabs.js): the Tenant in the body's _id (review on #75).
      const paid = await call('/rents/payment/' + tenantId + '/2027030100', {
        method: 'PATCH',
        token: t,
        realm: realmA,
        body: { _id: tenantId, payments: [{ date: '05/03/2027', amount: 800, type: 'transfer', reference: 'DE-RPR-contract' }] },
      });
      expect(paid.status).toBe(200);
      const client = new HttpMreClient({ apiBaseUrl: base, timeoutMs: 5000 });
      expect(await client.readRentTerm(await token(), realmA, tenantId, '2027030100')).toEqual({
        amountDue: Money.of('800.00', 'EUR'),
        payments: [{ date: '2027-03-05', amount: Money.of('800.00', 'EUR'), type: 'transfer', reference: 'DE-RPR-contract' }],
      });
      expect(await client.readRentTerm(await token(), realmA, tenantId, '2028010100')).toBeUndefined();
    });

    it('GET /rents/:year/:month lists the Tenant\'s rent of that month with _id, term and totalWithoutBalanceAmount; another Realm\'s month does not (VC-4-03)', async () => {
      const { status, json } = await call('/rents/2027/04', { token: await token(), realm: realmA });
      expect(status).toBe(200);
      const rents = z.object({ rents: z.array(z.object({ _id: z.string(), term: z.number(), totalWithoutBalanceAmount: z.number() }).passthrough()) }).parse(json).rents;
      expect(rents.find((r) => r._id === tenantId)).toMatchObject({ term: 2027040100, totalWithoutBalanceAmount: 800 });
      const client = new HttpMreClient({ apiBaseUrl: base, timeoutMs: 5000 });
      expect(await client.listRentTerms(await token(), realmA, 2027, 4)).toContainEqual({ mreTenantId: tenantId, term: '2027040100', amountDue: Money.of('800.00', 'EUR') });
      expect((await client.listRentTerms(await token(), realmB, 2027, 4)).map((r) => r.mreTenantId)).not.toContain(tenantId);
    });

    it('PATCH /rents/payment/:id/:term replaces the settlement: DE\'s payment next to an existing one, the promo and description kept; without _id or for another Realm a 500 and no change (VC-4-04)', async () => {
      const client = new HttpMreClient({ apiBaseUrl: base, timeoutMs: 5000 });
      const term = '2027050100';
      // MRE's own form first: a cash payment, a settlement discount and a description (no VAT).
      const seeded = await call(`/rents/payment/${tenantId}/${term}`, {
        method: 'PATCH',
        token: await token(),
        realm: realmA,
        body: { _id: tenantId, payments: [{ date: '02/05/2027', amount: 100, type: 'cash', reference: '', description: 'Bar' }], promo: 10, notepromo: 'Rabatt', description: 'Mai' },
      });
      expect(seeded.status).toBe(200);
      const read = await client.readRentTermForWriteBack(await token(), realmA, tenantId, term);
      expect(read).toMatchObject({ mreTenantId: tenantId, term, vatRatio: 0, promo: 10, notepromo: 'Rabatt\n', extracharge: 0, description: 'Mai' });
      if (read === undefined) throw new Error('term not read');
      expect(storedPayments(read.payments)).toEqual([{ date: '02/05/2027', amount: 100, type: 'cash', reference: '', description: 'Bar' }]);
      const payment = dePayment('0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b', Money.of('700.10', 'EUR'), '2027-05-03' as BusinessDate);
      const written = await client.writeRentTermPayments(await token(), realmA, tenantId, term, writeBody(read, payment));
      expect(written.kind).toBe('ANSWERED');
      if (written.kind !== 'ANSWERED') throw new Error(written.kind);
      expect(verifyWritten(read, written.term, payment)).toBe('OK');
      const after = await client.readRentTermForWriteBack(await token(), realmA, tenantId, term);
      if (after === undefined) throw new Error('term not read');
      expect(verifyWritten(read, after, payment)).toBe('OK');
      expect(markerIn(after, payment)).toBe('PRESENT');
      // Quirk: the Tenant comes from the body's _id; without it findOne finds nothing and MRE answers 500 (review on #75).
      const withoutId = await call(`/rents/payment/${tenantId}/${term}`, { method: 'PATCH', token: await token(), realm: realmA, body: { payments: [] } });
      expect(withoutId.status).toBe(500);
      // The same user's other Realm: the Tenant is not found there either.
      expect(await client.writeRentTermPayments(await token(), realmB, tenantId, term, { ...writeBody(read, payment), payments: [] })).toEqual({ kind: 'REFUSED', status: 500 });
      expect(await client.readRentTermForWriteBack(await token(), realmA, tenantId, term)).toEqual(after);
      // Restore the term as MRE's form left it.
      const restored = await client.writeRentTermPayments(await token(), realmA, tenantId, term, { ...writeBody(read, payment), payments: storedPayments(read.payments) });
      expect(restored.kind === 'ANSWERED' && markerIn(restored.term, payment)).toBe('ABSENT');
    });

    it('the removal PATCH removes only DE\'s payment: the existing one, the promo and the description kept (VC-4-05)', async () => {
      const client = new HttpMreClient({ apiBaseUrl: base, timeoutMs: 5000 });
      const term = '2027060100';
      const payment = dePayment('1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b', Money.of('650.00', 'EUR'), '2027-06-03' as BusinessDate);
      const seeded = await call(`/rents/payment/${tenantId}/${term}`, {
        method: 'PATCH',
        token: await token(),
        realm: realmA,
        body: { _id: tenantId, payments: [{ date: '01/06/2027', amount: 150, type: 'cash', reference: '', description: 'Bar' }, payment], promo: 5, notepromo: 'Rabatt', description: 'Juni' },
      });
      expect(seeded.status).toBe(200);
      const read = await client.readRentTermForWriteBack(await token(), realmA, tenantId, term);
      if (read === undefined) throw new Error('term not read');
      expect(markerIn(read, payment)).toBe('PRESENT');
      const removed = await client.writeRentTermPayments(await token(), realmA, tenantId, term, removalBody(read, payment));
      if (removed.kind !== 'ANSWERED') throw new Error(removed.kind);
      expect(verifyRemoved(read, removed.term, payment)).toBe('OK');
      const after = await client.readRentTermForWriteBack(await token(), realmA, tenantId, term);
      if (after === undefined) throw new Error('term not read');
      expect(verifyRemoved(read, after, payment)).toBe('OK');
      expect(storedPayments(after.payments)).toEqual([{ date: '01/06/2027', amount: 150, type: 'cash', reference: '', description: 'Bar' }]);
      expect(after).toMatchObject({ promo: 5, notepromo: 'Rabatt\n', description: 'Juni' });
    });
  });
});

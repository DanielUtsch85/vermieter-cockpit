import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExactDecimal } from '../../shared/index.js';
import { HttpMreClient } from './http-mre-client.js';
import { MreClientError, type MreClientErrorCode } from './mre-client.js';
import { signJwt, startFakeMre, type FakeMre } from './fake-mre.test-support.js';

async function expectCode(promise: Promise<unknown>, code: MreClientErrorCode): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(MreClientError);
  await expect(promise).rejects.toMatchObject({ code });
}

/** Serves one fixed response for every request. */
async function startStub(status: number, body: string, delayMs = 0): Promise<{ url: string; close: () => void }> {
  const server = createServer((_req, res) => {
    setTimeout(() => res.writeHead(status, { 'content-type': 'application/json' }).end(body), delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/v2`, close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const PROPERTY_A = '6512f0c2a1b2c3d4e5f60718';
const PROPERTY_B = '6512f0c2a1b2c3d4e5f60719';
const TENANT_A = '6512f0c2a1b2c3d4e5f60a01';

describe('HttpMreClient against a fake MRE', () => {
  let mre: FakeMre;
  let client: HttpMreClient;

  beforeAll(async () => {
    mre = await startFakeMre([
      {
        _id: 'realm-a',
        name: 'Landlord A',
        members: [
          { name: 'Anna', email: 'anna@example.com', role: 'administrator', registered: true },
          { name: 'Ralf', email: 'ralf@example.com', role: 'renter', registered: true },
        ],
        applications: [{ clientId: 'x' }],
        bankInfo: { iban: 'DE00' },
        properties: [
          {
            _id: PROPERTY_A,
            name: 'Wohnung 1',
            surface: 64.5,
            price: 950,
            address: { street1: 'Musterstraße 1', street2: '', zipCode: '10115', city: 'Berlin', country: 'DE' },
          },
          { _id: PROPERTY_B, name: 'Stellplatz' },
        ],
        tenants: [{ _id: TENANT_A, name: 'Tina Mieterin', contacts: [{ email: 'tina@example.com' }] }],
      },
      {
        _id: 'realm-b',
        name: 'Landlord B',
        members: [{ name: 'Bert', email: 'bert@example.com', role: 'administrator', registered: true }],
        applications: [],
      },
    ]);
    client = new HttpMreClient({ apiBaseUrl: `${mre.apiBaseUrl}/`, timeoutMs: 2000 });
  });

  afterAll(async () => {
    await mre.close();
  });

  it('forwards the bearer token to GET /api/v2/realms and maps only the needed fields', async () => {
    const token = signJwt({ account: { email: 'anna@example.com', firstname: 'Anna' } });
    const realms = await client.listRealms(token);
    expect(realms).toEqual([
      {
        mreRealmId: 'realm-a',
        name: 'Landlord A',
        members: [
          { email: 'anna@example.com', role: 'administrator' },
          { email: 'ralf@example.com', role: 'renter' },
        ],
      },
    ]);
    expect(mre.requests.at(-1)).toEqual({ path: '/api/v2/realms', authorization: `Bearer ${token}`, organizationid: undefined });
  });

  it('lists the Realm properties via GET /properties with organizationid, mapping only cached fields', async () => {
    const token = signJwt({ account: { email: 'anna@example.com' } });
    const properties = await client.listProperties(token, 'realm-a');
    expect(properties).toEqual([
      {
        mrePropertyId: PROPERTY_A,
        name: 'Wohnung 1',
        address: { street1: 'Musterstraße 1', zipCode: '10115', city: 'Berlin', country: 'DE' },
        surface: ExactDecimal.of('64.5'),
      },
      { mrePropertyId: PROPERTY_B, name: 'Stellplatz', address: null, surface: null },
    ]);
    expect(mre.requests.at(-1)).toEqual({ path: '/api/v2/properties', authorization: `Bearer ${token}`, organizationid: 'realm-a' });
  });

  it('listProperties maps 401 to UNAUTHENTICATED and a foreign Realm (404 upstream) to FORBIDDEN', async () => {
    await expectCode(client.listProperties(signJwt({ account: { email: 'anna@example.com' } }, 'wrong-secret'), 'realm-a'), 'UNAUTHENTICATED');
    await expectCode(client.listProperties(signJwt({ account: { email: 'anna@example.com' } }), 'realm-b'), 'FORBIDDEN');
  });

  it('listTenantIds returns only the Tenants\' _id of the Realm; a foreign Realm is FORBIDDEN', async () => {
    const token = signJwt({ account: { email: 'anna@example.com' } });
    expect(await client.listTenantIds(token, 'realm-a')).toEqual([TENANT_A]);
    expect(mre.requests.at(-1)).toMatchObject({ path: '/api/v2/tenants', organizationid: 'realm-a' });
    await expectCode(client.listTenantIds(token, 'realm-b'), 'FORBIDDEN');
  });

  it('maps 401 (bad signature or expired) to UNAUTHENTICATED', async () => {
    await expectCode(client.listRealms(signJwt({ account: { email: 'anna@example.com' } }, 'wrong-secret')), 'UNAUTHENTICATED');
    await expectCode(client.listRealms(signJwt({ account: { email: 'anna@example.com' } }, undefined, -1)), 'UNAUTHENTICATED');
  });

  it('maps 403 (tenant session token) to FORBIDDEN', async () => {
    await expectCode(client.listRealms(signJwt({ account: { email: 'tom@example.com', role: 'tenant' } })), 'FORBIDDEN');
  });
});

describe('HttpMreClient failure handling', () => {
  it.each([
    [500, '{"status":500}'],
    [404, ''],
    [200, 'not json'],
    [200, '{"realms":[]}'],
    [200, '[{"_id":"","name":"n","members":[]}]'],
    [200, '[{"_id":"r","name":"n","members":{}}]'],
    [302, ''],
  ])('status %i with body %j → UNAVAILABLE', async (status, body) => {
    const stub = await startStub(status, body);
    try {
      await expectCode(new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listRealms('a.b.c'), 'UNAVAILABLE');
    } finally {
      stub.close();
    }
  });

  it.each([
    ['not an array', '{"properties":[]}'],
    ['a property without _id', '[{"_id":"6512f0c2a1b2c3d4e5f60718","name":"a"},{"name":"b"}]'],
    ['an empty _id', '[{"_id":""}]'],
  ])('listProperties: %s → UNAVAILABLE (never a silent "not found")', async (_label, body) => {
    const stub = await startStub(200, body);
    try {
      await expectCode(new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listProperties('a.b.c', 'r'), 'UNAVAILABLE');
    } finally {
      stub.close();
    }
  });

  it.each([
    ['not an array', '{"tenants":[]}'],
    ['a tenant without _id', '[{"_id":"6512f0c2a1b2c3d4e5f60a01"},{"name":"Tina"}]'],
    ['an empty _id', '[{"_id":""}]'],
  ])('listTenantIds: %s → UNAVAILABLE (never a silent "not found"), without the body in the message', async (_label, body) => {
    const stub = await startStub(200, body);
    try {
      const listing = new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listTenantIds('a.b.c', 'r');
      await expectCode(listing, 'UNAVAILABLE');
      await expect(listing).rejects.not.toThrow(/Tina/);
    } finally {
      stub.close();
    }
  });

  it.each([
    [64.5, '64.5'],
    [0, '0'],
    [120, '120'],
    [0.1, '0.1'],
    [33.333333333333336, '33.333333333333336'],
    [-5, null],
    [1e-7, null],
    [1e21, null],
    ['64.5', null],
    [null, null],
  ])('listProperties takes surface %j exactly as %j (no float arithmetic)', async (surface, expected) => {
    const stub = await startStub(200, JSON.stringify([{ _id: 'p1', surface }]));
    try {
      const [property] = await new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listProperties('a.b.c', 'r');
      expect(property?.surface?.toString() ?? null).toBe(expected);
    } finally {
      stub.close();
    }
  });

  it('listProperties keeps a property whose display fields are malformed, without them', async () => {
    const body = JSON.stringify([
      { _id: 'p1', name: 42, address: 'Berlin' },
      { _id: 'p2', name: 'ok', address: { street1: 7, city: 'Köln' } },
      { _id: 'p3', name: '' },
    ]);
    const stub = await startStub(200, body);
    try {
      expect(await new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listProperties('a.b.c', 'r')).toEqual([
        { mrePropertyId: 'p1', name: null, address: null, surface: null },
        { mrePropertyId: 'p2', name: 'ok', address: { city: 'Köln' }, surface: null },
        { mrePropertyId: 'p3', name: null, address: null, surface: null },
      ]);
    } finally {
      stub.close();
    }
  });

  it('drops members with unknown roles or shape individually, keeping the rest', async () => {
    const body = JSON.stringify([
      {
        _id: 'r1',
        name: 'n',
        members: [
          { email: 'a@b', role: 'owner' },
          { email: '', role: 'administrator' },
          'garbage',
          { email: 'c@d', role: 'renter' },
        ],
      },
      { _id: 'r2', name: 'm', members: [{ email: 'a@b', role: 'administrator' }] },
    ]);
    const stub = await startStub(200, body);
    try {
      const realms = await new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listRealms('a.b.c');
      expect(realms).toEqual([
        { mreRealmId: 'r1', name: 'n', members: [{ email: 'c@d', role: 'renter' }] },
        { mreRealmId: 'r2', name: 'm', members: [{ email: 'a@b', role: 'administrator' }] },
      ]);
    } finally {
      stub.close();
    }
  });

  it('does not follow redirects with the caller token', async () => {
    const target = await startStub(200, '[]');
    const server = createServer((_req, res) => res.writeHead(302, { location: `${target.url}/realms` }).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expectCode(new HttpMreClient({ apiBaseUrl: `http://127.0.0.1:${port}/api/v2`, timeoutMs: 2000 }).listRealms('a.b.c'), 'UNAVAILABLE');
    } finally {
      server.close();
      target.close();
    }
  });

  it('times out → UNAVAILABLE', async () => {
    const stub = await startStub(200, '[]', 500);
    try {
      await expectCode(new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 50 }).listRealms('a.b.c'), 'UNAVAILABLE');
    } finally {
      stub.close();
    }
  });

  it('connection refused → UNAVAILABLE', async () => {
    await expectCode(new HttpMreClient({ apiBaseUrl: 'http://127.0.0.1:9/api/v2', timeoutMs: 2000 }).listRealms('a.b.c'), 'UNAVAILABLE');
  });
});

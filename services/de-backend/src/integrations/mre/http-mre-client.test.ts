import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    expect(mre.requests.at(-1)).toEqual({ path: '/api/v2/realms', authorization: `Bearer ${token}` });
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
    [200, '[{"_id":"r","name":"n","members":[{"email":"a@b","role":"owner"}]}]'],
  ])('status %i with body %j → UNAVAILABLE', async (status, body) => {
    const stub = await startStub(status, body);
    try {
      await expectCode(new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listRealms('a.b.c'), 'UNAVAILABLE');
    } finally {
      stub.close();
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

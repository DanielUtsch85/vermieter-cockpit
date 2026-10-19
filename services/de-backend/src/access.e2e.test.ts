import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';

const unusedLink = () => Promise.reject(new Error('not used in this test'));

/**
 * VC-0-08 / Phase-0 exit: the DE health endpoint responds only for a valid
 * MRE-authenticated identity within a Realm — wired exactly as in main.ts,
 * against a fake MRE that mirrors the pinned baseline.
 */
describe('DE /api/v1 with real MRE wiring', () => {
  let mre: FakeMre;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    mre = await startFakeMre([
      {
        _id: 'realm-a',
        name: 'A',
        members: [
          { name: 'Anna', email: 'anna@example.com', role: 'administrator', registered: true },
          { name: 'Ralf', email: 'ralf@example.com', role: 'renter', registered: true },
        ],
        applications: [{ clientId: 'app-1' }],
      },
      {
        _id: 'realm-b',
        name: 'B',
        members: [{ name: 'Bert', email: 'bert@example.com', role: 'administrator', registered: true }],
        applications: [],
      },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    server = createApp({ isReady: async () => true, verifyPrincipal: mrePrincipalVerifier(client), linkPropertyReference: unusedLink }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
  });

  const call = (token: string | undefined, realm: string | undefined) =>
    fetch(`${base}/api/v1/health`, {
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(realm === undefined ? {} : { organizationid: realm }),
      },
    }).then((r) => r.status);

  const anna = { account: { email: 'anna@example.com' } };

  it('administrator of the Realm → 200', async () => {
    expect(await call(signJwt(anna), 'realm-a')).toBe(200);
  });

  it.each([
    ['no token', () => call(undefined, 'realm-a'), 401],
    ['forged token', () => call(signJwt(anna, 'forged'), 'realm-a'), 401],
    ['expired token', () => call(signJwt(anna, undefined, -5), 'realm-a'), 401],
    ['no Realm header', () => call(signJwt(anna), undefined), 403],
    ['other Realm (isolation)', () => call(signJwt(anna), 'realm-b'), 403],
    ['renter (no DE access)', () => call(signJwt({ account: { email: 'ralf@example.com' } }), 'realm-a'), 403],
    ['tenant token', () => call(signJwt({ account: { email: 'anna@example.com', role: 'tenant' } }), 'realm-a'), 403],
    ['application token', () => call(signJwt({ application: { clientId: 'app-1' } }), 'realm-a'), 403],
  ] as const)('%s → %i', async (_label, request, status) => {
    expect(await request()).toBe(status);
  });

  it('MRE unreachable → 503, never 200', async () => {
    const down = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(new HttpMreClient({ apiBaseUrl: 'http://127.0.0.1:9/api/v2', timeoutMs: 500 })),
      linkPropertyReference: unusedLink,
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => down.once('listening', () => resolve()));
    try {
      const res = await fetch(`http://127.0.0.1:${(down.address() as AddressInfo).port}/api/v1/health`, {
        headers: { authorization: `Bearer ${signJwt(anna)}`, organizationid: 'realm-a' },
      });
      expect(res.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => down.close(() => resolve()));
    }
  });
});

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessError, type PrincipalVerifier } from '../application/index.js';
import { createApp, type AppDependencies } from './app.js';

let server: Server | undefined;

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({
  email: 'anna@example.com',
  mreRealmId: mreRealmId ?? '',
  mreRole: 'administrator',
});

const unusedLink: AppDependencies['linkPropertyReference'] = () => Promise.reject(new Error('not used in this test'));
const unusedRefresh: AppDependencies['refreshPropertyReference'] = () => Promise.reject(new Error('not used in this test'));

async function start(deps: Partial<AppDependencies>): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, linkPropertyReference: unusedLink, refreshPropertyReference: unusedRefresh, ...deps }).listen(
    0,
    '127.0.0.1',
  );
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('health endpoints', () => {
  it('liveness answers ok without touching dependencies', async () => {
    let called = false;
    const base = await start({ isReady: async () => ((called = true), false) });
    const res = await fetch(`${base}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(called).toBe(false);
  });

  const readinessCases: [string, AppDependencies['isReady'], number, string][] = [
    ['ready', async () => true, 200, 'ok'],
    ['not ready', async () => false, 503, 'unavailable'],
    ['throwing check', () => Promise.reject(new Error('boom')), 503, 'unavailable'],
  ];
  it.each(readinessCases)('readiness: %s → %i', async (_label, isReady, status, body) => {
    const base = await start({ isReady });
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ status: body });
  });

  it('unknown routes are 404 JSON and the framework is not advertised', async () => {
    const base = await start({});
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('/api/v1 access guard', () => {
  it('passes the Authorization and organizationid headers to the verifier', async () => {
    const seen: [string | undefined, string | undefined][] = [];
    const base = await start({
      verifyPrincipal: async (auth, realm) => {
        seen.push([auth, realm]);
        return { email: 'a@b', mreRealmId: realm ?? '', mreRole: 'administrator' };
      },
    });
    const res = await fetch(`${base}/api/v1/health`, {
      headers: { authorization: 'Bearer x.y.z', organizationid: 'realm-a' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', mreRealmId: 'realm-a' });
    expect(seen).toEqual([['Bearer x.y.z', 'realm-a']]);
  });

  const cases: [string, PrincipalVerifier, number, string][] = [
    ['unauthenticated', async () => Promise.reject(new AccessError('UNAUTHENTICATED', 'x')), 401, 'UNAUTHORIZED'],
    ['not a member', async () => Promise.reject(new AccessError('FORBIDDEN', 'x')), 403, 'FORBIDDEN'],
    ['MRE unavailable', async () => Promise.reject(new AccessError('AUTH_UNAVAILABLE', 'x')), 503, 'EXTERNAL_SYSTEM_ERROR'],
    ['unexpected error', async () => Promise.reject(new Error('bug')), 503, 'EXTERNAL_SYSTEM_ERROR'],
    ['renter role', async () => ({ email: 'r@b', mreRealmId: 'realm-a', mreRole: 'renter' }), 403, 'FORBIDDEN'],
  ];
  it.each(cases)('%s → %i', async (_label, verifyPrincipal, status, code) => {
    const base = await start({ verifyPrincipal });
    const res = await fetch(`${base}/api/v1/health`, { headers: { organizationid: 'realm-a' } });
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(code);
    expect(body.error.message).not.toContain('x'.repeat(2));
    if (status === 401) expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('guards unknown /api/v1 routes too (no route discovery without access)', async () => {
    const base = await start({ verifyPrincipal: async () => Promise.reject(new AccessError('UNAUTHENTICATED', 'x')) });
    expect((await fetch(`${base}/api/v1/does-not-exist`)).status).toBe(401);
    const adminBase = await start({});
    expect((await fetch(`${adminBase}/api/v1/does-not-exist`)).status).toBe(404);
  });
});

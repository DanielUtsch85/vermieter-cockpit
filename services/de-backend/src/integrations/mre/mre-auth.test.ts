import { describe, expect, it } from 'vitest';
import { MreAuthError, verifyMrePrincipal, type MreAuthErrorCode } from './mre-auth.js';
import { MreClientError, type MreClient, type MreRealmMembership } from './mre-client.js';
import { HttpMreClient } from './http-mre-client.js';
import { signJwt, startFakeMre } from './fake-mre.test-support.js';

const realms: MreRealmMembership[] = [
  {
    mreRealmId: 'realm-a',
    name: 'Landlord A',
    members: [
      { email: 'anna@example.com', role: 'administrator' },
      { email: 'ralf@example.com', role: 'renter' },
    ],
  },
  { mreRealmId: 'realm-b', name: 'Landlord B', members: [{ email: 'bert@example.com', role: 'administrator' }] },
];

/** Fake client: returns the realms the token's account is a member of, like MRE. */
function fakeClient(behaviour: 'ok' | MreClientError = 'ok'): MreClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listRealms(token) {
      calls.push(token);
      if (behaviour !== 'ok') throw behaviour;
      const email = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).account?.email;
      return realms.filter((r) => r.members.some((m) => m.email === email));
    },
  };
}

const bearer = (payload: Record<string, unknown>) => `Bearer ${signJwt(payload)}`;

async function expectCode(promise: Promise<unknown>, code: MreAuthErrorCode): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(MreAuthError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('verifyMrePrincipal', () => {
  it('returns the principal with its Realm role for a member', async () => {
    const principal = await verifyMrePrincipal(fakeClient(), bearer({ account: { email: 'anna@example.com' } }), 'realm-a');
    expect(principal).toEqual({ email: 'anna@example.com', mreRealmId: 'realm-a', mreRole: 'administrator' });
    const renter = await verifyMrePrincipal(fakeClient(), bearer({ account: { email: 'ralf@example.com' } }), 'realm-a');
    expect(renter.mreRole).toBe('renter');
  });

  it.each([undefined, '', 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer abc', 'Bearer a.b', 'Bearer  a.b.c', 'Bearer a.b.c extra'])(
    'rejects authorization header %j without calling MRE',
    async (header) => {
      const client = fakeClient();
      await expectCode(verifyMrePrincipal(client, header, 'realm-a'), 'UNAUTHENTICATED');
      expect(client.calls).toEqual([]);
    },
  );

  it('accepts the auth scheme case-insensitively (RFC 7235)', async () => {
    const token = signJwt({ account: { email: 'anna@example.com' } });
    await expect(verifyMrePrincipal(fakeClient(), `bearer ${token}`, 'realm-a')).resolves.toMatchObject({ mreRole: 'administrator' });
  });

  it('rejects a missing Realm', async () => {
    await expectCode(verifyMrePrincipal(fakeClient(), bearer({ account: { email: 'anna@example.com' } }), undefined), 'NOT_A_REALM_MEMBER');
    await expectCode(verifyMrePrincipal(fakeClient(), bearer({ account: { email: 'anna@example.com' } }), ''), 'NOT_A_REALM_MEMBER');
  });

  it('Realm isolation: knowing another Realm ID grants nothing', async () => {
    await expectCode(verifyMrePrincipal(fakeClient(), bearer({ account: { email: 'anna@example.com' } }), 'realm-b'), 'NOT_A_REALM_MEMBER');
    await expectCode(verifyMrePrincipal(fakeClient(), bearer({ account: { email: 'anna@example.com' } }), 'realm-unknown'), 'NOT_A_REALM_MEMBER');
  });

  it('email matching is exact, as in MRE', async () => {
    await expectCode(verifyMrePrincipal(fakeClient(), bearer({ account: { email: 'Anna@Example.com' } }), 'realm-a'), 'NOT_A_REALM_MEMBER');
  });

  it.each([
    ['tenant session', { account: { email: 'anna@example.com', role: 'tenant' } }],
    ['application credential', { application: { clientId: 'x' } }],
    ['internal service', { service: { serviceId: 'api', realmId: 'realm-a', role: 'administrator' } }],
    ['account without email', { account: {} }],
  ])('rejects a %s token even if MRE answers', async (_label, payload) => {
    const client: MreClient = { listRealms: async () => realms };
    await expectCode(verifyMrePrincipal(client, bearer(payload), 'realm-a'), 'NOT_A_REALM_MEMBER');
  });

  it.each([
    ['UNAUTHENTICATED', 'UNAUTHENTICATED'],
    ['FORBIDDEN', 'NOT_A_REALM_MEMBER'],
    ['UNAVAILABLE', 'MRE_UNAVAILABLE'],
  ] as const)('maps MRE %s to %s (never to success)', async (mreCode, authCode) => {
    const client = fakeClient(new MreClientError(mreCode, 'x'));
    await expectCode(verifyMrePrincipal(client, bearer({ account: { email: 'anna@example.com' } }), 'realm-a'), authCode);
  });
});

describe('verifyMrePrincipal end-to-end with HttpMreClient and a fake MRE', () => {
  it('accepts a valid landlord token and rejects forged, expired and tenant tokens', async () => {
    const mre = await startFakeMre([
      {
        _id: 'realm-a',
        name: 'Landlord A',
        members: [{ name: 'Anna', email: 'anna@example.com', role: 'administrator', registered: true }],
        applications: [{ clientId: 'app-1' }],
      },
    ]);
    try {
      const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
      const anna = { account: { email: 'anna@example.com' } };
      await expect(verifyMrePrincipal(client, `Bearer ${signJwt(anna)}`, 'realm-a')).resolves.toMatchObject({ mreRole: 'administrator' });
      await expectCode(verifyMrePrincipal(client, `Bearer ${signJwt(anna, 'forged')}`, 'realm-a'), 'UNAUTHENTICATED');
      await expectCode(verifyMrePrincipal(client, `Bearer ${signJwt(anna, undefined, -5)}`, 'realm-a'), 'UNAUTHENTICATED');
      await expectCode(
        verifyMrePrincipal(client, `Bearer ${signJwt({ account: { email: 'anna@example.com', role: 'tenant' } })}`, 'realm-a'),
        'NOT_A_REALM_MEMBER',
      );
      // MRE answers 200 with the associated realm for application and service tokens;
      // only the landlord-account check in DE refuses them.
      for (const payload of [
        { application: { clientId: 'app-1' } },
        { service: { serviceId: 'api', realmId: 'realm-a', role: 'administrator' } },
      ]) {
        await expect(client.listRealms(signJwt(payload))).resolves.toHaveLength(1);
        await expectCode(verifyMrePrincipal(client, `Bearer ${signJwt(payload)}`, 'realm-a'), 'NOT_A_REALM_MEMBER');
      }
    } finally {
      await mre.close();
    }
  });
});

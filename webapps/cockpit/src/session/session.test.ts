import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_CODES } from '../api/errors';
import { envelope, fakeJwt, json, scriptedFetch } from '../api/fetch.test-support';
import { createMreAuthenticator, listRealms, SignInError } from './mre-authenticator';
import { readTokenClaims, Session } from './session';

const T0 = Date.parse('2026-11-10T10:00:00Z');
/** MRE landlord access tokens live 30 s (mre-integration.md §47.1). */
const token = (n: number, issuedAt = T0) => fakeJwt({ account: { email: `admin${n}@example.com` }, iat: issuedAt / 1000, exp: issuedAt / 1000 + 30, n });

function setup(...answers: Parameters<typeof scriptedFetch>) {
  const { fetch, calls } = scriptedFetch(...answers);
  const clock = { now: T0 };
  const session = new Session(createMreAuthenticator(fetch), () => clock.now);
  const states: string[] = [];
  session.subscribe(() => states.push(session.getState().status));
  return { session, calls, clock, states };
}

// The access token lives in memory only (§47.2 point 1): any use of browser storage fails the test.
const touched: string[] = [];
beforeEach(() => {
  touched.length = 0;
  const trap = (name: string) =>
    new Proxy({}, { get: (_target, key) => (touched.push(`${name}.${String(key)}`), () => undefined), set: () => (touched.push(name), true) });
  Object.assign(globalThis, { localStorage: trap('localStorage'), sessionStorage: trap('sessionStorage'), document: { cookie: '' } });
});
afterEach(() => {
  expect(touched).toEqual([]);
  expect((globalThis as unknown as { document: { cookie: string } }).document.cookie).toBe('');
  for (const name of ['localStorage', 'sessionStorage', 'document']) Reflect.deleteProperty(globalThis, name);
});

describe('session start: reuse of the MRE session (§47.2 point 1)', () => {
  it('a refresh cookie gives a session without sign-in', async () => {
    const { session, calls } = setup(json(200, { accessToken: token(1) }));
    await session.start();
    expect(session.getState()).toEqual({ status: 'signedIn', email: 'admin1@example.com', epoch: 0, renewedAt: undefined });
    expect(calls[0]).toMatchObject({ url: '/api/v2/authenticator/landlord/refreshtoken', method: 'POST', credentials: 'same-origin' });
    expect(calls[0]?.headers.has('authorization')).toBe(false);
  });

  it('without a refresh cookie (the authenticator answers 403) the user signs in', async () => {
    const { session } = setup(new Response('Forbidden', { status: 403 }));
    await session.start();
    expect(session.getState()).toEqual({ status: 'signedOut', expired: false });
  });

  it('an unreachable authenticator is shown as unavailable, not as signed out, and not retried by itself', async () => {
    const { session, calls } = setup(new TypeError('Failed to fetch'), json(200, { accessToken: token(1) }));
    await session.start();
    expect(session.getState()).toEqual({ status: 'unavailable' });
    expect(calls).toHaveLength(1);
    await session.start();
    expect(session.getState().status).toBe('signedIn');
  });
});

describe('sign-in through the MRE authenticator (§47.2 point 1)', () => {
  it('sends email and password once as JSON and keeps only the access token', async () => {
    const { session, calls } = setup(json(200, { accessToken: token(1) }));
    await session.signIn('admin1@example.com', 'geheim');
    expect(calls[0]).toMatchObject({ url: '/api/v2/authenticator/landlord/signin', method: 'POST', credentials: 'same-origin' });
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ email: 'admin1@example.com', password: 'geheim' });
    expect(session.getState()).toMatchObject({ status: 'signedIn', email: 'admin1@example.com', epoch: 1 });
    await expect(session.accessToken()).resolves.toBe(token(1));
  });

  it('maps the authenticator answers: 401 wrong credentials, 422 missing fields, anything else unavailable', async () => {
    const cases: [Response | Error, SignInError['reason']][] = [
      [new Response('invalid credentials', { status: 401 }), 'INVALID_CREDENTIALS'],
      [new Response('missing fields', { status: 422 }), 'MISSING_FIELDS'],
      [new Response('error', { status: 500 }), 'UNAVAILABLE'],
      [json(200, { notAToken: true }), 'UNAVAILABLE'],
      [new TypeError('Failed to fetch'), 'UNAVAILABLE'],
    ];
    for (const [answer, reason] of cases) {
      const { session } = setup(answer);
      await expect(session.signIn('a@example.com', 'x')).rejects.toEqual(new SignInError(reason));
      expect(session.getState().status).not.toBe('signedIn');
    }
  });

  it('each sign-in is a new epoch, so query keys of an earlier session never match', async () => {
    const { session } = setup(json(200, { accessToken: token(1) }), json(200, { accessToken: token(2) }));
    await session.signIn('a@example.com', 'x');
    await session.signIn('a@example.com', 'x');
    expect(session.getState()).toMatchObject({ epoch: 2 });
  });
});

describe('token renewal (30 s tokens, §47.2 points 1 and 4)', () => {
  it('reuses the token until 5 s before its exp, then renews through the refresh cookie', async () => {
    const { session, calls, clock } = setup(json(200, { accessToken: token(1) }), json(200, { accessToken: token(2, T0 + 25_000) }));
    await session.start();
    clock.now = T0 + 24_999;
    await expect(session.accessToken()).resolves.toBe(token(1));
    expect(calls).toHaveLength(1);
    clock.now = T0 + 25_000;
    await expect(session.accessToken()).resolves.toBe(token(2, T0 + 25_000));
    expect(calls[1]?.url).toBe('/api/v2/authenticator/landlord/refreshtoken');
    expect(session.getState()).toMatchObject({ status: 'signedIn', renewedAt: new Date(T0 + 25_000) });
  });

  it('concurrent renewals share one refresh call: the authenticator spends a refresh token on use', async () => {
    const { session, calls } = setup(json(200, { accessToken: token(1) }), json(200, { accessToken: token(2) }));
    await session.start();
    const renewed = await Promise.all([session.renew(), session.renew(), session.renew()]);
    expect(new Set(renewed)).toEqual(new Set([token(2)]));
    expect(calls).toHaveLength(2);
  });

  it('a refused refresh ends the session as expired', async () => {
    const { session, states } = setup(json(200, { accessToken: token(1) }), new Response('Forbidden', { status: 403 }));
    await session.start();
    await expect(session.renew()).rejects.toMatchObject({ status: 401, code: CLIENT_CODES.sessionExpired });
    expect(session.getState()).toEqual({ status: 'signedOut', expired: true });
    await expect(session.accessToken()).rejects.toMatchObject({ code: CLIENT_CODES.sessionExpired });
    expect(states).toEqual(['checking', 'signedIn', 'signedOut']);
  });

  it('an unreachable authenticator during a renewal keeps the session and reports the network error', async () => {
    const { session } = setup(json(200, { accessToken: token(1) }), new TypeError('Failed to fetch'), json(200, { accessToken: token(2) }));
    await session.start();
    await expect(session.renew()).rejects.toMatchObject({ status: 0, code: CLIENT_CODES.network });
    expect(session.getState().status).toBe('signedIn');
    await expect(session.renew()).resolves.toBe(token(2));
  });

  it('a token without a readable exp is renewed after 25 s', async () => {
    const { session, calls, clock } = setup(json(200, { accessToken: 'opaque' }), json(200, { accessToken: token(2) }));
    await session.start();
    clock.now = T0 + 24_999;
    await expect(session.accessToken()).resolves.toBe('opaque');
    clock.now = T0 + 25_000;
    await session.accessToken();
    expect(calls).toHaveLength(2);
    expect(readTokenClaims('opaque')).toEqual({ exp: undefined, email: undefined });
  });
});

describe('sign-out', () => {
  it('ends the session in MRE and in memory, even when the authenticator does not answer', async () => {
    for (const answer of [new Response(null, { status: 204 }), new TypeError('Failed to fetch')]) {
      const { session, calls } = setup(json(200, { accessToken: token(1) }), answer);
      await session.start();
      await session.signOut();
      expect(calls[1]).toMatchObject({ url: '/api/v2/authenticator/landlord/signout', method: 'DELETE', credentials: 'same-origin' });
      expect(session.getState()).toEqual({ status: 'signedOut', expired: false });
      await expect(session.accessToken()).rejects.toMatchObject({ code: CLIENT_CODES.sessionExpired });
    }
  });
});

describe('sign-out while a refresh is on its way (review on #319)', () => {
  it('waits for the refresh, then signs out in MRE; the late token never signs the user back in', async () => {
    let deliver: (response: Response) => void = () => undefined;
    const order: string[] = [];
    const { session, calls } = setup(
      json(200, { accessToken: token(1) }),
      () =>
        new Promise<Response>((resolve) => {
          deliver = (response) => {
            order.push('refresh resolved');
            resolve(response);
          };
        }),
      (call) => {
        order.push(`signout sent ${call.method}`);
        return new Response(null, { status: 204 });
      },
    );
    await session.start();
    const renewal = session.renew();
    const signedOut = session.signOut();
    expect(session.getState()).toEqual({ status: 'signedOut', expired: false });
    await Promise.resolve();
    expect(calls.map((call) => call.url)).toEqual(['/api/v2/authenticator/landlord/refreshtoken', '/api/v2/authenticator/landlord/refreshtoken']);
    deliver(json(200, { accessToken: token(2) }));
    await signedOut;
    await expect(renewal).rejects.toMatchObject({ code: CLIENT_CODES.sessionExpired });
    expect(session.getState()).toEqual({ status: 'signedOut', expired: false });
    await expect(session.accessToken()).rejects.toMatchObject({ code: CLIENT_CODES.sessionExpired });
    expect(calls.map((call) => call.url.split('/').pop())).toEqual(['refreshtoken', 'refreshtoken', 'signout']);
    expect(order).toEqual(['refresh resolved', 'signout sent DELETE']);
  });
});

describe('Realm choice from GET /api/v2/realms (§47.2 point 3)', () => {
  const realms = [
    { _id: '64b7f0c2a1b2c3d4e5f60718', name: 'Bestand Nord', members: [{ email: 'admin1@example.com', role: 'administrator' }] },
    { _id: '64b7f0c2a1b2c3d4e5f60719', members: [] },
    { name: 'ohne id' },
    { _id: '', name: 'leere id' },
    'kein Objekt',
  ];

  it('lists id and name with the session token, drops entries without an id', async () => {
    const { session, calls } = setup(json(200, { accessToken: token(1) }));
    await session.start();
    const fetch = scriptedFetch(json(200, realms));
    await expect(listRealms(session, fetch.fetch)).resolves.toEqual([
      { id: '64b7f0c2a1b2c3d4e5f60718', name: 'Bestand Nord' },
      { id: '64b7f0c2a1b2c3d4e5f60719', name: '' },
    ]);
    expect(fetch.calls[0]).toMatchObject({ url: '/api/v2/realms', method: 'GET' });
    expect(fetch.calls[0]?.headers.get('authorization')).toBe(`Bearer ${token(1)}`);
    expect(fetch.calls[0]?.headers.has('organizationid')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('a 401 renews the token and lists again; a tenant token (403) is an error, not an empty list', async () => {
    const { session } = setup(json(200, { accessToken: token(1) }), json(200, { accessToken: token(2) }));
    await session.start();
    const fetch = scriptedFetch(new Response('Unauthorized', { status: 401 }), json(200, realms), new Response('Forbidden', { status: 403 }));
    await expect(listRealms(session, fetch.fetch)).resolves.toHaveLength(2);
    expect(fetch.calls.map((call) => call.headers.get('authorization'))).toEqual([`Bearer ${token(1)}`, `Bearer ${token(2)}`]);
    await expect(listRealms(session, fetch.fetch)).rejects.toMatchObject({ status: 403, code: CLIENT_CODES.unexpected });
  });

  it('an answer that is not a list is an error', async () => {
    const { session } = setup(json(200, { accessToken: token(1) }));
    await session.start();
    await expect(listRealms(session, scriptedFetch(json(200, { realms })).fetch)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(listRealms(session, scriptedFetch(envelope(503, 'EXTERNAL_SYSTEM_ERROR')).fetch)).rejects.toMatchObject({ status: 503 });
  });
});

import { describe, expect, it } from 'vitest';
import { AccessError, type PrincipalVerifier } from './application/index.js';
import { cachingPrincipalVerifier } from './wiring.js';

/** Issue #161: the bounded verification cache in front of MRE. */
describe('cachingPrincipalVerifier', () => {
  const T0 = 1_800_000_000_000;

  /** An unsigned JWT-shaped token with the given `exp` in seconds; the cache reads only `exp`. */
  const token = (exp: number | undefined, id = 'a') =>
    `h.${Buffer.from(JSON.stringify({ sub: id, ...(exp === undefined ? {} : { exp }) })).toString('base64url')}.s`;

  function setup(answer: (call: number) => Promise<void> = async () => {}, options: { maxEntries?: number } = {}) {
    const clock = { now: T0 };
    const calls: [string | undefined, string | undefined][] = [];
    const inner: PrincipalVerifier = async (header, realm) => {
      calls.push([header, realm]);
      await answer(calls.length);
      return { email: 'anna@example.com', mreRealmId: realm ?? '', mreRole: 'administrator' };
    };
    const verify = cachingPrincipalVerifier(inner, { now: () => clock.now, ...options });
    return { clock, calls, verify };
  }

  const exp = (secondsFromT0: number) => T0 / 1000 + secondsFromT0;

  it('verifies a token once within its lifetime', async () => {
    const { calls, verify } = setup();
    const t = token(exp(30));
    await verify(`Bearer ${t}`, 'realm-a');
    expect(await verify(`Bearer ${t}`, 'realm-a')).toMatchObject({ mreRealmId: 'realm-a' });
    expect(calls).toHaveLength(1);
  });

  it('verifies again once the token has expired', async () => {
    const { clock, calls, verify } = setup();
    const t = token(exp(10));
    await verify(`Bearer ${t}`, 'realm-a');
    clock.now = T0 + 9_999;
    await verify(`Bearer ${t}`, 'realm-a');
    expect(calls).toHaveLength(1);
    clock.now = T0 + 10_000;
    await verify(`Bearer ${t}`, 'realm-a');
    expect(calls).toHaveLength(2);
  });

  it('caps an entry at 30 seconds, whatever exp says', async () => {
    const { clock, calls, verify } = setup();
    const t = token(exp(3600));
    await verify(`Bearer ${t}`, 'realm-a');
    clock.now = T0 + 29_999;
    await verify(`Bearer ${t}`, 'realm-a');
    expect(calls).toHaveLength(1);
    clock.now = T0 + 30_000;
    await verify(`Bearer ${t}`, 'realm-a');
    expect(calls).toHaveLength(2);
  });

  it('does not cache a token without exp', async () => {
    const { calls, verify } = setup();
    const t = token(undefined);
    await verify(`Bearer ${t}`, 'realm-a');
    await verify(`Bearer ${t}`, 'realm-a');
    expect(calls).toHaveLength(2);
  });

  it('keeps Realms apart: the same token for another Realm is verified for that Realm', async () => {
    const { calls, verify } = setup();
    const t = token(exp(30));
    await verify(`Bearer ${t}`, 'realm-a');
    expect(await verify(`Bearer ${t}`, 'realm-b')).toMatchObject({ mreRealmId: 'realm-b' });
    expect(calls).toEqual([
      [`Bearer ${t}`, 'realm-a'],
      [`Bearer ${t}`, 'realm-b'],
    ]);
  });

  it.each(['UNAUTHENTICATED', 'FORBIDDEN', 'AUTH_UNAVAILABLE'] as const)('never caches a rejection (%s)', async (code) => {
    const { calls, verify } = setup(async (call) => {
      if (call === 1) throw new AccessError(code, 'no');
    });
    const t = token(exp(30));
    await expect(verify(`Bearer ${t}`, 'realm-a')).rejects.toMatchObject({ code });
    await expect(verify(`Bearer ${t}`, 'realm-a')).resolves.toMatchObject({ mreRealmId: 'realm-a' });
    expect(calls).toHaveLength(2);
  });

  it('passes requests without token or Realm straight through', async () => {
    const { calls, verify } = setup();
    await verify(undefined, 'realm-a');
    await verify(undefined, 'realm-a');
    await verify(`Bearer ${token(exp(30))}`, undefined);
    await verify(`Bearer ${token(exp(30))}`, undefined);
    expect(calls).toHaveLength(4);
  });

  it('shares one verification between concurrent requests', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { calls, verify } = setup(() => gate);
    const t = token(exp(30));
    const both = Promise.all([verify(`Bearer ${t}`, 'realm-a'), verify(`Bearer ${t}`, 'realm-a')]);
    release();
    await both;
    expect(calls).toHaveLength(1);
  });

  it('drops the least recently used entry beyond maxEntries', async () => {
    const { calls, verify } = setup(undefined, { maxEntries: 2 });
    const [a, b, c] = ['a', 'b', 'c'].map((id) => `Bearer ${token(exp(30), id)}`) as [string, string, string];
    await verify(a, 'r');
    await verify(b, 'r');
    await verify(a, 'r'); // a is now the most recently used
    await verify(c, 'r'); // drops b
    expect(calls).toHaveLength(3);
    await verify(a, 'r');
    await verify(c, 'r');
    expect(calls).toHaveLength(3);
    await verify(b, 'r');
    expect(calls).toHaveLength(4);
  });
});

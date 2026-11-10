import { describe, expect, it } from 'vitest';
import { fakeJwt } from '../api/fetch.test-support';
import { createQueryClient, realmKey, sessionKey } from '../query';
import { clearCacheWhenSessionEnds } from './cache-binding';
import type { MreAuthenticator } from './mre-authenticator';
import { Session } from './session';

const A = '64b7f0c2a1b2c3d4e5f60718';
const token = (n: number) => fakeJwt({ account: { email: 'admin1@example.com' }, exp: 4_000_000_000, n });

/** A signed-in session and a cache bound to it, with one entry of the Realm and one of the session. */
async function setup(refreshes: (string | undefined)[]) {
  const mre: MreAuthenticator = {
    refresh: () => Promise.resolve(refreshes.shift()),
    signIn: () => Promise.resolve(token(9)),
    signOut: () => Promise.resolve(),
  };
  const session = new Session(mre);
  await session.start();
  const queryClient = createQueryClient();
  const unsubscribe = clearCacheWhenSessionEnds(session, queryClient);
  queryClient.setQueryData(realmKey(A, 0, 'health'), { status: 'ok', mreRealmId: A });
  queryClient.setQueryData(sessionKey(0, 'realms'), [{ id: A, name: 'Bestand Nord' }]);
  const keys = () =>
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryHash);
  return { session, queryClient, keys, unsubscribe };
}

describe('the query cache follows the session (ui-guide.md §7.3, §11)', () => {
  it('a token renewal keeps the session and its cache', async () => {
    const { session, keys } = await setup([token(1), token(2)]);
    await session.renew();
    expect(session.getState()).toMatchObject({ status: 'signedIn', epoch: 0 });
    expect(keys()).toHaveLength(2);
  });

  it('a sign-out empties the cache: no data of the session stays in memory', async () => {
    const { session, keys } = await setup([token(1)]);
    await session.signOut();
    expect(keys()).toEqual([]);
  });

  it('an expiry (refused refresh) empties the cache as well', async () => {
    const { session, keys } = await setup([token(1), undefined]);
    await expect(session.renew()).rejects.toMatchObject({ status: 401 });
    expect(session.getState()).toEqual({ status: 'signedOut', expired: true });
    expect(keys()).toEqual([]);
  });

  it('a running request of the ended session is cancelled: its signal aborts and its answer is not cached', async () => {
    const { session, queryClient, keys } = await setup([token(1)]);
    let aborted = false;
    let answer: (value: string) => void = () => undefined;
    const running = queryClient.fetchQuery({
      queryKey: realmKey(A, 0, 'late'),
      queryFn: ({ signal }) => {
        signal.addEventListener('abort', () => (aborted = true));
        return new Promise<string>((resolve) => (answer = resolve));
      },
    });
    await session.signOut();
    expect(aborted).toBe(true);
    answer('late answer of the old session');
    await running.catch(() => undefined);
    expect(keys()).toEqual([]);
  });

  it('counter-check: once unsubscribed, a sign-out leaves the cache as it is', async () => {
    const { session, keys, unsubscribe } = await setup([token(1)]);
    unsubscribe();
    await session.signOut();
    expect(keys()).toHaveLength(2);
  });
});

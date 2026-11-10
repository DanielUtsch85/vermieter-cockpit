import type { QueryClient } from '@tanstack/react-query';
import type { SessionState } from './session';

/** The epoch of a signed-in session, undefined for any other state. */
const epochOf = (state: SessionState): number | undefined => (state.status === 'signedIn' ? state.epoch : undefined);

/**
 * Empties the query cache when a session ends (sign-out, expiry) or another one begins (ui-guide.md §7.3: the cache key
 * starts with Realm and authenticated session; §11: no data of an earlier context stays). The keys already carry the
 * epoch, so an earlier session's entries could never be shown; this also drops them from memory and cancels their
 * requests. A token renewal keeps the session and the cache. Returns the unsubscribe function.
 */
export function clearCacheWhenSessionEnds(
  session: { readonly getState: () => SessionState; readonly subscribe: (listener: () => void) => () => void },
  queryClient: QueryClient,
): () => void {
  let current = epochOf(session.getState());
  return session.subscribe(() => {
    const next = epochOf(session.getState());
    // `clear` removes every query and cancels its request (its signal aborts); late answers land nowhere.
    if (current !== undefined && next !== current) queryClient.clear();
    current = next;
  });
}

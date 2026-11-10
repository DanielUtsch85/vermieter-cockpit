import { QueryClient } from '@tanstack/react-query';

/**
 * TanStack Query for server state (ui-guide.md §7.1, §7.3). No automatic retries: a `401` is renewed once inside the
 * client, `403` and `503` are shown and not repeated in a loop (mre-integration.md §47.2 point 4); a refetch on window
 * focus would re-read in the background without the user knowing which state is shown.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

/** Query keys start with the Realm and the session (ui-guide.md §7.3), then resource, filters and dates. */
export function realmKey(realmId: string, epoch: number, ...rest: readonly unknown[]): readonly unknown[] {
  return ['realm', realmId, epoch, ...rest];
}

/** Keys of MRE reads made before a Realm is chosen (the Realm list). */
export function sessionKey(epoch: number, ...rest: readonly unknown[]): readonly unknown[] {
  return ['session', epoch, ...rest];
}

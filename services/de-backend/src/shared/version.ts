/**
 * Optimistic concurrency (api-design.md §16.1, backlog VC-X-20): a command that would change an aggregate (a
 * Transaction, a Party, …) may name the version it was based on (`If-Match`). A stale one is refused, so two people
 * editing one record do not overwrite each other unseen. A command that changes nothing (a repeat, the same values)
 * is answered as a no-op without the check: it cannot lose an update, and a retry stays a retry.
 */
export interface VersionConflict {
  readonly kind: 'VERSION_CONFLICT';
  readonly expectedVersions: readonly number[];
  readonly currentVersion: number;
}

/**
 * `expectedVersions`: the versions named by the strong entity tags of `If-Match` (any one matches, RFC 9110
 * §13.1.1); `undefined` = no check (no header, or `*`). An empty list (only weak or foreign tags) never matches.
 */
export function checkVersion(currentVersion: number, expectedVersions: readonly number[] | undefined): VersionConflict | undefined {
  if (expectedVersions === undefined || expectedVersions.includes(currentVersion)) return undefined;
  return { kind: 'VERSION_CONFLICT', expectedVersions, currentVersion };
}

/**
 * DE access policy (ADR-034 / TECH-ADR-005, mre-integration.md §47.1).
 *
 * Authentication and Realm membership are verified by MRE through an injected
 * PrincipalVerifier; this module only decides what a verified principal may do.
 *
 * Decision (2026-10-18, project owner; record: https://github.com/DanielUtsch85/vermieter-cockpit/pull/6#issuecomment-6250297469):
 * the MRE Realm role `administrator` has full access to all DE data. `renter` has
 * no DE access until a narrower policy is specified. Unknown roles are denied.
 */

export type AccessErrorCode =
  /** No usable identity (→ 401). */
  | 'UNAUTHENTICATED'
  /** Identity known but not allowed in this Realm or for DE (→ 403). */
  | 'FORBIDDEN'
  /** The identity provider (MRE) could not be asked (→ 503). */
  | 'AUTH_UNAVAILABLE';

export class AccessError extends Error {
  override readonly name = 'AccessError';

  constructor(
    readonly code: AccessErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A caller verified by MRE as member of one Realm. */
export interface RealmPrincipal {
  readonly email: string;
  readonly mreRealmId: string;
  readonly mreRole: string;
}

/**
 * Verifies the caller's MRE token and membership of the given Realm. Throws
 * AccessError; never resolves for an unverified caller.
 */
export type PrincipalVerifier = (
  authorizationHeader: string | undefined,
  mreRealmId: string | undefined,
) => Promise<RealmPrincipal>;

/** MRE Realm roles with DE access. */
export const DE_ACCESS_ROLES: readonly string[] = ['administrator'];

/** Throws FORBIDDEN unless the principal's Realm role grants DE access. */
export function assertDeAccess(principal: RealmPrincipal): void {
  if (!DE_ACCESS_ROLES.includes(principal.mreRole)) {
    throw new AccessError('FORBIDDEN', `Realm role '${principal.mreRole}' has no DE access`);
  }
}

/**
 * Anti-corruption boundary to MicroRealEstate (ADR-034, mre-integration.md,
 * coding-guidelines §6). Domain and application code depend on this interface
 * and on the DE integration models below, never on MRE DTOs or HTTP.
 */

/** MRE realm roles a landlord-side member can hold (MRE `UserRole`). */
export type MreMemberRole = 'administrator' | 'renter';

/** A Realm the caller belongs to, reduced to what DE needs for authorization. */
export interface MreRealmMembership {
  readonly mreRealmId: string;
  readonly name: string;
  readonly members: readonly { readonly email: string; readonly role: MreMemberRole }[];
}

export type MreClientErrorCode =
  /** MRE rejected the token (missing, malformed, expired, bad signature): HTTP 401. */
  | 'UNAUTHENTICATED'
  /** MRE accepted the token but refused the caller (e.g. a tenant token): HTTP 403. */
  | 'FORBIDDEN'
  /** MRE unreachable, timed out, or answered with an unexpected status or body. */
  | 'UNAVAILABLE';

export class MreClientError extends Error {
  override readonly name = 'MreClientError';

  constructor(
    readonly code: MreClientErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface MreClient {
  /**
   * Realms the bearer of `accessToken` is a member of. MRE verifies the token
   * (signature, expiry) and resolves membership server-side.
   */
  listRealms(accessToken: string): Promise<readonly MreRealmMembership[]>;
}

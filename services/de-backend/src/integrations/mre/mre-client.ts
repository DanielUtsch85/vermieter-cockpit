import type { ExactDecimal } from '../../shared/index.js';

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

/** An MRE Property reduced to what DE caches for a PropertyReference (data-model.md §9). */
export interface MreProperty {
  readonly mrePropertyId: string;
  readonly name: string | null;
  readonly address: MreAddress | null;
  /** MRE stores surface as a JS number; DE keeps its decimal text exactly. */
  readonly surface: ExactDecimal | null;
}

export interface MreAddress {
  readonly street1?: string;
  readonly street2?: string;
  readonly zipCode?: string;
  readonly city?: string;
  readonly state?: string;
  readonly country?: string;
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

  /**
   * Properties of one Realm as visible to the bearer of `accessToken`; MRE
   * enforces membership and Realm isolation (mre-integration.md §21.1).
   */
  listProperties(accessToken: string, mreRealmId: string): Promise<readonly MreProperty[]>;

  /**
   * The `_id`s of one Realm's Tenants, as visible to the bearer of `accessToken`. MRE's list has no filter, so the
   * caller looks for the id itself (mre-integration.md §20.1); nothing else of a Tenant is read.
   */
  listTenantIds(accessToken: string, mreRealmId: string): Promise<readonly string[]>;
}

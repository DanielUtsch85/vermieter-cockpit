import type {
  CachedAddress,
  LinkOutcome,
  PropertyReferenceRepository,
} from '../domains/property-reference/index.js';
import { AccessError, type RealmPrincipal } from './access.js';

/**
 * Link Property command (api-design.md §23, backlog VC-1-01): binds an MRE
 * `Property` to a DE `PropertyReference`, idempotent on the natural key
 * `(mreRealmId, mrePropertyId)`.
 *
 * Order: an existing link is returned as-is (200) without asking MRE, so a
 * repeat stays a success even after the upstream Property was deleted (DE
 * records remain valid, §23.1). Only a new link reads MRE, and nothing is
 * written unless MRE confirmed the Property in the caller's Realm (§77).
 */

/** The MRE Property as far as linking needs it. */
export interface MrePropertySnapshot {
  readonly mrePropertyId: string;
  readonly name: string | null;
  readonly address: CachedAddress | null;
}

/**
 * Looks up one Property in a Realm with the caller's own MRE credentials, so
 * MRE enforces Realm isolation. Resolves undefined when MRE does not know it in
 * that Realm. Throws AccessError when MRE refuses the caller and
 * MreUnavailableError when MRE cannot be asked.
 */
export type MrePropertyLookup = (
  authorizationHeader: string,
  mreRealmId: string,
  mrePropertyId: string,
) => Promise<MrePropertySnapshot | undefined>;

export class MreUnavailableError extends Error {
  override readonly name = 'MreUnavailableError';
}

export class MrePropertyNotFoundError extends Error {
  override readonly name = 'MrePropertyNotFoundError';

  constructor(
    readonly mreRealmId: string,
    readonly mrePropertyId: string,
  ) {
    super(`MRE Property ${mrePropertyId} not found in Realm ${mreRealmId}`);
  }
}

export interface LinkPropertyReferenceInput {
  readonly principal: RealmPrincipal;
  /** The caller's `Authorization` header, forwarded to MRE for the lookup. */
  readonly authorizationHeader: string;
  readonly mreRealmId: string;
  readonly mrePropertyId: string;
}

export interface LinkPropertyReferenceDeps {
  readonly repository: PropertyReferenceRepository;
  readonly lookupMreProperty: MrePropertyLookup;
  readonly now?: () => Date;
}

export type LinkPropertyReference = (input: LinkPropertyReferenceInput) => Promise<LinkOutcome>;

export function linkPropertyReference(deps: LinkPropertyReferenceDeps): LinkPropertyReference {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, authorizationHeader, mreRealmId, mrePropertyId }) => {
    // The principal was verified for the Realm in the `organizationid` header;
    // the body must name the same Realm, never another one the caller guesses.
    if (mreRealmId !== principal.mreRealmId) {
      throw new AccessError('FORBIDDEN', 'mreRealmId does not match the verified Realm');
    }

    const existing = await deps.repository.findByMreIdentity(mreRealmId, mrePropertyId);
    if (existing !== undefined) return { reference: existing, created: false };

    const property = await deps.lookupMreProperty(authorizationHeader, mreRealmId, mrePropertyId);
    if (property === undefined) throw new MrePropertyNotFoundError(mreRealmId, mrePropertyId);

    return deps.repository.linkOnce(
      {
        mreRealmId,
        mrePropertyId,
        displayName: property.name,
        cachedAddress: property.address,
        refreshedAt: now(),
      },
      { actorType: 'USER', actorId: principal.email },
    );
  };
}

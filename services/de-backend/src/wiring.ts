import {
  AccessError,
  MreUnavailableError,
  type MrePropertyLookup,
  type PrincipalVerifier,
} from './application/index.js';
import { MreAuthError, MreClientError, bearerToken, verifyMrePrincipal, type MreClient } from './integrations/mre/index.js';

/**
 * Adapts the MRE integration to the application's ports. Lives outside the
 * layers so neither side depends on the other.
 */
export function mrePrincipalVerifier(client: MreClient): PrincipalVerifier {
  return async (authorizationHeader, mreRealmId) => {
    try {
      return await verifyMrePrincipal(client, authorizationHeader, mreRealmId);
    } catch (error) {
      if (error instanceof MreAuthError) {
        const code =
          error.code === 'UNAUTHENTICATED'
            ? 'UNAUTHENTICATED'
            : error.code === 'NOT_A_REALM_MEMBER'
              ? 'FORBIDDEN'
              : 'AUTH_UNAVAILABLE';
        throw new AccessError(code, error.message);
      }
      throw error;
    }
  };
}

/**
 * Existence is decided from `GET /properties` (the Realm's list), never from
 * `GET /properties/:id`, which answers 500 for unknown ids (mre-integration.md §21.1).
 */
export function mrePropertyLookup(client: MreClient): MrePropertyLookup {
  return async (authorizationHeader, mreRealmId, mrePropertyId) => {
    const token = bearerToken(authorizationHeader);
    if (token === undefined) throw new AccessError('UNAUTHENTICATED', 'Missing or malformed bearer token');
    let properties;
    try {
      properties = await client.listProperties(token, mreRealmId);
    } catch (error) {
      if (error instanceof MreClientError) {
        if (error.code === 'UNAUTHENTICATED') throw new AccessError('UNAUTHENTICATED', error.message);
        if (error.code === 'FORBIDDEN') throw new AccessError('FORBIDDEN', error.message);
        throw new MreUnavailableError(error.message);
      }
      throw error;
    }
    const property = properties.find((p) => p.mrePropertyId === mrePropertyId);
    return property === undefined
      ? undefined
      : { mrePropertyId: property.mrePropertyId, name: property.name, address: property.address };
  };
}

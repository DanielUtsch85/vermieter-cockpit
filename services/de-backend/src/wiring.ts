import { AccessError, type PrincipalVerifier } from './application/index.js';
import { MreAuthError, verifyMrePrincipal, type MreClient } from './integrations/mre/index.js';

/**
 * Adapts the MRE authentication adapter to the application's PrincipalVerifier
 * port. Lives outside the layers so neither side depends on the other.
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

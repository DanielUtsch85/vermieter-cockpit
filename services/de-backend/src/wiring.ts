import {
  AccessError,
  MreUnavailableError,
  type MrePropertyLookup,
  type MreRentTermLookup,
  type MreRentTermReader,
  type MreMonthReader,
  type MreWriteBackTermReader,
  type MreWriteBackTermWriter,
  type MreTenantLookup,
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
        const code = error.code === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : error.code === 'NOT_A_REALM_MEMBER' ? 'FORBIDDEN' : 'AUTH_UNAVAILABLE';
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
      throw mreError(error);
    }
    const property = properties.find((p) => p.mrePropertyId === mrePropertyId);
    return property === undefined
      ? undefined
      : { mrePropertyId: property.mrePropertyId, name: property.name, address: property.address, surface: property.surface };
  };
}

/**
 * Existence is decided client-side from `GET /tenants` (the Realm's full list: MRE has no filter), never from
 * `GET /tenants/:id`, which answers 500 for unknown ids (mre-integration.md §20.1).
 */
export function mreTenantLookup(client: MreClient): MreTenantLookup {
  return async (authorizationHeader, mreRealmId, mreTenantId) => {
    const token = bearerToken(authorizationHeader);
    if (token === undefined) throw new AccessError('UNAUTHENTICATED', 'Missing or malformed bearer token');
    try {
      return (await client.listTenantIds(token, mreRealmId)).includes(mreTenantId);
    } catch (error) {
      throw mreError(error);
    }
  };
}

/** Whether MRE returns the Tenant's rent term in the Realm, with the caller's own token (api-design.md §37.1). */
export function mreRentTermLookup(client: MreClient): MreRentTermLookup {
  return async (authorizationHeader, mreRealmId, mreTenantId, mreRentTerm) => {
    const token = bearerToken(authorizationHeader);
    if (token === undefined) throw new AccessError('UNAUTHENTICATED', 'Missing or malformed bearer token');
    try {
      return await client.rentTermExists(token, mreRealmId, mreTenantId, mreRentTerm);
    } catch (error) {
      throw mreError(error);
    }
  };
}

/** The rent term with its amount due and payments, read with the caller's own token (api-design.md §37.2). */
export function mreRentTermReader(client: MreClient): MreRentTermReader {
  return async (authorizationHeader, mreRealmId, mreTenantId, mreRentTerm) => {
    const token = bearerToken(authorizationHeader);
    if (token === undefined) throw new AccessError('UNAUTHENTICATED', 'Missing or malformed bearer token');
    try {
      return await client.readRentTerm(token, mreRealmId, mreTenantId, mreRentTerm);
    } catch (error) {
      throw mreError(error);
    }
  };
}

/** Every rent of the Realm in one month, read with the caller's own token (api-design.md §37.3). */
export function mreMonthReader(client: MreClient): MreMonthReader {
  return async (authorizationHeader, mreRealmId, year, month) => {
    const token = bearerToken(authorizationHeader);
    if (token === undefined) throw new AccessError('UNAUTHENTICATED', 'Missing or malformed bearer token');
    try {
      return await client.listRentTerms(token, mreRealmId, year, month);
    } catch (error) {
      throw mreError(error);
    }
  };
}

/** The rent term with its raw values for the write-back (api-design.md §37.4), read with the caller's own token. */
export function mreWriteBackTermReader(client: MreClient): MreWriteBackTermReader {
  return async (authorizationHeader, mreRealmId, mreTenantId, mreRentTerm) => {
    const token = bearerToken(authorizationHeader);
    if (token === undefined) throw new AccessError('UNAUTHENTICATED', 'Missing or malformed bearer token');
    try {
      return await client.readRentTermForWriteBack(token, mreRealmId, mreTenantId, mreRentTerm);
    } catch (error) {
      throw mreError(error);
    }
  };
}

/** The write-back's PATCH (api-design.md §37.4) with the caller's own token; only a refusal of the caller throws. */
export function mreWriteBackTermWriter(client: MreClient): MreWriteBackTermWriter {
  return async (authorizationHeader, mreRealmId, mreTenantId, mreRentTerm, write) => {
    const token = bearerToken(authorizationHeader);
    if (token === undefined) throw new AccessError('UNAUTHENTICATED', 'Missing or malformed bearer token');
    try {
      return await client.writeRentTermPayments(token, mreRealmId, mreTenantId, mreRentTerm, write);
    } catch (error) {
      throw mreError(error);
    }
  };
}

function mreError(error: unknown): unknown {
  if (error instanceof MreClientError) {
    if (error.code === 'UNAUTHENTICATED') return new AccessError('UNAUTHENTICATED', error.message);
    if (error.code === 'FORBIDDEN') return new AccessError('FORBIDDEN', error.message);
    return new MreUnavailableError(error.message);
  }
  return error;
}

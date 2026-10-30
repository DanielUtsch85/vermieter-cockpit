import {
  AccessError,
  MreUnavailableError,
  type MrePropertyLookup,
  type MreRentTermLookup,
  type MreRentTermReader,
  type MreMonthReader,
  type MreWriteBackTermReader,
  type MreWriteBackTermWriter,
  type MreRentBreakdownReader,
  type MreTenantDepositReader,
  type MreTenantLookup,
  type PrincipalVerifier,
} from './application/index.js';
import { createHash } from 'node:crypto';
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

export interface PrincipalCacheOptions {
  /** Upper bound on an entry's lifetime, whatever the token's `exp` says. */
  readonly maxTtlMs?: number;
  /** Upper bound on entries; the least recently used one is dropped first. */
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/**
 * Caches successful verifications per token and Realm (issue #161, mre-integration.md §47.1), so a page loading several
 * resources asks MRE once. An entry lives until the token's `exp`, at most `maxTtlMs`; `exp` is read only after MRE has
 * accepted the token, so it is signed. Rejections (401, 403, 503) are never cached; concurrent requests for the same key
 * share one MRE call. The cache is per process: each instance verifies for itself.
 */
export function cachingPrincipalVerifier(verify: PrincipalVerifier, options: PrincipalCacheOptions = {}): PrincipalVerifier {
  const maxTtlMs = options.maxTtlMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 1000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { principal: Awaited<ReturnType<PrincipalVerifier>>; expiresAt: number }>();
  const inFlight = new Map<string, ReturnType<PrincipalVerifier>>();

  return async (authorizationHeader, mreRealmId) => {
    const token = bearerToken(authorizationHeader);
    if (token === undefined || mreRealmId === undefined || mreRealmId === '') return verify(authorizationHeader, mreRealmId);
    // The token itself is not kept as a key; the separator keeps (token, Realm) pairs distinct.
    const key = `${createHash('sha256').update(token).digest('hex')}\u0000${mreRealmId}`;

    const hit = entries.get(key);
    if (hit !== undefined) {
      entries.delete(key);
      if (hit.expiresAt > now()) {
        entries.set(key, hit);
        return hit.principal;
      }
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;

    const verification = verify(authorizationHeader, mreRealmId);
    inFlight.set(key, verification);
    try {
      const principal = await verification;
      const exp = tokenExpiryMs(token);
      const expiresAt = Math.min(exp ?? -Infinity, now() + maxTtlMs);
      if (expiresAt > now()) {
        entries.set(key, { principal, expiresAt });
        if (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
      }
      return principal;
    } finally {
      inFlight.delete(key);
    }
  };
}

/** The JWT's `exp` in milliseconds, or undefined without a numeric one (then nothing is cached). */
function tokenExpiryMs(token: string): number | undefined {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    const exp = typeof payload === 'object' && payload !== null ? (payload as { exp?: unknown }).exp : undefined;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
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

/** One Tenant's deposit fields from the Realm's list `GET /tenants`, with the caller's own token (api-design.md §47.1). */
export function mreTenantDepositReader(client: MreClient): MreTenantDepositReader {
  return async (authorizationHeader, mreRealmId, mreTenantId) => {
    const token = bearerToken(authorizationHeader);
    if (token === undefined) throw new AccessError('UNAUTHENTICATED', 'Missing or malformed bearer token');
    try {
      return await client.readTenantDeposit(token, mreRealmId, mreTenantId);
    } catch (error) {
      throw mreError(error);
    }
  };
}

/** A rent term's totals of a Tenant from the Realm's list, with the caller's own token (api-design.md §37.6). */
export function mreRentBreakdownReader(client: MreClient): MreRentBreakdownReader {
  return async (authorizationHeader, mreRealmId, mreTenantId, mreRentTerm) => {
    const token = bearerToken(authorizationHeader);
    if (token === undefined) throw new AccessError('UNAUTHENTICATED', 'Missing or malformed bearer token');
    try {
      return await client.readRentBreakdown(token, mreRealmId, mreTenantId, mreRentTerm);
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

import { MreClientError, type MreClient, type MreMemberRole } from './mre-client.js';

/**
 * Authentication adapter (ADR-034 / TECH-ADR-005; mechanism recorded in
 * mre-integration.md §47): DE does not hold MRE's token secret and has no
 * credential store. It forwards the caller's MRE access token to MRE, which
 * verifies signature and expiry and returns the caller's Realms. Membership of
 * the requested Realm is then checked here, server-side, so a known Realm ID
 * alone never grants access.
 */

/** A caller verified by MRE and confirmed as member of one Realm. */
export interface VerifiedMrePrincipal {
  readonly email: string;
  readonly mreRealmId: string;
  readonly mreRole: MreMemberRole;
}

export type MreAuthErrorCode =
  /** No usable bearer token, or MRE rejected it (→ 401). */
  | 'UNAUTHENTICATED'
  /** Token is valid but not a landlord user token, or caller is not a member of the Realm (→ 403/404). */
  | 'NOT_A_REALM_MEMBER'
  /** MRE could not be asked (→ 503); never treated as success. */
  | 'MRE_UNAVAILABLE';

export class MreAuthError extends Error {
  override readonly name = 'MreAuthError';

  constructor(
    readonly code: MreAuthErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The auth scheme is case-insensitive (RFC 7235); the token is a three-part JWT. */
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

export async function verifyMrePrincipal(
  client: MreClient,
  authorizationHeader: string | undefined,
  mreRealmId: string | undefined,
): Promise<VerifiedMrePrincipal> {
  const token = authorizationHeader === undefined ? undefined : BEARER.exec(authorizationHeader)?.[1];
  if (token === undefined) {
    throw new MreAuthError('UNAUTHENTICATED', 'Missing or malformed bearer token');
  }
  if (mreRealmId === undefined || mreRealmId === '') {
    throw new MreAuthError('NOT_A_REALM_MEMBER', 'No Realm given');
  }

  let realms;
  try {
    realms = await client.listRealms(token);
  } catch (error) {
    if (error instanceof MreClientError) {
      if (error.code === 'UNAUTHENTICATED') throw new MreAuthError('UNAUTHENTICATED', error.message);
      if (error.code === 'FORBIDDEN') throw new MreAuthError('NOT_A_REALM_MEMBER', error.message);
      throw new MreAuthError('MRE_UNAVAILABLE', error.message);
    }
    throw error;
  }

  // MRE has verified this exact token; its claims can now be read. Only landlord
  // user tokens ({ account: { email } }) are accepted — not tenant sessions,
  // application credentials or internal service tokens.
  const email = landlordAccountEmail(token);
  if (email === undefined) {
    throw new MreAuthError('NOT_A_REALM_MEMBER', 'Not a landlord user token');
  }

  const realm = realms.find((r) => r.mreRealmId === mreRealmId);
  const member = realm?.members.find((m) => m.email === email);
  if (member === undefined) {
    throw new MreAuthError('NOT_A_REALM_MEMBER', 'Caller is not a member of the Realm');
  }
  return { email, mreRealmId, mreRole: member.role };
}

function landlordAccountEmail(token: string): string | undefined {
  const payloadPart = token.split('.')[1] ?? '';
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null || !('account' in payload)) return undefined;
  const account = (payload as { account: unknown }).account;
  if (typeof account !== 'object' || account === null) return undefined;
  const { email, role } = account as { email?: unknown; role?: unknown };
  if (typeof email !== 'string' || email === '' || role === 'tenant') return undefined;
  return email;
}

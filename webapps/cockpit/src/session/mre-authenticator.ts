import { ApiError, CLIENT_CODES } from '../api/errors';
import { authorizedFetch, readAnswer, type FetchLike, type TokenSource } from '../api/transport';

/**
 * The MRE side of the session (mre-integration.md §47.2): sign-in, refresh and sign-out run through the MRE
 * authenticator of the pinned baseline (`services/authenticator/src/routes/landlord.js` at 479d0ad), the Realms come
 * from the MRE API. There is no DE login. The refresh token is the authenticator's `httpOnly`, `sameSite: strict`
 * cookie; this client never sees it, it only sends requests on the same origin with `credentials: 'same-origin'`.
 */
export interface MreAuthenticator {
  /** The access token of a new session; rejects with a `SignInError`. */
  signIn(email: string, password: string): Promise<string>;
  /** A new access token from the refresh cookie, or undefined when there is no session (the authenticator's `403`). */
  refresh(): Promise<string | undefined>;
  signOut(): Promise<void>;
}

export class SignInError extends Error {
  override readonly name = 'SignInError';

  constructor(readonly reason: 'INVALID_CREDENTIALS' | 'MISSING_FIELDS' | 'UNAVAILABLE') {
    super(reason);
  }
}

const AUTHENTICATOR = '/api/v2/authenticator/landlord';

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

async function accessTokenOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as unknown;
    const token = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['accessToken'] : undefined;
    return typeof token === 'string' && token !== '' ? token : undefined;
  } catch {
    return undefined;
  }
}

export function createMreAuthenticator(fetchFn: FetchLike = defaultFetch): MreAuthenticator {
  const post = async (path: string, body?: unknown) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    const init: RequestInit = { method: 'POST', credentials: 'same-origin', headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      return await fetchFn(`${AUTHENTICATOR}${path}`, init);
    } catch {
      return undefined;
    }
  };

  return {
    async signIn(email, password) {
      const response = await post('/signin', { email, password });
      if (response === undefined) throw new SignInError('UNAVAILABLE');
      if (response.status === 401) throw new SignInError('INVALID_CREDENTIALS');
      if (response.status === 422) throw new SignInError('MISSING_FIELDS');
      const token = response.ok ? await accessTokenOf(response) : undefined;
      if (token === undefined) throw new SignInError('UNAVAILABLE');
      return token;
    },

    async refresh() {
      const response = await post('/refreshtoken');
      if (response === undefined) throw new ApiError(0, CLIENT_CODES.network, 'The MRE authenticator did not answer.');
      // The pinned authenticator answers 403 without or with a spent refresh cookie; 401 is read the same way.
      if (response.status === 401 || response.status === 403) return undefined;
      const token = response.ok ? await accessTokenOf(response) : undefined;
      if (token === undefined) throw new ApiError(response.status, CLIENT_CODES.unexpected, `Refresh answered HTTP ${response.status}.`);
      return token;
    },

    async signOut() {
      try {
        await fetchFn(`${AUTHENTICATOR}/signout`, { method: 'DELETE', credentials: 'same-origin' });
      } catch {
        // The local session ends anyway; the refresh token then expires in MRE on its own.
      }
    },
  };
}

/** A Realm the signed-in landlord is a member of (`GET /api/v2/realms`, the list DE checks against; §47.1). */
export interface MreRealm {
  readonly id: string;
  readonly name: string;
}

/**
 * The Realms of the session, from `GET /api/v2/realms`. Only id and name are read: membership and role are checked by
 * DE on every call (§47.1), so the choice of a Realm grants nothing by itself.
 */
export async function listRealms(tokens: TokenSource, fetchFn: FetchLike = defaultFetch, signal?: AbortSignal): Promise<readonly MreRealm[]> {
  const init: RequestInit = { method: 'GET', headers: { accept: 'application/json' } };
  if (signal !== undefined) init.signal = signal;
  const response = await authorizedFetch(tokens, fetchFn, '/api/v2/realms', init);
  const body = await readAnswer(response);
  if (!Array.isArray(body)) throw new ApiError(response.status, CLIENT_CODES.unexpected, 'The Realm list is not a list.');
  return body.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { _id: id, name } = entry as Record<string, unknown>;
    return typeof id === 'string' && id !== '' ? [{ id, name: typeof name === 'string' ? name : '' }] : [];
  });
}

import { ApiError, CLIENT_CODES, errorFromAnswer } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The session as the transport sees it (implemented by `session/session.ts`). */
export interface TokenSource {
  /** A current MRE access token, renewed first when it is about to expire. Rejects when there is no session. */
  accessToken(): Promise<string>;
  /** Renews the token after a `401` (mre-integration.md §47.2 point 4). Rejects when the session cannot be renewed. */
  renew(): Promise<string>;
  /** Ends the session after a renewed token was refused again: the user signs in again. */
  expire(): void;
}

/**
 * Sends a request with the session's token as `Authorization: Bearer …` and answers mre-integration.md §47.2 point 4: a
 * `401` renews the token and retries once; a second `401` ends the session (`CLIENT_SESSION_EXPIRED`). `403` and `503`
 * are returned as they are: never another Realm, never a retry loop.
 */
export async function authorizedFetch(tokens: TokenSource, fetchFn: FetchLike, url: string, init: RequestInit): Promise<Response> {
  const send = async (token: string) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    try {
      return await fetchFn(url, { ...init, headers, credentials: 'same-origin' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, CLIENT_CODES.network, 'No answer from the server; the outcome is unknown.');
    }
  };
  const first = await send(await tokens.accessToken());
  if (first.status !== 401) return first;
  const second = await send(await tokens.renew());
  if (second.status !== 401) return second;
  tokens.expire();
  throw new ApiError(401, CLIENT_CODES.sessionExpired, 'The renewed token was refused again; sign in again.');
}

/** The JSON body of an answer, or undefined when it has none or is not JSON. */
async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A 2xx answer's JSON body; a non-2xx answer becomes an `ApiError` (envelope, field errors, `Retry-After`). */
export async function readAnswer(response: Response): Promise<unknown> {
  const body = await readBody(response);
  if (!response.ok) throw errorFromAnswer(response.status, body, response.headers.get('retry-after'));
  if (body === undefined && response.status !== 204) {
    throw new ApiError(response.status, CLIENT_CODES.unexpected, `HTTP ${response.status} without a JSON body.`);
  }
  return body;
}

import type { TransactionRentCoverageDto } from './rent-reconciliations';
import type { FetchLike, TokenSource } from './transport';

/** A JSON answer as the backend or MRE sends it. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** The error envelope of api-design.md §12–13. */
export function envelope(status: number, code: string, details?: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code, message: `${code} message`, ...(details === undefined ? {} : { details }) } }, headers);
}

export interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  /** A `multipart/form-data` body as sent (the bank import). */
  readonly form: FormData | undefined;
  readonly credentials: RequestCredentials | undefined;
  readonly signal: AbortSignal | undefined;
}

/** A fetch that answers from a script, one answer per call in order, and records every call; a function may answer later. */
export function scriptedFetch(...answers: (Response | Error | ((call: Call) => Response | Promise<Response>))[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
      form: init.body instanceof FormData ? init.body : undefined,
      credentials: init.credentials,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const answer = answers.shift();
    if (answer === undefined) return Promise.reject(new Error(`unexpected call ${call.method} ${url}`));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(typeof answer === 'function' ? answer(call) : answer);
  };
  return { fetch, calls };
}

/** A token source with numbered tokens: `token-1` first, each renewal the next one. */
export function countingTokens(): TokenSource & { renewals: number; expired: boolean } {
  const tokens = {
    renewals: 0,
    expired: false,
    accessToken: () => Promise.resolve(`token-${tokens.renewals + 1}`),
    renew: () => {
      tokens.renewals += 1;
      return Promise.resolve(`token-${tokens.renewals + 1}`);
    },
    expire: () => {
      tokens.expired = true;
    },
  };
  return tokens;
}

const base64url = (value: string) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** An unsigned JWT with the given payload, shaped as MRE's landlord access token (`{ account: { email } }`, `exp`). */
export function fakeJwt(payload: Record<string, unknown>): string {
  return `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(payload))}.signature`;
}

/** `GET /transactions/{id}/rent-reconciliations` (step 6) when a test does not script it: no rent share, no match. */
const RENT_OF_TRANSACTION = /^GET \/api\/v1\/transactions\/([^/]+)\/rent-reconciliations$/;

/**
 * The answer of the Buchungsdetail's rent section when a test does not script that route (review on #339, H2): shaped
 * as the backend's `toTransactionDto` for a Transaction without a rent share and without matches. A test that scripts
 * the route gets only its own answers, and an exhausted queue stays an unexpected call.
 */
function defaultAnswer(key: string): (() => Response) | undefined {
  const rent = RENT_OF_TRANSACTION.exec(key);
  if (rent === null) return undefined;
  const coverage: TransactionRentCoverageDto = {
    transactionId: decodeURIComponent(rent[1] ?? ''),
    status: 'IMPORTED',
    direction: 'INFLOW',
    correctionRole: null,
    counted: false,
    rentCash: null,
    matchedTotal: { amount: '0.00', currency: 'EUR' },
    available: null,
    reconciliations: [],
  };
  return () => json(200, coverage);
}

/**
 * A fetch that answers by method and path, each route with its own queue of answers; every call is recorded. A route
 * the test does not name at all gets its default answer where there is one (`defaultAnswer`), else it is refused.
 */
export function routedFetch(routes: Record<string, (() => Response)[]>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
      form: init.body instanceof FormData ? init.body : undefined,
      credentials: init.credentials,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const key = `${call.method} ${new URL(url, 'https://cockpit.internal').pathname}`;
    const next = Object.hasOwn(routes, key) ? routes[key]?.shift() : defaultAnswer(key);
    return next === undefined ? Promise.reject(new Error(`unexpected call ${key}`)) : Promise.resolve(next());
  };
  return { fetch, calls };
}

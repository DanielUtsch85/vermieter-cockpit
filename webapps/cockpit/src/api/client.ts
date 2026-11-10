import { authorizedFetch, readAnswer, type FetchLike, type TokenSource } from './transport';

/**
 * The typed client of the DE API (ui-guide.md §7.1: one place for base URL, Realm, token, errors, versions and
 * aborting). Same origin behind the reverse proxy, so the base is the path `/api/v1` (mre-integration.md §47.2, no CORS).
 */

export type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface RequestOptions {
  /**
   * Query parameters. Only the parameters a route supports may be sent: the backend refuses every unknown one (§58W,
   * ui-guide.md §6.3). `undefined` leaves a parameter out; a list is sent as the backend's comma list (`status=A,B`).
   */
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** A JSON body. Never a whole response object: separate request types per command (ui-guide.md §5.3). */
  readonly body?: unknown;
  /** The strong `ETag` read before, as received (`"3"`), for `If-Match` (ui-guide.md §7.3). */
  readonly ifMatch?: string;
  /** One key per business intent of the user, the same key for a retry after a timeout (ui-guide.md §7.3). */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface ApiResult<T> {
  readonly status: number;
  readonly data: T;
  /** The `ETag` of the answer, when it has one: the version to send with the next change. */
  readonly etag: string | undefined;
}

export interface DeClient {
  /** The Realm every call of this client is made for (`organizationid`). */
  readonly realmId: string;
  get<T>(path: string, options?: RequestOptions): Promise<ApiResult<T>>;
  post<T>(path: string, options?: RequestOptions): Promise<ApiResult<T>>;
  put<T>(path: string, options?: RequestOptions): Promise<ApiResult<T>>;
}

/** A strong entity tag, as the backend sends and reads it (`"3"`; api-design.md §16.1). */
const STRONG_ETAG = /^"[\x21\x23-\x7e]*"$/;
/** The backend's `Idempotency-Key` format (validation.ts: visible ASCII, 1–255 characters). */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

/** The `If-Match` value for a version number of a DTO (`version: 3` → `"3"`). */
export function ifMatchForVersion(version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) throw new TypeError(`Not a version: ${version}`);
  return `"${version}"`;
}

/** A new key for one business intent. Create it when the user decides, not per click or per network retry. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** A path with each value encoded as one segment: `apiPath\`/transactions/${id}\``. */
export function apiPath(strings: TemplateStringsArray, ...values: readonly string[]): string {
  return strings.reduce((path, part, i) => path + part + (i < values.length ? encodeURIComponent(values[i] ?? '') : ''), '');
}

export function queryString(query: Readonly<Record<string, QueryValue>> | undefined): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`Query parameter ${name} is not a finite number.`);
    params.append(name, typeof value === 'object' ? value.join(',') : String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export function createDeClient(options: {
  readonly tokens: TokenSource;
  /** The chosen MRE Realm, sent as `organizationid` on every call (mre-integration.md §47.1, §47.2 point 3). */
  readonly realmId: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
}): DeClient {
  const baseUrl = options.baseUrl ?? '/api/v1';
  const fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const request = async <T>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> => {
    if (!path.startsWith('/')) throw new TypeError(`An API path starts with "/": ${path}`);
    const headers = new Headers({ accept: 'application/json', organizationid: options.realmId });
    if (opts.ifMatch !== undefined) {
      if (!STRONG_ETAG.test(opts.ifMatch)) throw new TypeError(`If-Match needs a strong entity tag: ${opts.ifMatch}`);
      headers.set('if-match', opts.ifMatch);
    }
    if (opts.idempotencyKey !== undefined) {
      if (!IDEMPOTENCY_KEY.test(opts.idempotencyKey)) throw new TypeError('Idempotency-Key must be 1–255 visible ASCII characters.');
      headers.set('idempotency-key', opts.idempotencyKey);
    }
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(opts.body);
    }
    if (opts.signal !== undefined) init.signal = opts.signal;
    const response = await authorizedFetch(options.tokens, fetchFn, `${baseUrl}${path}${queryString(opts.query)}`, init);
    const data = (await readAnswer(response)) as T;
    return { status: response.status, data, etag: response.headers.get('etag') ?? undefined };
  };

  return {
    realmId: options.realmId,
    get: (path, opts) => request('GET', path, opts),
    post: (path, opts) => request('POST', path, opts),
    put: (path, opts) => request('PUT', path, opts),
  };
}

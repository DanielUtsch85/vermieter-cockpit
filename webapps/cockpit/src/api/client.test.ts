import { describe, expect, it } from 'vitest';
import { apiPath, createDeClient, ifMatchForVersion, newIdempotencyKey, queryString } from './client';
import { CLIENT_CODES } from './errors';
import { countingTokens, envelope, json, scriptedFetch } from './fetch.test-support';

const REALM = '64b7f0c2a1b2c3d4e5f60718';

function client(...answers: Parameters<typeof scriptedFetch>) {
  const { fetch, calls } = scriptedFetch(...answers);
  const tokens = countingTokens();
  return { api: createDeClient({ tokens, realmId: REALM, fetch }), calls, tokens };
}

describe('DE client: request shape', () => {
  it('sends token, Realm and Accept on the same origin under /api/v1', async () => {
    const { api, calls } = client(json(200, { status: 'ok', mreRealmId: REALM }));
    const result = await api.get<{ status: string }>('/health');
    expect(result).toEqual({ status: 200, data: { status: 'ok', mreRealmId: REALM }, etag: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/health');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.credentials).toBe('same-origin');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer token-1');
    expect(calls[0]?.headers.get('organizationid')).toBe(REALM);
    expect(calls[0]?.headers.get('accept')).toBe('application/json');
    expect(calls[0]?.headers.has('content-type')).toBe(false);
  });

  it('sends only the parameters given: undefined left out, lists as comma lists, no index', async () => {
    const { api, calls } = client(json(200, { items: [], total: 0 }));
    await api.get('/transactions', { query: { page: 2, pageSize: 50, reviewable: true, status: ['IMPORTED', 'UNREVIEWED'], financialAccountId: undefined } });
    expect(calls[0]?.url).toBe('/api/v1/transactions?page=2&pageSize=50&reviewable=true&status=IMPORTED%2CUNREVIEWED');
    expect(queryString({})).toBe('');
    expect(queryString({ a: undefined })).toBe('');
    expect(() => queryString({ page: Number.NaN })).toThrow(TypeError);
  });

  it('a JSON body gets its content type; the answer carries the ETag for the next change', async () => {
    const { api, calls } = client(json(200, { transactionId: 't', version: 4 }, { etag: '"4"' }));
    const body = { splits: [{ amount: { amount: '850.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE' }] };
    const result = await api.put('/transactions/t/splits', { body, ifMatch: '"3"' });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.headers.get('if-match')).toBe('"3"');
    expect(calls[0]?.body).toBe(JSON.stringify(body));
    expect(result.etag).toBe('"4"');
  });

  it('If-Match only with a strong entity tag; a version becomes one', async () => {
    const { api, calls } = client();
    await expect(api.post('/transactions/t/confirm', { ifMatch: 'W/"3"' })).rejects.toThrow(TypeError);
    await expect(api.post('/transactions/t/confirm', { ifMatch: '3' })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
    expect(ifMatchForVersion(3)).toBe('"3"');
    expect(() => ifMatchForVersion(-1)).toThrow(TypeError);
    expect(() => ifMatchForVersion(1.5)).toThrow(TypeError);
  });

  it('Idempotency-Key is sent as given and checked against the backend format', async () => {
    const key = newIdempotencyKey();
    const { api, calls } = client(json(201, { original: {}, reversal: {}, replacement: {} }));
    await api.post('/transactions/t/correct', { idempotencyKey: key, ifMatch: '"5"', body: { reason: 'Falsche Kategorie' } });
    expect(calls[0]?.headers.get('idempotency-key')).toBe(key);
    expect(key).toMatch(/^[\x21-\x7e]{1,255}$/);
    expect(newIdempotencyKey()).not.toBe(key);
    await expect(api.post('/transactions/t/correct', { idempotencyKey: 'mit leerzeichen' })).rejects.toThrow(TypeError);
    await expect(api.post('/transactions/t/correct', { idempotencyKey: '' })).rejects.toThrow(TypeError);
  });

  it('paths start with a slash; apiPath encodes each value as one segment', async () => {
    const { api } = client();
    await expect(api.get('health')).rejects.toThrow(TypeError);
    expect(apiPath`/transactions/${'a/b?c'}/splits`).toBe('/transactions/a%2Fb%3Fc/splits');
    expect(apiPath`/health`).toBe('/health');
  });
});

describe('DE client: answers (mre-integration.md §47.2 point 4, ui-guide.md §7.4)', () => {
  it('a 401 renews the token and retries once with the new token', async () => {
    const { api, calls, tokens } = client(envelope(401, 'UNAUTHORIZED'), json(200, { status: 'ok', mreRealmId: REALM }));
    await expect(api.get('/health')).resolves.toMatchObject({ status: 200 });
    expect(calls.map((call) => call.headers.get('authorization'))).toEqual(['Bearer token-1', 'Bearer token-2']);
    expect(tokens.renewals).toBe(1);
    expect(tokens.expired).toBe(false);
  });

  it('a second 401 ends the session: CLIENT_SESSION_EXPIRED, no third call', async () => {
    const { api, calls, tokens } = client(envelope(401, 'UNAUTHORIZED'), envelope(401, 'UNAUTHORIZED'));
    await expect(api.get('/health')).rejects.toMatchObject({ status: 401, code: CLIENT_CODES.sessionExpired });
    expect(calls).toHaveLength(2);
    expect(tokens.expired).toBe(true);
  });

  it('a 403 is returned as it is: no renewal, no retry, the Realm unchanged', async () => {
    const { api, calls, tokens } = client(envelope(403, 'FORBIDDEN'));
    await expect(api.get('/health')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(calls).toHaveLength(1);
    expect(tokens.renewals).toBe(0);
  });

  it('a 503 is returned with its Retry-After and not repeated', async () => {
    const { api, calls } = client(envelope(503, 'EXTERNAL_SYSTEM_ERROR', undefined, { 'retry-after': '10' }));
    await expect(api.get('/health')).rejects.toMatchObject({ status: 503, code: 'EXTERNAL_SYSTEM_ERROR', retryAfterSeconds: 10 });
    expect(calls).toHaveLength(1);
  });

  it('a 400 carries its field errors in the server order', async () => {
    const fields = [
      { field: 'zzz', code: 'INVALID_FORMAT' },
      { field: 'status', code: 'INVALID_FORMAT' },
    ];
    const { api } = client(envelope(400, 'VALIDATION_ERROR', { fields }));
    await expect(api.get('/transactions', { query: { zzz: '1', status: 'NOPE' } })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR', fields });
  });

  it('a 412 keeps its details for the version conflict dialog', async () => {
    const { api } = client(envelope(412, 'VERSION_CONFLICT', { currentVersion: 7 }));
    await expect(api.post('/transactions/t/confirm', { ifMatch: '"6"' })).rejects.toMatchObject({ status: 412, details: { currentVersion: 7 } });
  });

  it('no answer is CLIENT_NETWORK_ERROR with status 0: the outcome is unknown', async () => {
    const { api } = client(new TypeError('Failed to fetch'));
    await expect(api.get('/health')).rejects.toMatchObject({ status: 0, code: CLIENT_CODES.network });
  });

  it('an abort stays an abort, not a network error', async () => {
    const { api } = client(new DOMException('aborted', 'AbortError'));
    await expect(api.get('/health', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a 2xx answer without JSON is CLIENT_UNEXPECTED_RESPONSE; a 204 has no data', async () => {
    const { api } = client(new Response('<html></html>', { status: 200 }), new Response(null, { status: 204 }));
    await expect(api.get('/health')).rejects.toMatchObject({ status: 200, code: CLIENT_CODES.unexpected });
    await expect(api.post('/x')).resolves.toEqual({ status: 204, data: undefined, etag: undefined });
  });

  it('an HTML error page of the proxy is CLIENT_UNEXPECTED_RESPONSE with its status', async () => {
    const { api } = client(new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    await expect(api.get('/health')).rejects.toMatchObject({ status: 502, code: CLIENT_CODES.unexpected });
  });
});

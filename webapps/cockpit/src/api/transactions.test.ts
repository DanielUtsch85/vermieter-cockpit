import { describe, expect, it } from 'vitest';
import { USED_ROUTES } from '../gate/backend-pin';
import { readListParams, toApiQuery } from '../transactions/list-params';
import { account, ACCOUNT, detail, page, property, REALM_A, REALM_B, split, transaction, TX } from '../transactions/fixtures.test-support';
import { createDeClient } from './client';
import { ApiError, CLIENT_CODES } from './errors';
import { countingTokens, envelope, json, scriptedFetch, type Call } from './fetch.test-support';
import { getTransaction, listFinancialAccounts, listFinancialCategories, listPropertyReferences, listTransactions, PICKER_PAGE_SIZE } from './transactions';

function client(...answers: Parameters<typeof scriptedFetch>) {
  const { fetch, calls } = scriptedFetch(...answers);
  return { client: createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch }), calls };
}

/** The inventory route a call reached: its path matched against the `:parameter` templates of `USED_ROUTES`. */
function routeOf(call: Call): string | undefined {
  const path = new URL(call.url, 'https://cockpit.internal').pathname;
  const used = USED_ROUTES.find(([method, template]) => method === call.method && new RegExp(`^${template.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path));
  return used === undefined ? undefined : `${used[0]} ${used[1]}`;
}

describe('step 2 reads: GET /transactions (api-design.md §30.1)', () => {
  it('sends only the supported parameters of the URL, with the Realm and the token', async () => {
    const { client: de, calls } = client(json(200, page([transaction()])));
    const query = toApiQuery(readListParams('?status=IMPORTED&status=UNREVIEWED&q=Miete&reviewable=true&page=2'));
    const result = await listTransactions(de, query);
    expect(result.items).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/transactions?status=IMPORTED%2CUNREVIEWED&reviewable=true&page=2&pageSize=50');
    expect(calls[0]?.headers.get('organizationid')).toBe(REALM_A);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer token-1');
    expect(calls[0]?.body).toBeUndefined();
  });

  it('the amount stays the string of the API: no number reaches the page', async () => {
    const { client: de } = client(json(200, page([transaction({ amount: { amount: '999999999999999999.99', currency: 'EUR' } })])));
    const result = await listTransactions(de, { page: '1', pageSize: '50' });
    expect(result.items[0]?.amount).toEqual({ amount: '999999999999999999.99', currency: 'EUR' });
  });

  it('a refusal keeps its field errors with their names, in the server order', async () => {
    const fields = [
      { field: 'status', code: 'INVALID_FORMAT' },
      { field: 'bookingDateTo', code: 'INVALID_RANGE' },
      { field: 'zzz', code: 'INVALID_FORMAT' },
    ];
    const { client: de } = client(envelope(400, 'VALIDATION_ERROR', { fields }));
    const error = await listTransactions(de, { status: 'FOO', page: '1', pageSize: '50' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).fields).toEqual(fields);
  });

  it('403 and 503 are errors and are not repeated', async () => {
    const { client: de, calls } = client(envelope(403, 'FORBIDDEN'), envelope(503, 'EXTERNAL_SYSTEM_ERROR', undefined, { 'retry-after': '9' }));
    await expect(listTransactions(de, { page: '1', pageSize: '50' })).rejects.toMatchObject({ status: 403 });
    await expect(listTransactions(de, { page: '1', pageSize: '50' })).rejects.toMatchObject({ status: 503, retryAfterSeconds: 9 });
    expect(calls).toHaveLength(2);
  });

  it('an item of another Realm refuses the whole answer (never shown)', async () => {
    const { client: de } = client(json(200, page([transaction(), transaction({ mreRealmId: REALM_B })])));
    await expect(listTransactions(de, { page: '1', pageSize: '50' })).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
  });
});

describe('step 2 reads: GET /transactions/{transactionId}', () => {
  it('reads the Transaction with its splits and its ETag', async () => {
    const { client: de, calls } = client(json(200, detail({ splits: [split()] }), { etag: '"3"' }));
    const read = await getTransaction(de, TX);
    expect(calls[0]?.url).toBe(`/api/v1/transactions/${TX}`);
    expect(read.etag).toBe('"3"');
    expect(read.transaction.splits).toHaveLength(1);
  });

  it('the id is one encoded path segment', async () => {
    const { client: de, calls } = client(envelope(400, 'VALIDATION_ERROR', { fields: [{ field: 'transactionId', code: 'INVALID_FORMAT' }] }));
    await expect(getTransaction(de, '../financial-accounts')).rejects.toMatchObject({ status: 400 });
    expect(calls[0]?.url).toBe('/api/v1/transactions/..%2Ffinancial-accounts');
  });

  it('404 is an error; a detail of another Realm is refused', async () => {
    const { client: de } = client(envelope(404, 'NOT_FOUND'), json(200, detail({ mreRealmId: REALM_B })));
    await expect(getTransaction(de, TX)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(getTransaction(de, TX)).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
  });
});

describe('step 2 reads: the lists that name ids (accounts, objects, categories)', () => {
  it('read the first page at the largest page size, no other parameter', async () => {
    const { client: de, calls } = client(json(200, page([account()])), json(200, page([property()])), json(200, { items: [] }));
    await listFinancialAccounts(de);
    await listPropertyReferences(de);
    await listFinancialCategories(de);
    expect(calls.map((call) => call.url)).toEqual([
      `/api/v1/financial-accounts?page=1&pageSize=${PICKER_PAGE_SIZE}`,
      `/api/v1/property-references?page=1&pageSize=${PICKER_PAGE_SIZE}`,
      '/api/v1/financial-categories',
    ]);
    expect(PICKER_PAGE_SIZE).toBe(200);
  });

  it('an account or object of another Realm refuses the answer', async () => {
    const { client: de } = client(json(200, page([account({ mreRealmId: REALM_B })])), json(200, page([property({ mreRealmId: REALM_B })])));
    await expect(listFinancialAccounts(de)).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    await expect(listPropertyReferences(de)).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
  });
});

describe('integration gate: step 2 calls only routes of the pinned inventory', () => {
  it('every request of the step-2 reads is a route of USED_ROUTES, and every step-2 route is used', async () => {
    const { client: de, calls } = client(
      json(200, page([transaction()])),
      json(200, detail(), { etag: '"3"' }),
      json(200, page([account()])),
      json(200, page([property()])),
      json(200, { items: [] }),
    );
    await listTransactions(de, { page: '1', pageSize: '50' });
    await getTransaction(de, TX);
    await listFinancialAccounts(de);
    await listPropertyReferences(de);
    await listFinancialCategories(de);
    const reached = calls.map(routeOf);
    expect(reached).not.toContain(undefined);
    expect(new Set(reached)).toEqual(new Set(USED_ROUTES.filter(([, path]) => path !== '/api/v1/health').map(([method, path]) => `${method} ${path}`)));
  });

  it('counter-check: a route outside USED_ROUTES is found', () => {
    const call = { url: `/api/v1/financial-accounts/${ACCOUNT}`, method: 'GET' } as Call;
    expect(routeOf(call)).toBeUndefined();
    expect(routeOf({ url: `/api/v1/transactions/${TX}/confirm`, method: 'POST' } as Call)).toBeUndefined();
  });
});

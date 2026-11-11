import { describe, expect, it } from 'vitest';
import { USED_ROUTES } from '../gate/backend-pin';
import { readListParams, toApiQuery } from '../transactions/list-params';
import {
  account,
  ACCOUNT,
  correctionAnswer,
  detail,
  page,
  property,
  PROPERTY,
  reversalAnswer,
  REALM_A,
  REALM_B,
  split,
  transaction,
  TX,
  TX_REVERSAL as TX_OTHER,
} from '../transactions/fixtures.test-support';
import { createDeClient } from './client';
import { ApiError, CLIENT_CODES } from './errors';
import { countingTokens, envelope, json, scriptedFetch, type Call } from './fetch.test-support';
import {
  confirmTransaction,
  correctTransaction,
  getTransaction,
  listFinancialAccounts,
  listFinancialCategories,
  listPropertyReferences,
  listTransactions,
  PICKER_PAGE_SIZE,
  putSplits,
  reverseTransaction,
  type TransactionSplitsDto,
} from './transactions';

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

/** The answer of `PUT …/splits` as the backend's `toSplitsDto` writes it. */
function splitsAnswer(overrides: Partial<TransactionSplitsDto> = {}): TransactionSplitsDto {
  return {
    transactionId: TX,
    amount: { amount: '850.00', currency: 'EUR' },
    direction: 'INFLOW',
    status: 'CLASSIFIED',
    version: 4,
    splits: [split(), split({ splitId: '6b4f8c7e-9d0a-4b12-8d34-d5e6f708192a', position: 2, amount: { amount: '150.00', currency: 'EUR' } })],
    ...overrides,
  };
}

const BODY = {
  splits: [
    { amount: { amount: '700.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE', propertyReferenceId: PROPERTY },
    { amount: { amount: '150.00', currency: 'EUR' }, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', propertyReferenceId: PROPERTY },
  ],
};

describe('step 3 write: PUT /transactions/{transactionId}/splits (api-design.md §33.2, §16.1; ui-guide.md §8)', () => {
  it('sends the whole set as JSON with If-Match, the Realm and the token; no Idempotency-Key (the route takes none)', async () => {
    const { client: de, calls } = client(json(200, splitsAnswer(), { etag: '"4"' }));
    await putSplits(de, TX, BODY, '"3"');
    const call = calls[0];
    expect(call?.method).toBe('PUT');
    expect(call?.url).toBe(`/api/v1/transactions/${TX}/splits`);
    expect(call?.headers.get('if-match')).toBe('"3"');
    expect(call?.headers.get('organizationid')).toBe(REALM_A);
    expect(call?.headers.get('authorization')).toBe('Bearer token-1');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.headers.has('idempotency-key')).toBe(false);
    expect(call?.body).toBe(JSON.stringify(BODY));
  });

  it('takes the ETag header, not the version of the body, when the two differ', async () => {
    const { client: de } = client(json(200, splitsAnswer({ version: 4 }), { etag: '"7"' }));
    expect((await putSplits(de, TX, BODY, '"3"')).etag).toBe('"7"');
  });

  it('answers with the new ETag; without the header, the version of the body as entity tag', async () => {
    const { client: de } = client(json(200, splitsAnswer(), { etag: '"4"' }), json(200, splitsAnswer({ version: 7 })));
    expect(await putSplits(de, TX, BODY, '"3"')).toMatchObject({ etag: '"4"', result: { version: 4, status: 'CLASSIFIED' } });
    expect((await putSplits(de, TX, BODY, '"4"')).etag).toBe('"7"');
  });

  it('a weak or unquoted entity tag is never sent', async () => {
    const { client: de, calls } = client();
    await expect(putSplits(de, TX, BODY, 'W/"3"')).rejects.toThrow(TypeError);
    await expect(putSplits(de, TX, BODY, '3')).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('412 is an error with the versions; field errors keep their dotted names in the server order', async () => {
    const fields = [
      { field: 'splits.1.amount.amount', code: 'SCALE_EXCEEDED' },
      { field: 'splits.0.financialCategoryCode', code: 'UNKNOWN_CATEGORY' },
    ];
    const { client: de, calls } = client(
      envelope(412, 'VERSION_CONFLICT', { expectedVersions: [3], currentVersion: 4 }),
      envelope(400, 'VALIDATION_ERROR', { fields }),
    );
    await expect(putSplits(de, TX, BODY, '"3"')).rejects.toMatchObject({ status: 412, code: 'VERSION_CONFLICT', details: { currentVersion: 4 } });
    const error = await putSplits(de, TX, BODY, '"3"').catch((e: unknown) => e);
    expect((error as ApiError).fields).toEqual(fields);
    expect(calls).toHaveLength(2);
  });

  it('an answer for another Transaction is refused, never shown', async () => {
    const { client: de } = client(json(200, splitsAnswer({ transactionId: TX_OTHER }), { etag: '"4"' }));
    await expect(putSplits(de, TX, BODY, '"3"')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('the id is one encoded path segment', async () => {
    const { client: de, calls } = client(envelope(400, 'VALIDATION_ERROR', { fields: [{ field: 'transactionId', code: 'INVALID_FORMAT' }] }));
    await expect(putSplits(de, '../x', BODY, '"3"')).rejects.toMatchObject({ status: 400 });
    expect(calls[0]?.url).toBe('/api/v1/transactions/..%2Fx/splits');
  });

  it('no answer is an error with status 0 (outcome unknown), not repeated by the client', async () => {
    const { client: de, calls } = client(new TypeError('network down'));
    await expect(putSplits(de, TX, BODY, '"3"')).rejects.toMatchObject({ status: 0, code: CLIENT_CODES.network });
    expect(calls).toHaveLength(1);
  });
});

describe('integration gate: steps 2 to 4 call only routes of the pinned inventory', () => {
  it('every request of the step-2 reads and the step-3 and step-4 writes is a route of USED_ROUTES, and every such route is used', async () => {
    const { client: de, calls } = client(
      json(200, page([transaction()])),
      json(200, detail(), { etag: '"3"' }),
      json(200, page([account()])),
      json(200, page([property()])),
      json(200, { items: [] }),
      json(200, splitsAnswer(), { etag: '"4"' }),
      json(200, transaction({ status: 'CONFIRMED', version: 5 }), { etag: '"5"' }),
      json(201, correctionAnswer({ description: 'Neu' })),
      json(201, reversalAnswer()),
    );
    await listTransactions(de, { page: '1', pageSize: '50' });
    await getTransaction(de, TX);
    await listFinancialAccounts(de);
    await listPropertyReferences(de);
    await listFinancialCategories(de);
    await putSplits(de, TX, BODY, '"3"');
    await confirmTransaction(de, TX, '"4"');
    await correctTransaction(de, TX, { reason: 'Test', replacement: { description: 'Neu' } }, '"5"', 'key-1');
    await reverseTransaction(de, TX, { reason: 'Doppelt erfasst' }, '"5"', 'key-2');
    const reached = calls.map(routeOf);
    expect(reached).not.toContain(undefined);
    // The import routes of step 5 and the rent routes of step 6 have their own gate tests (imports.test.ts,
    // rent-reconciliations.test.ts).
    const steps2to4 = USED_ROUTES.filter(
      ([, path]) => path !== '/api/v1/health' && !path.startsWith('/api/v1/imports') && !path.includes('rent-reconciliations'),
    );
    expect(new Set(reached)).toEqual(new Set(steps2to4.map(([method, path]) => `${method} ${path}`)));
  });

  it('counter-check: a route outside USED_ROUTES is found', () => {
    const call = { url: `/api/v1/financial-accounts/${ACCOUNT}`, method: 'GET' } as Call;
    expect(routeOf(call)).toBeUndefined();
    expect(routeOf({ url: `/api/v1/transactions/${TX}/ignore`, method: 'POST' } as Call)).toBeUndefined();
    expect(routeOf({ url: `/api/v1/transactions/${TX}/reverse`, method: 'PUT' } as Call)).toBeUndefined();
    expect(routeOf({ url: `/api/v1/transactions/${TX}/reverse`, method: 'POST' } as Call)).toBe('POST /api/v1/transactions/:transactionId/reverse');
    expect(routeOf({ url: `/api/v1/transactions/${TX}/amend`, method: 'POST' } as Call)).toBeUndefined();
    expect(routeOf({ url: `/api/v1/transactions/${TX}/confirm`, method: 'PUT' } as Call)).toBeUndefined();
    expect(routeOf({ url: `/api/v1/transactions/${TX}/confirm`, method: 'POST' } as Call)).toBe('POST /api/v1/transactions/:transactionId/confirm');
    expect(routeOf({ url: `/api/v1/transactions/${TX}/splits`, method: 'POST' } as Call)).toBeUndefined();
    expect(routeOf({ url: `/api/v1/transactions/${TX}/splits`, method: 'PUT' } as Call)).toBe('PUT /api/v1/transactions/:transactionId/splits');
  });
});

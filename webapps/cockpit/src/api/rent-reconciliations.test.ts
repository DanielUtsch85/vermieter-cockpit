import { describe, expect, it } from 'vitest';
import { USED_ROUTES } from '../gate/backend-pin';
import {
  confirmed,
  reconciliation,
  read,
  REC,
  REC_2,
  released,
  splitProposal,
  suggestResult,
  TENANT,
  TERM,
  termCoverage,
  transactionCoverage,
  written,
} from '../rent/fixtures.test-support';
import { REALM_A, REALM_B, TX, TX_REPLACEMENT } from '../transactions/fixtures.test-support';
import { createDeClient } from './client';
import { CLIENT_CODES } from './errors';
import { countingTokens, envelope, json, scriptedFetch, type Call } from './fetch.test-support';
import {
  confirmReconciliation,
  createReconciliation,
  getReconciliation,
  getSplitProposal,
  getTermCoverage,
  getTransactionRentCoverage,
  listReconciliations,
  rejectReconciliation,
  releaseReconciliation,
  removeFromMre,
  suggestReconciliations,
  writeBackToMre,
} from './rent-reconciliations';

/**
 * Client contract of step 6 (ui-guide.md §12 point 2): every rent command and read as it leaves the browser (method,
 * path, headers, body as sent) and the answers the client accepts (api-design.md §37.1–§37.5).
 */

function client(...answers: Parameters<typeof scriptedFetch>) {
  const { fetch, calls } = scriptedFetch(...answers);
  return { client: createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch }), calls };
}

const EUR = (amount: string) => ({ amount, currency: 'EUR' });

/** What every request of step 6 carries, and what none of them carries. */
function expectCommon(call: Call | undefined) {
  expect(call?.headers.get('organizationid')).toBe(REALM_A);
  expect(call?.headers.get('authorization')).toBe('Bearer token-1');
  expect(call?.headers.has('idempotency-key')).toBe(false);
}

describe('step 6: POST /rent-reconciliations/suggest (api-design.md §37.3)', () => {
  it('sends exactly { from, to }, no If-Match, no Idempotency-Key; answers the run with its skipped counts', async () => {
    const answer = suggestResult([reconciliation()], { unconfirmed: 2, noRentCash: 1 });
    const { client: de, calls } = client(json(200, answer));
    expect(await suggestReconciliations(de, { from: '2026-03', to: '2026-04' })).toEqual(answer);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('/api/v1/rent-reconciliations/suggest');
    expect(calls[0]?.body).toBe('{"from":"2026-03","to":"2026-04"}');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.headers.has('if-match')).toBe(false);
    expectCommon(calls[0]);
  });

  it('an answer for another window, of another Realm, or with an item that is not SUGGESTED is refused', async () => {
    const { client: de } = client(
      json(200, suggestResult([], undefined, { from: '2026-02', to: '2026-04' })),
      json(200, suggestResult([reconciliation({ mreRealmId: REALM_B })])),
      json(200, suggestResult([confirmed()])),
    );
    const body = { from: '2026-03', to: '2026-04' };
    await expect(suggestReconciliations(de, body)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(suggestReconciliations(de, body)).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    await expect(suggestReconciliations(de, body)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('503 keeps Retry-After; no answer is status 0 and is not sent again by the client', async () => {
    const { client: de, calls } = client(envelope(503, 'EXTERNAL_SYSTEM_ERROR', undefined, { 'retry-after': '7' }), new TypeError('offline'));
    await expect(suggestReconciliations(de, { from: '2026-03', to: '2026-03' })).rejects.toMatchObject({ status: 503, retryAfterSeconds: 7 });
    await expect(suggestReconciliations(de, { from: '2026-03', to: '2026-03' })).rejects.toMatchObject({ status: 0, code: CLIENT_CODES.network });
    expect(calls).toHaveLength(2);
  });
});

describe('step 6: the reads (api-design.md §37.1, §37.2)', () => {
  it('GET /rent-reconciliations sends only status, page and pageSize; items of another Realm or status are refused', async () => {
    const { client: de, calls } = client(
      json(200, { items: [reconciliation()], page: 2, pageSize: 50, total: 51 }),
      json(200, { items: [], page: 1, pageSize: 50, total: 0 }),
      json(200, { items: [reconciliation({ mreRealmId: REALM_B })], page: 1, pageSize: 50, total: 1 }),
      json(200, { items: [confirmed()], page: 1, pageSize: 50, total: 1 }),
    );
    expect((await listReconciliations(de, { status: 'SUGGESTED', page: 2 })).total).toBe(51);
    await listReconciliations(de, { status: undefined, page: 1 });
    expect(calls.map((call) => call.url)).toEqual([
      '/api/v1/rent-reconciliations?status=SUGGESTED&page=2&pageSize=50',
      '/api/v1/rent-reconciliations?page=1&pageSize=50',
    ]);
    await expect(listReconciliations(de, { status: undefined, page: 1 })).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    await expect(listReconciliations(de, { status: 'SUGGESTED', page: 1 })).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('GET /rent-reconciliations/{id} without checkMre, with its ETag; another id or Realm is refused', async () => {
    const { client: de, calls } = client(
      json(200, read(), { etag: '"1"' }),
      json(200, read({ version: 3 })),
      json(200, read({ reconciliationId: REC_2 })),
      json(200, read({ mreRealmId: REALM_B })),
    );
    expect(await getReconciliation(de, REC)).toEqual({ reconciliation: read(), etag: '"1"' });
    expect((await getReconciliation(de, REC)).etag).toBe('"3"');
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/${REC}`);
    expect(calls[0]?.method).toBe('GET');
    await expect(getReconciliation(de, REC)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(getReconciliation(de, REC)).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
  });

  it('the coverage of a term: its own path; another term, another Realm or a match of another term is refused', async () => {
    const { client: de, calls } = client(
      json(200, termCoverage()),
      json(200, termCoverage({ mreRentTerm: '2026040100' })),
      json(200, termCoverage({ reconciliations: [confirmed('800.00', { mreRealmId: REALM_B })] })),
      json(200, termCoverage({ reconciliations: [confirmed('800.00', { mreRentTerm: '2026040100' })] })),
    );
    expect(await getTermCoverage(de, TENANT, TERM)).toEqual(termCoverage());
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/terms/${TENANT}/${TERM}`);
    expectCommon(calls[0]);
    await expect(getTermCoverage(de, TENANT, TERM)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(getTermCoverage(de, TENANT, TERM)).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    await expect(getTermCoverage(de, TENANT, TERM)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('the rent reconciliations of a Transaction; another Transaction or Realm is refused', async () => {
    const { client: de, calls } = client(
      json(200, transactionCoverage()),
      json(200, transactionCoverage({ transactionId: TX_REPLACEMENT })),
      json(200, transactionCoverage({ reconciliations: [confirmed('800.00', { mreRealmId: REALM_B })] })),
      json(200, transactionCoverage({ reconciliations: [confirmed('800.00', { transactionId: TX_REPLACEMENT })] })),
    );
    expect(await getTransactionRentCoverage(de, TX)).toEqual(transactionCoverage());
    expect(calls[0]?.url).toBe(`/api/v1/transactions/${TX}/rent-reconciliations`);
    await expect(getTransactionRentCoverage(de, TX)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(getTransactionRentCoverage(de, TX)).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    await expect(getTransactionRentCoverage(de, TX)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });
});

describe('step 6: confirm and reject (api-design.md §37.3)', () => {
  it('confirm: If-Match, body exactly { matchedAmount } with the string as typed, no Idempotency-Key; the new ETag', async () => {
    const { client: de, calls } = client(json(200, confirmed('849.99'), { etag: '"2"' }));
    const answer = await confirmReconciliation(de, REC, EUR('849.99'), '"1"');
    expect(answer).toEqual({ reconciliation: confirmed('849.99'), etag: '"2"' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/${REC}/confirm`);
    expect(calls[0]?.headers.get('if-match')).toBe('"1"');
    expect(calls[0]?.body).toBe('{"matchedAmount":{"amount":"849.99","currency":"EUR"}}');
    expectCommon(calls[0]);
  });

  it('confirm: an answer not CONFIRMED, with another amount, another id or another Realm is refused', async () => {
    const { client: de } = client(
      json(200, reconciliation({ version: 2, matchedAmount: EUR('849.99') })),
      json(200, confirmed('850.00')),
      json(200, confirmed('849.99', { reconciliationId: REC_2 })),
      json(200, confirmed('849.99', { mreRealmId: REALM_B })),
      json(200, confirmed('849.9')),
    );
    await expect(confirmReconciliation(de, REC, EUR('849.99'), '"1"')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(confirmReconciliation(de, REC, EUR('849.99'), '"1"')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(confirmReconciliation(de, REC, EUR('849.99'), '"1"')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(confirmReconciliation(de, REC, EUR('849.99'), '"1"')).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    // The same amount in another spelling of the server (one place) is the same amount, compared on cents.
    await expect(confirmReconciliation(de, REC, EUR('849.90'), '"1"')).resolves.toMatchObject({ reconciliation: { status: 'CONFIRMED' } });
  });

  it('reject: If-Match, body exactly { reason }; the answer must be REJECTED', async () => {
    const rejected = reconciliation({ status: 'REJECTED', rejectReason: 'Nicht diese Miete', version: 2 });
    const { client: de, calls } = client(json(200, rejected), json(200, confirmed()));
    expect((await rejectReconciliation(de, REC, 'Nicht diese Miete', '"1"')).reconciliation).toEqual(rejected);
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/${REC}/reject`);
    expect(calls[0]?.headers.get('if-match')).toBe('"1"');
    expect(calls[0]?.body).toBe('{"reason":"Nicht diese Miete"}');
    expectCommon(calls[0]);
    await expect(rejectReconciliation(de, REC, 'x', '"1"')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('refusals keep code, reason and details: 422 ABOVE_SUGGESTION, 409 SUGGESTION_STALE, 412, field errors', async () => {
    const { client: de } = client(
      envelope(422, 'ABOVE_SUGGESTION', { suggested: EUR('850.00') }),
      envelope(409, 'CONFLICT', { reason: 'SUGGESTION_STALE', openAmount: EUR('0.00') }),
      envelope(412, 'PRECONDITION_FAILED', { currentVersion: 2 }),
      envelope(400, 'VALIDATION_ERROR', { fields: [{ field: 'reason', code: 'REQUIRED' }] }),
    );
    await expect(confirmReconciliation(de, REC, EUR('850.01'), '"1"')).rejects.toMatchObject({ status: 422, code: 'ABOVE_SUGGESTION' });
    await expect(confirmReconciliation(de, REC, EUR('850.00'), '"1"')).rejects.toMatchObject({ status: 409, details: { reason: 'SUGGESTION_STALE' } });
    await expect(confirmReconciliation(de, REC, EUR('850.00'), '"1"')).rejects.toMatchObject({ status: 412 });
    await expect(rejectReconciliation(de, REC, ' ', '"1"')).rejects.toMatchObject({ status: 400, fields: [{ field: 'reason', code: 'REQUIRED' }] });
  });
});

describe('step 6: write-back, release and removal are three separate commands (api-design.md §37.1, §37.4, §37.5)', () => {
  it('write-back: no body, If-Match, no Idempotency-Key; the answer must be CONFIRMED and WRITTEN', async () => {
    const { client: de, calls } = client(json(200, written(), { etag: '"4"' }), json(200, confirmed('850.00', { mreWriteBackState: 'FAILED' })));
    expect(await writeBackToMre(de, REC, '"2"')).toEqual({ reconciliation: written(), etag: '"4"' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/${REC}/write-back-to-mre`);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers.has('content-type')).toBe(false);
    expect(calls[0]?.headers.get('if-match')).toBe('"2"');
    expectCommon(calls[0]);
    await expect(writeBackToMre(de, REC, '"2"')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('release: body exactly { reason }, If-Match; the answer must be RELEASED. It is no removal from MRE', async () => {
    const { client: de, calls } = client(json(200, released('REMOVAL_REQUIRED')), json(200, written()));
    expect((await releaseReconciliation(de, REC, 'Falsche Buchung', '"4"')).reconciliation.mreWriteBackState).toBe('REMOVAL_REQUIRED');
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/${REC}/release`);
    expect(calls[0]?.body).toBe('{"reason":"Falsche Buchung"}');
    expect(calls[0]?.headers.get('if-match')).toBe('"4"');
    expectCommon(calls[0]);
    await expect(releaseReconciliation(de, REC, 'x', '"4"')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    expect(calls.map((call) => call.url).filter((url) => url.endsWith('remove-from-mre'))).toEqual([]);
  });

  it('removal: no body, If-Match; the answer must be RELEASED and REMOVED', async () => {
    const { client: de, calls } = client(
      json(200, released('REMOVED', { version: 7 })),
      json(200, released('REMOVAL_FAILED')),
      json(200, released('REMOVED', { mreRealmId: REALM_B })),
    );
    expect((await removeFromMre(de, REC, '"5"')).etag).toBe('"7"');
    expect(calls[0]?.url).toBe(`/api/v1/rent-reconciliations/${REC}/remove-from-mre`);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers.get('if-match')).toBe('"5"');
    expectCommon(calls[0]);
    await expect(removeFromMre(de, REC, '"5"')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(removeFromMre(de, REC, '"5"')).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
  });

  it('409 WRITE_BACK_IN_PROGRESS and a 503 keep Retry-After and details; a weak or missing tag is never sent', async () => {
    const { client: de, calls } = client(
      envelope(409, 'CONFLICT', { reason: 'WRITE_BACK_IN_PROGRESS', reconciliationId: REC_2 }, { 'retry-after': '30' }),
      envelope(503, 'EXTERNAL_SYSTEM_ERROR', { reason: 'MRE_UNAVAILABLE', mreWriteBackState: 'FAILED' }),
    );
    await expect(writeBackToMre(de, REC, '"2"')).rejects.toMatchObject({ status: 409, retryAfterSeconds: 30, details: { reconciliationId: REC_2 } });
    await expect(writeBackToMre(de, REC, '"2"')).rejects.toMatchObject({ status: 503, details: { mreWriteBackState: 'FAILED' } });
    await expect(writeBackToMre(de, REC, 'W/"2"')).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(2);
  });
});

/** The inventory route a call reached: its path matched against the `:parameter` templates of `USED_ROUTES`. */
function routeOf(call: Pick<Call, 'url' | 'method'>): string | undefined {
  const path = new URL(call.url, 'https://cockpit.internal').pathname;
  // A literal path wins over a template (`…/split-proposal` before `…/:reconciliationId`), as the backend registers it.
  const matches = USED_ROUTES.filter(([method, template]) => method === call.method && new RegExp(`^${template.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path));
  const used = matches.find(([, template]) => template === path) ?? matches[0];
  return used === undefined ? undefined : `${used[0]} ${used[1]}`;
}

describe('integration gate: step 6 calls only routes of the pinned inventory', () => {
  it('every request of step 6 is a route of USED_ROUTES, and every rent route there is used', async () => {
    const { client: de, calls } = client(
      json(200, suggestResult([])),
      json(200, { items: [], page: 1, pageSize: 50, total: 0 }),
      json(200, read()),
      json(200, confirmed()),
      json(200, reconciliation({ status: 'REJECTED' })),
      json(200, written()),
      json(200, released('REMOVAL_REQUIRED')),
      json(200, released('REMOVED')),
      json(200, termCoverage()),
      json(200, transactionCoverage()),
      json(200, splitProposal()),
      json(201, confirmed('850.00', { confidence: null, suggestionReason: null })),
    );
    await suggestReconciliations(de, { from: '2026-03', to: '2026-04' });
    await listReconciliations(de, { status: undefined, page: 1 });
    await getReconciliation(de, REC);
    await confirmReconciliation(de, REC, EUR('850.00'), '"1"');
    await rejectReconciliation(de, REC, 'x', '"1"');
    await writeBackToMre(de, REC, '"2"');
    await releaseReconciliation(de, REC, 'x', '"4"');
    await removeFromMre(de, REC, '"5"');
    await getTermCoverage(de, TENANT, TERM);
    await getTransactionRentCoverage(de, TX);
    await getSplitProposal(de, TX, { mreTenantId: TENANT, mreRentTerm: TERM });
    await createReconciliation(de, { transactionId: TX, mreTenantId: TENANT, mreRentTerm: TERM, matchedAmount: EUR('850.00') }, 'key-1');
    const reached = calls.map(routeOf);
    expect(reached).not.toContain(undefined);
    const rent = USED_ROUTES.filter(([, path]) => path.includes('rent-reconciliations')).map(([method, path]) => `${method} ${path}`);
    expect(new Set(reached)).toEqual(new Set(rent));
    expect(rent).toHaveLength(12);
    expect(reached.slice(-2)).toEqual(['GET /api/v1/rent-reconciliations/split-proposal', 'POST /api/v1/rent-reconciliations']);
  });

  it('counter-check: a list read by PUT, another method and the ignore of a Transaction are not used routes', () => {
    expect(routeOf({ url: '/api/v1/rent-reconciliations', method: 'PUT' })).toBeUndefined();
    expect(routeOf({ url: `/api/v1/rent-reconciliations/${REC}/write-back-to-mre`, method: 'PUT' })).toBeUndefined();
    expect(routeOf({ url: `/api/v1/transactions/${TX}/ignore`, method: 'POST' })).toBeUndefined();
  });
});

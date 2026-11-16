import { describe, expect, it } from 'vitest';
import { batchSummary, BATCH, EARLIER_BATCH } from '../imports/fixtures.test-support';
import { REALM_B } from '../transactions/fixtures.test-support';
import { createDeClient } from './client';
import { CLIENT_CODES } from './errors';
import { countingTokens, json, scriptedFetch } from './fetch.test-support';
import { IMPORT_HISTORY_PAGE_SIZE, listImportBatches } from './imports';
import { REALM_A } from '../transactions/fixtures.test-support';

/** Client contract of „Bisherige Importe“ (#369, api-design.md §32.6): the request and the answers the client accepts. */

function client(...answers: Parameters<typeof scriptedFetch>) {
  const { fetch, calls } = scriptedFetch(...answers);
  return { client: createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch }), calls };
}
const newer = batchSummary({ importBatchId: BATCH, importedAt: '2026-10-07T08:00:00.000Z', status: 'NEEDS_REVIEW', needsReviewCount: 2 });
const older = batchSummary({ importBatchId: EARLIER_BATCH, importedAt: '2026-10-06T08:00:00.000Z' });
const pageOf = (items: readonly unknown[], overrides: Record<string, unknown> = {}) =>
  json(200, { items, page: 2, pageSize: IMPORT_HISTORY_PAGE_SIZE, total: 22, ...overrides });

describe('GET /imports (§32.6, #369)', () => {
  it('asks for the page with the list s page size and no filter; the answer as the server sent it', async () => {
    const { client: de, calls } = client(pageOf([newer, older]));
    const answer = await listImportBatches(de, 2);
    expect(calls.map((c) => [c.method, c.url])).toEqual([['GET', `/api/v1/imports?page=2&pageSize=${IMPORT_HISTORY_PAGE_SIZE}`]]);
    expect(answer).toEqual({ items: [newer, older], page: 2, pageSize: IMPORT_HISTORY_PAGE_SIZE, total: 22 });
    // An equal time is newest first too (the server breaks the tie by the id).
    const tie = batchSummary({ importBatchId: EARLIER_BATCH, importedAt: newer.importedAt });
    expect((await listImportBatches(client(pageOf([newer, tie])).client, 2)).items).toHaveLength(2);
  });

  it.each([
    ['a batch of another Realm', pageOf([newer, { ...older, mreRealmId: REALM_B }]), CLIENT_CODES.realmMismatch],
    ['another page', pageOf([newer], { page: 1 }), CLIENT_CODES.unexpected],
    ['another page size', pageOf([newer], { pageSize: 50 }), CLIENT_CODES.unexpected],
    ['a batch listed twice', pageOf([newer, newer]), CLIENT_CODES.unexpected],
    ['oldest first', pageOf([older, newer]), CLIENT_CODES.unexpected],
  ])('refuses %s, never shown', async (_case, answer, code) => {
    await expect(listImportBatches(client(answer).client, 2)).rejects.toMatchObject({ code });
  });
});

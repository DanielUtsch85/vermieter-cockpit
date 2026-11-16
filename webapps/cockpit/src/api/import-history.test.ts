import { describe, expect, it } from 'vitest';
import { batch, batchSummary, BATCH, EARLIER_BATCH } from '../imports/fixtures.test-support';
import { ACCOUNT, REALM_B } from '../transactions/fixtures.test-support';
import { createDeClient } from './client';
import { CLIENT_CODES } from './errors';
import { countingTokens, json, scriptedFetch } from './fetch.test-support';
import { getImportBatch, IMPORT_HISTORY_PAGE_SIZE, listImportBatches } from './imports';
import { REALM_A } from '../transactions/fixtures.test-support';

/** Client contract of „Bisherige Importe“ (#369, api-design.md §32.6; VC-X-75, VC-X-76): requests and accepted answers. */

function client(...answers: Parameters<typeof scriptedFetch>) {
  const { fetch, calls } = scriptedFetch(...answers);
  return { client: createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch }), calls };
}
const OTHER_ACCOUNT = '0f1e2d3c-4b5a-4968-8776-655443322110';
const newer = batchSummary({ importBatchId: BATCH, importedAt: '2026-10-07T08:00:00.000Z', status: 'NEEDS_REVIEW', needsReviewCount: 2 });
const older = batchSummary({ importBatchId: EARLIER_BATCH, importedAt: '2026-10-06T08:00:00.000Z' });
const pageOf = (items: readonly unknown[], overrides: Record<string, unknown> = {}) =>
  json(200, { items, page: 2, pageSize: IMPORT_HISTORY_PAGE_SIZE, total: 22, ...overrides });
const all = { page: 2, openOnly: false, financialAccountId: undefined };

describe('GET /imports (§32.6, #369)', () => {
  it('asks for the page with the list s page size and no filter; the answer as the server sent it', async () => {
    const { client: de, calls } = client(pageOf([newer, older]));
    const answer = await listImportBatches(de, all);
    expect(calls.map((c) => [c.method, c.url])).toEqual([['GET', `/api/v1/imports?page=2&pageSize=${IMPORT_HISTORY_PAGE_SIZE}`]]);
    expect(answer).toEqual({ items: [newer, older], page: 2, pageSize: IMPORT_HISTORY_PAGE_SIZE, total: 22 });
    // An equal time is newest first too (the server breaks the tie by the id).
    const tie = batchSummary({ importBatchId: EARLIER_BATCH, importedAt: newer.importedAt });
    expect((await listImportBatches(client(pageOf([newer, tie])).client, all)).items).toHaveLength(2);
  });

  it('sends the filters as the route names them (VC-X-76): status=NEEDS_REVIEW and the account', async () => {
    const { client: de, calls } = client(pageOf([newer]), pageOf([older]), pageOf([newer]));
    await listImportBatches(de, { ...all, openOnly: true });
    await listImportBatches(de, { ...all, financialAccountId: ACCOUNT });
    await listImportBatches(de, { ...all, openOnly: true, financialAccountId: ACCOUNT });
    const base = `/api/v1/imports?page=2&pageSize=${IMPORT_HISTORY_PAGE_SIZE}`;
    expect(calls.map((c) => c.url)).toEqual([
      `${base}&status=NEEDS_REVIEW`,
      `${base}&financialAccountId=${ACCOUNT}`,
      `${base}&status=NEEDS_REVIEW&financialAccountId=${ACCOUNT}`,
    ]);
  });

  it('accepts a booking range: both dates with the first not after the last, one day, or both null (VC-X-75)', async () => {
    for (const range of [
      { firstBookingDate: '2026-10-01', lastBookingDate: '2026-10-31' },
      { firstBookingDate: '2026-10-15', lastBookingDate: '2026-10-15' },
      { firstBookingDate: null, lastBookingDate: null },
    ]) {
      expect((await listImportBatches(client(pageOf([{ ...newer, ...range }])).client, all)).items[0]).toMatchObject(range);
    }
  });

  it.each([
    ['a batch of another Realm', all, pageOf([newer, { ...older, mreRealmId: REALM_B }]), CLIENT_CODES.realmMismatch],
    ['another page', all, pageOf([newer], { page: 1 }), CLIENT_CODES.unexpected],
    ['another page size', all, pageOf([newer], { pageSize: 50 }), CLIENT_CODES.unexpected],
    ['a batch listed twice', all, pageOf([newer, newer]), CLIENT_CODES.unexpected],
    ['oldest first', all, pageOf([older, newer]), CLIENT_CODES.unexpected],
    ['a completed import under „Nur mit offenen Klärfällen“', { ...all, openOnly: true }, pageOf([newer, older]), CLIENT_CODES.unexpected],
    [
      'an import of another account',
      { ...all, financialAccountId: ACCOUNT },
      pageOf([{ ...newer, financialAccountId: OTHER_ACCOUNT }]),
      CLIENT_CODES.unexpected,
    ],
    ['the first date after the last', all, pageOf([{ ...newer, firstBookingDate: '2026-11-01', lastBookingDate: '2026-10-31' }]), CLIENT_CODES.unexpected],
    ['only a first date', all, pageOf([{ ...newer, firstBookingDate: '2026-10-01', lastBookingDate: null }]), CLIENT_CODES.unexpected],
    ['only a last date', all, pageOf([{ ...newer, firstBookingDate: null, lastBookingDate: '2026-10-01' }]), CLIENT_CODES.unexpected],
    ['a date in another format', all, pageOf([{ ...newer, firstBookingDate: '01.10.2026', lastBookingDate: '2026-10-31' }]), CLIENT_CODES.unexpected],
  ])('refuses %s, never shown', async (_case, query, answer, code) => {
    await expect(listImportBatches(client(answer).client, query)).rejects.toMatchObject({ code });
  });
});

describe('GET /imports/{id}: booking range and continuityMissing (VC-X-75, VC-X-77)', () => {
  it('accepts a reason without a report and a report without a reason', async () => {
    const reasonOnly = batch({ continuityMissing: 'NO_BALANCE_COLUMN' });
    expect(await getImportBatch(client(json(200, reasonOnly)).client, BATCH)).toEqual(reasonOnly);
    const reportOnly = batch({ continuity: { order: 'OLDEST_FIRST', breaks: [], previousExport: 'CHAINS' } });
    expect(await getImportBatch(client(json(200, reportOnly)).client, BATCH)).toEqual(reportOnly);
  });

  it.each([
    [
      'a report and a reason together',
      batch({ continuity: { order: 'OLDEST_FIRST', breaks: [], previousExport: 'CHAINS' }, continuityMissing: 'NO_ROW_WITH_BALANCE' }),
    ],
    ['the first date after the last', batch({ firstBookingDate: '2026-10-02', lastBookingDate: '2026-10-01' })],
  ])('refuses %s', async (_case, answer) => {
    await expect(getImportBatch(client(json(200, answer)).client, BATCH)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });
});

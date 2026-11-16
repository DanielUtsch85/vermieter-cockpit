import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImportBatchFilter, ImportBatchSummary, PrincipalVerifier } from '../application/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** `GET /imports` (api-design.md §32.6, #369, VC-X-74) at the HTTP edge: the query, the route and the items' shape. */
const REALM = '64b0c0ffee0000000000000a';
const ACCOUNT = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const BATCH = '5d4c3b2a-1f0e-4d9c-8b7a-695847362514';
const summary = {
  id: BATCH,
  mreRealmId: REALM,
  financialAccountId: ACCOUNT,
  adapterId: 'generic-csv',
  adapterVersion: '2',
  sourceFilename: null,
  contentHash: 'abc',
  status: 'NEEDS_REVIEW',
  transactionCount: 1,
  duplicateCount: 2,
  needsReviewCount: 3,
  errorCount: 4,
  skippedCount: 5,
  importedAt: new Date('2026-11-16T08:00:00Z'),
  importedBy: 'anna@example.com',
  firstBookingDate: '2026-10-01',
  lastBookingDate: '2026-10-31',
} as unknown as ImportBatchSummary;

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });

let server: Server | undefined;
async function start(commands: CommandOverrides): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith(commands) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});
const auth = { authorization: 'Bearer a.b.c', organizationid: REALM };

type Call = { readonly realm: string; readonly filter: ImportBatchFilter; readonly page: { page: number; pageSize: number } };
/** A fake list that records its arguments; `getBatch` refuses, so a request it reaches is visible. */
async function listing(items: readonly ImportBatchSummary[] = [summary]) {
  const calls: Call[] = [];
  const base = await start({
    imports: {
      listBatches: async ({ principal, filter, page }) => {
        calls.push({ realm: principal.mreRealmId, filter, page });
        return { items, page: page.page, pageSize: page.pageSize, total: 7 };
      },
      getBatch: () => Promise.reject(new Error('GET /imports reached the single read')),
    },
  });
  const get = (query = '') => fetch(`${base}/api/v1/imports${query}`, { headers: auth });
  return { calls, get };
}

describe('GET /imports (§32.6)', () => {
  it('answers the page with the items as the single read without rows and continuity, in the order the list gives', async () => {
    const older = {
      ...summary,
      id: '00000000-0000-4000-8000-000000000001',
      status: 'COMPLETED',
      needsReviewCount: 0,
      firstBookingDate: null,
      lastBookingDate: null,
    } as unknown as ImportBatchSummary;
    const { calls, get } = await listing([summary, older]);
    const answer = await get();
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { items: Record<string, unknown>[] };
    expect(body).toEqual({
      items: [
        {
          importBatchId: BATCH,
          mreRealmId: REALM,
          financialAccountId: ACCOUNT,
          adapterId: 'generic-csv',
          adapterVersion: '2',
          sourceFilename: null,
          contentHash: 'abc',
          status: 'NEEDS_REVIEW',
          transactionCount: 1,
          duplicateCount: 2,
          needsReviewCount: 3,
          errorCount: 4,
          skippedCount: 5,
          importedAt: '2026-11-16T08:00:00.000Z',
          importedBy: 'anna@example.com',
          firstBookingDate: '2026-10-01',
          lastBookingDate: '2026-10-31',
        },
        // VC-X-75: no row with a booking date → both null, never left out.
        expect.objectContaining({
          importBatchId: '00000000-0000-4000-8000-000000000001',
          status: 'COMPLETED',
          needsReviewCount: 0,
          firstBookingDate: null,
          lastBookingDate: null,
        }),
      ],
      page: 1,
      pageSize: 50,
      total: 7,
    });
    for (const item of body.items) {
      expect(item).not.toHaveProperty('rows');
      expect(item).not.toHaveProperty('continuity');
    }
    // No filter, the default page, the caller's Realm.
    expect(calls).toEqual([{ realm: REALM, filter: {}, page: { page: 1, pageSize: 50 } }]);
  });

  it('passes both filters, the account lower-cased and the statuses as a list, and the page at its bounds', async () => {
    const { calls, get } = await listing();
    expect((await get(`?financialAccountId=${ACCOUNT.toUpperCase()}&status=NEEDS_REVIEW,COMPLETED&page=1000000&pageSize=200`)).status).toBe(200);
    expect((await get('?status=COMPLETED&pageSize=1')).status).toBe(200);
    expect(calls.map((c) => [c.filter, c.page])).toEqual([
      [
        { financialAccountId: ACCOUNT, statuses: ['NEEDS_REVIEW', 'COMPLETED'] },
        { page: 1_000_000, pageSize: 200 },
      ],
      [{ statuses: ['COMPLETED'] }, { page: 1, pageSize: 1 }],
    ]);
  });

  it.each([
    ['?financialAccountId=nope', 'financialAccountId', 'INVALID_FORMAT'],
    ['?financialAccountId=', 'financialAccountId', 'INVALID_FORMAT'],
    ['?status=PENDING', 'status', 'INVALID_FORMAT'],
    ['?status=completed', 'status', 'INVALID_FORMAT'],
    ['?status=COMPLETED,', 'status', 'INVALID_FORMAT'],
    ['?status=', 'status', 'INVALID_FORMAT'],
    // §58W's shared paging: refused by name, its code that of every paged route.
    ['?page=0', 'page', undefined],
    ['?pageSize=201', 'pageSize', undefined],
    ['?accountId=x', 'accountId', 'INVALID_FORMAT'],
    ['?cursor=x', 'cursor', 'INVALID_FORMAT'],
  ] as const)('%s is 400 on %s and no read runs', async (query, field, code) => {
    const { calls, get } = await listing();
    const answer = await get(query);
    expect(answer.status).toBe(400);
    const body = (await answer.json()) as { error: { code: string; details: { fields: { field: string; code: string }[] } } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.fields).toContainEqual(code === undefined ? expect.objectContaining({ field }) : { field, code });
    expect(calls).toEqual([]);
  });

  it('is its own path: a batch id still reaches the single read, and the list is not answered there', async () => {
    let single = 0;
    const base = await start({
      imports: {
        listBatches: () => Promise.reject(new Error('the single read reached the list')),
        getBatch: async () => {
          single += 1;
          return { ...summary, rows: [], continuity: null, continuityMissing: 'NO_BALANCE_COLUMN' };
        },
      },
    });
    const answer = await fetch(`${base}/api/v1/imports/${BATCH}`, { headers: auth });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ importBatchId: BATCH, rows: [], continuity: null });
    expect(single).toBe(1);
  });
});

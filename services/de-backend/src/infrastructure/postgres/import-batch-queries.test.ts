import { Kysely, PostgresDialect, type KyselyPlugin } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportBatchSummary } from '../../domains/ledger/index.js';
import { PostgresImportBatchQueries } from './import-batch-queries.js';
import { migrateToLatest } from './migrate.js';
import type { Database } from './schema.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * `GET /imports` past the repository (api-design.md §32.6, #369, VC-X-74): the order with its tie-break, the paging
 * boundaries, each filter alone and together, the Realm, the absent rows, no write, and `total` and `items` in one
 * snapshot. Batches are seeded with SQL, so timestamps and ids are chosen; synthetic data only.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const EMPTY_REALM = '64b0c0ffee0000000000000c';
const UNKNOWN_ACCOUNT = '00000000-0000-4000-8000-0000000000ff';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(databaseUrl === undefined)('the list of a Realm s imports (§32.6)', () => {
  const schema = testSchemaName('import_batch_queries_test');
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let queries: PostgresImportBatchQueries;
  /** Run once after the count of the next list, from another connection (the snapshot test). */
  let afterCount: (() => Promise<void>) | undefined;
  let giro: string;
  let savings: string;
  let foreign: string;

  const account = async (realm: string, name: string) =>
    (
      await pool.query(
        `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by) VALUES ($1, 'BANK', $2, 'EUR', 'OPEN', 'x') RETURNING id`,
        [realm, name],
      )
    ).rows[0].id as string;
  const batch = (realm: string, accountId: string, n: number, importedAt: string, needsReview = 0) =>
    pool.query(
      `INSERT INTO import_batch (id, mre_realm_id, financial_account_id, adapter_id, adapter_version, source_filename, content_hash, provenance, status,
         transaction_count, duplicate_count, needs_review_count, error_count, skipped_count, rows, imported_at, imported_by, continuity)
       VALUES ($1, $2, $3, 'generic-csv', '2', $4, $5, 'BANK_CSV', $6, 1, 0, $7, 0, 0, '[{"outcome":"created","position":1}]', $8, 'anna@example.com',
         '{"order":"OLDEST_FIRST","breaks":[],"previousExport":"GAP"}')`,
      [id(n), realm, accountId, `umsatz-${n}.csv`, `hash-${n}`, needsReview > 0 ? 'NEEDS_REVIEW' : 'COMPLETED', needsReview, importedAt],
    );
  const ids = (items: readonly ImportBatchSummary[]) => items.map((b) => b.id);
  const all = { page: 1, pageSize: 200 };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const snapshotProbe: KyselyPlugin = {
      transformQuery: (args) => args.node,
      transformResult: async (args) => {
        const run = afterCount;
        if (run !== undefined && args.result.rows[0] !== undefined && 'n' in args.result.rows[0]) {
          afterCount = undefined;
          await run();
        }
        return args.result;
      },
    };
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }), plugins: [snapshotProbe] });
    queries = new PostgresImportBatchQueries(db);

    giro = await account(REALM, 'Giro');
    savings = await account(REALM, 'Tagesgeld');
    foreign = await account(OTHER_REALM, 'Giro B');
    // Realm A: five batches; 2, 3 and 4 share one timestamp (the id breaks the tie), 3 and 5 have open review items.
    await batch(REALM, giro, 1, '2026-10-01T08:00:00Z');
    await batch(REALM, savings, 2, '2026-10-02T08:00:00Z');
    await batch(REALM, giro, 3, '2026-10-02T08:00:00Z', 2);
    await batch(REALM, giro, 4, '2026-10-02T08:00:00Z');
    await batch(REALM, savings, 5, '2026-10-03T08:00:00Z', 1);
    // Realm B: newer than all of A's, so a dropped Realm filter would put it first.
    await batch(OTHER_REALM, foreign, 9, '2026-12-01T08:00:00Z', 1);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('a Realm without imports answers an empty page, also beyond the first', async () => {
    expect(await queries.list(EMPTY_REALM, {}, { page: 1, pageSize: 50 })).toEqual({ items: [], page: 1, pageSize: 50, total: 0 });
    expect(await queries.list(EMPTY_REALM, {}, { page: 3, pageSize: 1 })).toEqual({ items: [], page: 3, pageSize: 1, total: 0 });
  });

  it('newest importedAt first, then the id descending; every field but rows and continuity', async () => {
    const { items, total } = await queries.list(REALM, {}, all);
    expect(total).toBe(5);
    expect(ids(items)).toEqual([id(5), id(4), id(3), id(2), id(1)]);
    expect(items[2]).toEqual({
      id: id(3),
      mreRealmId: REALM,
      financialAccountId: giro,
      adapterId: 'generic-csv',
      adapterVersion: '2',
      sourceFilename: 'umsatz-3.csv',
      contentHash: 'hash-3',
      status: 'NEEDS_REVIEW',
      transactionCount: 1,
      duplicateCount: 0,
      needsReviewCount: 2,
      errorCount: 0,
      skippedCount: 0,
      importedAt: new Date('2026-10-02T08:00:00Z'),
      importedBy: 'anna@example.com',
    });
    for (const item of items) {
      expect(item).not.toHaveProperty('rows');
      expect(item).not.toHaveProperty('continuity');
    }
  });

  it('pages of two cut through the equal timestamps and together list each batch once; the last page is short, the next empty', async () => {
    const pages = await Promise.all([1, 2, 3, 4].map((page) => queries.list(REALM, {}, { page, pageSize: 2 })));
    expect(pages.map((p) => ids(p.items))).toEqual([[id(5), id(4)], [id(3), id(2)], [id(1)], []]);
    expect(pages.map((p) => [p.page, p.pageSize, p.total])).toEqual([
      [1, 2, 5],
      [2, 2, 5],
      [3, 2, 5],
      [4, 2, 5],
    ]);
    // Exactly full pages: the last full page is the end, the next one empty.
    expect(ids((await queries.list(REALM, {}, { page: 1, pageSize: 5 })).items)).toHaveLength(5);
    expect(await queries.list(REALM, {}, { page: 2, pageSize: 5 })).toEqual({ items: [], page: 2, pageSize: 5, total: 5 });
    // The same page twice is the same page.
    expect(ids((await queries.list(REALM, {}, { page: 2, pageSize: 2 })).items)).toEqual([id(3), id(2)]);
  });

  it('filters by account, by status (one or both) and by both together, each with its own total', async () => {
    const list = async (filter: Parameters<PostgresImportBatchQueries['list']>[1]) => {
      const { items, total } = await queries.list(REALM, filter, all);
      expect(total).toBe(items.length);
      return ids(items);
    };
    expect(await list({ financialAccountId: giro })).toEqual([id(4), id(3), id(1)]);
    expect(await list({ financialAccountId: savings })).toEqual([id(5), id(2)]);
    expect(await list({ statuses: ['NEEDS_REVIEW'] })).toEqual([id(5), id(3)]);
    expect(await list({ statuses: ['COMPLETED'] })).toEqual([id(4), id(2), id(1)]);
    expect(await list({ statuses: ['COMPLETED', 'NEEDS_REVIEW'] })).toEqual([id(5), id(4), id(3), id(2), id(1)]);
    expect(await list({ financialAccountId: giro, statuses: ['NEEDS_REVIEW'] })).toEqual([id(3)]);
    expect(await list({ financialAccountId: savings, statuses: ['COMPLETED'] })).toEqual([id(2)]);
    // Paged within a filter: the total is the filter's.
    expect(await queries.list(REALM, { financialAccountId: giro }, { page: 2, pageSize: 2 })).toMatchObject({ total: 3, items: [{ id: id(1) }] });
  });

  it('an unknown account, another Realm s account and a malformed id match nothing: an empty page, no error', async () => {
    for (const financialAccountId of [UNKNOWN_ACCOUNT, foreign, 'not-a-uuid']) {
      expect(await queries.list(REALM, { financialAccountId }, all), financialAccountId).toEqual({ items: [], page: 1, pageSize: 200, total: 0 });
    }
    expect(await queries.list(REALM, { statuses: [] }, all)).toMatchObject({ items: [], total: 0 });
  });

  it('another Realm s batches are never listed, also with its own account as the filter from Realm A', async () => {
    expect(ids((await queries.list(REALM, {}, all)).items)).not.toContain(id(9));
    expect(ids((await queries.list(REALM, { statuses: ['NEEDS_REVIEW'] }, all)).items)).not.toContain(id(9));
    expect(await queries.list(OTHER_REALM, {}, all)).toMatchObject({ total: 1, items: [{ id: id(9), mreRealmId: OTHER_REALM }] });
    expect(await queries.list(OTHER_REALM, { financialAccountId: giro }, all)).toMatchObject({ total: 0, items: [] });
  });

  it('writes nothing: the batches, the review items and the AuditRecords are unchanged', async () => {
    const state = async () =>
      (
        await pool.query(
          `SELECT (SELECT md5(string_agg(b::text, ',' ORDER BY b.id)) FROM import_batch b) AS batches,
                  (SELECT count(*) FROM import_review_item) AS items, (SELECT count(*) FROM audit_record) AS audits`,
        )
      ).rows[0];
    const before = await state();
    await queries.list(REALM, { financialAccountId: giro, statuses: ['NEEDS_REVIEW'] }, { page: 1, pageSize: 2 });
    await queries.list(OTHER_REALM, {}, all);
    expect(await state()).toEqual(before);
  });

  it('total and items come from one snapshot: a batch committed between the count and the page is in neither', async () => {
    const realm = '64b0c0ffee0000000000000d';
    const own = await account(realm, 'Giro D');
    await batch(realm, own, 20, '2026-10-01T08:00:00Z');
    afterCount = async () => {
      await batch(realm, own, 21, '2026-10-05T08:00:00Z');
    };
    const page = await queries.list(realm, {}, all);
    expect(afterCount).toBeUndefined();
    expect(page).toMatchObject({ total: 1, items: [{ id: id(20) }] });
    // Counter-check: the batch was committed, and the next read sees it in both.
    expect(await queries.list(realm, {}, all)).toMatchObject({ total: 2, items: [{ id: id(21) }, { id: id(20) }] });
  });
});

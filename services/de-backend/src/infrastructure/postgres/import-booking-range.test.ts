import { createHash } from 'node:crypto';
import { Kysely, PostgresDialect, type KyselyPlugin } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contentFingerprintFieldsV1,
  type BusinessDate,
  type ImportBatch,
  type NormalizedBankRow,
  type ParsedRow,
  type ParsedStatement,
} from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresImportBatchQueries } from './import-batch-queries.js';
import { bookingRanges } from './import-booking-range.js';
import { PostgresImportRepository } from './import-repository.js';
import { migrateToLatest } from './migrate.js';
import type { Database } from './schema.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-X-75 (api-design.md §32.6, Entscheidung des Projektinhabers, 2026-11-16): `firstBookingDate` / `lastBookingDate`
 * of a batch, past the repository. Batches come from the real import, so their rows are what an upload stores: the
 * Transactions of `created` rows and the batch's own review items count; duplicates, rows re-presenting another
 * batch's item, errors and skipped rows do not. The upload answer, the single read and the list answer the same range.
 * Synthetic data only.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const all = { page: 1, pageSize: 200 };

type RowSpec = { bookingDate: string; amount?: string; description?: string } | { error: string };

/** A statement as the adapter produces it; the content hash depends on the rows and their order. */
function statement(specs: readonly RowSpec[]): ParsedStatement {
  const rows: ParsedRow[] = specs.map((spec, index) => {
    if ('error' in spec) return { kind: 'ERROR', position: index + 1, errors: [{ field: 'amount', code: spec.error }] };
    const row: NormalizedBankRow = {
      bookingDate: spec.bookingDate as BusinessDate,
      valueDate: null,
      amount: Money.of(spec.amount ?? '1250.00', 'EUR'),
      direction: 'INFLOW',
      counterpartyIbanRaw: null,
      counterpartyNameRaw: 'Max Mieter',
      description: spec.description ?? `Miete ${spec.bookingDate}`,
      externalTransactionId: null,
      balanceAfter: null,
    };
    const contentFingerprint = createHash('sha256').update(contentFingerprintFieldsV1(row)).digest('hex');
    return { kind: 'ROW', position: index + 1, sourceRowId: null, row, contentFingerprint };
  });
  const contentHash = createHash('sha256').update(JSON.stringify(specs)).digest('hex');
  return { adapterId: 'generic-csv', adapterVersion: '1', contentHash, sourceStatementId: null, rows, balanceColumn: false };
}

const range = (b: Pick<ImportBatch, 'firstBookingDate' | 'lastBookingDate'>) => [b.firstBookingDate, b.lastBookingDate];

describe.skipIf(databaseUrl === undefined)('the booking range of an import (§32.6, VC-X-75)', () => {
  const schema = testSchemaName('import_booking_range_test');
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let imports: PostgresImportRepository;
  let queries: PostgresImportBatchQueries;
  let accounts: PostgresFinancialAccountRepository;
  /** Run once after the count of the next list, from another connection (the snapshot test). */
  let afterCount: (() => Promise<void>) | undefined;

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
    imports = new PostgresImportRepository(db);
    queries = new PostgresImportBatchQueries(db);
    accounts = new PostgresFinancialAccountRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  /** Each test its own Realm and account, so earlier files are never duplicates of a later test's rows. */
  let realms = 0;
  const freshRealm = () => `64b0c0ffee00000000${String(++realms).padStart(6, '0')}`;
  async function openAccount(mreRealmId: string): Promise<string> {
    const outcome = await accounts.create({ mreRealmId, accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR', iban: null }, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }
  async function run(mreRealmId: string, financialAccountId: string, specs: readonly RowSpec[]): Promise<ImportBatch> {
    const outcome = await imports.importStatement(
      { mreRealmId, financialAccountId, statement: statement(specs), provenance: 'BANK_CSV', sourceFilename: 'umsatz.csv' },
      actor,
    );
    if (outcome.kind !== 'IMPORTED') throw new Error(outcome.kind);
    return outcome.batch;
  }
  /** The range as the upload, the single read and the list answer it: always the same. */
  async function rangesOf(mreRealmId: string, batch: ImportBatch) {
    const read = await imports.findBatch(batch.id, mreRealmId);
    const listed = (await queries.list(mreRealmId, {}, all)).items.find((b) => b.id === batch.id);
    if (read === undefined || listed === undefined) throw new Error('batch not found');
    expect(range(read)).toEqual(range(batch));
    expect(range(listed)).toEqual(range(batch));
    return range(batch);
  }

  it('no row with a booking date: both null, also for a file of errors and skipped rows only', async () => {
    const realm = freshRealm();
    const account = await openAccount(realm);
    const batch = await run(realm, account, [{ error: 'INVALID_FORMAT' }, { error: 'ZERO_AMOUNT' }]);
    expect(batch.rows.map((r) => r.outcome)).toEqual(['error', 'skipped']);
    expect(await rangesOf(realm, batch)).toEqual([null, null]);
    // The list answers both keys, null, never leaves them out.
    const [listed] = (await queries.list(realm, {}, all)).items;
    expect(listed).toHaveProperty('firstBookingDate', null);
    expect(listed).toHaveProperty('lastBookingDate', null);
  });

  it('one row: first and last are its booking date', async () => {
    const realm = freshRealm();
    const batch = await run(realm, await openAccount(realm), [{ bookingDate: '2026-10-15' }]);
    expect(await rangesOf(realm, batch)).toEqual(['2026-10-15', '2026-10-15']);
  });

  it('several rows: the earliest and latest of the created rows and the own review items, whatever the file order', async () => {
    const realm = freshRealm();
    const account = await openAccount(realm);
    const first = await run(realm, account, [{ bookingDate: '2026-08-01', description: 'Miete August' }]);
    // The August row again in another file is a review item of this batch (same content, other statement); it is the
    // earliest date. Errors and skipped rows in between change nothing.
    const second = await run(realm, account, [
      { bookingDate: '2026-09-28' },
      { error: 'INVALID_FORMAT' },
      { bookingDate: '2026-08-01', description: 'Miete August' },
      { bookingDate: '2026-09-03' },
      { error: 'ZERO_AMOUNT' },
    ]);
    expect(second.rows.map((r) => r.outcome)).toEqual(['created', 'error', 'needs_review', 'created', 'skipped']);
    expect(await rangesOf(realm, second)).toEqual(['2026-08-01', '2026-09-28']);
    // The first batch keeps its own range: the second's rows are not its rows.
    expect(await rangesOf(realm, first)).toEqual(['2026-08-01', '2026-08-01']);

    // Resolved, the item still counts (CREATE books the same date); the range does not move.
    const [item] = (await imports.listReviewItems(second.id, realm))?.items ?? [];
    if (item === undefined) throw new Error('no review item');
    expect((await imports.resolveReviewItem(second.id, item.id, realm, 'CREATE', actor)).kind).toBe('RESOLVED');
    expect(range((await imports.findBatch(second.id, realm)) as ImportBatch)).toEqual(['2026-08-01', '2026-09-28']);
  });

  it('duplicates and rows re-presenting another batch s item do not count: the same file again has no range', async () => {
    const realm = freshRealm();
    const account = await openAccount(realm);
    await run(realm, account, [{ bookingDate: '2026-07-01', description: 'Miete Juli' }]);
    const specs: RowSpec[] = [{ bookingDate: '2026-07-01', description: 'Miete Juli' }, { bookingDate: '2026-07-31' }];
    const owning = await run(realm, account, specs);
    expect(owning.rows.map((r) => r.outcome)).toEqual(['needs_review', 'created']);
    const again = await run(realm, account, specs);
    // The created row is a duplicate now, the review row re-presents the owning batch's PENDING item.
    expect(again.rows.map((r) => r.outcome)).toEqual(['needs_review', 'duplicate']);
    expect(again.needsReviewCount).toBe(0);
    expect(await rangesOf(realm, again)).toEqual([null, null]);
    expect(await rangesOf(realm, owning)).toEqual(['2026-07-01', '2026-07-31']);
  });

  it('another Realm s rows never count, not even when a batch of Realm A names its Transaction', async () => {
    const realm = freshRealm();
    const other = await run(OTHER_REALM, await openAccount(OTHER_REALM), [{ bookingDate: '2025-01-02' }, { bookingDate: '2025-12-30', amount: '7.00' }]);
    expect(range(other)).toEqual(['2025-01-02', '2025-12-30']);
    const foreignTransaction = other.rows.flatMap((r) => (r.outcome === 'created' ? [r.transactionId] : []))[0];
    // Not possible through the import: a batch of Realm A whose stored row names Realm B's Transaction.
    const account = await openAccount(realm);
    const crafted = '00000000-0000-4000-8000-0000000000a1';
    await pool.query(
      `INSERT INTO import_batch (id, mre_realm_id, financial_account_id, adapter_id, adapter_version, content_hash, provenance, status,
         transaction_count, duplicate_count, needs_review_count, error_count, skipped_count, rows, imported_by)
       VALUES ($1, $2, $3, 'generic-csv', '1', 'crafted', 'BANK_CSV', 'COMPLETED', 1, 0, 0, 0, 0, $4, 'anna@example.com')`,
      [crafted, realm, account, JSON.stringify([{ outcome: 'created', position: 1, transactionId: foreignTransaction }])],
    );
    expect((await queries.list(realm, {}, all)).items).toMatchObject([{ id: crafted, firstBookingDate: null, lastBookingDate: null }]);
    // Asked from Realm A by its id, Realm B's batch has no range (neither its Transactions nor its items are read).
    expect(await bookingRanges(db, realm, [other.id, crafted])).toEqual(new Map());
    expect([...(await bookingRanges(db, OTHER_REALM, [other.id])).values()]).toEqual([{ firstBookingDate: '2025-01-02', lastBookingDate: '2025-12-30' }]);
  });

  it('a review item of another Realm s batch is not read by Realm A, even by the batch id', async () => {
    const account = await openAccount(OTHER_REALM);
    await run(OTHER_REALM, account, [{ bookingDate: '2025-03-01', description: 'Miete März' }]);
    const owning = await run(OTHER_REALM, account, [{ bookingDate: '2025-03-01', description: 'Miete März' }, { error: 'ZERO_AMOUNT' }]);
    expect(owning.rows.map((r) => r.outcome)).toEqual(['needs_review', 'skipped']);
    expect(range(owning)).toEqual(['2025-03-01', '2025-03-01']);
    expect(await bookingRanges(db, REALM, [owning.id])).toEqual(new Map());
  });

  it('paging is unaffected: pages of one list each batch once, in order, with the same total and range', async () => {
    const realm = freshRealm();
    const account = await openAccount(realm);
    const batches = [
      await run(realm, account, [{ bookingDate: '2026-01-10' }]),
      await run(realm, account, [{ error: 'INVALID_FORMAT' }]),
      await run(realm, account, [{ bookingDate: '2026-03-05' }, { bookingDate: '2026-02-20' }]),
    ];
    const whole = await queries.list(realm, {}, all);
    expect(whole.total).toBe(3);
    const pages = await Promise.all([1, 2, 3, 4].map((page) => queries.list(realm, {}, { page, pageSize: 1 })));
    expect(pages.map((p) => p.total)).toEqual([3, 3, 3, 3]);
    expect(pages.flatMap((p) => p.items)).toEqual(whole.items);
    expect(pages[3]?.items).toEqual([]);
    expect(whole.items.map((b) => [b.id, ...range(b)])).toEqual([...batches].reverse().map((b) => [b.id, ...range(b)]));
    expect(whole.items.map(range)).toEqual([
      ['2026-02-20', '2026-03-05'],
      [null, null],
      ['2026-01-10', '2026-01-10'],
    ]);
  });

  it('the range is read in the page s snapshot: a row committed after the count is not in it', async () => {
    const realm = freshRealm();
    const account = await openAccount(realm);
    const batch = await run(realm, account, [{ bookingDate: '2026-05-10' }]);
    // Not possible through the import (a batch's items are written with it): an item committed later, from another
    // connection, with an earlier date.
    afterCount = async () => {
      await pool.query(
        `INSERT INTO import_review_item (id, import_batch_id, mre_realm_id, financial_account_id, adapter_id, adapter_version,
           source_statement_key, source_row_key, content_fingerprint, normalized_row, ambiguity_reason, conflicting_transaction_ids,
           prior_review_item_ids, status)
         VALUES (gen_random_uuid(), $1, $2, $3, 'generic-csv', '1', 'late', 'pos:9', 'f', '{"bookingDate":"2026-04-01"}',
           'AMBIGUOUS_CROSS_FILE_MATCH', '{}', '{}', 'PENDING')`,
        [batch.id, realm, account],
      );
    };
    const page = await queries.list(realm, {}, all);
    expect(afterCount).toBeUndefined();
    expect(page.items.map(range)).toEqual([['2026-05-10', '2026-05-10']]);
    // Counter-check: the item was committed, and the next read counts it.
    expect((await queries.list(realm, {}, all)).items.map(range)).toEqual([['2026-04-01', '2026-05-10']]);
  });

  it('reads only: the batches, review items, Transactions and AuditRecords are unchanged', async () => {
    const state = async () =>
      (
        await pool.query(
          `SELECT (SELECT md5(string_agg(b::text, ',' ORDER BY b.id)) FROM import_batch b) AS batches,
                  (SELECT md5(string_agg(i::text, ',' ORDER BY i.id)) FROM import_review_item i) AS items,
                  (SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) FROM ledger_transaction t) AS transactions,
                  (SELECT count(*) FROM audit_record) AS audits`,
        )
      ).rows[0];
    const before = await state();
    await queries.list(OTHER_REALM, {}, all);
    const ids = (await pool.query<{ id: string }>(`SELECT id FROM import_batch`)).rows.map((r) => r.id);
    await bookingRanges(db, OTHER_REALM, ids);
    expect(await state()).toEqual(before);
  });
});

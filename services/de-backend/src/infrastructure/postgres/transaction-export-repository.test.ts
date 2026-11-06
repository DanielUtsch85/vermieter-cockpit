import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate, TransactionExportHead, TransactionFilter, TransactionId, TransactionWithSplits } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionExport } from './transaction-export-repository.js';
import { PostgresTransactionQueries } from './transaction-query-repository.js';
import { PostgresUnconfirmedTransactionRepository } from './unconfirmed-transaction-repository.js';

/**
 * VC-X-04 (api-design.md §58S): the Kassenbuch export's reads. Every §30.1 filter gives exactly the list's Transactions
 * (one function, `filtered`), oldest first; the keyset batches are complete and stable across their edges with equal
 * booking dates and creation times; count and rows come from one snapshot; the Realm is the caller's. Synthetic data.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM = '64b0c0ffee00000000058a0a';
const OTHER = '64b0c0ffee00000000058a0b';
const BULK = '64b0c0ffee00000000058a0c';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;

/** Reads a whole export into memory, with the batch sizes seen. */
async function collect(exporter: PostgresTransactionExport, realm: string, filter: TransactionFilter, batchSize = 500, countRows = false) {
  const heads: TransactionExportHead[] = [];
  const batches: (readonly TransactionWithSplits[])[] = [];
  await exporter.exportAll(
    realm,
    filter,
    { batchSize, countRows },
    { begin: (head) => void heads.push(head), batch: async (items) => void batches.push(items) },
  );
  const items = batches.flat();
  return { head: heads[0], heads, sizes: batches.map((b) => b.length), items, ids: items.map((i) => i.transaction.id) };
}

describe.skipIf(databaseUrl === undefined)('PostgresTransactionExport (VC-X-04, 58S)', () => {
  const schema = testSchemaName('transaction_export_test');
  let pool: pg.Pool;
  let exporter: PostgresTransactionExport;
  let queries: PostgresTransactionQueries;
  const id: Record<string, string> = {};

  /** One Transaction, inserted unconfirmed, split, and confirmed when asked (as the API leaves it). */
  async function tx(
    realm: string,
    key: string,
    f: {
      account: string;
      date: string;
      amount: string;
      direction?: string;
      provenance?: string;
      property?: string | null;
      splits?: [string, string, string | null][];
      confirm?: boolean;
    },
  ) {
    const { rows } = await pool.query(
      `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, property_reference_id, created_by)
       VALUES ($1, $2, $3, 'EUR', $4, $5, $6, 'UNREVIEWED', $7, 'seed') RETURNING id`,
      [realm, f.account, f.amount, f.direction ?? 'INFLOW', f.date, f.provenance ?? 'MANUAL', f.property ?? null],
    );
    id[key] = rows[0].id as string;
    for (const [i, [code, amount, property]] of (f.splits ?? []).entries()) {
      await pool.query(
        `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, created_by)
         SELECT $1, $2, $3, $4, 'EUR', id, $6, 'seed' FROM financial_category WHERE code = $5`,
        [id[key], realm, i + 1, amount, code, property],
      );
    }
    if (f.confirm === true) {
      await pool.query(`UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'seed', version = 2 WHERE id = $1`, [id[key]]);
    }
    return id[key];
  }

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    exporter = new PostgresTransactionExport(db);
    queries = new PostgresTransactionQueries(db);

    for (const [key, realm] of [
      ['giro', REALM],
      ['savings', REALM],
      ['foreign', OTHER],
      ['bulk', BULK],
    ] as const) {
      const { rows } = await pool.query(
        `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by) VALUES ($1, 'BANK', $2, 'EUR', 'OPEN', 'seed') RETURNING id`,
        [realm, key],
      );
      id[key] = rows[0].id as string;
    }
    for (const [key, realm, mre] of [
      ['p', REALM, '6b00000000000000000058a1'],
      ['q', REALM, '6b00000000000000000058a2'],
      ['foreignP', OTHER, '6b00000000000000000058a3'],
    ] as const) {
      const { rows } = await pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'seed') RETURNING id`,
        [realm, mre],
      );
      id[key] = rows[0].id as string;
    }
    const giro = id['giro'] as string;
    const p = id['p'] as string;
    const q = id['q'] as string;
    await tx(REALM, 'rent', { account: giro, date: '2026-01-03', amount: '1000.00', splits: [['RENT_BASE', '1000.00', p]], confirm: true });
    await tx(REALM, 'cost', {
      account: giro,
      date: '2026-01-10',
      amount: '200.00',
      direction: 'OUTFLOW',
      splits: [['MAINTENANCE', '200.00', q]],
      confirm: true,
    });
    await tx(REALM, 'own', { account: id['savings'] as string, date: '2026-02-01', amount: '5.00', property: p, provenance: 'BANK_CSV' });
    await tx(REALM, 'open', { account: giro, date: '2026-02-15', amount: '7.50', provenance: 'BANK_CSV' });
    await pool.query(`UPDATE ledger_transaction SET status = 'IMPORTED' WHERE id = $1`, [id['open']]);
    await tx(REALM, 'ignored', { account: giro, date: '2026-03-01', amount: '1.00' });
    const ignored = await new PostgresUnconfirmedTransactionRepository(db).ignore(id['ignored'] as TransactionId, REALM, 'Dublette', actor);
    expect(ignored.kind).toBe('IGNORED');
    await tx(REALM, 'wrong', { account: giro, date: '2026-03-05', amount: '1100.00', splits: [['RENT_BASE', '1100.00', p]], confirm: true });
    const corrected = await new PostgresCorrectionRepository(db).correct(
      id['wrong'] as TransactionId,
      REALM,
      {
        reason: 'Betrag',
        replacement: {
          amount: Money.of('1000.00', 'EUR'),
          splits: [
            {
              amount: Money.of('1000.00', 'EUR'),
              financialCategoryCode: 'RENT_BASE',
              propertyReferenceId: p,
              loanId: null,
              securityDepositId: null,
              description: null,
            },
          ],
        },
      },
      actor,
    );
    if (corrected.kind !== 'CORRECTED') throw new Error(`seed failed: ${corrected.kind}`);
    id['reversal'] = corrected.result.reversal.id;
    id['replacement'] = corrected.result.replacement?.id ?? '';
    await tx(OTHER, 'foreignTx', { account: id['foreign'] as string, date: '2026-01-05', amount: '9.00', property: id['foreignP'] as string });
  });

  afterAll(async () => {
    await pool.end();
  });

  /** The list's ids for the same filter, newest first, reversed: §58S's order is §30.1's read backwards. */
  const listed = async (realm: string, filter: TransactionFilter) =>
    (await queries.list(realm, filter, { page: 1, pageSize: 200 })).items.map((t) => t.id).reverse();

  it('every 30.1 filter, alone and combined, gives exactly the list Transactions, oldest first; the head counts them', async () => {
    const giro = id['giro'] as string;
    const filters: [string, TransactionFilter][] = [
      ['none (the raw set)', {}],
      ['financialAccountId', { financialAccountId: giro }],
      ['status', { statuses: ['CONFIRMED', 'IGNORED'] }],
      ['provenance', { provenances: ['BANK_CSV'] }],
      ['reviewable', { statuses: ['IMPORTED', 'UNREVIEWED'] }],
      ['current', { current: true }],
      ['propertyReferenceId (own or a split)', { propertyReferenceId: id['p'] as string }],
      ['financialCategoryCode', { financialCategoryCode: 'RENT_BASE' }],
      ['bookingDateFrom/To', { bookingDateFrom: '2026-01-05' as BusinessDate, bookingDateTo: '2026-02-28' as BusinessDate }],
      ['combined', { financialAccountId: giro, current: true, financialCategoryCode: 'RENT_BASE', bookingDateFrom: '2026-01-01' as BusinessDate }],
      ['status without overlap', { statuses: [] }],
      ['an unknown category', { financialCategoryCode: 'NO_SUCH_CODE' }],
      ['another Realm account', { financialAccountId: id['foreign'] as string }],
      ['another Realm property', { propertyReferenceId: id['foreignP'] as string }],
      ['a malformed account id', { financialAccountId: 'x' }],
    ];
    for (const [label, filter] of filters) {
      const got = await collect(exporter, REALM, filter);
      expect(got.ids, label).toEqual(await listed(REALM, filter));
      expect(got.head?.transactionCount, label).toBe(got.ids.length);
      expect(got.head?.rowCount, label).toBeUndefined();
    }
    expect((await collect(exporter, REALM, {})).ids).toHaveLength(8);
    expect((await collect(exporter, REALM, { current: true })).ids).toHaveLength(3);
    expect((await collect(exporter, REALM, { statuses: [] })).heads).toEqual([expect.objectContaining({ transactionCount: 0 })]);
  });

  it('history: a corrected Transaction (original, reversal, replacement) and an ignored one are rows of the raw set, not of current', async () => {
    const raw = await collect(exporter, REALM, {});
    const byId = new Map<string, unknown>(raw.items.map((i) => [i.transaction.id, i.transaction]));
    expect(byId.get(id['wrong'] as string)).toMatchObject({ status: 'CORRECTED', correctionRole: null });
    expect(byId.get(id['reversal'] as string)).toMatchObject({ correctionRole: 'REVERSAL', correctionOfTransactionId: id['wrong'] });
    expect(byId.get(id['replacement'] as string)).toMatchObject({ correctionRole: 'REPLACEMENT', correctionOfTransactionId: id['wrong'] });
    expect(byId.get(id['ignored'] as string)).toMatchObject({ status: 'IGNORED' });
    const current = (await collect(exporter, REALM, { current: true })).ids;
    expect(current).toEqual([id['rent'], id['cost'], id['replacement']]);
    // Splits come in position order with their Transaction; the reversal mirrors the original split.
    expect(byId.size).toBe(8);
    expect(raw.items.find((i) => i.transaction.id === id['reversal'])?.splits.map((s) => [s.position, s.financialCategoryCode, s.amount.amount])).toEqual([
      [1, 'RENT_BASE', '1100.00'],
    ]);
  });

  it('the Realm is the caller: no row of another Realm, and its rows only in its own export', async () => {
    const mine = (await collect(exporter, REALM, {})).ids;
    expect(mine).not.toContain(id['foreignTx']);
    expect((await collect(exporter, OTHER, {})).ids).toEqual([id['foreignTx']]);
  });

  it('rows=splits counts one row per split and one per unsplit Transaction', async () => {
    const got = await collect(exporter, REALM, {}, 500, true);
    expect(got.head?.rowCount).toBe(got.items.reduce((n, i) => n + Math.max(1, i.splits.length), 0));
    expect(got.head?.rowCount).toBe(8);
  });

  describe('1201 Transactions with equal booking dates and creation times, in batches of 500', () => {
    beforeAll(async () => {
      // One statement: one `now()`, so every row has the same created_at; the order then rests on the id alone.
      await pool.query(
        `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by)
         SELECT $1, $2, (g % 97) + 0.01, 'EUR', 'INFLOW', date '2026-05-01' + (g % 2), 'MANUAL', 'UNREVIEWED', 'seed' FROM generate_series(1, 1201) g`,
        [BULK, id['bulk']],
      );
    });

    it('is complete and stable across the batch edges: every id once, by booking date, creation and id', async () => {
      const got = await collect(exporter, BULK, {});
      expect(got.sizes).toEqual([500, 500, 201]);
      expect(got.head?.transactionCount).toBe(1201);
      expect(new Set(got.ids).size).toBe(1201);
      const { rows } = await pool.query(`SELECT id FROM ledger_transaction WHERE mre_realm_id = $1 ORDER BY booking_date, created_at, id`, [BULK]);
      expect(got.ids).toEqual(rows.map((r) => r.id as string));
      expect(new Set(got.items.map((i) => i.transaction.createdAt.getTime())).size).toBe(1);
    });

    it('one snapshot: a write committed after the count or after the first batch is not in the file, and the count equals the rows', async () => {
      const late = async (date: string) =>
        pool.query(
          `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by)
           VALUES ($1, $2, 1, 'EUR', 'INFLOW', $3, 'MANUAL', 'UNREVIEWED', 'late') RETURNING id`,
          [BULK, id['bulk'], date],
        );
      let count = 0;
      const ids: string[] = [];
      const written: string[] = [];
      let batches = 0;
      await exporter.exportAll(
        BULK,
        {},
        { batchSize: 500, countRows: false },
        {
          begin: async (head) => {
            count = head.transactionCount;
            written.push((await late('2026-12-31')).rows[0].id as string);
          },
          batch: async (items) => {
            ids.push(...items.map((i) => i.transaction.id));
            if (++batches === 1) written.push((await late('2026-12-30')).rows[0].id as string);
          },
        },
      );
      expect(ids).toHaveLength(count);
      for (const w of written) expect(ids).not.toContain(w);
      // Committed: the next export sees both.
      const after = await collect(exporter, BULK, {});
      expect(after.head?.transactionCount).toBe(count + 2);
      expect(after.ids.slice(-2)).toEqual([written[1], written[0]]);
      await pool.query(`DELETE FROM ledger_transaction WHERE created_by = 'late'`);
    });

    it('a sink that throws ends the read with that error (the snapshot rolls back), and the next export runs', async () => {
      const failure = new Error('client gone');
      await expect(
        exporter.exportAll(
          BULK,
          {},
          { batchSize: 500, countRows: false },
          {
            begin: () => undefined,
            batch: async () => {
              throw failure;
            },
          },
        ),
      ).rejects.toBe(failure);
      expect((await collect(exporter, BULK, {})).ids).toHaveLength(1201);
    });
  });
});

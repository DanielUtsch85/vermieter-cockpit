import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contentFingerprintFieldsV1,
  type BusinessDate,
  type FinancialAccountId,
  type ImportBatch,
  type NormalizedBankRow,
  type ParsedRow,
  type ParsedStatement,
} from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresImportRepository } from './import-repository.js';
import { migrateToLatest } from './migrate.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-1-12 persistence (ADR-043, data-model.md §70.6): the balance identity across overlapping exports, its content
 * and uniqueness rules, the continuity report, and the stored balance — against the real schema (migration 0034).
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000001c';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;

/** A booking: day, signed amount, balance after it (null: none), description. */
type Booking = readonly [day: string, signed: string, balanceAfter: string | null, description?: string | undefined];

function bankRow([day, signed, balanceAfter, description = 'Buchung']: Booking): NormalizedBankRow {
  const negative = signed.startsWith('-');
  return {
    bookingDate: `2026-${day}` as BusinessDate,
    valueDate: null,
    amount: Money.of(negative ? signed.slice(1) : signed, 'EUR'),
    direction: negative ? 'OUTFLOW' : 'INFLOW',
    counterpartyIbanRaw: null,
    counterpartyNameRaw: 'WEG',
    description,
    externalTransactionId: null,
    balanceAfter,
  };
}

/** A file as generic-csv would parse it; the content hash depends on the bookings, their order and the version. */
function file(bookings: readonly Booking[], adapterVersion = '2'): ParsedStatement {
  const rows: ParsedRow[] = bookings.map((b, index) => {
    const row = bankRow(adapterVersion === '1' ? [b[0], b[1], null, b[3]] : b);
    return {
      kind: 'ROW',
      position: index + 1,
      sourceRowId: null,
      row,
      contentFingerprint: createHash('sha256').update(contentFingerprintFieldsV1(row)).digest('hex'),
    };
  });
  const contentHash = createHash('sha256')
    .update(JSON.stringify([adapterVersion, bookings]))
    .digest('hex');
  return { adapterId: 'generic-csv', adapterVersion, contentHash, sourceStatementId: null, rows };
}

const outcomes = (batch: ImportBatch) => batch.rows.map((r) => r.outcome);
const created = (batch: ImportBatch) => batch.rows.flatMap((r) => (r.outcome === 'created' ? [r.transactionId] : []));

describe.skipIf(databaseUrl === undefined)('balance identity and continuity (§70.6)', () => {
  const schema = testSchemaName('import_balance_test');
  let pool: pg.Pool;
  let imports: PostgresImportRepository;
  let accounts: PostgresFinancialAccountRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    imports = new PostgresImportRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function openAccount(): Promise<FinancialAccountId> {
    const outcome = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }

  async function run(financialAccountId: string, parsed: ParsedStatement): Promise<ImportBatch> {
    const outcome = await imports.importStatement(
      { mreRealmId: REALM, financialAccountId, statement: parsed, provenance: 'BANK_CSV', sourceFilename: 'export.csv' },
      actor,
    );
    if (outcome.kind !== 'IMPORTED') throw new Error(outcome.kind);
    return outcome.batch;
  }

  const september: Booking[] = [
    ['09-01', '-10.00', '90.00'],
    ['09-02', '-20.00', '70.00'],
    ['09-03', '5.00', '75.00'],
  ];

  it('overlapping exports with balance: shared rows are duplicates, new rows created, no review item; the report says OVERLAPS', async () => {
    const account = await openAccount();
    const first = await run(account, file(september));
    expect(first).toMatchObject({ transactionCount: 3, continuity: { order: 'OLDEST_FIRST', breaks: [], previousExport: 'NO_EARLIER_BALANCE' } });
    const [, second, third] = created(first);

    // The next export, newest first, overlaps by two rows: another file, so the fallback alone would ask a human.
    const next = await run(account, file([['09-04', '-25.00', '50.00'], september[2] as Booking, september[1] as Booking]));
    expect(next.rows).toEqual([
      { outcome: 'created', position: 1, transactionId: expect.any(String) },
      { outcome: 'duplicate', position: 2, duplicateOf: 'TRANSACTION', transactionId: third },
      { outcome: 'duplicate', position: 3, duplicateOf: 'TRANSACTION', transactionId: second },
    ]);
    expect(next).toMatchObject({ needsReviewCount: 0, continuity: { order: 'NEWEST_FIRST', breaks: [], previousExport: 'OVERLAPS' } });
  });

  it('the same balance identity with other content is BALANCE_IDENTITY_CONTENT_CONFLICT, no Transaction', async () => {
    const account = await openAccount();
    const [original] = created(await run(account, file([['09-01', '-10.00', '90.00', 'Hausgeld']])));
    const changed = await run(account, file([['09-01', '-10.00', '90.00', 'Hausgeld (berichtigt)']]));
    expect(changed.rows).toEqual([
      {
        outcome: 'needs_review',
        position: 1,
        reviewItemId: expect.any(String),
        importBatchId: changed.id,
        reason: 'BALANCE_IDENTITY_CONTENT_CONFLICT',
        conflictingTransactionIds: [original],
      },
    ]);
  });

  it('a repeated identity in one file uses the fallback, stores its balance, and against an earlier file is review, never a duplicate', async () => {
    const account = await openAccount();
    const debit: Booking = ['10-01', '-100.00', '900.00', 'Lastschrift'];
    const [earlier] = created(await run(account, file([debit])));
    // Debit, its return, the same debit again: one day, one balance identity twice.
    const repeated = await run(account, file([debit, ['10-01', '100.00', '1000.00', 'Rücklastschrift'], debit]));
    expect(repeated.rows).toEqual([
      expect.objectContaining({ outcome: 'needs_review', reason: 'AMBIGUOUS_CROSS_FILE_MATCH', conflictingTransactionIds: [earlier] }),
      expect.objectContaining({ outcome: 'created', position: 2 }),
      expect.objectContaining({ outcome: 'needs_review', reason: 'AMBIGUOUS_CROSS_FILE_MATCH', conflictingTransactionIds: [earlier] }),
    ]);
  });

  it('several existing matches: review naming all of them, even with the same content (both debits imported, then the identity once)', async () => {
    const account = await openAccount();
    const debit: Booking = ['10-01', '-100.00', '900.00', 'Lastschrift'];
    const both = await run(account, file([debit, ['10-01', '100.00', '1000.00', 'Rücklastschrift'], debit]));
    expect(outcomes(both)).toEqual(['created', 'created', 'created']);
    const [first, , second] = created(both);
    const stored = await pool.query(`SELECT source_balance_after::text AS balance FROM ledger_transaction WHERE id = ANY($1) ORDER BY balance`, [
      [first, second],
    ]);
    expect(stored.rows).toEqual([{ balance: '900.00' }, { balance: '900.00' }]);

    const once = await run(account, file([debit, ['10-02', '-1.00', '899.00']]));
    // Both were created in one statement, so their order is not defined: compare as a set.
    expect(once.rows[0]).toEqual({
      outcome: 'needs_review',
      position: 1,
      reviewItemId: expect.any(String),
      importBatchId: once.id,
      reason: 'AMBIGUOUS_CROSS_FILE_MATCH',
      conflictingTransactionIds: expect.arrayContaining([first, second]),
    });
    expect(once.rows[0]).toMatchObject({ conflictingTransactionIds: { length: 2 } });
    expect(once.rows[1]).toMatchObject({ outcome: 'created' });
  });

  it('a broken chain (filtered export) is reported, rows are deduped as usual; a gap between exports is reported too', async () => {
    const account = await openAccount();
    const [firstId] = created(await run(account, file(september)));
    // Filtered: only some bookings, so the balances do not chain; the first one is already imported.
    const filtered = await run(account, file([september[0] as Booking, ['09-10', '-1.00', '40.00'], ['09-12', '-2.00', '30.00']]));
    expect(filtered.rows.map((r) => r.outcome)).toEqual(['duplicate', 'created', 'created']);
    expect(filtered.rows[0]).toMatchObject({ transactionId: firstId });
    expect(filtered.continuity).toEqual({
      order: 'OLDEST_FIRST',
      breaks: [
        { position: 2, expectedBalanceAfter: '89.00', balanceAfter: '40.00' },
        { position: 3, expectedBalanceAfter: '38.00', balanceAfter: '30.00' },
      ],
      previousExport: 'OVERLAPS',
    });

    const afterGap = await run(account, file([['09-20', '-3.00', '10.00']]));
    expect(afterGap).toMatchObject({ transactionCount: 1, continuity: { breaks: [], previousExport: 'GAP' } });
    const chained = await run(account, file([['09-21', '-4.00', '6.00']]));
    expect(chained.continuity).toMatchObject({ previousExport: 'CHAINS' });
  });

  it('v1 rows, then an overlapping v2 file with balance: the shared rows are review once, not dropped', async () => {
    const account = await openAccount();
    const v1 = await run(account, file(september, '1'));
    expect(v1).toMatchObject({ transactionCount: 3, continuity: null });
    const v2 = await run(account, file([september[2] as Booking, ['09-04', '-25.00', '50.00']]));
    expect(v2.rows).toEqual([
      expect.objectContaining({ outcome: 'needs_review', reason: 'AMBIGUOUS_CROSS_FILE_MATCH', conflictingTransactionIds: [created(v1)[2]] }),
      expect.objectContaining({ outcome: 'created' }),
    ]);
  });

  it('a CREATE resolution keeps the balance; the balance is fixed after creation (migration 0034)', async () => {
    const account = await openAccount();
    await run(account, file([['10-01', '-10.00', '90.00', 'alt']]));
    const conflict = await run(account, file([['10-01', '-10.00', '90.00', 'neu']]));
    const item = conflict.rows[0];
    if (item?.outcome !== 'needs_review') throw new Error('expected a review item');
    const resolved = await imports.resolveReviewItem(conflict.id, item.reviewItemId, REALM, 'CREATE', actor);
    if (resolved.kind !== 'RESOLVED') throw new Error(resolved.kind);
    const id = resolved.item.createdTransactionId;
    expect((await pool.query(`SELECT source_balance_after::text AS b FROM ledger_transaction WHERE id = $1`, [id])).rows).toEqual([{ b: '90.00' }]);
    await expect(pool.query(`UPDATE ledger_transaction SET source_balance_after = 1 WHERE id = $1`, [id])).rejects.toThrow(/fixed after creation/);
    await expect(pool.query(`UPDATE ledger_transaction SET source_balance_after = 0.001 WHERE id = $1`, [id])).rejects.toThrow(/check constraint|fixed/);
  });
});

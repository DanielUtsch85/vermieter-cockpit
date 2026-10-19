import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contentFingerprintFieldsV1,
  type BusinessDate,
  type FinancialAccountId,
  type ImportBatch,
  type NewImport,
  type NormalizedBankRow,
  type ParsedRow,
  type ParsedStatement,
  type RowOutcome,
} from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresImportRepository } from './import-repository.js';
import { migrateToLatest } from './migrate.js';

/**
 * VC-1-05/06 persistence: the duplicate rules of data-model.md §70 and the
 * review-item ownership of §20A, against the real schema — identical retries,
 * identical payments within one file, reordered files, pending and resolved
 * review items, adapter-version conflicts, the external-id branch, the closed
 * account rule, concurrent uploads and the schema's own uniqueness.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;

type RowSpec = Partial<Omit<NormalizedBankRow, 'amount'>> & { amount?: string };

function bankRow(spec: RowSpec): NormalizedBankRow {
  const { amount = '1250.00', ...rest } = spec;
  return {
    bookingDate: '2026-09-01' as BusinessDate,
    valueDate: null,
    amount: Money.of(amount, 'EUR'),
    direction: 'INFLOW',
    counterpartyIbanRaw: null,
    counterpartyNameRaw: 'Max Mieter',
    description: 'Miete September',
    externalTransactionId: null,
    ...rest,
  };
}

/** A statement as the adapter would produce it: the content hash depends on the rows and their order. */
function statement(specs: readonly (RowSpec | { error: string })[], adapterVersion = '1'): ParsedStatement {
  const rows: ParsedRow[] = specs.map((spec, index) => {
    if ('error' in spec) return { kind: 'ERROR', position: index + 1, errors: [{ field: 'amount', code: spec.error }] };
    const row = bankRow(spec);
    const contentFingerprint = createHash('sha256').update(contentFingerprintFieldsV1(row)).digest('hex');
    return { kind: 'ROW', position: index + 1, sourceRowId: null, row, contentFingerprint };
  });
  const contentHash = createHash('sha256').update(JSON.stringify(specs)).digest('hex');
  return { adapterId: 'generic-csv', adapterVersion, contentHash, sourceStatementId: null, rows };
}

const outcomes = (batch: ImportBatch) => batch.rows.map((r) => r.outcome);
const created = (batch: ImportBatch) => batch.rows.flatMap((r) => (r.outcome === 'created' ? [r.transactionId] : []));

describe.skipIf(databaseUrl === undefined)('PostgresImportRepository', () => {
  const schema = `import_test_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let imports: PostgresImportRepository;
  let accounts: PostgresFinancialAccountRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    imports = new PostgresImportRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });

  async function openAccount(mreRealmId = REALM): Promise<FinancialAccountId> {
    const outcome = await accounts.create(
      { mreRealmId, accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR', iban: null },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }

  async function run(financialAccountId: string, parsed: ParsedStatement, mreRealmId = REALM): Promise<ImportBatch> {
    const input: NewImport = { mreRealmId, financialAccountId, statement: parsed, provenance: 'BANK_CSV', sourceFilename: 'umsatz.csv' };
    const outcome = await imports.importStatement(input, actor);
    if (outcome.kind !== 'IMPORTED') throw new Error(outcome.kind);
    return outcome.batch;
  }

  const count = async (table: string, accountId: string) =>
    Number((await pool.query(`SELECT count(*) FROM ${table} WHERE financial_account_id = $1`, [accountId])).rows[0].count);

  const september = [
    { description: 'Miete September Whg 1' },
    { description: 'Miete September Whg 2', amount: '980.00' },
    { description: 'Hausgeld', amount: '310.40', direction: 'OUTFLOW' as const },
  ];

  it('creates IMPORTED Transactions with their source identity, stores the batch and audits it', async () => {
    const accountId = await openAccount();
    const batch = await run(accountId, statement(september));

    expect(batch).toMatchObject({
      mreRealmId: REALM,
      financialAccountId: accountId,
      adapterId: 'generic-csv',
      adapterVersion: '1',
      sourceFilename: 'umsatz.csv',
      status: 'COMPLETED',
      transactionCount: 3,
      duplicateCount: 0,
      needsReviewCount: 0,
      errorCount: 0,
      skippedCount: 0,
      importedBy: 'anna@example.com',
    });
    expect(outcomes(batch)).toEqual(['created', 'created', 'created']);

    const { rows } = await pool.query(
      `SELECT amount::text, direction, to_char(booking_date, 'YYYY-MM-DD') AS booking_date, provenance, status,
              import_batch_id, adapter_id, adapter_version, source_statement_key, source_row_key, counterparty_name_raw
         FROM ledger_transaction WHERE financial_account_id = $1 ORDER BY source_row_key`,
      [accountId],
    );
    expect(rows[2]).toMatchObject({
      amount: '310.40',
      direction: 'OUTFLOW',
      booking_date: '2026-09-01',
      provenance: 'BANK_CSV',
      status: 'IMPORTED',
      import_batch_id: batch.id,
      adapter_id: 'generic-csv',
      adapter_version: '1',
      source_statement_key: `sha256:${batch.contentHash}`,
      source_row_key: 'pos:3',
      counterparty_name_raw: 'Max Mieter',
    });

    const audit = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'ImportBatch' AND entity_id = $1`, [
      batch.id,
    ]);
    expect(audit.rows).toEqual([{ action: 'IMPORTED', metadata: expect.objectContaining({ transactionCount: 3, status: 'COMPLETED' }) }]);

    expect(await imports.findBatch(batch.id, REALM)).toEqual(batch);
    expect(await imports.findBatch(batch.id, OTHER_REALM)).toBeUndefined();
    expect(await imports.findBatch('not-a-uuid', REALM)).toBeUndefined();
  });

  it('re-importing the identical file creates nothing and reports each row as a duplicate of its Transaction', async () => {
    const accountId = await openAccount();
    const first = await run(accountId, statement(september));
    const retry = await run(accountId, statement(september));

    expect(retry).toMatchObject({ status: 'COMPLETED', transactionCount: 0, duplicateCount: 3, needsReviewCount: 0 });
    expect(retry.rows).toEqual(
      created(first).map((transactionId, i) => ({ outcome: 'duplicate', position: i + 1, duplicateOf: 'TRANSACTION', transactionId })),
    );
    expect(await count('ledger_transaction', accountId)).toBe(3);
  });

  it('two identical payments in one file are two Transactions (their positions differ)', async () => {
    const accountId = await openAccount();
    const batch = await run(accountId, statement([{ description: 'Abschlag' }, { description: 'Abschlag' }]));
    expect(outcomes(batch)).toEqual(['created', 'created']);
    expect(await count('ledger_transaction', accountId)).toBe(2);
  });

  it('a reordered file is a different statement: matching content becomes review items, never Transactions', async () => {
    const accountId = await openAccount();
    const first = await run(accountId, statement(september));
    const reordered = [september[2], september[0], september[1], { description: 'Neu', amount: '12.00' }] as RowSpec[];
    const batch = await run(accountId, statement(reordered));

    expect(batch).toMatchObject({ status: 'NEEDS_REVIEW', transactionCount: 1, duplicateCount: 0, needsReviewCount: 3 });
    const [r1, r2, r3, r4] = batch.rows;
    expect(r1).toMatchObject({
      outcome: 'needs_review',
      importBatchId: batch.id,
      reason: 'AMBIGUOUS_CROSS_FILE_MATCH',
      conflictingTransactionIds: [created(first)[2]],
    });
    expect(r2).toMatchObject({ outcome: 'needs_review', conflictingTransactionIds: [created(first)[0]] });
    expect(r3).toMatchObject({ outcome: 'needs_review', conflictingTransactionIds: [created(first)[1]] });
    expect(r4).toMatchObject({ outcome: 'created' });
    expect(await count('ledger_transaction', accountId)).toBe(4);

    const items = await pool.query(
      `SELECT id, import_batch_id, status, ambiguity_reason, source_row_key, normalized_row
         FROM import_review_item WHERE financial_account_id = $1 ORDER BY source_row_key`,
      [accountId],
    );
    expect(items.rows).toHaveLength(3);
    expect(items.rows[0]).toMatchObject({
      import_batch_id: batch.id,
      status: 'PENDING',
      ambiguity_reason: 'AMBIGUOUS_CROSS_FILE_MATCH',
      source_row_key: 'pos:1',
      normalized_row: expect.objectContaining({ amount: { amount: '310.40', currency: 'EUR' }, direction: 'OUTFLOW', position: 1 }),
    });
  });

  it('re-presenting a PENDING item references it in its owning batch without counting or duplicating it', async () => {
    const accountId = await openAccount();
    await run(accountId, statement(september));
    const reordered = [september[1], september[0]] as RowSpec[];
    const owning = await run(accountId, statement(reordered));
    const again = await run(accountId, statement(reordered));

    expect(again).toMatchObject({ status: 'COMPLETED', transactionCount: 0, duplicateCount: 0, needsReviewCount: 0 });
    expect(again.rows).toEqual(owning.rows);
    expect(again.rows.every((r) => r.outcome === 'needs_review' && r.importBatchId === owning.id)).toBe(true);
    expect(await count('import_review_item', accountId)).toBe(2);
  });

  it('a RESOLVED item makes the re-presented row a duplicate carrying the stored decision', async () => {
    const accountId = await openAccount();
    const first = await run(accountId, statement(september));
    const reordered = [september[1], september[0]] as RowSpec[];
    const owning = await run(accountId, statement(reordered));
    const [skipItem, createItem] = owning.rows as Extract<RowOutcome, { outcome: 'needs_review' }>[];
    if (skipItem === undefined || createItem === undefined) throw new Error('expected two review items');
    // Resolution itself is VC-1-06a; here only its stored result matters.
    await pool.query(
      `UPDATE import_review_item SET status = 'RESOLVED', resolution = 'SKIP', resolved_by = 'anna@example.com', resolved_at = now() WHERE id = $1`,
      [skipItem.reviewItemId],
    );
    const decided = created(first)[2] ?? '';
    await pool.query(
      `UPDATE import_review_item SET status = 'RESOLVED', resolution = 'CREATE', resolved_by = 'anna@example.com', resolved_at = now(),
              created_transaction_id = $2 WHERE id = $1`,
      [createItem.reviewItemId, decided],
    );

    const again = await run(accountId, statement(reordered));
    expect(again).toMatchObject({ status: 'COMPLETED', transactionCount: 0, duplicateCount: 2, needsReviewCount: 0 });
    expect(again.rows).toEqual([
      {
        outcome: 'duplicate',
        position: 1,
        duplicateOf: 'RESOLVED_REVIEW_ITEM',
        reviewItemId: skipItem.reviewItemId,
        importBatchId: owning.id,
        resolution: 'SKIP',
      },
      {
        outcome: 'duplicate',
        position: 2,
        duplicateOf: 'RESOLVED_REVIEW_ITEM',
        reviewItemId: createItem.reviewItemId,
        importBatchId: owning.id,
        resolution: 'CREATE',
        createdTransactionId: decided,
      },
    ]);
  });

  it('the same statement under another adapter version is a conflict for review, never automatic', async () => {
    const accountId = await openAccount();
    const first = await run(accountId, statement(september));
    const v2 = await run(accountId, statement(september, '2'));

    expect(v2).toMatchObject({ status: 'NEEDS_REVIEW', transactionCount: 0, needsReviewCount: 3 });
    expect(v2.rows[0]).toMatchObject({
      outcome: 'needs_review',
      importBatchId: v2.id,
      reason: 'ADAPTER_VERSION_CONFLICT',
      conflictingTransactionIds: [created(first)[0]],
    });
    const prior = await pool.query(
      `SELECT prior_review_item_ids FROM import_review_item WHERE import_batch_id = $1 AND source_row_key = 'pos:1'`,
      [v2.id],
    );
    expect(prior.rows).toEqual([{ prior_review_item_ids: [] }]);
    expect(await count('ledger_transaction', accountId)).toBe(3);

    // The v2 retry references its own pending items; a v3 sees both the Transaction and the v2 item.
    const v3 = await run(accountId, statement(september, '3'));
    const item = await pool.query(
      `SELECT prior_review_item_ids, conflicting_transaction_ids FROM import_review_item WHERE import_batch_id = $1 AND source_row_key = 'pos:1'`,
      [v3.id],
    );
    const [v2Row] = v2.rows as Extract<RowOutcome, { outcome: 'needs_review' }>[];
    expect(item.rows).toEqual([{ prior_review_item_ids: [v2Row?.reviewItemId], conflicting_transaction_ids: [created(first)[0]] }]);
  });

  it('a stable external id decides alone: duplicate across files and adapter versions', async () => {
    const accountId = await openAccount();
    const first = await run(
      accountId,
      statement([{ externalTransactionId: 'BANK-REF-1' }, { externalTransactionId: 'BANK-REF-2', amount: '7.00' }]),
    );
    expect(outcomes(first)).toEqual(['created', 'created']);

    const other = await run(accountId, statement([{ externalTransactionId: 'BANK-REF-2', amount: '7.00', description: 'anders' }], '2'));
    expect(other.rows).toEqual([{ outcome: 'duplicate', position: 1, duplicateOf: 'TRANSACTION', transactionId: created(first)[1] }]);

    // Same content but its own external id: a different payment, not ambiguous.
    const third = await run(accountId, statement([{ externalTransactionId: 'BANK-REF-3' }]));
    expect(outcomes(third)).toEqual(['created']);

    // Without an id, the same content as an id-imported row is ambiguous, not new.
    const withoutId = await run(accountId, statement([{ description: 'Miete September' }]));
    const [ambiguous] = withoutId.rows as Extract<RowOutcome, { outcome: 'needs_review' }>[];
    expect(ambiguous?.outcome).toBe('needs_review');
    expect([...(ambiguous?.conflictingTransactionIds ?? [])].sort()).toEqual([created(first)[0], created(third)[0]].sort());
  });

  it('records row errors and zero amounts without failing the batch', async () => {
    const accountId = await openAccount();
    const batch = await run(accountId, statement([{ error: 'INVALID_FORMAT' }, { error: 'ZERO_AMOUNT' }, { description: 'ok' }]));
    expect(batch).toMatchObject({ status: 'COMPLETED', transactionCount: 1, errorCount: 1, skippedCount: 1 });
    expect(batch.rows.slice(0, 2)).toEqual([
      { outcome: 'error', position: 1, errors: [{ field: 'amount', code: 'INVALID_FORMAT' }] },
      { outcome: 'skipped', position: 2, reason: 'ZERO_AMOUNT' },
    ]);
  });

  it('imports into a closed account only up to the closing day', async () => {
    const accountId = await openAccount();
    await accounts.close(accountId, REALM, new Date('2026-09-15T10:00:00Z'), actor);
    const batch = await run(
      accountId,
      statement([{ bookingDate: '2026-09-15' as BusinessDate }, { bookingDate: '2026-09-16' as BusinessDate }]),
    );
    expect(batch.rows).toEqual([
      { outcome: 'created', position: 1, transactionId: expect.any(String) },
      { outcome: 'error', position: 2, errors: [{ field: 'bookingDate', code: 'ACCOUNT_CLOSED' }] },
    ]);
  });

  it('another Realm’s or an unknown account is not found, and nothing is stored', async () => {
    const accountId = await openAccount(OTHER_REALM);
    const input = (financialAccountId: string): NewImport => ({
      mreRealmId: REALM,
      financialAccountId,
      statement: statement(september),
      provenance: 'BANK_CSV',
      sourceFilename: null,
    });
    expect(await imports.importStatement(input(accountId), actor)).toEqual({ kind: 'ACCOUNT_NOT_FOUND' });
    expect(await imports.importStatement(input('nope'), actor)).toEqual({ kind: 'ACCOUNT_NOT_FOUND' });
    expect(await count('import_batch', accountId)).toBe(0);
  });

  it('two concurrent uploads of one file create each row once', async () => {
    const accountId = await openAccount();
    const [a, b] = await Promise.all([run(accountId, statement(september)), run(accountId, statement(september))]);
    expect([a.transactionCount, b.transactionCount].sort()).toEqual([0, 3]);
    expect(a.duplicateCount + b.duplicateCount).toBe(3);
    expect(await count('ledger_transaction', accountId)).toBe(3);
  });

  it('the schema itself refuses a second Transaction or review item for one source identity', async () => {
    const accountId = await openAccount();
    const first = await run(accountId, statement(september));
    await expect(
      pool.query(
        `INSERT INTO ledger_transaction (id, mre_realm_id, financial_account_id, amount, currency, direction, booking_date,
            provenance, status, created_by, import_batch_id, adapter_id, adapter_version, source_statement_key, source_row_key, content_fingerprint)
         SELECT gen_random_uuid(), mre_realm_id, financial_account_id, amount, currency, direction, booking_date,
            provenance, status, created_by, import_batch_id, adapter_id, adapter_version, source_statement_key, source_row_key, 'x'
           FROM ledger_transaction WHERE id = $1`,
        [created(first)[0]],
      ),
    ).rejects.toThrow(/ledger_transaction_source_row_key/);
    await expect(
      pool.query(
        `INSERT INTO ledger_transaction (id, mre_realm_id, financial_account_id, amount, currency, direction, booking_date,
            provenance, status, created_by, import_batch_id)
         SELECT gen_random_uuid(), mre_realm_id, financial_account_id, amount, currency, direction, booking_date,
            provenance, status, created_by, import_batch_id FROM ledger_transaction WHERE id = $1`,
        [created(first)[0]],
      ),
    ).rejects.toThrow(/ledger_transaction_import_identity/);
  });
});

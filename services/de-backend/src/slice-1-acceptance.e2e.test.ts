import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import {
  closeFinancialAccount,
  confirmTransaction,
  correctTransaction,
  amendTransaction,
  ignoreTransaction,
  restoreTransaction,
  createFinancialAccount,
  createManualTransaction,
  getFinancialCategory,
  getImportBatch,
  importBankStatement,
  linkPropertyReference,
  listFinancialCategories,
  listReviewItems,
  refreshPropertyReference,
  resolveReviewItem,
  setTransactionSplits,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresFinancialCategoryRepository,
  PostgresImportRepository,
  PostgresPropertyReferenceRepository,
  PostgresCorrectionRepository,
  PostgresUnconfirmedTransactionRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { findBankStatementAdapter } from './integrations/bank-import/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier, mrePropertyLookup } from './wiring.js';

/**
 * VC-1-09: the Slice-1 definition of done (project-brief.md §7) as one
 * acceptance run through the HTTP API, wired as in main.ts: link an MRE
 * property, create a financial account, import a bank CSV twice without
 * duplicates, split a transaction so totals reconcile and confirm it — all
 * Realm-isolated, all money exact, all records traceable to their source.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000000a';
const REALM_B = '64b0c0ffee0000000000000b';
const PROPERTY = '6512f0c2a1b2c3d4e5f60901';

const september = ['Buchungstag;Betrag;Verwendungszweck', '01.09.2026;1.250,00;Miete September', '02.09.2026;-310,40;Hausgeld'].join(
  '\r\n',
);
const reordered = ['Buchungstag;Betrag;Verwendungszweck', '02.09.2026;-310,40;Hausgeld', '01.09.2026;1.250,00;Miete September'].join(
  '\r\n',
);

describe.skipIf(databaseUrl === undefined)('Slice 1 acceptance (definition of done)', () => {
  const schema = testSchemaName('slice_1_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });

    const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
    mre = await startFakeMre([
      { _id: REALM_A, name: 'A', members: member, applications: [], properties: [{ _id: PROPERTY, name: 'Wohnung 1', surface: 64.5 }] },
      { _id: REALM_B, name: 'B', members: member, applications: [], properties: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const propertyReferences = { repository: new PostgresPropertyReferenceRepository(db), lookupMreProperty: mrePropertyLookup(client) };
    const accounts = new PostgresFinancialAccountRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const unconfirmed = new PostgresUnconfirmedTransactionRepository(db);
    const imports = new PostgresImportRepository(db);
    const categories = new PostgresFinancialCategoryRepository(db);
    server = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      linkPropertyReference: linkPropertyReference(propertyReferences),
      refreshPropertyReference: refreshPropertyReference(propertyReferences),
      createFinancialAccount: createFinancialAccount({ repository: accounts }),
      closeFinancialAccount: closeFinancialAccount({ repository: accounts }),
      createManualTransaction: createManualTransaction({ repository: transactions }),
      confirmTransaction: confirmTransaction({ repository: transactions }),
      correctTransaction: correctTransaction({ repository: new PostgresCorrectionRepository(db) }),
      amendTransaction: amendTransaction({ repository: unconfirmed }),
      ignoreTransaction: ignoreTransaction({ repository: unconfirmed }),
      restoreTransaction: restoreTransaction({ repository: unconfirmed }),
      setTransactionSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
      listFinancialCategories: listFinancialCategories({ categories }),
      getFinancialCategory: getFinancialCategory({ categories }),
      importBankStatement: importBankStatement({ imports, accounts, findAdapter: findBankStatementAdapter }),
      getImportBatch: getImportBatch({ imports }),
      listReviewItems: listReviewItems({ imports }),
      resolveReviewItem: resolveReviewItem({ imports }),
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.end();
  });

  const headers = (realm: string) => ({
    authorization: `Bearer ${signJwt({ account: { email: 'anna@example.com' } })}`,
    organizationid: realm,
  });
  const call = (realm: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...headers(realm), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const upload = (realm: string, financialAccountId: string, file: string) => {
    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({
        financialAccountId,
        adapterId: 'generic-csv',
        adapterVersion: '1',
        columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag', description: 'Verwendungszweck' },
      }),
    );
    form.append('file', new Blob([file]), 'umsatz.csv');
    return fetch(`${base}/api/v1/imports/bank-transactions`, { method: 'POST', headers: headers(realm), body: form });
  };
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const eur = (amount: string) => ({ amount, currency: 'EUR' });

  it('links, imports twice without duplicates, splits exactly, confirms — isolated, exact and traceable', async () => {
    // 1. Link the MRE property.
    const property = await json<{ propertyReferenceId: string }>(
      await call(REALM_A, 'POST', '/property-references/link', { mreRealmId: REALM_A, mrePropertyId: PROPERTY }),
      201,
    );

    // 2. Create the bank account.
    const account = await json<{ financialAccountId: string }>(
      await call(REALM_A, 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Mietkonto', currency: 'EUR' }),
      201,
    );

    // 3. Import the September statement twice: two Transactions, then two duplicates.
    const first = await json<{ importBatchId: string; transactionCount: number; rows: { outcome: string; transactionId?: string }[] }>(
      await upload(REALM_A, account.financialAccountId, september),
      201,
    );
    expect(first.transactionCount).toBe(2);
    const second = await json<{ transactionCount: number; duplicateCount: number }>(
      await upload(REALM_A, account.financialAccountId, september),
      201,
    );
    expect(second).toMatchObject({ transactionCount: 0, duplicateCount: 2 });
    const rentId = first.rows[0]?.transactionId ?? '';

    // 4. Split the rent so the totals reconcile exactly; a cent off is refused.
    const rentSplits = [
      { amount: eur('1000.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: property.propertyReferenceId },
      { amount: eur('250.00'), financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', propertyReferenceId: property.propertyReferenceId },
    ];
    const offByOneCent = await call(REALM_A, 'PUT', `/transactions/${rentId}/splits`, {
      splits: [rentSplits[0], { ...rentSplits[1], amount: eur('249.99') }],
    });
    expect(offByOneCent.status).toBe(409);
    expect(await json(await call(REALM_A, 'PUT', `/transactions/${rentId}/splits`, { splits: rentSplits }), 200)).toMatchObject({
      status: 'CLASSIFIED',
    });

    // 5. Confirm; afterwards the classification is frozen.
    expect(await json(await call(REALM_A, 'POST', `/transactions/${rentId}/confirm`), 200)).toMatchObject({
      status: 'CONFIRMED',
      amount: eur('1250.00'),
      direction: 'INFLOW',
    });
    expect(
      (
        await call(REALM_A, 'PUT', `/transactions/${rentId}/splits`, {
          splits: [{ amount: eur('1250.00'), financialCategoryCode: 'OTHER' }],
        })
      ).status,
    ).toBe(409);

    // Exact money: stored as written, never rounded; over-precise or float input refused.
    const stored = await pool.query(`SELECT amount::text, direction, status FROM ledger_transaction WHERE id = $1`, [rentId]);
    expect(stored.rows).toEqual([{ amount: '1250.00', direction: 'INFLOW', status: 'CONFIRMED' }]);
    const splits = await pool.query(`SELECT amount::text FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [rentId]);
    expect(splits.rows).toEqual([{ amount: '1000.00' }, { amount: '250.00' }]);
    for (const amount of [eur('1.005'), { amount: 1.5, currency: 'EUR' }, { amount: '-1.00', currency: 'EUR' }]) {
      const res = await call(REALM_A, 'POST', '/transactions', {
        financialAccountId: account.financialAccountId,
        amount,
        direction: 'INFLOW',
        bookingDate: '2026-09-01',
      });
      expect(res.status, JSON.stringify(amount)).toBe(400);
    }

    // Traceable: the confirmed Transaction leads back to its import, file row and every step's AuditRecord.
    const source = await pool.query(
      `SELECT import_batch_id, provenance, adapter_id, adapter_version, source_row_key, confirmed_by FROM ledger_transaction WHERE id = $1`,
      [rentId],
    );
    expect(source.rows).toEqual([
      {
        import_batch_id: first.importBatchId,
        provenance: 'BANK_CSV',
        adapter_id: 'generic-csv',
        adapter_version: '1',
        source_row_key: 'pos:1',
        confirmed_by: 'anna@example.com',
      },
    ]);
    const audit = await pool.query(`SELECT entity_type, action FROM audit_record ORDER BY occurred_at, new_version`);
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        { entity_type: 'PropertyReference', action: expect.any(String) },
        { entity_type: 'FinancialAccount', action: 'CREATED' },
        { entity_type: 'ImportBatch', action: 'IMPORTED' },
        { entity_type: 'Transaction', action: 'SPLITS_REPLACED' },
        { entity_type: 'Transaction', action: 'CONFIRMED' },
      ]),
    );

    // Realm isolation: every endpoint, given Realm A's ids, answers Realm B with 404 and changes nothing.
    const review = await json<{ importBatchId: string }>(await upload(REALM_A, account.financialAccountId, reordered), 201);
    const items = await json<{ items: { reviewItemId: string }[] }>(
      await call(REALM_A, 'GET', `/imports/${review.importBatchId}/review-items`),
      200,
    );
    const itemId = items.items[0]?.reviewItemId ?? '';
    const before = await pool.query(`SELECT count(*) FROM audit_record`);
    const fromB: [string, string, unknown?][] = [
      ['POST', `/property-references/${property.propertyReferenceId}/refresh`],
      ['POST', `/financial-accounts/${account.financialAccountId}/close`],
      [
        'POST',
        '/transactions',
        { financialAccountId: account.financialAccountId, amount: eur('1.00'), direction: 'INFLOW', bookingDate: '2026-09-01' },
      ],
      ['PUT', `/transactions/${rentId}/splits`, { splits: rentSplits }],
      ['POST', `/transactions/${rentId}/confirm`],
      ['POST', `/transactions/${rentId}/correct`, { reason: 'x', replacement: { bookingDate: '2026-09-03' } }],
      ['POST', `/transactions/${rentId}/amend`, { description: 'x' }],
      ['POST', `/transactions/${rentId}/ignore`, { reason: 'x' }],
      ['POST', `/transactions/${rentId}/restore`],
      ['GET', `/imports/${first.importBatchId}`],
      ['GET', `/imports/${review.importBatchId}/review-items`],
      ['POST', `/imports/${review.importBatchId}/review-items/${itemId}/resolve`, { resolution: 'SKIP' }],
    ];
    for (const [method, path, body] of fromB) {
      expect((await call(REALM_B, method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    expect((await upload(REALM_B, account.financialAccountId, september)).status).toBe(404);
    expect((await pool.query(`SELECT count(*) FROM audit_record`)).rows).toEqual(before.rows);
  });

  it('corrects a confirmed import by reversal + replacement; a re-import still finds the original (VC-1-11)', async () => {
    const account = await json<{ financialAccountId: string }>(
      await call(REALM_A, 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Mietkonto 2', currency: 'EUR' }),
      201,
    );
    const imported = await json<{ rows: { transactionId?: string }[] }>(await upload(REALM_A, account.financialAccountId, september), 201);
    const rentId = imported.rows[0]?.transactionId ?? '';
    await json(await call(REALM_A, 'PUT', `/transactions/${rentId}/splits`, { splits: [{ amount: eur('1250.00'), financialCategoryCode: 'RENT_BASE' }] }), 200);
    await json(await call(REALM_A, 'POST', `/transactions/${rentId}/confirm`), 200);

    // Realm B cannot correct Realm A's Transaction, and nothing is written.
    const before = await pool.query(`SELECT count(*) FROM ledger_transaction`);
    const foreign = await call(REALM_B, 'POST', `/transactions/${rentId}/correct`, { reason: 'x', replacement: { bookingDate: '2026-09-03' } });
    expect(foreign.status).toBe(404);
    expect((await pool.query(`SELECT count(*) FROM ledger_transaction`)).rows).toEqual(before.rows);

    const corrected = await json<Record<'original' | 'reversal' | 'replacement', Record<string, unknown>>>(
      await call(REALM_A, 'POST', `/transactions/${rentId}/correct`, {
        reason: 'Parser hat Kaltmiete und Nebenkosten nicht getrennt',
        replacement: {
          splits: [
            { amount: eur('1000.00'), financialCategoryCode: 'RENT_BASE' },
            { amount: eur('250.00'), financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' },
          ],
        },
      }),
      201,
    );
    expect(corrected.original).toMatchObject({ transactionId: rentId, status: 'CORRECTED', provenance: 'BANK_CSV' });
    expect(corrected.reversal).toMatchObject({ direction: 'OUTFLOW', amount: eur('1250.00'), provenance: 'CORRECTION', correctionRole: 'REVERSAL' });
    expect(corrected.replacement).toMatchObject({ direction: 'INFLOW', amount: eur('1250.00'), status: 'CONFIRMED', correctionRole: 'REPLACEMENT' });
    // A second attempt names the correction instead of making another one.
    const again = await json<{ error: { details: Record<string, unknown> } }>(
      await call(REALM_A, 'POST', `/transactions/${rentId}/correct`, { reason: 'x', replacement: { bookingDate: '2026-09-03' } }),
      409,
    );
    expect(again.error.details).toEqual({
      reason: 'ALREADY_CORRECTED',
      reversalTransactionId: corrected.reversal['transactionId'],
      replacementTransactionId: corrected.replacement['transactionId'],
    });

    // The bank row still belongs to the original: re-importing the file creates nothing.
    const reimport = await json<{ transactionCount: number; duplicateCount: number }>(
      await upload(REALM_A, account.financialAccountId, september),
      201,
    );
    expect(reimport).toMatchObject({ transactionCount: 0, duplicateCount: 2 });

    // Net effect on the account: the rent counts once, now split in two categories.
    const totals = await pool.query(
      `SELECT c.code, sum(CASE t.direction WHEN 'INFLOW' THEN s.amount ELSE -s.amount END)::text AS total
       FROM ledger_transaction t JOIN transaction_split s ON s.transaction_id = t.id JOIN financial_category c ON c.id = s.financial_category_id
       WHERE t.financial_account_id = $1 AND t.status IN ('CONFIRMED', 'RECONCILED', 'CORRECTED')
       GROUP BY c.code HAVING sum(CASE t.direction WHEN 'INFLOW' THEN s.amount ELSE -s.amount END) <> 0 ORDER BY c.code`,
      [account.financialAccountId],
    );
    expect(totals.rows).toEqual([
      { code: 'RENT_BASE', total: '1000.00' },
      { code: 'RENT_OPERATING_COST_ADVANCE', total: '250.00' },
    ]);
  });
});

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { unusedCommands } from './api/app.test-support.js';
import { createFinancialAccount, getImportBatch, importBankStatement, listReviewItems, resolveReviewItem } from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresImportRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { findBankStatementAdapter } from './integrations/bank-import/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';

/** VC-1-05/06/06a end to end, wired as in main.ts: a real CSV through generic-csv v1 into PostgreSQL. */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000000a';
const REALM_B = '64b0c0ffee0000000000000b';

const csv = [
  'Kontoauszug Girokonto',
  'Buchungstag;Wertstellung;Betrag;Empfaenger;Verwendungszweck',
  '01.09.2026;01.09.2026;1.250,00;Max Mieter;Miete September',
  '02.09.2026;02.09.2026;-310,40;WEG Musterstr.;Hausgeld',
  '30.09.2026;30.09.2026;0,00;;Abschluss',
  '03.09.2026;;abc;Fehler;kaputt',
].join('\r\n');
const reordered = [
  'Kontoauszug Girokonto',
  'Buchungstag;Wertstellung;Betrag;Empfaenger;Verwendungszweck',
  '02.09.2026;02.09.2026;-310,40;WEG Musterstr.;Hausgeld',
  '01.09.2026;01.09.2026;1.250,00;Max Mieter;Miete September',
].join('\r\n');

describe.skipIf(databaseUrl === undefined)('bank import end to end', () => {
  const schema = `import_e2e_${process.pid}_${Date.now()}`;
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
      { _id: REALM_A, name: 'A', members: member, applications: [] },
      { _id: REALM_B, name: 'B', members: member, applications: [] },
    ]);
    const db = createDatabase(pool);
    const accounts = new PostgresFinancialAccountRepository(db);
    const imports = new PostgresImportRepository(db);
    server = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 })),
      ...unusedCommands,
      createFinancialAccount: createFinancialAccount({ repository: accounts }),
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
  const newAccount = async (realm = REALM_A) =>
    (
      (await (
        await fetch(`${base}/api/v1/financial-accounts`, {
          method: 'POST',
          headers: { ...headers(realm), 'content-type': 'application/json' },
          body: JSON.stringify({ accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }),
        })
      ).json()) as { financialAccountId: string }
    ).financialAccountId;
  const upload = (realm: string, financialAccountId: string, file: string) => {
    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({
        financialAccountId,
        adapterId: 'generic-csv',
        adapterVersion: '1',
        skipLines: 1,
        columnMapping: {
          bookingDate: 'Buchungstag',
          valueDate: 'Wertstellung',
          amount: 'Betrag',
          counterpartyName: 'Empfaenger',
          description: 'Verwendungszweck',
        },
      }),
    );
    form.append('file', new Blob([file]), 'umsatz.csv');
    return fetch(`${base}/api/v1/imports/bank-transactions`, { method: 'POST', headers: headers(realm), body: form });
  };

  it('imports, reports a retry as duplicates, sends a reordered file to review, and serves the batch', async () => {
    const accountId = await newAccount();
    const first = await upload(REALM_A, accountId, csv);
    expect(first.status).toBe(201);
    const batch = (await first.json()) as { importBatchId: string; rows: unknown[] };
    expect(batch).toMatchObject({ status: 'COMPLETED', transactionCount: 2, errorCount: 1, skippedCount: 1, sourceFilename: 'umsatz.csv' });
    expect(batch.rows[3]).toEqual({ outcome: 'error', position: 4, errors: [{ field: 'amount', code: 'INVALID_FORMAT' }] });

    const retry = await (await upload(REALM_A, accountId, csv)).json();
    expect(retry).toMatchObject({ transactionCount: 0, duplicateCount: 2 });

    const review = await (await upload(REALM_A, accountId, reordered)).json();
    expect(review).toMatchObject({ status: 'NEEDS_REVIEW', transactionCount: 0, needsReviewCount: 2 });

    const stored = await pool.query(
      `SELECT amount::text, direction, provenance, status FROM ledger_transaction WHERE financial_account_id = $1 ORDER BY booking_date`,
      [accountId],
    );
    expect(stored.rows).toEqual([
      { amount: '1250.00', direction: 'INFLOW', provenance: 'BANK_CSV', status: 'IMPORTED' },
      { amount: '310.40', direction: 'OUTFLOW', provenance: 'BANK_CSV', status: 'IMPORTED' },
    ]);

    const fetched = await fetch(`${base}/api/v1/imports/${batch.importBatchId}`, { headers: headers(REALM_A) });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(batch);
    expect((await fetch(`${base}/api/v1/imports/${batch.importBatchId}`, { headers: headers(REALM_B) })).status).toBe(404);
  });

  it('lists the review items of a reordered file and resolves them; the batch completes and a re-import reports the decisions', async () => {
    const accountId = await newAccount();
    await upload(REALM_A, accountId, csv);
    const review = (await (await upload(REALM_A, accountId, reordered)).json()) as { importBatchId: string };
    const listed = (await (
      await fetch(`${base}/api/v1/imports/${review.importBatchId}/review-items`, { headers: headers(REALM_A) })
    ).json()) as {
      items: { reviewItemId: string; normalizedRow: { description: string }; conflictingTransactions: { description: string }[] }[];
    };
    expect(listed.items.map((i) => [i.normalizedRow.description, i.conflictingTransactions.map((t) => t.description)])).toEqual([
      ['Hausgeld', ['Hausgeld']],
      ['Miete September', ['Miete September']],
    ]);
    const [hausgeld, miete] = listed.items;
    const resolveAs = (id: string, resolution: string, realm = REALM_A) =>
      fetch(`${base}/api/v1/imports/${review.importBatchId}/review-items/${id}/resolve`, {
        method: 'POST',
        headers: { ...headers(realm), 'content-type': 'application/json' },
        body: JSON.stringify({ resolution }),
      });

    expect((await resolveAs(hausgeld?.reviewItemId ?? '', 'SKIP', REALM_B)).status).toBe(404);
    expect((await resolveAs(hausgeld?.reviewItemId ?? '', 'SKIP')).status).toBe(200);
    const created = await resolveAs(miete?.reviewItemId ?? '', 'CREATE');
    expect(created.status).toBe(200);
    const createdItem = (await created.json()) as { createdTransactionId: string };
    expect((await resolveAs(miete?.reviewItemId ?? '', 'CREATE')).headers.get('idempotent-replayed')).toBe('true');
    expect((await resolveAs(miete?.reviewItemId ?? '', 'SKIP')).status).toBe(409);

    const batch = await (await fetch(`${base}/api/v1/imports/${review.importBatchId}`, { headers: headers(REALM_A) })).json();
    expect(batch).toMatchObject({ status: 'COMPLETED', needsReviewCount: 0 });
    const again = (await (await upload(REALM_A, accountId, reordered)).json()) as { rows: unknown[] };
    expect(again.rows).toEqual([
      expect.objectContaining({ outcome: 'duplicate', duplicateOf: 'RESOLVED_REVIEW_ITEM', resolution: 'SKIP' }),
      expect.objectContaining({ outcome: 'duplicate', resolution: 'CREATE', createdTransactionId: createdItem.createdTransactionId }),
    ]);
    const count = await pool.query('SELECT count(*) FROM ledger_transaction WHERE financial_account_id = $1', [accountId]);
    expect(Number(count.rows[0].count)).toBe(3);
  });

  it("another Realm's account is 404 and a broken file is 400 IMPORT_ERROR; neither stores a batch", async () => {
    const foreign = await newAccount(REALM_B);
    expect((await upload(REALM_A, foreign, csv)).status).toBe(404);
    const accountId = await newAccount();
    const broken = await upload(REALM_A, accountId, 'Kontoauszug\nDatum;Summe\n01.09.2026;1,00');
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: { code: 'IMPORT_ERROR', details: { reason: 'MISSING_COLUMN' } } });
    const batches = await pool.query('SELECT count(*) FROM import_batch WHERE financial_account_id = ANY($1)', [[foreign, accountId]]);
    expect(Number(batches.rows[0].count)).toBe(0);
  });
});

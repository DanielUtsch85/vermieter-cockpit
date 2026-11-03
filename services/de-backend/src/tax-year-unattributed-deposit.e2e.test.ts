import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  closeDeposit,
  confirmTransaction,
  createDeposit,
  createFinancialAccount,
  createManualTransaction,
  createReconciliation,
  createTaxClassification,
  getDepositTaxMeaning,
  getTaxMeaning,
  getTaxYearView,
  releaseReconciliation,
  reopenDeposit,
  setTransactionSplits,
} from './application/index.js';
import { sha256Fingerprinter } from './infrastructure/hashing/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresRentReconciliationRepository,
  PostgresSecurityDepositRepository,
  PostgresTaxClassificationRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { codes, type Json as View } from './phase-8-acceptance.test-support.js';
import { mrePrincipalVerifier, mreRentTermLookup, mreTenantDepositReader } from './wiring.js';

/**
 * VC-X-51 end to end (api-design.md §58J "Tests the implementation needs"; Entscheidung des Projektinhabers, 2026-11-03,
 * §58J Frage 4: its own e2e test, ACC7 and ACC8 unchanged), wired as in main.ts, synthetic values only. §58J's example
 * through the HTTP API: T's rent on P1 and on P2 (a booking error), so D is SEVERAL_PROPERTY_REFERENCES; D closed on
 * 2027-12-20 (300.00), classified, reopened and closed anew on 2028-01-10 (250.00). 2028 lists D in P1's and P2's
 * `notAttributed` (not P3's) with NOT_COUNTED (CLOSING_CHANGED) open and UNATTRIBUTED_ITEMS, not final, figures unchanged;
 * classified anew NOT_COUNTED goes; Realm isolation and no cash mutated around the views.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM_A = '64b0c0ffee0000000000e51a';
const REALM_B = '64b0c0ffee0000000000e51b';
const T = '6512f0c2a1b2c3d4e5f6e51a';

describe.skipIf(databaseUrl === undefined)('an unattributed deposit closed anew since its classification (VC-X-51) end to end', () => {
  const schema = testSchemaName('tax_year_unattributed_deposit_e2e');
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
      {
        _id: REALM_A,
        name: 'A',
        members: member,
        applications: [],
        tenants: [{ _id: T, name: 'Mieterin T (synthetisch)', guaranty: 900 }],
        rents: { [T]: [2027030100, 2027040100] },
      },
      { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const transactions = new PostgresTransactionRepository(db);
    const reconciliations = new PostgresRentReconciliationRepository(db);
    const deposits = new PostgresSecurityDepositRepository(db);
    const classifications = new PostgresTaxClassificationRepository(db);
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
        },
        rentReconciliations: {
          create: createReconciliation({ repository: reconciliations, lookupMreRentTerm: mreRentTermLookup(client) }),
          release: releaseReconciliation({ repository: reconciliations }),
        },
        securityDeposits: {
          create: createDeposit({ repository: deposits, readMreTenant: mreTenantDepositReader(client) }),
          close: closeDeposit({ repository: deposits }),
          reopen: reopenDeposit({ repository: deposits }),
        },
        taxation: {
          create: createTaxClassification({ repository: classifications }),
          taxMeaning: getTaxMeaning({ repository: classifications }),
          depositTaxMeaning: getDepositTaxMeaning({ repository: classifications }),
          taxYear: getTaxYearView({ repository: classifications, fingerprinter: sha256Fingerprinter }),
        },
      }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.end();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 600);
  const call = (realm: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
  const json = async <X>(res: Response, status: number): Promise<X> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as X;
  };
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  let counter = 0;
  let giro = '';
  const at = (id: string, iso: string) => pool.query(`UPDATE audit_record SET occurred_at = $2 WHERE id = $1`, [id, iso]);
  /** The record of the action not yet re-timed (a time set here may lie after a record written now). */
  const timed = new Set<string>();
  const recordOf = async (entityId: string, action: string) => {
    const { rows } = await pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2`, [entityId, action]);
    const id = rows.map((r) => r.id as string).find((r) => !timed.has(r)) as string;
    timed.add(id);
    return id;
  };

  async function property(realm = REALM_A) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f9f510n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function booked(direction: 'INFLOW' | 'OUTFLOW', bookingDate: string, splits: Record<string, unknown>[]) {
    if (giro === '')
      giro = (
        await json<{ financialAccountId: string }>(await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }), 201)
      ).financialAccountId;
    const total = splits.reduce((s: number, x) => s + Number((x['amount'] as { amount: string }).amount), 0).toFixed(2);
    const { transactionId } = await json<{ transactionId: string }>(
      await A('POST', '/transactions', { financialAccountId: giro, amount: eur(total), direction, bookingDate }),
      201,
    );
    const set = await json<{ splits: { splitId: string }[] }>(await A('PUT', `/transactions/${transactionId}/splits`, { splits }), 200);
    await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
    return { transactionId, splitId: set.splits[0]?.splitId as string };
  }
  async function matched(transactionId: string, tenant: string, term: string, amount: string, recordedAt: string) {
    const { reconciliationId } = await json<{ reconciliationId: string }>(
      await A('POST', '/rent-reconciliations', { transactionId, mreTenantId: tenant, mreRentTerm: term, matchedAmount: eur(amount) }),
      201,
    );
    await at(await recordOf(reconciliationId, 'CONFIRMED'), recordedAt);
    return reconciliationId;
  }
  const lineOf = (v: View, category: string): View =>
    [...v.einnahmen.lines, ...v.werbungskosten.lines].find((l: View) => l.taxCategory === category) ?? { items: [], total: eur('0.00') };
  const view = async (pr: string, year: number) => json<View>(await A('GET', `/property-references/${pr}/tax-years/${year}`), 200);
  const level = (v: View, code: string) => [v.review.open.some((o: View) => o.code === code), v.review.info.some((o: View) => o.code === code)];
  const CASH = ['ledger_transaction', 'transaction_split', 'tax_classification', 'security_deposit', 'rent_payment_reconciliation'];

  const openCodes = (v: View) => (v.review.open as View[]).map((o) => o.code as string).sort();
  /** Every figure of a view: the sections with their lines, the result, the owners and NOT_OWNED. */
  const money = (v: View) => [v.einnahmen, v.werbungskosten, v.result, v.owners, v.notOwned];

  it('the example of §58J: D listed in P1 s and P2 s 2028 (not P3 s) not final, NOT_COUNTED open until classified anew, UNATTRIBUTED_ITEMS after it; figures unchanged', async () => {
    const [P1, P2, P3] = [await property(), await property(), await property()];
    // T's rent on P1 and on P2 (a booking error never corrected): D has two candidates.
    const onP1 = await booked('INFLOW', '2027-03-01', [{ amount: eur('900.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: P1 }]);
    await matched(onP1.transactionId, T, '2027030100', '900.00', '2027-03-05T10:00:00Z');
    const onP2 = await booked('INFLOW', '2027-04-01', [{ amount: eur('900.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: P2 }]);
    await matched(onP2.transactionId, T, '2027040100', '900.00', '2027-04-05T10:00:00Z');
    const D = (await json<{ securityDepositId: string }>(await A('POST', '/security-deposits', { mreTenantId: T }), 201)).securityDepositId;
    await booked('INFLOW', '2026-01-05', [{ amount: eur('900.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: D }]);
    await booked('OUTFLOW', '2027-12-15', [{ amount: eur('600.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: D }]);
    const close = async (closingDate: string, recordedAt: string) => {
      await json(await A('POST', `/security-deposits/${D}/close`, { closingDate, reason: 'RETAINED', closingNote: 'Schaden (synthetisch)' }), 200);
      await at(await recordOf(D, 'CLOSED'), recordedAt);
    };
    await close('2027-12-20', '2027-12-20T10:00:00Z');
    const first = await json<{ classificationId: string }>(
      await A('POST', '/tax-classifications', { sourceType: 'DEPOSIT_CLOSING', sourceId: D, taxCategory: 'RETAINED_DEPOSIT_DAMAGES', treatment: 'INCOME' }),
      201,
    );
    // 2027 before anything else: D in P1's and P2's notAttributed, never summed.
    for (const pr of [P1, P2])
      expect(
        (await view(pr, 2027)).notAttributed.items.map((i: View) => i.sourceId),
        pr,
      ).toEqual([D]);
    expect((await view(P3, 2027)).notAttributed.items).toEqual([]);
    // Reopened on 2028-02-12; the 50.00 of 2028-01-10 linked; closed anew on 2028-02-14 with 2028-01-10 (250.00).
    expect(await json(await A('POST', `/security-deposits/${D}/reopen`, {}), 200)).toMatchObject({ status: 'ACTIVE' });
    await at(await recordOf(D, 'REOPENED'), '2028-02-12T10:00:00Z');
    await booked('OUTFLOW', '2028-01-10', [{ amount: eur('50.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: D }]);
    await close('2028-01-10', '2028-02-14T10:00:00Z');
    const meaning = await json<View>(await A('GET', `/security-deposits/${D}/tax-meaning`), 200);
    expect([meaning.counts, meaning.taxYear, meaning.classificationId, codes(meaning.flags)]).toEqual([
      false,
      2028,
      first.classificationId,
      ['NOT_COUNTED', 'NO_PROPERTY_REFERENCE'],
    ]);
    const theirs = await property(REALM_B);
    const untouched = await rowsSnapshot(pool);
    for (const pr of [P1, P2]) {
      const v = await view(pr, 2028);
      expect(
        v.notAttributed.items.map((i: View) => [i.sourceId, i.amount, i.lineAmount, i.share, i.taxCategory, i.reviewState, i.classificationId, codes(i.flags)]),
        pr,
      ).toEqual([
        [D, eur('250.00'), null, null, 'RETAINED_DEPOSIT_DAMAGES', 'USER_CONFIRMED', first.classificationId, ['NOT_COUNTED', 'NO_PROPERTY_REFERENCE']],
      ]);
      expect(v.notAttributed.items[0].flags[0], pr).toEqual({
        code: 'NOT_COUNTED',
        details: { depositStatus: 'CLOSED', retainedAmount: eur('250.00'), reason: 'CLOSING_CHANGED' },
      });
      const { reason, candidates, href } = v.notAttributed.items[0];
      expect({ reason, candidates, href }, pr).toEqual({
        reason: 'SEVERAL_PROPERTY_REFERENCES',
        candidates: [P1, P2].sort(),
        href: `/api/v1/security-deposits/${D}/tax-meaning`,
      });
      expect([v.flags.find((f: View) => f.code === 'UNATTRIBUTED_ITEMS')?.details, openCodes(v), v.review.final], pr).toEqual([
        { count: 1 },
        ['NOT_COUNTED', 'UNATTRIBUTED_ITEMS'],
        false,
      ]);
      expect([v.einnahmen.total, lineOf(v, 'RETAINED_DEPOSIT_DAMAGES').total, v.unclassified.items], pr).toEqual([eur('0.00'), eur('0.00'), []]);
    }
    const p3 = await view(P3, 2028);
    expect([p3.notAttributed.items, codes(p3.flags), p3.review.open]).toEqual([[], [], []]);
    // 2027 after the reopen: D in no list of 2027.
    for (const pr of [P1, P2, P3]) expect((await view(pr, 2027)).notAttributed.items, pr).toEqual([]);
    // Realm isolation: the other Realm sees no view of P1; its own PropertyReference lists nothing of D.
    expect((await call(REALM_B, 'GET', `/property-references/${P1}/tax-years/2028`)).status).toBe(404);
    expect((await json<View>(await call(REALM_B, 'GET', `/property-references/${theirs}/tax-years/2028`), 200)).notAttributed.items).toEqual([]);
    expect(await rowsSnapshot(pool)).toEqual(untouched);

    // Classified anew (superseding the old one): NOT_COUNTED goes, UNATTRIBUTED_ITEMS stays; P1 and P2 only; figures unchanged.
    const before = await Promise.all([P1, P2].map(async (pr) => money(await view(pr, 2028))));
    const next = await json<{ classificationId: string }>(
      await A('POST', '/tax-classifications', {
        sourceType: 'DEPOSIT_CLOSING',
        sourceId: D,
        taxCategory: 'RETAINED_DEPOSIT_DAMAGES',
        treatment: 'INCOME',
        supersedes: first.classificationId,
      }),
      201,
    );
    const classified = await rowsSnapshot(pool);
    for (const [n, pr] of [P1, P2].entries()) {
      const v = await view(pr, 2028);
      expect([v.notAttributed.items.map((i: View) => [i.sourceId, i.classificationId, codes(i.flags)]), openCodes(v), level(v, 'NOT_COUNTED')], pr).toEqual([
        [[D, next.classificationId, ['NO_PROPERTY_REFERENCE']]],
        ['UNATTRIBUTED_ITEMS'],
        [false, false],
      ]);
      expect(money(v), pr).toEqual(before[n]);
    }
    expect((await view(P3, 2028)).notAttributed.items).toEqual([]);
    const after = await rowsSnapshot(pool);
    for (const table of CASH) expect(after[table], table).toEqual(classified[table]);
    expect(after).toEqual(classified);
  });
});

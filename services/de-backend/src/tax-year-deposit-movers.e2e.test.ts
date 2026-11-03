import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  acknowledgeAttributionChange,
  closeDeposit,
  confirmTransaction,
  correctTransaction,
  createDeposit,
  createFinancialAccount,
  createManualTransaction,
  createReconciliation,
  createTaxClassification,
  getTaxMeaning,
  getTaxYearView,
  listAcknowledgements,
  releaseReconciliation,
  reopenDeposit,
  reverseTransaction,
  setTransactionSplits,
  withdrawAcknowledgement,
} from './application/index.js';
import { sha256Fingerprinter } from './infrastructure/hashing/index.js';
import {
  PostgresCorrectionRepository,
  PostgresFinancialAccountRepository,
  PostgresRentReconciliationRepository,
  PostgresSecurityDepositRepository,
  PostgresTaxClassificationRepository,
  PostgresTaxStatementRepository,
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
 * VC-X-50 end to end (api-design.md §58I "Tests the implementation needs"; Entscheidung des Projektinhabers, 2026-11-03,
 * §58I Frage 7: its own e2e test, ACC7 and ACC8 unchanged), wired as in main.ts, synthetic values only. Every AuditRecord
 * time that matters is set explicitly (the settable clock of the history). §58I's two examples through the HTTP API: D
 * reopened on 2028-02-12 and closed again on 2028-02-14 (2027 flagged and acknowledged, the CLOSED record refused in
 * 2027 with CHANGE_NOT_FLAGGED, 2028 open through NOT_COUNTED until D is classified anew); X corrected from P1 to P2 on
 * 2028-03-02 (both views flagged and acknowledged); Realm isolation and no cash mutated around them.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM_A = '64b0c0ffee0000000000e50a';
const REALM_B = '64b0c0ffee0000000000e50b';
const T = '6512f0c2a1b2c3d4e5f6e50a';
const U = '6512f0c2a1b2c3d4e5f6e50b';

type Entry = { kind: string; auditRecordId: string; items: View[]; changeFingerprint: string; acknowledgement: unknown } & Record<string, unknown>;

describe.skipIf(databaseUrl === undefined)('the deposit s other movers (VC-X-50) end to end', () => {
  const schema = testSchemaName('tax_year_deposit_movers_e2e');
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
        tenants: [
          { _id: T, name: 'Mieterin T (synthetisch)', guaranty: 900 },
          { _id: U, name: 'Mieter U (synthetisch)', guaranty: 900 },
        ],
        rents: { [T]: [2027030100], [U]: [2027110100] },
      },
      { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const transactions = new PostgresTransactionRepository(db);
    const reconciliations = new PostgresRentReconciliationRepository(db);
    const deposits = new PostgresSecurityDepositRepository(db);
    const classifications = new PostgresTaxClassificationRepository(db);
    const statements = new PostgresTaxStatementRepository(db);
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
          correct: correctTransaction({ repository: new PostgresCorrectionRepository(db) }),
          reverse: reverseTransaction({ repository: new PostgresCorrectionRepository(db) }),
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
          taxYear: getTaxYearView({ repository: classifications, fingerprinter: sha256Fingerprinter }),
        },
        taxStatements: {
          acknowledge: acknowledgeAttributionChange({ repository: statements, fingerprinter: sha256Fingerprinter }),
          listAcknowledgements: listAcknowledgements({ repository: statements }),
          withdrawAcknowledgement: withdrawAcknowledgement({ repository: statements }),
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
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f9f000n + BigInt(++counter)).toString(16).padStart(24, '0');
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
  const changes = (v: View, code: string) => (v.flags.find((f: View) => f.code === code)?.details ?? []) as Entry[];
  const level = (v: View, code: string) => [v.review.open.some((o: View) => o.code === code), v.review.info.some((o: View) => o.code === code)];
  const ackPath = (pr: string, year: number) => `/property-references/${pr}/tax-years/${year}/acknowledgements`;
  const acknowledge = (pr: string, year: number, entry: Pick<Entry, 'auditRecordId' | 'changeFingerprint'>, kind?: string, realm = REALM_A) =>
    call(realm, 'POST', ackPath(pr, year), {
      auditRecordId: entry.auditRecordId,
      ...(kind === undefined ? {} : { kind }),
      expectedFingerprint: entry.changeFingerprint,
      reason: 'Erklärung noch nicht abgegeben (synthetisch)',
    });
  const details = async (res: Response, status: number) => (await json<{ error: { details: unknown } }>(res, status)).error.details;
  const CASH = ['ledger_transaction', 'transaction_split', 'tax_classification', 'security_deposit', 'rent_payment_reconciliation'];

  it('example (a): D reopened on 2028-02-12 and closed again on 2028-02-14 (250.00 in 2028); 2027 flagged and acknowledged, the CLOSED record refused in 2027; 2028 open through NOT_COUNTED', async () => {
    const P1 = await property();
    const rent = await booked('INFLOW', '2027-03-01', [{ amount: eur('900.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: P1 }]);
    await matched(rent.transactionId, T, '2027030100', '900.00', '2027-03-05T10:00:00Z');
    const D = (await json<{ securityDepositId: string }>(await A('POST', '/security-deposits', { mreTenantId: T }), 201)).securityDepositId;
    await booked('INFLOW', '2026-01-05', [{ amount: eur('900.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: D }]);
    await booked('OUTFLOW', '2027-12-15', [{ amount: eur('600.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: D }]);
    const close = async (closingDate: string, recordedAt: string) => {
      await json(await A('POST', `/security-deposits/${D}/close`, { closingDate, reason: 'RETAINED', closingNote: 'Schaden (synthetisch)' }), 200);
      const record = await recordOf(D, 'CLOSED');
      await at(record, recordedAt);
      return record;
    };
    await close('2027-12-20', '2027-12-20T10:00:00Z');
    const first = await json<{ classificationId: string }>(
      await A('POST', '/tax-classifications', { sourceType: 'DEPOSIT_CLOSING', sourceId: D, taxCategory: 'RETAINED_DEPOSIT_DAMAGES', treatment: 'INCOME' }),
      201,
    );
    const b27 = await view(P1, 2027);
    expect([lineOf(b27, 'RETAINED_DEPOSIT_DAMAGES').total, changes(b27, 'ATTRIBUTION_INPUT_CHANGED')]).toEqual([eur('300.00'), []]);

    // 2028-02-12: reopened; the 50.00 of 2028-01-10 linked; closed again on 2028-02-14 with 2028-01-10.
    expect(await json(await A('POST', `/security-deposits/${D}/reopen`, {}), 200)).toMatchObject({ status: 'ACTIVE' });
    const reopened = await recordOf(D, 'REOPENED');
    await at(reopened, '2028-02-12T10:00:00Z');
    await booked('OUTFLOW', '2028-01-10', [{ amount: eur('50.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: D }]);
    const closed = await close('2028-01-10', '2028-02-14T10:00:00Z');
    const untouched = await rowsSnapshot(pool);
    const [v27, v28] = [await view(P1, 2027), await view(P1, 2028)];
    expect([lineOf(v27, 'RETAINED_DEPOSIT_DAMAGES').total, lineOf(v28, 'RETAINED_DEPOSIT_DAMAGES').total]).toEqual([eur('0.00'), eur('0.00')]);
    expect(changes(v27, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([
      expect.objectContaining({
        kind: 'DEPOSIT_REOPENED',
        entityType: 'SecurityDeposit',
        entityId: D,
        securityDepositId: D,
        mreTenantId: T,
        closingDate: '2027-12-20',
        reason: 'RETAINED',
        auditRecordId: reopened,
        amendedAt: '2028-02-12T10:00:00.000Z',
        items: [{ sourceId: D, yearBefore: 2027, yearAfter: null }],
        acknowledgement: null,
      }),
    ]);
    expect(level(v27, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([true, false]);
    // 2028: the CLOSED record was made during 2028; D is in unclassified with NOT_COUNTED (CLOSING_CHANGED), open (§58I Frage 4).
    expect([changes(v28, 'ATTRIBUTION_INPUT_CHANGED'), v28.unclassified.items.map((i: View) => [i.sourceId, codes(i.flags)])]).toEqual([
      [],
      [[D, expect.arrayContaining(['NOT_COUNTED'])]],
    ]);
    expect([level(v28, 'NOT_COUNTED'), v28.review.final]).toEqual([[true, false], false]);
    const entry = changes(v27, 'ATTRIBUTION_INPUT_CHANGED')[0] as Entry;
    expect(await details(await acknowledge(P1, 2027, { auditRecordId: closed, changeFingerprint: entry.changeFingerprint }), 409)).toEqual({
      reason: 'CHANGE_NOT_FLAGGED',
      auditRecordId: closed,
      year: 2027,
    });
    const ack = await json<{ acknowledgementId: string; change: View }>(await acknowledge(P1, 2027, entry, 'DEPOSIT_REOPENED'), 201);
    expect(ack.change).toMatchObject({
      kind: 'DEPOSIT_REOPENED',
      entityType: 'SecurityDeposit',
      entityId: D,
      items: [{ sourceId: D, yearBefore: 2027, yearAfter: null }],
    });
    const a27 = await view(P1, 2027);
    expect([level(a27, 'ATTRIBUTION_INPUT_CHANGED'), lineOf(a27, 'RETAINED_DEPOSIT_DAMAGES').total]).toEqual([[false, true], eur('0.00')]);
    // Realm isolation: B sees neither the view nor the acknowledgement; its own PropertyReference refuses D's record.
    expect((await call(REALM_B, 'GET', ackPath(P1, 2027))).status).toBe(404);
    expect((await acknowledge(await property(REALM_B), 2027, entry, undefined, REALM_B)).status).toBe(409);
    // No cash mutated by the acknowledgement and the views.
    const after = await rowsSnapshot(pool);
    for (const table of CASH) expect(after[table], table).toEqual(untouched[table]);
    // D classified anew (superseding the old one): 250.00 in 2028's line, NOT_COUNTED gone.
    await json(
      await A('POST', '/tax-classifications', {
        sourceType: 'DEPOSIT_CLOSING',
        sourceId: D,
        taxCategory: 'RETAINED_DEPOSIT_DAMAGES',
        treatment: 'INCOME',
        supersedes: first.classificationId,
      }),
      201,
    );
    const n28 = await view(P1, 2028);
    expect([lineOf(n28, 'RETAINED_DEPOSIT_DAMAGES').total, level(n28, 'NOT_COUNTED')]).toEqual([eur('250.00'), [false, false]]);
    const viewsOnly = await rowsSnapshot(pool);
    for (const year of [2027, 2028]) await view(P1, year);
    expect(await rowsSnapshot(pool)).toEqual(viewsOnly);
  });

  it('example (b): X corrected on 2028-03-02 from P1 to P2 (released before, Y matched after); both views flagged with their split and acknowledged', async () => {
    const [P1, P2] = [await property(), await property()];
    const x = await booked('INFLOW', '2027-11-03', [{ amount: eur('950.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: P1 }]);
    const reconciliation = await matched(x.transactionId, U, '2027110100', '950.00', '2027-11-05T10:00:00Z');
    await json(
      await A('POST', '/tax-classifications', { sourceType: 'TRANSACTION_SPLIT', sourceId: x.splitId, taxCategory: 'RENT', treatment: 'INCOME' }),
      201,
    );
    expect([lineOf(await view(P1, 2027), 'RENT').total, lineOf(await view(P2, 2027), 'RENT').total]).toEqual([eur('950.00'), eur('0.00')]);
    // A reconciled rent split cannot be corrected (TRANSACTION_RENT_RECONCILED): released first.
    expect((await A('POST', `/transactions/${x.transactionId}/correct`, { reason: 'Falsches Objekt (synthetisch)', replacement: {} })).status).toBe(409);
    await json(await A('POST', `/rent-reconciliations/${reconciliation}/release`, { reason: 'Falsches Objekt (synthetisch)' }), 200);
    await at(await recordOf(reconciliation, 'RELEASED'), '2028-03-02T09:00:00Z');
    const corrected = await json<{ reversal: View; replacement: View }>(
      await A('POST', `/transactions/${x.transactionId}/correct`, {
        reason: 'Buchung auf falsches Objekt (synthetisch)',
        replacement: { splits: [{ amount: eur('950.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: P2 }] },
      }),
      201,
    );
    const record = await recordOf(x.transactionId, 'CORRECTED');
    await at(record, '2028-03-02T10:00:00Z');
    const Y = corrected.replacement.transactionId as string;
    await matched(Y, U, '2027110100', '950.00', '2028-03-02T11:00:00Z');
    const S2 = (await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1`, [Y])).rows[0].id as string;
    const untouched = await rowsSnapshot(pool);
    const [v1, v2] = [await view(P1, 2027), await view(P2, 2027)];
    expect([lineOf(v1, 'RENT').total, lineOf(v2, 'RENT').total]).toEqual([eur('0.00'), eur('950.00')]);
    const keys = {
      kind: 'TRANSACTION_CORRECTED',
      entityType: 'Transaction',
      entityId: x.transactionId,
      transactionId: x.transactionId,
      reversalTransactionId: corrected.reversal.transactionId,
      replacementTransactionId: Y,
      reason: 'Buchung auf falsches Objekt (synthetisch)',
      auditRecordId: record,
      amendedAt: '2028-03-02T10:00:00.000Z',
      acknowledgement: null,
    };
    expect(changes(v1, 'PROPERTY_PART_CHANGED')).toEqual([
      expect.objectContaining({
        ...keys,
        items: [
          {
            sourceType: 'TRANSACTION_SPLIT',
            sourceId: x.splitId,
            taxYear: 2027,
            stateBefore: 'ATTRIBUTED',
            partBefore: eur('950.00'),
            stateAfter: 'NONE',
            partAfter: null,
          },
        ],
      }),
    ]);
    expect(changes(v2, 'PROPERTY_PART_CHANGED')).toEqual([
      expect.objectContaining({
        ...keys,
        items: [
          {
            sourceType: 'TRANSACTION_SPLIT',
            sourceId: S2,
            taxYear: 2027,
            stateBefore: 'NONE',
            partBefore: null,
            stateAfter: 'ATTRIBUTED',
            partAfter: eur('950.00'),
          },
        ],
      }),
    ]);
    // Release and match move no year (a November booking); S2 carries the item flag and P7-D2's flag.
    for (const v of [v1, v2]) expect(codes(v.flags)).not.toContain('ATTRIBUTION_INPUT_CHANGED');
    expect(codes(lineOf(v2, 'RENT').items[0].flags)).toEqual(expect.arrayContaining(['PROPERTY_PART_CHANGED', 'CLASSIFICATION_ON_CORRECTED_SPLIT']));
    expect([level(v1, 'PROPERTY_PART_CHANGED'), level(v2, 'PROPERTY_PART_CHANGED')]).toEqual([
      [true, false],
      [true, false],
    ]);
    // Acknowledged in both views (P2 with its kind); the figures unchanged.
    await json(await acknowledge(P1, 2027, changes(v1, 'PROPERTY_PART_CHANGED')[0] as Entry), 201);
    const second = await json<{ change: View }>(await acknowledge(P2, 2027, changes(v2, 'PROPERTY_PART_CHANGED')[0] as Entry, 'TRANSACTION_CORRECTED'), 201);
    expect(second.change).toMatchObject({
      kind: 'TRANSACTION_CORRECTED',
      entityType: 'Transaction',
      items: [{ sourceType: 'TRANSACTION_SPLIT', sourceId: S2 }],
    });
    const [a1, a2] = [await view(P1, 2027), await view(P2, 2027)];
    expect([level(a1, 'PROPERTY_PART_CHANGED'), level(a2, 'PROPERTY_PART_CHANGED'), lineOf(a1, 'RENT').total, lineOf(a2, 'RENT').total]).toEqual([
      [false, true],
      [false, true],
      eur('0.00'),
      eur('950.00'),
    ]);
    // A CHANGE_NOT_FLAGGED in another year; Realm isolation; no cash mutated.
    expect(await details(await acknowledge(P1, 2028, changes(v1, 'PROPERTY_PART_CHANGED')[0] as Entry), 409)).toEqual({
      reason: 'CHANGE_NOT_FLAGGED',
      auditRecordId: record,
      year: 2028,
    });
    expect((await call(REALM_B, 'GET', `/property-references/${P2}/tax-years/2027`)).status).toBe(404);
    const after = await rowsSnapshot(pool);
    for (const table of CASH) expect(after[table], table).toEqual(untouched[table]);
  });
});

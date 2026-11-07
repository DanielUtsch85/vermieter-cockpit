import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  acknowledgeAttributionChange,
  confirmAllocationSet,
  confirmTransaction,
  createFinancialAccount,
  createLoan,
  createLoanAllocation,
  createLoanTerms,
  createManualTransaction,
  createParty,
  getTaxYearView,
  listAcknowledgements,
  listConfirmations,
  setTransactionSplits,
  voidLoanAllocation,
  withdrawAcknowledgement,
  withdrawConfirmation,
} from './application/index.js';
import { sha256Fingerprinter } from './infrastructure/hashing/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresLoanAllocationRepository,
  PostgresLoanRepository,
  PostgresLoanTermsRepository,
  PostgresPartyRepository,
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
import { cents, codes, type Json as View } from './phase-8-acceptance.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';
import { stageAudit } from './infrastructure/postgres/audit-stage.test-support.js';

/**
 * VC-X-48 end to end (api-design.md §58G "Tests the implementation needs"; Entscheidung des Projektinhabers, 2026-11-03,
 * Frage 6: its own e2e test, ACC7 and ACC8 unchanged), wired as in main.ts, synthetic values only. Every AuditRecord
 * time that matters is set explicitly (the settable clock of the history). §58G's example through the HTTP API: L, its
 * terms, S1, the four debits, S2 appended on 2028-03-01, both views of 2027 and 2028 at both levels, the acknowledgement
 * in P1 with P2 still open, S2 voided on 2029-02-01, the second entries and 2028 flagged; Realm isolation and no cash
 * mutated around it.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM_A = '64b0c0ffee0000000000e48a';
const REALM_B = '64b0c0ffee0000000000e48b';

type Entry = { kind: string; auditRecordId: string; items: View[]; changeFingerprint: string; acknowledgement: unknown };

describe.skipIf(databaseUrl === undefined)('backdated allocation sets in the tax-year view (VC-X-48) end to end', () => {
  const schema = testSchemaName('tax_year_part_changes_e2e');
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
      { _id: REALM_A, name: 'A', members: member, applications: [], tenants: [] },
      { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const transactions = new PostgresTransactionRepository(db);
    const terms = new PostgresLoanTermsRepository(db);
    const allocations = new PostgresLoanAllocationRepository(db);
    const statements = new PostgresTaxStatementRepository(db);
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        parties: { create: createParty({ repository: new PostgresPartyRepository(db) }) },
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
        },
        loans: { create: createLoan({ repository: new PostgresLoanRepository(db) }) },
        loanTerms: { create: createLoanTerms({ repository: terms }) },
        loanAllocations: { create: createLoanAllocation({ repository: allocations }), void: voidLoanAllocation({ repository: allocations }) },
        taxation: { taxYear: getTaxYearView({ repository: new PostgresTaxClassificationRepository(db), fingerprinter: sha256Fingerprinter }) },
        taxStatements: {
          acknowledge: acknowledgeAttributionChange({ repository: statements, fingerprinter: sha256Fingerprinter }),
          listAcknowledgements: listAcknowledgements({ repository: statements }),
          withdrawAcknowledgement: withdrawAcknowledgement({ repository: statements }),
          confirm: confirmAllocationSet({ repository: statements }),
          listConfirmations: listConfirmations({ repository: statements }),
          withdrawConfirmation: withdrawConfirmation({ repository: statements }),
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
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  let counter = 0;
  let giro = '';
  const at = (id: string, iso: string) => stageAudit(pool, `UPDATE audit_record SET occurred_at = $2 WHERE id = $1`, [id, iso]);
  const recordOf = async (entityId: string, action: string) =>
    (await pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2`, [entityId, action])).rows[0].id as string;

  async function property(realm = REALM_A) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f8e000n + BigInt(++counter)).toString(16).padStart(24, '0');
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
    const total = splits.reduce((s: bigint, x) => s + (cents(x['amount'] as { amount: string; currency: string }) ?? 0n), 0n);
    const amount = eur(`${total / 100n}.${String(total % 100n).padStart(2, '0')}`);
    const { transactionId } = await json<{ transactionId: string }>(
      await A('POST', '/transactions', { financialAccountId: giro, amount, direction, bookingDate }),
      201,
    );
    const set = await json<{ splits: { splitId: string }[] }>(await A('PUT', `/transactions/${transactionId}/splits`, { splits }), 200);
    await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
    return { transactionId, splitId: set.splits[0]?.splitId as string };
  }
  const party = async (displayName: string, partyType = 'PERSON') =>
    (await json<{ partyId: string }>(await A('POST', '/parties', { partyType, displayName }), 201)).partyId;
  async function loan(startDate: string) {
    const lender = await party('Bank Beispiel (synthetisch)', 'ORGANIZATION');
    const borrower = await party('Anna Darlehen (synthetisch)');
    return (
      await json<{ loanId: string }>(
        await A('POST', '/loans', { lenderPartyId: lender, borrowerPartyIds: [borrower], principalOriginal: eur('100000.00'), startDate }),
        201,
      )
    ).loanId;
  }
  /** A cash line of either section by its `taxCategory`; an empty line when the view has none. */
  const lineOf = (v: View, category: string): View =>
    [...v.einnahmen.lines, ...v.werbungskosten.lines].find((l: View) => l.taxCategory === category) ?? { items: [], total: eur('0.00') };
  const view = async (pr: string, year: number) => json<View>(await A('GET', `/property-references/${pr}/tax-years/${year}`), 200);
  const changes = (v: View) => (v.flags.find((f: View) => f.code === 'PROPERTY_PART_CHANGED')?.details ?? []) as Entry[];
  const level = (v: View, code: string) => [v.review.open.some((o: View) => o.code === code), v.review.info.some((o: View) => o.code === code)];
  const ackPath = (pr: string, year: number) => `/property-references/${pr}/tax-years/${year}/acknowledgements`;
  const acknowledge = (
    pr: string,
    year: number,
    entry: Pick<Entry, 'auditRecordId' | 'changeFingerprint'>,
    reason = 'Erklärung noch nicht abgegeben (synthetisch)',
    kind?: string,
  ) =>
    A('POST', ackPath(pr, year), {
      auditRecordId: entry.auditRecordId,
      ...(kind === undefined ? {} : { kind }),
      expectedFingerprint: entry.changeFingerprint,
      reason,
    });

  const money = (amount: string) => ({ amount, currency: 'EUR' });
  /** The open codes other than the part flag (no Ownership and an unconfirmed 10-day item stay open throughout). */
  const others = (v: View) => v.review.open.map((o: View) => o.code).filter((c: string) => c !== 'PROPERTY_PART_CHANGED');

  it('the example of §58G: S2 appended on 2028-03-01 moves 2027 (808.80 to 719.01, 539.20 to 628.99), acknowledged per view; voided on 2029-02-01 it flags both years', async () => {
    const [a, b] = [await property(), await property()];
    const [P1, P2] = a < b ? [a, b] : [b, a];
    const L = await loan('2027-01-01');
    const { termsId } = await json<{ termsId: string }>(
      await A('POST', `/loans/${L}/terms`, { validFrom: '2027-01-01', interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-31' }),
      201,
    );
    await at(await recordOf(termsId, 'CREATED'), '2026-12-01T10:00:00Z');
    const set = async (validFrom: string, shares: [string, string][], recordedAt: string) => {
      const created = await json<{ allocationSetId: string }>(
        await A('POST', `/loans/${L}/allocations`, {
          validFrom,
          basis: 'MANUAL',
          allocations: shares.map(([propertyReferenceId, share]) => ({ propertyReferenceId, share })),
        }),
        201,
      );
      const auditRecordId = await recordOf(created.allocationSetId, 'CREATED');
      await at(auditRecordId, recordedAt);
      return { setId: created.allocationSetId, auditRecordId };
    };
    await set(
      '2027-02-01',
      [
        [P1, '3/5'],
        [P2, '2/5'],
      ],
      '2027-02-01T10:00:00Z',
    );
    const debit = async (amount: string, bookingDate: string) =>
      (await booked('OUTFLOW', bookingDate, [{ amount: eur(amount), financialCategoryCode: 'LOAN_INTEREST', loanId: L }])).splitId;
    const [d1, d2, d3, d4] = [
      await debit('450.01', '2027-03-31'),
      await debit('449.99', '2027-07-30'),
      await debit('448.00', '2028-01-03'),
      await debit('446.00', '2028-06-30'),
    ];
    const [b1, b2] = [await view(P1, 2027), await view(P2, 2027)];
    expect([lineOf(b1, 'LOAN_INTEREST').total, lineOf(b2, 'LOAN_INTEREST').total]).toEqual([money('808.80'), money('539.20')]);
    // d3 (booked 2028-01-03, due 2027-12-31) counts in 2027 by the 10-day rule.
    expect(lineOf(b1, 'LOAN_INTEREST').items.map((i: View) => i.sourceId)).toEqual([d1, d2, d3]);
    expect(changes(b1)).toEqual([]);
    const baseline = { 2027: others(b1), 2028: others(await view(P1, 2028)) };
    expect(baseline[2027]).not.toContain('PROPERTY_PART_CHANGED');
    const untouched = await rowsSnapshot(pool);

    // Step 1: S2 from 2027-07-01 appended on 2028-03-01.
    const S2 = await set(
      '2027-07-01',
      [
        [P1, '1/2'],
        [P2, '1/2'],
      ],
      '2028-03-01T10:00:00Z',
    );
    const [v1, v2] = [await view(P1, 2027), await view(P2, 2027)];
    expect([lineOf(v1, 'LOAN_INTEREST').total, lineOf(v2, 'LOAN_INTEREST').total]).toEqual([money('719.01'), money('628.99')]);
    const sorted = <T extends { sourceId: string }>(x: T[]) => [...x].sort((p, q) => (p.sourceId < q.sourceId ? -1 : 1));
    const item = (sourceId: string, before: string, after: string) => ({
      sourceType: 'TRANSACTION_SPLIT',
      sourceId,
      taxYear: 2027,
      stateBefore: 'ATTRIBUTED',
      partBefore: money(before),
      stateAfter: 'ATTRIBUTED',
      partAfter: money(after),
    });
    expect(changes(v1)).toEqual([
      expect.objectContaining({
        kind: 'LOAN_ALLOCATION_SET_ADDED',
        entityType: 'LoanAllocationSet',
        entityId: S2.setId,
        loanId: L,
        allocationSetId: S2.setId,
        validFrom: '2027-07-01',
        auditRecordId: S2.auditRecordId,
        amendedAt: '2028-03-01T10:00:00.000Z',
        items: sorted([item(d2, '269.99', '225.00'), item(d3, '268.80', '224.00')]),
        acknowledgement: null,
      }),
    ]);
    expect(changes(v2)[0]?.items).toEqual(sorted([item(d2, '180.00', '224.99'), item(d3, '179.20', '224.00')]));
    for (const v of [v1, v2]) {
      expect([level(v, 'PROPERTY_PART_CHANGED'), others(v), v.flags.some((f: View) => f.code === 'ATTRIBUTION_INPUT_CHANGED')]).toEqual([
        [true, false],
        baseline[2027],
        false,
      ]);
      expect(lineOf(v, 'LOAN_INTEREST').items.map((i: View) => [i.sourceId, codes(i.flags).includes('PROPERTY_PART_CHANGED')])).toEqual([
        [d1, false],
        [d2, true],
        [d3, true],
      ]);
    }
    // 2028: the record lies in 2028; d4 under S2, not flagged.
    for (const pr of [P1, P2]) {
      const v = await view(pr, 2028);
      expect([changes(v), lineOf(v, 'LOAN_INTEREST').total, others(v)]).toEqual([[], money('223.00'), baseline[2028]]);
    }

    // The order of checks over HTTP: kind 400, CHANGE_NOT_FLAGGED in 2028 and with another kind, 412, 201 in P1.
    const entry = changes(v1)[0] as Entry;
    const invalid = await json<{ error: { details: { fields: unknown[] } } }>(await acknowledge(P1, 2027, entry, 'x', 'LOAN_ALLOCATION_CHANGED'), 400);
    expect(invalid.error.details.fields).toEqual([{ field: 'kind', code: 'INVALID_FORMAT' }]);
    expect((await json<{ error: { details: unknown } }>(await acknowledge(P1, 2028, entry), 409)).error.details).toEqual({
      reason: 'CHANGE_NOT_FLAGGED',
      auditRecordId: S2.auditRecordId,
      year: 2028,
    });
    expect((await json<{ error: { details: unknown } }>(await acknowledge(P1, 2027, entry, 'x', 'LOAN_ALLOCATION_SET_VOIDED'), 409)).error.details).toEqual({
      reason: 'CHANGE_NOT_FLAGGED',
      auditRecordId: S2.auditRecordId,
      year: 2027,
      kind: 'LOAN_ALLOCATION_SET_VOIDED',
    });
    expect((await json<{ error: { code: string } }>(await acknowledge(P1, 2027, { ...entry, changeFingerprint: 'a'.repeat(64) }), 412)).error.code).toBe(
      'ATTRIBUTION_CHANGE_DIFFERS',
    );
    const created = await acknowledge(
      P1,
      2027,
      entry,
      'Erklärung 2027 noch nicht abgegeben; Aufteilung ab Juli 50/50 nachgetragen (synthetisch)',
      'LOAN_ALLOCATION_SET_ADDED',
    );
    const ack = await json<{ acknowledgementId: string; change: View }>(created, 201);
    expect([created.headers.get('etag'), created.headers.get('location')]).toEqual(['"1"', `/api/v1${ackPath(P1, 2027)}/${ack.acknowledgementId}`]);
    expect(ack.change).toEqual({
      auditRecordId: S2.auditRecordId,
      kind: 'LOAN_ALLOCATION_SET_ADDED',
      entityType: 'LoanAllocationSet',
      entityId: S2.setId,
      recordedAt: '2028-03-01T10:00:00.000Z',
      fingerprint: entry.changeFingerprint,
      items: sorted([item(d2, '269.99', '225.00'), item(d3, '268.80', '224.00')]),
    });
    const [a1, a2] = [await view(P1, 2027), await view(P2, 2027)];
    expect([level(a1, 'PROPERTY_PART_CHANGED'), others(a1), lineOf(a1, 'LOAN_INTEREST').total]).toEqual([[false, true], baseline[2027], money('719.01')]);
    expect([level(a2, 'PROPERTY_PART_CHANGED'), others(a2)]).toEqual([[true, false], baseline[2027]]);
    const listed = await json<{ items: { change: View }[] }>(await A('GET', ackPath(P1, 2027)), 200);
    expect(listed.items.map((i) => i.change.items.length)).toEqual([2]);

    // Step 2: S2 voided on 2029-02-01: S1 covers everything again.
    await json(await A('POST', `/loans/${L}/allocations/${S2.setId}/void`, { reason: 'Aufteilung falsch nachgetragen (synthetisch)' }), 200);
    const voided = await recordOf(S2.setId, 'VOIDED');
    await at(voided, '2029-02-01T10:00:00Z');
    const [w1, w2] = [await view(P1, 2027), await view(P2, 2027)];
    expect(changes(w1).map((e) => [e.kind, e.acknowledgement === null])).toEqual([
      ['LOAN_ALLOCATION_SET_ADDED', false],
      ['LOAN_ALLOCATION_SET_VOIDED', true],
    ]);
    expect(changes(w1)[1]?.items).toEqual(sorted([item(d2, '225.00', '269.99'), item(d3, '224.00', '268.80')]));
    expect(changes(w2).map((e) => [e.kind, e.acknowledgement])).toEqual([
      ['LOAN_ALLOCATION_SET_ADDED', null],
      ['LOAN_ALLOCATION_SET_VOIDED', null],
    ]);
    expect([lineOf(w1, 'LOAN_INTEREST').total, lineOf(w2, 'LOAN_INTEREST').total]).toEqual([money('808.80'), money('539.20')]);
    expect([level(w1, 'PROPERTY_PART_CHANGED'), others(w1)]).toEqual([[true, false], baseline[2027]]);
    for (const [pr, before, after] of [
      [P1, '223.00', '267.60'],
      [P2, '223.00', '178.40'],
    ] as const) {
      const v = await view(pr, 2028);
      expect(changes(v).map((e) => [e.kind, e.auditRecordId, e.items])).toEqual([
        ['LOAN_ALLOCATION_SET_VOIDED', voided, [{ ...item(d4, before, after), taxYear: 2028 }]],
      ]);
      expect([level(v, 'PROPERTY_PART_CHANGED'), others(v), lineOf(v, 'LOAN_INTEREST').total]).toEqual([[true, false], baseline[2028], money(after)]);
    }
    // Acknowledged in P1's 2027 (without kind: the record is one change) and 2028: final again; P2 still open.
    await json(await acknowledge(P1, 2027, changes(w1)[1] as Entry), 201);
    await json(await acknowledge(P1, 2028, changes(await view(P1, 2028))[0] as Entry), 201);
    expect([
      level(await view(P1, 2027), 'PROPERTY_PART_CHANGED'),
      level(await view(P1, 2028), 'PROPERTY_PART_CHANGED'),
      level(await view(P2, 2028), 'PROPERTY_PART_CHANGED'),
    ]).toEqual([
      [false, true],
      [false, true],
      [true, false],
    ]);
    // Withdrawn: open again.
    const withdraw = `${ackPath(P1, 2027)}/${ack.acknowledgementId}/withdraw`;
    expect(await json(await A('POST', withdraw, { reason: 'Irrtum (synthetisch)' }, { 'if-match': '"1"' }), 200)).toMatchObject({
      status: 'WITHDRAWN',
      version: 2,
    });
    expect(level(await view(P1, 2027), 'PROPERTY_PART_CHANGED')).toEqual([true, false]);

    // Realm isolation: Realm B sees neither the views nor the acknowledgements; its own PropertyReference is not flagged.
    expect((await call(REALM_B, 'GET', ackPath(P1, 2027))).status).toBe(404);
    expect((await call(REALM_B, 'GET', `/property-references/${P1}/tax-years/2027`)).status).toBe(404);
    const foreign = await property(REALM_B);
    const refused = await call(REALM_B, 'POST', ackPath(foreign, 2027), {
      auditRecordId: S2.auditRecordId,
      expectedFingerprint: entry.changeFingerprint,
      reason: 'x',
    });
    expect(refused.status).toBe(409);
    expect(changes(await json<View>(await call(REALM_B, 'GET', `/property-references/${foreign}/tax-years/2027`), 200))).toEqual([]);

    // No cash mutated: the ledger and the classifications as before S2; the views write nothing.
    const after = await rowsSnapshot(pool);
    expect([after['ledger_transaction'], after['transaction_split'], after['tax_classification'], after['loan_terms']]).toEqual([
      untouched['ledger_transaction'],
      untouched['transaction_split'],
      untouched['tax_classification'],
      untouched['loan_terms'],
    ]);
    const viewsOnly = await rowsSnapshot(pool);
    for (const pr of [P1, P2]) for (const year of [2027, 2028]) await view(pr, year);
    expect(await rowsSnapshot(pool)).toEqual(viewsOnly);
  });
});

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  acknowledgeAttributionChange,
  closeLoan,
  confirmTransaction,
  createFinancialAccount,
  createLoan,
  createLoanAllocation,
  createLoanTerms,
  createManualTransaction,
  createOwnership,
  createParty,
  getTaxYearView,
  listAcknowledgements,
  setTransactionSplits,
  voidLoanTerms,
  withdrawAcknowledgement,
} from './application/index.js';
import { sha256Fingerprinter } from './infrastructure/hashing/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresLoanAllocationRepository,
  PostgresLoanRepository,
  PostgresLoanTermsRepository,
  PostgresOwnershipRepository,
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
import type { Json as View } from './phase-8-acceptance.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';
import { stageAudit } from './infrastructure/postgres/audit-stage.test-support.js';

/**
 * VC-X-54 end to end (api-design.md §58P "Tests the implementation needs"; Entscheidung des Projektinhabers, 2026-11-05,
 * §58P Frage 11: its own e2e test, ACC7 and ACC8 unchanged), wired as in main.ts, synthetic values only, every AuditRecord
 * time that matters set explicitly (the settable clock of the history). Example 1 through the HTTP API (Loan Q, the
 * sets, the four debits, r0, then r1 and r2 on 2028-02-10, both 2027 views at both levels, the acknowledgement in P1, P2
 * still open) and Example 2 (the closing on 2028-01-20); Realm isolation and no cash mutated around it.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM_A = '64b0c0ffee0000000000f54a';
const REALM_B = '64b0c0ffee0000000000f54b';

type Entry = { kind: string; entityType: string; auditRecordId: string; changeFingerprint: string; acknowledgement: unknown; items: View[] };

describe.skipIf(databaseUrl === undefined)('terms records and closings as part changes (VC-X-54) end to end', () => {
  const schema = testSchemaName('tax_year_loan_schedule_parts_e2e');
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
    const loans = new PostgresLoanRepository(db);
    const statements = new PostgresTaxStatementRepository(db);
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        parties: { create: createParty({ repository: new PostgresPartyRepository(db) }) },
        ownerships: { create: createOwnership({ repository: new PostgresOwnershipRepository(db) }) },
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
        },
        loans: { create: createLoan({ repository: loans }), close: closeLoan({ repository: loans }) },
        loanTerms: { create: createLoanTerms({ repository: terms }), void: voidLoanTerms({ repository: terms }) },
        loanAllocations: { create: createLoanAllocation({ repository: new PostgresLoanAllocationRepository(db) }) },
        taxation: { taxYear: getTaxYearView({ repository: new PostgresTaxClassificationRepository(db), fingerprinter: sha256Fingerprinter }) },
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
  const call = (realm: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T = View>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  const at = (id: string, iso: string) => stageAudit(pool, `UPDATE audit_record SET occurred_at = $2 WHERE id = $1`, [id, iso]);
  const recordOf = async (entityId: string, action: string) =>
    (await pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2`, [entityId, action])).rows[0].id as string;
  let counter = 0;

  /** One Realm's world: P1 < P2, A and B owning P1 half each (A < B), C owning P2, all from 2026-01-01; a Loan of 120 000.00 from 2027-01-01. */
  async function world(realm: string) {
    const R = (method: string, path: string, body?: unknown) => call(realm, method, path, body);
    const property = async () =>
      (
        await pool.query(
          `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
          [realm, (0x6512f0c2a1b2c3d4e5f9f700n + BigInt(++counter)).toString(16).padStart(24, '0')],
        )
      ).rows[0].id as string;
    const party = async (displayName: string, partyType = 'PERSON') =>
      (await json<{ partyId: string }>(await R('POST', '/parties', { partyType, displayName }), 201)).partyId;
    const [P1, P2] = [await property(), await property()].sort() as [string, string];
    const [a, b] = [await party('Eigentümerin A (synthetisch)'), await party('Eigentümer B (synthetisch)')].sort() as [string, string];
    const c = await party('Eigentümerin C (synthetisch)');
    for (const [pr, ownerPartyId, share] of [
      [P1, a, '1/2'],
      [P1, b, '1/2'],
      [P2, c, '1/1'],
    ] as const) {
      await json(await R('POST', '/ownerships', { propertyReferenceId: pr, ownerPartyId, share, validFrom: '2026-01-01' }), 201);
    }
    const giro = (
      await json<{ financialAccountId: string }>(await R('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }), 201)
    ).financialAccountId;
    const loanId = (
      await json<{ loanId: string }>(
        await R('POST', '/loans', {
          lenderPartyId: await party('Bank Beispiel (synthetisch)', 'ORGANIZATION'),
          borrowerPartyIds: [a, b, c],
          principalOriginal: eur('120000.00'),
          startDate: '2027-01-01',
        }),
        201,
      )
    ).loanId;
    const terms = async (body: Record<string, unknown>, recordedAt: string) => {
      const { termsId } = await json<{ termsId: string }>(
        await R('POST', `/loans/${loanId}/terms`, { validFrom: '2027-01-01', interestRate: '3.000', ...body }),
        201,
      );
      const record = await recordOf(termsId, 'CREATED');
      await at(record, recordedAt);
      return { termsId, record };
    };
    const sets = async (second: string) => {
      for (const [validFrom, allocations] of [
        ['2027-01-01', [{ propertyReferenceId: P1, share: '1/1' }]],
        [
          second,
          second === '2027-03-01'
            ? [P1, P2].map((propertyReferenceId) => ({ propertyReferenceId, share: '1/2' }))
            : [{ propertyReferenceId: P2, share: '1/1' }],
        ],
      ] as const) {
        const { allocationSetId } = await json<{ allocationSetId: string }>(
          await R('POST', `/loans/${loanId}/allocations`, { validFrom, basis: 'MANUAL', allocations }),
          201,
        );
        await at(await recordOf(allocationSetId, 'CREATED'), '2027-01-02T10:00:00Z');
      }
    };
    const pay = async (bookingDate: string, interest: string, principal?: string) => {
      const cents = Math.round(Number(interest) * 100) + Math.round(Number(principal ?? '0') * 100);
      const { transactionId } = await json<{ transactionId: string }>(
        await R('POST', '/transactions', { financialAccountId: giro, amount: eur((cents / 100).toFixed(2)), direction: 'OUTFLOW', bookingDate }),
        201,
      );
      const splits = [
        { amount: eur(interest), financialCategoryCode: 'LOAN_INTEREST', loanId },
        ...(principal === undefined ? [] : [{ amount: eur(principal), financialCategoryCode: 'LOAN_PRINCIPAL', loanId }]),
      ];
      const set = await json<{ splits: { splitId: string }[] }>(await R('PUT', `/transactions/${transactionId}/splits`, { splits }), 200);
      await json(await R('POST', `/transactions/${transactionId}/confirm`), 200);
      return set.splits[0]?.splitId as string;
    };
    const view = async (pr: string, year: number, ownerPartyId?: string) =>
      json(await R('GET', `/property-references/${pr}/tax-years/${year}${ownerPartyId === undefined ? '' : `?ownerPartyId=${ownerPartyId}`}`), 200);
    return { R, P1, P2, a, b, c, loanId, terms, sets, pay, view };
  }
  const line = (v: View) => v.werbungskosten.lines.find((l: View) => l.taxCategory === 'LOAN_INTEREST');
  const amounts = (v: View) => (line(v)?.items ?? []).map((i: View) => i.lineAmount?.amount);
  const entries = (v: View) => (v.flags.find((f: View) => f.code === 'PROPERTY_PART_CHANGED')?.details ?? []) as Entry[];
  const level = (v: View) => [
    v.review.open.some((o: View) => o.code === 'PROPERTY_PART_CHANGED'),
    v.review.info.some((o: View) => o.code === 'PROPERTY_PART_CHANGED'),
  ];
  const moved = (e: Entry | undefined) =>
    (e?.items ?? []).map((i: View) => [i.stateBefore, i.partBefore?.amount ?? null, i.stateAfter, i.partAfter?.amount ?? null]);

  it('Example 1: the interval entered on 2028-02-10 (void r1, re-entry r2) flags both 2027 views at both levels; acknowledged in P1, P2 still open; no cash mutated', async () => {
    const w = await world(REALM_A);
    const tm = await w.terms({ repaymentModel: 'ANNUITY', scheduledPayment: eur('1800.00'), firstPaymentDate: '2027-03-31' }, '2027-01-04T10:00:00Z');
    await w.sets('2027-03-01');
    const d1 = await w.pay('2027-03-31', '900.00', '900.00');
    await w.pay('2027-06-30', '893.25', '906.75');
    await w.pay('2027-09-30', '886.45', '913.55');
    await w.pay('2027-12-31', '879.60', '920.40');
    expect([amounts(await w.view(w.P1, 2027)), amounts(await w.view(w.P2, 2027))]).toEqual([
      ['450.00', '446.63', '443.23', '439.80'],
      ['450.00', '446.62', '443.22', '439.80'],
    ]);
    expect(entries(await w.view(w.P1, 2027))).toEqual([]);
    const cash = await rowsSnapshot(pool);
    await json(await w.R('POST', `/loans/${w.loanId}/terms/${tm.termsId}/void`, { reason: 'mit Intervall neu erfasst (synthetisch)' }), 200);
    await at(await recordOf(tm.termsId, 'VOIDED'), '2028-02-10T09:00:00Z');
    const tq = await w.terms(
      { repaymentModel: 'ANNUITY', scheduledPayment: eur('1800.00'), firstPaymentDate: '2027-03-31', paymentIntervalMonths: 3 },
      '2028-02-10T09:05:00Z',
    );
    const [v1, v2] = [await w.view(w.P1, 2027), await w.view(w.P2, 2027)];
    expect([amounts(v1), amounts(v2)]).toEqual([
      ['745.00', '446.63', '443.23', '439.80'],
      ['155.00', '446.62', '443.22', '439.80'],
    ]);
    expect([line(v1)?.total.amount, line(v2)?.total.amount]).toEqual(['2074.66', '1484.64']);
    for (const [v, after] of [
      [v1, '745.00'],
      [v2, '155.00'],
    ] as const) {
      expect(entries(v).map((e) => [e.kind, e.entityType, e.auditRecordId, e.acknowledgement])).toEqual([
        ['LOAN_TERMS_PART_ADDED', 'LoanTerms', tq.record, null],
      ]);
      expect(moved(entries(v)[0])).toEqual([['ATTRIBUTED', '450.00', 'ATTRIBUTED', after]]);
      expect(entries(v)[0]?.items[0]?.sourceId).toBe(d1);
      expect(level(v)).toEqual([true, false]);
      expect(v.flags.some((f: View) => f.code === 'ATTRIBUTION_INPUT_CHANGED')).toBe(false);
    }
    // The owners' level: A and B half of P1's part each, C all of P2's; the flag in each owner's view.
    for (const [pr, owner, first] of [
      [w.P1, w.a, '372.50'],
      [w.P1, w.b, '372.50'],
      [w.P2, w.c, '155.00'],
    ] as const) {
      const o = await w.view(pr, 2027, owner);
      expect(amounts(o)[0]).toBe(first);
      expect(entries(o).map((e) => e.kind)).toEqual(['LOAN_TERMS_PART_ADDED']);
    }
    // The acknowledgement in P1: without kind accepted (one change only), informative there; P2 still open.
    const entry = entries(v1)[0] as Entry;
    const created = await json(
      await w.R('POST', `/property-references/${w.P1}/tax-years/2027/acknowledgements`, {
        auditRecordId: entry.auditRecordId,
        expectedFingerprint: entry.changeFingerprint,
        reason: 'Erklärung noch nicht abgegeben (synthetisch)',
      }),
      201,
    );
    expect(created.change).toMatchObject({ kind: 'LOAN_TERMS_PART_ADDED', entityType: 'LoanTerms', entityId: tq.termsId, items: [{ sourceId: d1 }] });
    expect([level(await w.view(w.P1, 2027)), level(await w.view(w.P2, 2027))]).toEqual([
      [false, true],
      [true, false],
    ]);
    // An unknown kind: 400 INVALID_FORMAT; the void r1 moved nothing: 409 CHANGE_NOT_FLAGGED.
    const bad = await w.R('POST', `/property-references/${w.P2}/tax-years/2027/acknowledgements`, {
      auditRecordId: entry.auditRecordId,
      expectedFingerprint: entry.changeFingerprint,
      reason: 'x',
      kind: 'LOAN_SCHEDULE_PART_CHANGED',
    });
    expect((await json(bad, 400)).error.details).toEqual({ fields: [{ field: 'kind', code: 'INVALID_FORMAT' }] });
    const notFlagged = await w.R('POST', `/property-references/${w.P2}/tax-years/2027/acknowledgements`, {
      auditRecordId: await recordOf(tm.termsId, 'VOIDED'),
      expectedFingerprint: entry.changeFingerprint,
      reason: 'x',
      kind: 'LOAN_TERMS_PART_VOIDED',
    });
    expect((await json(notFlagged, 409)).error.details.reason).toBe('CHANGE_NOT_FLAGGED');
    // No cash mutated: the ledger and the sets as before the terms records.
    const after = await rowsSnapshot(pool);
    for (const table of ['ledger_transaction', 'transaction_split', 'loan_allocation_set', 'loan_allocation', 'ownership'])
      expect(after[table], table).toEqual(cash[table]);
    // The views write nothing.
    const quiet = await rowsSnapshot(pool);
    for (const pr of [w.P1, w.P2]) await w.view(pr, 2027);
    expect(await rowsSnapshot(pool)).toEqual(quiet);
  });

  it('Example 2: the closing recorded on 2028-01-20 moves the stub 190.00 from P2 to P1 (LOAN_CLOSED_PART); Realm isolation', async () => {
    const w = await world(REALM_A);
    await w.terms({ repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-31' }, '2027-01-02T09:00:00Z');
    await w.sets('2027-05-01');
    for (const d of ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']) await w.pay(d, '300.00');
    const stub = await w.pay('2027-05-20', '190.00', '120000.00');
    expect([line(await w.view(w.P1, 2027))?.total.amount, line(await w.view(w.P2, 2027))?.total.amount]).toEqual(['1200.00', '190.00']);
    await json(await w.R('POST', `/loans/${w.loanId}/close`, { closingDate: '2027-05-20', reason: 'REPAID' }), 200);
    const r3 = await recordOf(w.loanId, 'CLOSED');
    await at(r3, '2028-01-20T08:00:00Z');
    const [v1, v2] = [await w.view(w.P1, 2027), await w.view(w.P2, 2027)];
    expect([line(v1)?.total.amount, line(v2)?.total.amount ?? '0.00']).toEqual(['1390.00', '0.00']);
    expect(entries(v1).map((e) => [e.kind, e.entityType, e.auditRecordId])).toEqual([['LOAN_CLOSED_PART', 'Loan', r3]]);
    expect(moved(entries(v1)[0])).toEqual([['NONE', null, 'ATTRIBUTED', '190.00']]);
    expect(moved(entries(v2)[0])).toEqual([['ATTRIBUTED', '190.00', 'NONE', null]]);
    expect(entries(v1)[0]?.items[0]?.sourceId).toBe(stub);
    expect([amounts(await w.view(w.P1, 2027, w.a)), amounts(await w.view(w.P1, 2027, w.b))]).toEqual([
      ['150.00', '150.00', '150.00', '150.00', '95.00'],
      ['150.00', '150.00', '150.00', '150.00', '95.00'],
    ]);
    // Realm isolation: the same world in Realm B with the same dates, terms, closing and record changes nothing in A.
    const before = [JSON.stringify(v1), JSON.stringify(v2)];
    const wb = await world(REALM_B);
    await wb.terms({ repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-31' }, '2027-01-02T09:00:00Z');
    await wb.sets('2027-05-01');
    await wb.pay('2027-05-20', '190.00', '120000.00');
    await json(await wb.R('POST', `/loans/${wb.loanId}/close`, { closingDate: '2027-05-20', reason: 'REPAID' }), 200);
    await at(await recordOf(wb.loanId, 'CLOSED'), '2028-01-20T08:00:00Z');
    expect([JSON.stringify(await w.view(w.P1, 2027)), JSON.stringify(await w.view(w.P2, 2027))]).toEqual(before);
    // A's PropertyReference and its record are not B's: 404, and B's own entry names its own record only.
    await json(await call(REALM_B, 'GET', `/property-references/${w.P1}/tax-years/2027`), 404);
    expect(entries(await wb.view(wb.P1, 2027)).map((e) => e.auditRecordId)).not.toContain(r3);
    const foreign = await call(REALM_B, 'POST', `/property-references/${wb.P1}/tax-years/2027/acknowledgements`, {
      auditRecordId: r3,
      expectedFingerprint: (entries(v1)[0] as Entry).changeFingerprint,
      reason: 'x',
    });
    expect((await json(foreign, 409)).error.details.reason).toBe('CHANGE_NOT_FLAGGED');
  });
});

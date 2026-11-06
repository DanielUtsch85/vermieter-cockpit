import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  confirmTransaction,
  createFinancialAccount,
  createLoan,
  createLoanAllocation,
  createLoanTerms,
  createManualTransaction,
  createOwnership,
  createParty,
  createTaxClassification,
  getTaxYearView,
  setTransactionSplits,
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
 * VC-X-40 end to end (api-design.md §58L "Tests and mutations"; Entscheidung des Projektinhabers, 2026-11-04, L11: its own
 * e2e test, ACC7 and ACC8 unchanged), wired as in main.ts, synthetic values only. Example 1 and Example 3 of §58L through
 * the HTTP API at both levels, S2 recorded after the year's end as a part change of 2027 in both views, the recorded
 * interest period of Example 2 through `POST /tax-classifications` with its refusals, the views writing nothing, and Realm
 * isolation. Every AuditRecord time that matters is set explicitly.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM_A = '64b0c0ffee0000000000f40a';
const REALM_B = '64b0c0ffee0000000000f40b';

describe.skipIf(databaseUrl === undefined)('loan interest by periods of use (VC-X-40) end to end', () => {
  const schema = testSchemaName('tax_year_loan_periods_e2e');
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
    const classifications = new PostgresTaxClassificationRepository(db);
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
        loans: { create: createLoan({ repository: new PostgresLoanRepository(db) }) },
        loanTerms: { create: createLoanTerms({ repository: new PostgresLoanTermsRepository(db) }) },
        loanAllocations: { create: createLoanAllocation({ repository: new PostgresLoanAllocationRepository(db) }) },
        taxation: {
          create: createTaxClassification({ repository: classifications }),
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
  const call = (realm: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  let counter = 0;
  const giro = new Map<string, string>();
  const at = (id: string, iso: string) => stageAudit(pool, `UPDATE audit_record SET occurred_at = $2 WHERE id = $1`, [id, iso]);
  const recordOf = async (entityId: string, action: string) =>
    (await pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2`, [entityId, action])).rows[0].id as string;

  /** One Realm's world: two PropertyReferences (P1 < P2), A and B owning P1 half each (A < B), C owning P2. */
  async function world(realm: string) {
    const A = (method: string, path: string, body?: unknown) => call(realm, method, path, body);
    const property = async () =>
      (
        await pool.query(
          `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
          [realm, (0x6512f0c2a1b2c3d4e5f9f000n + BigInt(++counter)).toString(16).padStart(24, '0')],
        )
      ).rows[0].id as string;
    const party = async (displayName: string, partyType = 'PERSON') =>
      (await json<{ partyId: string }>(await A('POST', '/parties', { partyType, displayName }), 201)).partyId;
    const [P1, P2] = [await property(), await property()].sort() as [string, string];
    const [a, b] = [await party('Eigentümerin A (synthetisch)'), await party('Eigentümer B (synthetisch)')].sort() as [string, string];
    const c = await party('Eigentümerin C (synthetisch)');
    for (const [pr, ownerPartyId, share] of [
      [P1, a, '1/2'],
      [P1, b, '1/2'],
      [P2, c, '1/1'],
    ] as const) {
      await json(await A('POST', '/ownerships', { propertyReferenceId: pr, ownerPartyId, share, validFrom: '2026-01-01' }), 201);
    }
    if (!giro.has(realm)) {
      giro.set(
        realm,
        (await json<{ financialAccountId: string }>(await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }), 201))
          .financialAccountId,
      );
    }
    /** A Loan from `startDate` with monthly interest-only terms from `firstPaymentDate` (recorded 2026-12-01). */
    const loan = async (startDate: string, firstPaymentDate: string) => {
      const loanId = (
        await json<{ loanId: string }>(
          await A('POST', '/loans', {
            lenderPartyId: await party('Bank Beispiel (synthetisch)', 'ORGANIZATION'),
            borrowerPartyIds: [a, b, c],
            principalOriginal: eur('120000.00'),
            startDate,
          }),
          201,
        )
      ).loanId;
      const { termsId } = await json<{ termsId: string }>(
        await A('POST', `/loans/${loanId}/terms`, { validFrom: startDate, interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate }),
        201,
      );
      await at(await recordOf(termsId, 'CREATED'), '2026-12-01T10:00:00Z');
      return loanId;
    };
    const set = async (loanId: string, validFrom: string, shares: readonly (readonly [string, string])[], recordedAt: string) => {
      const created = await json<{ allocationSetId: string }>(
        await A('POST', `/loans/${loanId}/allocations`, {
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
    const debit = async (loanId: string, amount: string, bookingDate: string) => {
      const { transactionId } = await json<{ transactionId: string }>(
        await A('POST', '/transactions', { financialAccountId: giro.get(realm), amount: eur(amount), direction: 'OUTFLOW', bookingDate }),
        201,
      );
      const splits = await json<{ splits: { splitId: string }[] }>(
        await A('PUT', `/transactions/${transactionId}/splits`, { splits: [{ amount: eur(amount), financialCategoryCode: 'LOAN_INTEREST', loanId }] }),
        200,
      );
      await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
      return splits.splits[0]?.splitId as string;
    };
    const view = async (pr: string, year: number, ownerPartyId?: string) =>
      json<View>(await A('GET', `/property-references/${pr}/tax-years/${year}${ownerPartyId === undefined ? '' : `?ownerPartyId=${ownerPartyId}`}`), 200);
    return { A, P1, P2, a, b, c, loan, set, debit, view };
  }
  const interest = (v: View): View[] => v.werbungskosten.lines.find((l: View) => l.taxCategory === 'LOAN_INTEREST')?.items ?? [];
  const amounts = (v: View) => interest(v).map((i: View) => i.lineAmount?.amount);
  const changes = (v: View): View[] => v.flags.find((f: View) => f.code === 'PROPERTY_PART_CHANGED')?.details ?? [];

  it('Example 1: P1 230.00 and 150.00, P2 80.00 and 150.00, A and B 115.00 each; S2 recorded 2028-02-10 is a part change of 2027 in both views; reads write nothing', async () => {
    const w = await world(REALM_A);
    const L = await w.loan('2027-01-01', '2027-01-31');
    const S1 = await w.set(L, '2027-01-01', [[w.P1, '1/1']], '2027-01-02T10:00:00Z');
    const S2 = await w.set(
      L,
      '2027-03-16',
      [
        [w.P1, '1/2'],
        [w.P2, '1/2'],
      ],
      '2028-02-10T10:00:00Z',
    );
    const march = await w.debit(L, '310.00', '2027-03-31');
    const april = await w.debit(L, '300.00', '2027-04-30');
    const snapshot = await rowsSnapshot(pool);
    const [v1, v2] = [await w.view(w.P1, 2027), await w.view(w.P2, 2027)];
    expect(interest(v1).map((i: View) => [i.sourceId, i.lineAmount.amount, i.loanAllocation.share, i.loanAllocation.allocationSetId])).toEqual([
      [march, '230.00', '23/31', null],
      [april, '150.00', '1/2', S2.setId],
    ]);
    expect(interest(v1)[0].loanAllocation).toMatchObject({
      interestPeriod: { from: '2027-03-01', until: '2027-03-31', source: 'LOAN_SCHEDULE' },
      segments: [
        { from: '2027-03-01', until: '2027-03-15', allocationSetId: S1.setId, basis: 'MANUAL', share: '1/1' },
        { from: '2027-03-16', until: '2027-03-31', allocationSetId: S2.setId, basis: 'MANUAL', share: '1/2' },
      ],
      propertyPart: eur('230.00'),
    });
    expect(amounts(v2)).toEqual(['80.00', '150.00']);
    expect(amounts(await w.view(w.P1, 2027, w.a))).toEqual(['115.00', '75.00']);
    expect(amounts(await w.view(w.P1, 2027, w.b))).toEqual(['115.00', '75.00']);
    expect(amounts(await w.view(w.P2, 2027, w.c))).toEqual(['80.00', '150.00']);
    // 2027 across both views: 380.00 + 230.00 = 610.00, the two debits.
    const total = (v: View) => v.werbungskosten.lines.find((l: View) => l.taxCategory === 'LOAN_INTEREST')?.total;
    expect([total(v1), total(v2)]).toEqual([eur('380.00'), eur('230.00')]);
    // §58G: S2 recorded after 31 December 2027 moved the March debit in both views (April was booked after S2's validFrom).
    const s2 = (v: View) => changes(v).filter((e: View) => e.auditRecordId === S2.auditRecordId);
    expect(s2(v1).map((e: View) => e.items.map((i: View) => [i.sourceId, i.stateBefore, i.partBefore?.amount, i.stateAfter, i.partAfter?.amount]))).toEqual([
      [
        [march, 'ATTRIBUTED', '310.00', 'ATTRIBUTED', '230.00'],
        [april, 'ATTRIBUTED', '300.00', 'ATTRIBUTED', '150.00'],
      ].sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)),
    ]);
    expect(s2(v2).map((e: View) => e.items.map((i: View) => [i.sourceId, i.stateBefore, i.partAfter?.amount]))).toEqual([
      [
        [march, 'NONE', '80.00'],
        [april, 'NONE', '150.00'],
      ].sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)),
    ]);
    expect(v1.review.open.map((o: View) => o.code)).toContain('PROPERTY_PART_CHANGED');
    expect(changes(v1).some((e: View) => e.auditRecordId === S1.auditRecordId)).toBe(false);
    expect(await rowsSnapshot(pool)).toEqual(snapshot);
  });

  it('Example 3: clipped at debtFrom P1 81.00; with the first set from 2027-03-20 the split is not attributed with its uncovered days, at both levels', async () => {
    const w = await world(REALM_A);
    const covered = await w.loan('2027-03-16', '2027-03-31');
    await w.set(covered, '2027-03-16', [[w.P1, '1/1']], '2027-03-16T10:00:00Z');
    const late = await w.loan('2027-03-16', '2027-03-31');
    await w.set(late, '2027-03-20', [[w.P1, '1/1']], '2027-03-20T10:00:00Z');
    const ok = await w.debit(covered, '81.00', '2027-03-31');
    const gap = await w.debit(late, '81.00', '2027-03-31');
    for (const owner of [undefined, w.a]) {
      const v = await w.view(w.P1, 2027, owner);
      expect(interest(v).map((i: View) => [i.sourceId, i.loanAllocation.propertyPart.amount])).toEqual([[ok, '81.00']]);
      expect(v.notAttributed.items.map((i: View) => [i.sourceId, i.lineAmount, i.reason, i.interestPeriod, i.uncovered])).toEqual([
        [gap, null, 'NO_LOAN_ALLOCATION', { from: '2027-03-16', until: '2027-03-31', source: 'LOAN_SCHEDULE' }, [{ from: '2027-03-16', until: '2027-03-19' }]],
      ]);
      expect(v.flags.find((f: View) => f.code === 'LOAN_INTEREST_NOT_ATTRIBUTED')?.details).toEqual({
        loanIds: [late],
        interestTotal: eur('81.00'),
        splitIds: [gap],
      });
      expect(v.review.final).toBe(false);
    }
    expect(amounts(await w.view(w.P1, 2027, w.a))).toEqual(['40.50']);
  });

  it('Example 2 with the recorded period through POST /tax-classifications: P1 2,730.00, P2 920.00; the refusals; Realm isolation', async () => {
    const w = await world(REALM_A);
    const M = await w.loan('2026-01-01', '2026-01-31');
    await w.set(M, '2026-01-01', [[w.P1, '1/1']], '2026-01-02T10:00:00Z');
    await w.set(M, '2027-10-01', [[w.P2, '1/1']], '2027-10-01T10:00:00Z');
    const yearly = await w.debit(M, '3650.00', '2027-12-30');
    expect([amounts(await w.view(w.P1, 2027)), amounts(await w.view(w.P2, 2027))]).toEqual([[], ['3650.00']]);
    const body = (interestPeriod: unknown, sourceType = 'TRANSACTION_SPLIT') => ({
      sourceType,
      sourceId: yearly,
      taxCategory: 'LOAN_INTEREST',
      treatment: 'DEDUCTIBLE',
      sourceReferences: ['Zinsbescheinigung 2027 (synthetisch)'],
      interestPeriod,
    });
    const refused = await json<{ error: { details: unknown } }>(
      await w.A('POST', '/tax-classifications', body({ from: '2027-12-31', until: '2027-01-01' })),
      400,
    );
    expect(JSON.stringify(refused)).toContain('OUT_OF_RANGE');
    expect(
      JSON.stringify(await json(await w.A('POST', '/tax-classifications', body({ from: '2027-01-01', until: '2027-12-31' }, 'DEPOSIT_CLOSING')), 400)),
    ).toContain('NOT_SUPPORTED');
    // Another Realm cannot record a period on this split.
    await json(await call(REALM_B, 'POST', '/tax-classifications', body({ from: '2027-01-01', until: '2027-12-31' })), 404);
    const created = await json<View>(await w.A('POST', '/tax-classifications', body({ from: '2027-01-01', until: '2027-12-31' })), 201);
    expect(created.interestPeriod).toEqual({ from: '2027-01-01', until: '2027-12-31' });
    const [v1, v2] = [await w.view(w.P1, 2027), await w.view(w.P2, 2027)];
    expect([amounts(v1), amounts(v2)]).toEqual([['2730.00'], ['920.00']]);
    expect(interest(v1)[0].loanAllocation).toMatchObject({
      share: '273/365',
      interestPeriod: { from: '2027-01-01', until: '2027-12-31', source: 'CLASSIFICATION' },
    });
    expect(amounts(await w.view(w.P1, 2027, w.a))).toEqual(['1365.00']);
    expect(amounts(await w.view(w.P1, 2027, w.b))).toEqual(['1365.00']);
    // A principal split of the Loan takes no period (NOT_SUPPORTED at interestPeriod).
    const { transactionId } = await json<{ transactionId: string }>(
      await w.A('POST', '/transactions', { financialAccountId: giro.get(REALM_A), amount: eur('500.00'), direction: 'OUTFLOW', bookingDate: '2027-12-30' }),
      201,
    );
    const principal = (
      await json<{ splits: { splitId: string }[] }>(
        await w.A('PUT', `/transactions/${transactionId}/splits`, { splits: [{ amount: eur('500.00'), financialCategoryCode: 'LOAN_PRINCIPAL', loanId: M }] }),
        200,
      )
    ).splits[0]?.splitId;
    await json(await w.A('POST', `/transactions/${transactionId}/confirm`), 200);
    const off = await w.A('POST', '/tax-classifications', {
      ...body({ from: '2027-01-01', until: '2027-12-31' }),
      sourceId: principal,
      taxCategory: 'NOT_RELEVANT',
      treatment: 'NOT_RELEVANT',
    });
    expect(off.status).toBe(400);
    expect(JSON.stringify(await off.json())).toContain('interestPeriod');

    // Realm isolation: the same Loan, sets and debit in Realm B is its own (December's use), and changes nothing in A.
    const wb = await world(REALM_B);
    const MB = await wb.loan('2026-01-01', '2026-01-31');
    await wb.set(MB, '2026-01-01', [[wb.P1, '1/1']], '2026-01-02T10:00:00Z');
    await wb.set(MB, '2027-10-01', [[wb.P2, '1/1']], '2027-10-01T10:00:00Z');
    await wb.debit(MB, '3650.00', '2027-12-30');
    expect([amounts(await wb.view(wb.P1, 2027)), amounts(await wb.view(wb.P2, 2027))]).toEqual([[], ['3650.00']]);
    expect([amounts(await w.view(w.P1, 2027)), amounts(await w.view(w.P2, 2027))]).toEqual([['2730.00'], ['920.00']]);
    await json(await call(REALM_B, 'GET', `/property-references/${w.P1}/tax-years/2027`), 404);
  });
});

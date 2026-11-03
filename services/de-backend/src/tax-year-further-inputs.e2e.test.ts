import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  acknowledgeAttributionChange,
  closeDeposit,
  closeLoan,
  confirmTransaction,
  createDeposit,
  createEconomicPlan,
  createFinancialAccount,
  createLoan,
  createLoanAllocation,
  createLoanTerms,
  createManualTransaction,
  createMembership,
  createParty,
  createReconciliation,
  createTaxClassification,
  createWeg,
  getTaxMeaning,
  getTaxYearView,
  listAcknowledgements,
  releaseReconciliation,
  setTransactionSplits,
  voidEconomicPlan,
  withdrawAcknowledgement,
} from './application/index.js';
import { sha256Fingerprinter } from './infrastructure/hashing/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresLoanAllocationRepository,
  PostgresLoanRepository,
  PostgresLoanTermsRepository,
  PostgresPartyRepository,
  PostgresRentReconciliationRepository,
  PostgresSecurityDepositRepository,
  PostgresTaxClassificationRepository,
  PostgresTaxStatementRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegEconomicPlanRepository,
  PostgresWegRepository,
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
 * VC-X-49 end to end (api-design.md §58H "Tests the implementation needs"; Entscheidung des Projektinhabers, 2026-11-03,
 * §58H Frage 4 with §58E Frage 8: its own e2e test, ACC7 and ACC8 unchanged), wired as in main.ts, synthetic values only.
 * Every AuditRecord time that matters is set explicitly (the settable clock of the history). §58H's three examples
 * through the HTTP API: M closed on 2028-02-15 (2027 flagged and acknowledged, 2028 refused with CHANGE_NOT_FLAGGED); D
 * moved and back (P1's two entries acknowledged, P2 never flagged); E1 voided, E2 added and voided (nothing raised);
 * Realm isolation and no cash mutated around them.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM_A = '64b0c0ffee0000000000e49a';
const REALM_B = '64b0c0ffee0000000000e49b';
const T = '6512f0c2a1b2c3d4e5f6e49a';

type Entry = { kind: string; auditRecordId: string; items: View[]; changeFingerprint: string; acknowledgement: unknown };

describe.skipIf(databaseUrl === undefined)('further silent inputs of the tax year (VC-X-49) end to end', () => {
  const schema = testSchemaName('tax_year_further_inputs_e2e');
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
        tenants: [{ _id: T, name: 'Mieterin T (synthetisch)', guaranty: 3000 }],
        rents: { [T]: [2027030100, 2027050100] },
      },
      { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const transactions = new PostgresTransactionRepository(db);
    const loans = new PostgresLoanRepository(db);
    const reconciliations = new PostgresRentReconciliationRepository(db);
    const deposits = new PostgresSecurityDepositRepository(db);
    const wegs = new PostgresWegRepository(db);
    const plans = new PostgresWegEconomicPlanRepository(db);
    const classifications = new PostgresTaxClassificationRepository(db);
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
        loans: { create: createLoan({ repository: loans }), close: closeLoan({ repository: loans }) },
        loanTerms: { create: createLoanTerms({ repository: new PostgresLoanTermsRepository(db) }) },
        loanAllocations: { create: createLoanAllocation({ repository: new PostgresLoanAllocationRepository(db) }) },
        rentReconciliations: {
          create: createReconciliation({ repository: reconciliations, lookupMreRentTerm: mreRentTermLookup(client) }),
          release: releaseReconciliation({ repository: reconciliations }),
        },
        securityDeposits: {
          create: createDeposit({ repository: deposits, readMreTenant: mreTenantDepositReader(client) }),
          close: closeDeposit({ repository: deposits }),
        },
        wegs: { createWeg: createWeg({ repository: wegs }), createMembership: createMembership({ repository: wegs }) },
        wegEconomicPlans: { create: createEconomicPlan({ repository: plans }), void: voidEconomicPlan({ repository: plans }) },
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
  const recordOf = async (entityId: string, action: string) =>
    (await pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2`, [entityId, action])).rows[0].id as string;

  async function property(realm = REALM_A) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f8f000n + BigInt(++counter)).toString(16).padStart(24, '0');
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
  const party = async (displayName: string, partyType = 'PERSON') =>
    (await json<{ partyId: string }>(await A('POST', '/parties', { partyType, displayName }), 201)).partyId;
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
  const CASH = [
    'ledger_transaction',
    'transaction_split',
    'tax_classification',
    'loan',
    'loan_terms',
    'security_deposit',
    'rent_payment_reconciliation',
    'weg_economic_plan',
  ];

  it('the Loan closed (§58H): M closed on 2028-02-15 moves the 61.20 from 2027 to 2028; 2027 flagged and acknowledged, 2028 refused', async () => {
    const P3 = await property();
    const M = (
      await json<{ loanId: string }>(
        await A('POST', '/loans', {
          lenderPartyId: await party('Bank Beispiel (synthetisch)', 'ORGANIZATION'),
          borrowerPartyIds: [await party('Dora Darlehen (synthetisch)')],
          principalOriginal: eur('24480.00'),
          startDate: '2026-01-01',
        }),
        201,
      )
    ).loanId;
    const { termsId } = await json<{ termsId: string }>(
      await A('POST', `/loans/${M}/terms`, { validFrom: '2026-01-01', interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2026-01-06' }),
      201,
    );
    await at(await recordOf(termsId, 'CREATED'), '2025-12-01T10:00:00Z');
    const set = await json<{ allocationSetId: string }>(
      await A('POST', `/loans/${M}/allocations`, { validFrom: '2026-01-01', basis: 'MANUAL', allocations: [{ propertyReferenceId: P3, share: '1/1' }] }),
      201,
    );
    await at(await recordOf(set.allocationSetId, 'CREATED'), '2026-01-01T10:00:00Z');
    const { splitId: debit } = await booked('OUTFLOW', '2028-01-03', [
      { amount: eur('61.20'), financialCategoryCode: 'LOAN_INTEREST', loanId: M },
      { amount: eur('24480.00'), financialCategoryCode: 'LOAN_PRINCIPAL', loanId: M },
    ]);
    // Before the closing: due 2028-01-06, its period 2027-12-07 to 2028-01-06 (25 days in 2027): 2027 by the 10-day rule.
    const b27 = await view(P3, 2027);
    expect([lineOf(b27, 'LOAN_INTEREST').total, lineOf(b27, 'LOAN_INTEREST').items.map((i: View) => [i.sourceId, codes(i.flags)])]).toEqual([
      eur('61.20'),
      [[debit, expect.arrayContaining(['ATTRIBUTED_BY_10_DAY_RULE'])]],
    ]);
    expect(lineOf(await view(P3, 2028), 'LOAN_INTEREST').total).toEqual(eur('0.00'));
    const untouched = await rowsSnapshot(pool);

    // Closed REPAID on 2028-01-03, recorded on 2028-02-15: the nearest entry is 2027-12-06, outside the window.
    expect(await json(await A('POST', `/loans/${M}/close`, { closingDate: '2028-01-03', reason: 'REPAID' }), 200)).toMatchObject({ status: 'CLOSED' });
    const closing = await recordOf(M, 'CLOSED');
    await at(closing, '2028-02-15T10:00:00Z');
    const [v27, v28] = [await view(P3, 2027), await view(P3, 2028)];
    expect([lineOf(v27, 'LOAN_INTEREST').total, lineOf(v28, 'LOAN_INTEREST').total]).toEqual([eur('0.00'), eur('61.20')]);
    expect(changes(v27, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([
      expect.objectContaining({
        kind: 'LOAN_CLOSED',
        entityType: 'Loan',
        entityId: M,
        loanId: M,
        closingDate: '2028-01-03',
        closingReason: 'REPAID',
        auditRecordId: closing,
        amendedAt: '2028-02-15T10:00:00.000Z',
        items: [{ sourceId: debit, yearBefore: 2027, yearAfter: 2028 }],
        acknowledgement: null,
      }),
    ]);
    expect([
      level(v27, 'ATTRIBUTION_INPUT_CHANGED'),
      changes(v28, 'ATTRIBUTION_INPUT_CHANGED'),
      v27.flags.some((f: View) => f.code === 'PROPERTY_PART_CHANGED'),
    ]).toEqual([[true, false], [], false]);
    const entry = changes(v27, 'ATTRIBUTION_INPUT_CHANGED')[0] as Entry;
    expect(await details(await acknowledge(P3, 2028, entry), 409)).toEqual({ reason: 'CHANGE_NOT_FLAGGED', auditRecordId: closing, year: 2028 });
    const ack = await json<{ acknowledgementId: string; change: View }>(await acknowledge(P3, 2027, entry, 'LOAN_CLOSED'), 201);
    expect(ack.change).toMatchObject({ kind: 'LOAN_CLOSED', entityType: 'Loan', entityId: M, items: [{ sourceId: debit, yearBefore: 2027, yearAfter: 2028 }] });
    const a27 = await view(P3, 2027);
    expect([level(a27, 'ATTRIBUTION_INPUT_CHANGED'), lineOf(a27, 'LOAN_INTEREST').total]).toEqual([[false, true], eur('0.00')]);
    // Realm isolation: B sees neither the view nor the acknowledgement; its own PropertyReference refuses M's record.
    expect((await call(REALM_B, 'GET', ackPath(P3, 2027))).status).toBe(404);
    expect((await acknowledge(await property(REALM_B), 2027, entry, undefined, REALM_B)).status).toBe(409);
    // No cash mutated by the acknowledgement and the views (the closing itself wrote only the Loan).
    const after = await rowsSnapshot(pool);
    for (const table of CASH.filter((t) => t !== 'loan')) expect(after[table], table).toEqual(untouched[table]);
    const viewsOnly = await rowsSnapshot(pool);
    for (const year of [2027, 2028]) await view(P3, year);
    expect(await rowsSnapshot(pool)).toEqual(viewsOnly);
  });

  it('the deposit (§58H): D moved to P1 and P2 by a match on 2028-02-10 and back on 2028-02-20; P1 two entries acknowledged, P2 never flagged', async () => {
    const [P1, P2] = [await property(), await property()];
    const match = async (pr: string, amount: string, bookingDate: string, term: string, recordedAt: string) => {
      const rent = await booked('INFLOW', bookingDate, [{ amount: eur(amount), financialCategoryCode: 'RENT_BASE', propertyReferenceId: pr }]);
      const { reconciliationId } = await json<{ reconciliationId: string }>(
        await A('POST', '/rent-reconciliations', { transactionId: rent.transactionId, mreTenantId: T, mreRentTerm: term, matchedAmount: eur(amount) }),
        201,
      );
      const auditRecordId = await recordOf(reconciliationId, 'CONFIRMED');
      await at(auditRecordId, recordedAt);
      return { reconciliationId, auditRecordId };
    };
    await match(P1, '900.00', '2027-03-01', '2027030100', '2027-03-05T10:00:00Z');
    const D = (await json<{ securityDepositId: string }>(await A('POST', '/security-deposits', { mreTenantId: T }), 201)).securityDepositId;
    await booked('INFLOW', '2026-01-05', [{ amount: eur('3000.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: D }]);
    await booked('OUTFLOW', '2027-06-20', [{ amount: eur('2700.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: D }]);
    await json(
      await A('POST', `/security-deposits/${D}/close`, { closingDate: '2027-06-30', reason: 'RETAINED', closingNote: 'Mietrückstand (synthetisch)' }),
      200,
    );
    await json(
      await A('POST', '/tax-classifications', { sourceType: 'DEPOSIT_CLOSING', sourceId: D, taxCategory: 'RETAINED_DEPOSIT_RENT', treatment: 'INCOME' }),
      201,
    );
    const b1 = await view(P1, 2027);
    expect([lineOf(b1, 'RETAINED_DEPOSIT_RENT').total, changes(b1, 'PROPERTY_PART_CHANGED')]).toEqual([eur('300.00'), []]);
    const income = (v: View) => BigInt(String(v.einnahmen.total.amount).replace('.', ''));

    // 2028-02-10: the 80.00 on P2 (booked 2027-05-03) matched to T's May term: D has two PropertyReferences.
    const moved = await match(P2, '80.00', '2027-05-03', '2027050100', '2028-02-10T10:00:00Z');
    const untouched = await rowsSnapshot(pool);
    const [m1, m2] = [await view(P1, 2027), await view(P2, 2027)];
    expect([lineOf(m1, 'RETAINED_DEPOSIT_RENT').total, income(b1) - income(m1)]).toEqual([eur('0.00'), 30000n]);
    const item = (stateBefore: string, partBefore: string | null, stateAfter: string, partAfter: string | null) => ({
      sourceType: 'DEPOSIT_CLOSING',
      sourceId: D,
      taxYear: 2027,
      stateBefore,
      partBefore: partBefore === null ? null : eur(partBefore),
      stateAfter,
      partAfter: partAfter === null ? null : eur(partAfter),
    });
    expect(changes(m1, 'PROPERTY_PART_CHANGED')).toEqual([
      expect.objectContaining({
        kind: 'DEPOSIT_RECONCILIATION_CONFIRMED',
        entityType: 'RentPaymentReconciliation',
        entityId: moved.reconciliationId,
        auditRecordId: moved.auditRecordId,
        securityDepositIds: [D],
        items: [item('ATTRIBUTED', '300.00', 'NOT_ATTRIBUTED', null)],
        acknowledgement: null,
      }),
    ]);
    for (const v of [m1, m2]) {
      expect(v.notAttributed.items.map((i: View) => i.sourceId)).toEqual([D]);
      expect(codes(v.flags)).toContain('UNATTRIBUTED_ITEMS');
      // The 80.00 is booked mid-year: no year moves.
      expect(codes(v.flags)).not.toContain('ATTRIBUTION_INPUT_CHANGED');
    }
    expect([level(m1, 'PROPERTY_PART_CHANGED'), codes(m1.notAttributed.items[0].flags)]).toEqual([
      [true, false],
      expect.arrayContaining(['PROPERTY_PART_CHANGED']),
    ]);
    expect([changes(m2, 'PROPERTY_PART_CHANGED'), codes(m2.notAttributed.items[0].flags)]).toEqual([[], expect.not.arrayContaining(['PROPERTY_PART_CHANGED'])]);

    // 2028-02-20: released (another Tenant's payment): D is P1's again.
    await json(await A('POST', `/rent-reconciliations/${moved.reconciliationId}/release`, { reason: 'Zahlung eines anderen Mieters (synthetisch)' }), 200);
    const released = await recordOf(moved.reconciliationId, 'RELEASED');
    await at(released, '2028-02-20T10:00:00Z');
    const r1 = await view(P1, 2027);
    expect([lineOf(r1, 'RETAINED_DEPOSIT_RENT').total, income(r1), codes(r1.flags)]).toEqual([
      eur('300.00'),
      income(b1),
      expect.not.arrayContaining(['UNATTRIBUTED_ITEMS']),
    ]);
    const entries = changes(r1, 'PROPERTY_PART_CHANGED');
    expect(entries.map((e) => [e.kind, e.auditRecordId, e.items])).toEqual([
      ['DEPOSIT_RECONCILIATION_CONFIRMED', moved.auditRecordId, [item('ATTRIBUTED', '300.00', 'NOT_ATTRIBUTED', null)]],
      ['DEPOSIT_RECONCILIATION_RELEASED', released, [item('NOT_ATTRIBUTED', null, 'ATTRIBUTED', '300.00')]],
    ]);
    expect(changes(await view(P2, 2027), 'PROPERTY_PART_CHANGED')).toEqual([]);
    // Each acknowledged in P1 (the second without kind: its record is one change); open until both are.
    await json(await acknowledge(P1, 2027, entries[0] as Entry, 'DEPOSIT_RECONCILIATION_CONFIRMED'), 201);
    expect(level(await view(P1, 2027), 'PROPERTY_PART_CHANGED')).toEqual([true, false]);
    const second = await json<{ change: View }>(await acknowledge(P1, 2027, entries[1] as Entry), 201);
    expect(second.change.items).toEqual([item('NOT_ATTRIBUTED', null, 'ATTRIBUTED', '300.00')]);
    const done = await view(P1, 2027);
    expect([level(done, 'PROPERTY_PART_CHANGED'), lineOf(done, 'RETAINED_DEPOSIT_RENT').total]).toEqual([[false, true], eur('300.00')]);
    expect(await details(await acknowledge(P2, 2027, entries[0] as Entry), 409)).toEqual({
      reason: 'CHANGE_NOT_FLAGGED',
      auditRecordId: moved.auditRecordId,
      year: 2027,
    });
    // Realm isolation and no cash mutated (the acknowledgements wrote only their rows and AuditRecords).
    expect((await call(REALM_B, 'GET', `/property-references/${P1}/tax-years/2027`)).status).toBe(404);
    const after = await rowsSnapshot(pool);
    for (const table of CASH.filter((t) => t !== 'rent_payment_reconciliation')) expect(after[table], table).toEqual(untouched[table]);
    const viewsOnly = await rowsSnapshot(pool);
    for (const pr of [P1, P2]) await view(pr, 2027);
    expect(await rowsSnapshot(pool)).toEqual(viewsOnly);
  });

  it('the WEG economic plan (§58H Frage 1): E1 voided, E2 added and voided after 2027 raise nothing; 2027 figures, flags and final as before', async () => {
    const P4 = await property();
    const weg = await json<{ wegId: string }>(await A('POST', '/wegs', { displayName: 'WEG Beispielweg (synthetisch)' }), 201);
    const membership = await json<{ membershipId: string }>(
      await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: P4, miteigentumsanteil: '125/10000', validFrom: '2026-01-01' }),
      201,
    );
    const plan = async (advanceDueDay: number, recordedAt: string) => {
      const created = await json<{ economicPlanId: string }>(
        await A('POST', `/weg-memberships/${membership.membershipId}/economic-plans`, {
          financialYear: 2027,
          effectiveFrom: '2027-01-01',
          advanceDueDay,
          monthlyHausgeld: eur('250.00'),
          monthlyReserveContribution: eur('0.00'),
          recoverableCosts: eur('2000.00'),
          nonRecoverableCosts: eur('1000.00'),
        }),
        201,
      );
      await at(await recordOf(created.economicPlanId, 'CREATED'), recordedAt);
      return created.economicPlanId;
    };
    const voided = async (id: string, recordedAt: string) => {
      await json(await A('POST', `/weg-economic-plans/${id}/void`, { reason: 'Falscher Fälligkeitstag (synthetisch)' }), 200);
      await at(await recordOf(id, 'VOIDED'), recordedAt);
    };
    const E1 = await plan(1, '2027-01-05T10:00:00Z');
    const { splitId: debit } = await booked('OUTFLOW', '2027-12-30', [
      { amount: eur('250.00'), financialCategoryCode: 'WEG_RECOVERABLE', propertyReferenceId: P4 },
    ]);
    await json(
      await A('POST', '/tax-classifications', { sourceType: 'TRANSACTION_SPLIT', sourceId: debit, taxCategory: 'WEG_HAUSGELD', treatment: 'DEDUCTIBLE' }),
      201,
    );
    const state = async () => {
      const v = await view(P4, 2027);
      const meaning = await json<View>(await A('GET', `/transaction-splits/${debit}/tax-meaning`), 200);
      const line = lineOf(v, 'WEG_HAUSGELD');
      return {
        total: line.total,
        items: line.items.map((i: View) => i.sourceId),
        yearFlags: codes(v.flags).filter((c: string) => c === 'ATTRIBUTION_INPUT_CHANGED' || c === 'PROPERTY_PART_CHANGED'),
        open: v.review.open,
        final: v.review.final,
        taxYear: meaning.taxYear,
        proposedYear: meaning.attribution.proposedYear,
        flags: codes(meaning.flags),
      };
    };
    const before = await state();
    // E1, day 1: the nearest due date 2028-01-01, the year kept, proposedYear 2028, informative (the classification is confirmed).
    expect(before).toMatchObject({
      total: eur('250.00'),
      items: [debit],
      yearFlags: [],
      taxYear: 2027,
      proposedYear: 2028,
      flags: ['ECONOMIC_PERIOD_ASSUMED'],
    });
    const untouched = await rowsSnapshot(pool);
    await voided(E1, '2028-02-01T10:00:00Z');
    const E2 = await plan(28, '2028-02-01T10:05:00Z');
    // E2, day 28: due 2027-12-28, the proposal disappears; nothing else moves.
    expect(await state()).toEqual({ ...before, proposedYear: 2027, flags: [] });
    await voided(E2, '2028-02-02T10:00:00Z');
    expect(await state()).toEqual({ ...before, proposedYear: 2027, flags: ['NO_ECONOMIC_PERIOD'] });
    expect((await json<{ items: unknown[] }>(await A('GET', ackPath(P4, 2027)), 200)).items).toEqual([]);
    const after = await rowsSnapshot(pool);
    for (const table of CASH.filter((t) => t !== 'weg_economic_plan')) expect(after[table], table).toEqual(untouched[table]);
  });
});

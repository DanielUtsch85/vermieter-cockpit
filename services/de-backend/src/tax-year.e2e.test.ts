import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  amendRentalContractReference,
  closeDeposit,
  confirmTransaction,
  createDeposit,
  createEconomicPlan,
  createFinancialAccount,
  createLoan,
  createLoanTerms,
  createManualTransaction,
  createMembership,
  createParty,
  createReconciliation,
  createRentalContractReference,
  createTaxClassification,
  createWeg,
  getDepositTaxMeaning,
  getRentalContractReference,
  getTaxClassification,
  getTaxMeaning,
  listRentalContractReferences,
  listTaxClassificationHistory,
  listTaxMeanings,
  reviewTaxClassification,
  setTransactionSplits,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresLoanRepository,
  PostgresLoanTermsRepository,
  PostgresPartyRepository,
  PostgresRentReconciliationRepository,
  PostgresRentalContractReferenceRepository,
  PostgresSecurityDepositRepository,
  PostgresTaxClassificationRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegEconomicPlanRepository,
  PostgresWegRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier, mreRentTermLookup, mreTenantDepositReader, mreTenantLookup } from './wiring.js';

/**
 * VC-7-02 end to end (api-design.md §58A), wired as in main.ts: a January rent paid on 29 December, without a
 * RentalContractReference, with day 3 and with day 15; a Hausgeld debit of 30 December from a plan with
 * `advanceDueDay` 1, then classified with `taxYear` Y+1; interest due on 2 January debited on 30 December; a refund of
 * an earlier year; a retained deposit classified as rent compensation; Realm isolation on the new routes. Figures and
 * names are invented.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee000000000000d1';
const REALM_B = '64b0c0ffee000000000000d2';
const TENANT = '6512f0c2a1b2c3d4e5f6d001';
const JANUARY = '2027010100';

/** The new routes of §58A under `/api/v1`, as `METHOD /path/:param`. */
const VC_7_02 = /^[A-Z]+ \/rental-contract-references\b|^[A-Z]+ \/security-deposits\/:depositId\/tax-meaning$/;

function routesOf(app: Express): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle: { stack?: Layer[] } };
  const walk = (stack: readonly Layer[]): string[] =>
    stack.flatMap((layer) => {
      if (layer.route !== undefined) return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route?.path}`);
      return layer.name === 'router' && layer.handle.stack !== undefined ? walk(layer.handle.stack) : [];
    });
  return walk((app as unknown as { _router: { stack: Layer[] } })._router.stack);
}

describe.skipIf(databaseUrl === undefined)('Tax year and income (VC-7-02) end to end', () => {
  const schema = testSchemaName('tax_year_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let app: Express;
  let server: Server;
  let base: string;
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    mre = await startFakeMre([
      {
        _id: REALM_A,
        name: 'A',
        members: member,
        applications: [],
        tenants: [{ _id: TENANT, name: 'Mieter M', guaranty: 3000 }],
        rents: { [TENANT]: [Number(JANUARY)] },
      },
      { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const wegs = new PostgresWegRepository(db);
    const plans = new PostgresWegEconomicPlanRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const deposits = new PostgresSecurityDepositRepository(db);
    const loans = new PostgresLoanRepository(db);
    const loanTerms = new PostgresLoanTermsRepository(db);
    const classifications = new PostgresTaxClassificationRepository(db);
    const references = new PostgresRentalContractReferenceRepository(db);
    const readMreTenant = mreTenantDepositReader(client);
    app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        parties: { create: createParty({ repository: new PostgresPartyRepository(db) }) },
        loans: { create: createLoan({ repository: loans }) },
        loanTerms: { create: createLoanTerms({ repository: loanTerms }) },
        wegs: { createWeg: createWeg({ repository: wegs }), createMembership: createMembership({ repository: wegs }) },
        wegEconomicPlans: { create: createEconomicPlan({ repository: plans }) },
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
        },
        rentReconciliations: {
          create: createReconciliation({ repository: new PostgresRentReconciliationRepository(db), lookupMreRentTerm: mreRentTermLookup(client) }),
        },
        securityDeposits: { create: createDeposit({ repository: deposits, readMreTenant }), close: closeDeposit({ repository: deposits }) },
        taxation: {
          create: createTaxClassification({ repository: classifications }),
          get: getTaxClassification({ repository: classifications }),
          history: listTaxClassificationHistory({ repository: classifications }),
          review: reviewTaxClassification({ repository: classifications }),
          taxMeaning: getTaxMeaning({ repository: classifications }),
          depositTaxMeaning: getDepositTaxMeaning({ repository: classifications }),
          taxMeanings: listTaxMeanings({ repository: classifications }),
        },
        rentalContractReferences: {
          create: createRentalContractReference({ repository: references, lookupMreTenant: mreTenantLookup(client) }),
          get: getRentalContractReference({ repository: references }),
          list: listRentalContractReferences({ repository: references }),
          amend: amendRentalContractReference({ repository: references }),
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

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 300);
  const call = (realm: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
  const B = (method: string, path: string, body?: unknown) => call(REALM_B, method, path, body);
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const errorOf = async (res: Response, status: number) => (await json<{ error: { code: string; details?: Record<string, unknown> } }>(res, status)).error;
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  type Flag = { code: string; details: Record<string, unknown> };
  type Meaning = {
    sourceType: string;
    splitId?: string;
    taxYear: number | null;
    attribution?: { proposedYear: number; overridden: boolean };
    refund?: { presentation: string; line: string; ofYear: number | null } | null;
    taxCategory: string;
    origin: string;
    flags: Flag[];
  };
  const codes = (m: Meaning) => m.flags.map((f) => f.code);

  it('rent, Hausgeld, interest, a refund and a retained deposit across the year-end; Realm isolation on the new routes', async () => {
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f7d101', 'ACTIVE', 'x') RETURNING id`,
      [REALM_A],
    );
    const flat = rows[0].id as string;
    const giro = (
      await json<{ financialAccountId: string }>(
        await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR' }),
        201,
      )
    ).financialAccountId;
    /** A confirmed Transaction with the given splits; returns its id and its first split's id. */
    const booked = async (direction: 'INFLOW' | 'OUTFLOW', bookingDate: string, splits: Record<string, unknown>[]) => {
      const total = splits.reduce((sum, s) => sum + Number((s['amount'] as { amount: string }).amount), 0).toFixed(2);
      const { transactionId } = await json<{ transactionId: string }>(
        await A('POST', '/transactions', { financialAccountId: giro, amount: eur(total), direction, bookingDate, description: 'Buchung' }),
        201,
      );
      const set = await json<{ splits: { splitId: string }[] }>(await A('PUT', `/transactions/${transactionId}/splits`, { splits }), 200);
      await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
      return { transactionId, splitId: (set.splits[0] as { splitId: string }).splitId };
    };
    const meaningOf = async (splitId: string) => json<Meaning>(await A('GET', `/transaction-splits/${splitId}/tax-meaning`), 200);
    const yearOf = async (year: number) =>
      (await json<{ items: Meaning[] }>(await A('GET', `/property-references/${flat}/tax-meanings?year=${year}&pageSize=200`), 200)).items;

    // 1. A January rent paid on 29 December 2026 and matched to its January term.
    const rent = await booked('INFLOW', '2026-12-29', [{ amount: eur('900.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: flat }]);
    await json(
      await A('POST', '/rent-reconciliations', { transactionId: rent.transactionId, mreTenantId: TENANT, mreRentTerm: JANUARY, matchedAmount: eur('900.00') }),
      201,
    );
    // Without a reference: January's year, the due date assumed.
    const assumed = await meaningOf(rent.splitId);
    expect([assumed.taxYear, codes(assumed)]).toEqual([2027, ['DUE_DATE_ASSUMED', 'ATTRIBUTED_BY_10_DAY_RULE']]);
    expect((await yearOf(2027)).map((m) => m.splitId)).toEqual([rent.splitId]);
    expect((await yearOf(2026)).map((m) => m.splitId)).toEqual([]);
    // With rentDueDays day 3: the same year, without the flag.
    const created = await A(
      'POST',
      '/rental-contract-references',
      { mreTenantId: TENANT, rentDueDays: [{ validFrom: '2025-01-01', day: 3 }] },
      { 'idempotency-key': 'rcr-1' },
    );
    const reference = await json<{ rentalContractReferenceId: string; version: number }>(created, 201);
    expect(created.headers.get('location')).toBe(`/api/v1/rental-contract-references/${reference.rentalContractReferenceId}`);
    const third = await meaningOf(rent.splitId);
    expect([third.taxYear, codes(third)]).toEqual([2027, ['ATTRIBUTED_BY_10_DAY_RULE']]);
    expect(await errorOf(await A('POST', '/rental-contract-references', { mreTenantId: TENANT }), 409)).toMatchObject({
      details: { reason: 'RENTAL_CONTRACT_REFERENCE_EXISTS', rentalContractReferenceId: reference.rentalContractReferenceId },
    });
    expect(await errorOf(await A('POST', '/rental-contract-references', { mreTenantId: '6512f0c2a1b2c3d4e5f6d0ff' }), 422)).toMatchObject({
      code: 'MRE_TENANT_NOT_FOUND',
      details: { mreTenantId: '6512f0c2a1b2c3d4e5f6d0ff' },
    });
    // With day 15 (a supplement to the lease): due outside the window, so December's year.
    const path = `/rental-contract-references/${reference.rentalContractReferenceId}`;
    expect((await A('POST', `${path}/amend`, { rentDueDays: [{ validFrom: '2025-01-01', day: 15 }] }, { 'if-match': '"9"' })).status).toBe(412);
    const amended = await json<{ version: number; rentDueDays: unknown }>(
      await A('POST', `${path}/amend`, { rentDueDays: [{ validFrom: '2025-01-01', day: 15 }] }, { 'if-match': '"1"' }),
      200,
    );
    expect(amended).toMatchObject({ version: 2, rentDueDays: [{ validFrom: '2025-01-01', day: 15 }] });
    expect(await meaningOf(rent.splitId)).toMatchObject({ taxYear: 2026, flags: [] });
    expect((await yearOf(2026)).map((m) => m.splitId)).toEqual([rent.splitId]);
    expect(await json(await A('GET', `/rental-contract-references?mreTenantId=${TENANT}`), 200)).toMatchObject({ items: [{ version: 2 }] });

    // 2. A Hausgeld debit on 30 December, from a plan with advanceDueDay 1: its booking year, ECONOMIC_PERIOD_ASSUMED.
    const weg = await json<{ wegId: string }>(await A('POST', '/wegs', { displayName: 'WEG Beispielweg 3' }), 201);
    const membership = await json<{ membershipId: string }>(
      await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '250/10000', validFrom: '2026-01-01' }),
      201,
    );
    const planBody = {
      financialYear: 2026,
      effectiveFrom: '2026-01-01',
      advanceDueDay: 1,
      monthlyHausgeld: eur('300.00'),
      monthlyReserveContribution: eur('50.00'),
      recoverableCosts: eur('2400.00'),
      nonRecoverableCosts: eur('1200.00'),
    };
    expect(await json(await A('POST', `/weg-memberships/${membership.membershipId}/economic-plans`, planBody), 201)).toMatchObject({ advanceDueDay: 1 });
    const hausgeld = await booked('OUTFLOW', '2026-12-30', [{ amount: eur('200.00'), financialCategoryCode: 'WEG_RECOVERABLE', propertyReferenceId: flat }]);
    const guessed = await meaningOf(hausgeld.splitId);
    expect([guessed.taxYear, guessed.attribution, codes(guessed)]).toEqual([
      2026,
      expect.objectContaining({ proposedYear: 2027 }),
      ['ECONOMIC_PERIOD_ASSUMED'],
    ]);
    // The user decides: classified with taxYear 2027.
    const decided = await json<{ taxYear: number }>(
      await A('POST', '/tax-classifications', {
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: hausgeld.splitId,
        taxCategory: 'WEG_HAUSGELD',
        treatment: 'DEDUCTIBLE',
        taxYear: 2027,
      }),
      201,
    );
    expect(decided.taxYear).toBe(2027);
    expect(await meaningOf(hausgeld.splitId)).toMatchObject({ taxYear: 2027, origin: 'CLASSIFICATION', attribution: { proposedYear: 2027, overridden: true } });
    expect((await yearOf(2027)).map((m) => m.splitId)).toEqual([hausgeld.splitId]);
    expect(
      await errorOf(
        await A('POST', '/tax-classifications', {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: rent.splitId,
          taxCategory: 'RENT',
          treatment: 'INCOME',
          taxYear: 2028,
        }),
        422,
      ),
    ).toMatchObject({ code: 'TAX_YEAR_OUT_OF_RANGE', details: { taxYear: 2028, bookingYear: 2026 } });

    // 3. Interest due on 2 January and debited on 30 December: December's interest, the booking year.
    const party = async (displayName: string) =>
      (await json<{ partyId: string }>(await A('POST', '/parties', { partyType: 'ORGANIZATION', displayName, legalName: displayName }), 201)).partyId;
    const loan = await json<{ loanId: string }>(
      await A('POST', '/loans', {
        lenderPartyId: await party('Bank AG'),
        borrowerPartyIds: [await party('Eigentümer GbR')],
        principalOriginal: eur('100000.00'),
        startDate: '2026-01-01',
      }),
      201,
    );
    await json(
      await A('POST', `/loans/${loan.loanId}/terms`, {
        validFrom: '2026-01-01',
        interestRate: '3.000',
        repaymentModel: 'INTEREST_ONLY',
        firstPaymentDate: '2026-01-02',
      }),
      201,
    );
    const interest = await booked('OUTFLOW', '2026-12-30', [{ amount: eur('250.00'), financialCategoryCode: 'LOAN_INTEREST', loanId: loan.loanId }]);
    expect(await meaningOf(interest.splitId)).toMatchObject({ taxYear: 2026, attribution: { proposedYear: 2026 }, flags: [] });

    // 4. A refund of an earlier year: an insurance refund in 2027 for 2026.
    const refund = await booked('INFLOW', '2027-03-15', [{ amount: eur('60.00'), financialCategoryCode: 'INSURANCE', propertyReferenceId: flat }]);
    expect((await meaningOf(refund.splitId)).flags.map((f) => f.code)).toEqual(['REFUND_YEAR_UNKNOWN']);
    await json(
      await A('POST', '/tax-classifications', {
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: refund.splitId,
        taxCategory: 'INSURANCE',
        treatment: 'DEDUCTIBLE',
        refundOfYear: 2026,
      }),
      201,
    );
    expect((await meaningOf(refund.splitId)).refund).toEqual({
      kind: 'REFUND',
      ofYear: 2026,
      ofYearSource: 'CLASSIFICATION',
      presentation: 'INCOME',
      line: 'REFUNDS_OF_EARLIER_YEARS',
    });

    // 5. A retained deposit, classified as rent compensation, in the year of the closing date.
    const deposit = await json<{ securityDepositId: string }>(await A('POST', '/security-deposits', { mreTenantId: TENANT }), 201);
    await booked('INFLOW', '2026-01-05', [{ amount: eur('3000.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: deposit.securityDepositId }]);
    await booked('OUTFLOW', '2027-06-20', [
      { amount: eur('2100.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: deposit.securityDepositId },
    ]);
    await json(
      await A('POST', `/security-deposits/${deposit.securityDepositId}/close`, {
        closingDate: '2027-06-30',
        reason: 'RETAINED',
        closingNote: 'Mietrückstand Juni',
      }),
      200,
    );
    const depositPath = `/security-deposits/${deposit.securityDepositId}/tax-meaning`;
    expect(await json(await A('GET', depositPath), 200)).toMatchObject({
      sourceType: 'DEPOSIT_CLOSING',
      counts: true,
      taxYear: 2027,
      amount: eur('900.00'),
      propertyReferenceId: flat,
      taxCategory: 'UNCLASSIFIED',
      treatment: null,
      reviewState: 'NEEDS_REVIEW',
      origin: 'DEFAULT',
    });
    expect(
      await errorOf(
        await A('POST', '/tax-classifications', {
          sourceType: 'DEPOSIT_CLOSING',
          sourceId: deposit.securityDepositId,
          taxCategory: 'RENT',
          treatment: 'INCOME',
        }),
        422,
      ),
    ).toMatchObject({ code: 'TREATMENT_NOT_ALLOWED', details: { sourceType: 'DEPOSIT_CLOSING' } });
    const compensation = await json<{ classificationId: string; depositClosing: unknown }>(
      await A('POST', '/tax-classifications', {
        sourceType: 'DEPOSIT_CLOSING',
        sourceId: deposit.securityDepositId,
        taxCategory: 'RETAINED_DEPOSIT_RENT',
        treatment: 'INCOME',
        notes: 'Einbehalt für die Junimiete',
      }),
      201,
    );
    expect(compensation.depositClosing).toEqual({ closingDate: '2027-06-30', retainedAmount: eur('900.00') });
    expect(await json(await A('GET', depositPath), 200)).toMatchObject({ origin: 'CLASSIFICATION', taxCategory: 'RETAINED_DEPOSIT_RENT', treatment: 'INCOME' });
    const in2027 = await yearOf(2027);
    expect(in2027.map((m) => [m.sourceType, m.taxCategory])).toEqual([
      ['TRANSACTION_SPLIT', 'WEG_HAUSGELD'],
      ['TRANSACTION_SPLIT', 'INSURANCE'],
      ['DEPOSIT_CLOSING', 'RETAINED_DEPOSIT_RENT'],
    ]);
    expect(
      (
        await json<{ items: { classificationId: string }[] }>(
          await A('GET', `/tax-classifications?sourceType=DEPOSIT_CLOSING&sourceId=${deposit.securityDepositId}`),
          200,
        )
      ).items.map((c) => c.classificationId),
    ).toEqual([compensation.classificationId]);

    // Realm isolation on the new routes.
    const exercised = new Set<string>();
    const isolated = async (method: string, route: string, target: string, body?: unknown) => {
      exercised.add(`${method} ${route}`);
      return B(method, target, body);
    };
    // The Tenant is not in Realm B's MRE list: 422, nothing written.
    expect((await isolated('POST', '/rental-contract-references', '/rental-contract-references', { mreTenantId: TENANT })).status).toBe(422);
    expect((await isolated('GET', '/rental-contract-references/:rentalContractReferenceId', path)).status).toBe(404);
    expect(await json(await isolated('GET', '/rental-contract-references', `/rental-contract-references?mreTenantId=${TENANT}`), 200)).toEqual({ items: [] });
    expect((await isolated('POST', '/rental-contract-references/:rentalContractReferenceId/amend', `${path}/amend`, { notes: 'x' })).status).toBe(404);
    expect((await isolated('GET', '/security-deposits/:depositId/tax-meaning', depositPath)).status).toBe(404);
    expect([...exercised].sort()).toEqual(
      routesOf(app)
        .filter((r) => VC_7_02.test(r))
        .sort(),
    );
    // The changed routes of §58A refuse Realm B too.
    expect((await B('GET', `/property-references/${flat}/tax-meanings?year=2027`)).status).toBe(404);
    expect((await B('POST', `/weg-memberships/${membership.membershipId}/economic-plans`, { ...planBody, effectiveFrom: '2026-07-01' })).status).toBe(404);
    expect(
      (
        await B('POST', '/tax-classifications', {
          sourceType: 'DEPOSIT_CLOSING',
          sourceId: deposit.securityDepositId,
          taxCategory: 'NOT_RELEVANT',
          treatment: 'NOT_RELEVANT',
        })
      ).status,
    ).toBe(404);
    // Nothing of Realm A changed: the reference keeps its version.
    expect(await json(await A('GET', path), 200)).toMatchObject({ version: 2, notes: null });
  });
});

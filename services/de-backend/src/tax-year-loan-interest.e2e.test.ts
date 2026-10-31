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
  getLoanPayments,
  getTaxYearView,
  setTransactionSplits,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresLoanAllocationRepository,
  PostgresLoanDebtRepository,
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
import { cents, codes, lineOf, type View } from './phase-7-acceptance.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-X-29 end to end (api-design.md §58D), wired as in main.ts: the section's synthetic example through the HTTP API.
 * A Loan with a monthly schedule (due on the last day of each month) and three MANUAL sets (60/40 from 2027-02-01,
 * 50/50 from 2027-07-01, 70/30 from 2028-01-01) over two PropertyReferences; four interest debits split with its
 * `loanId` and confirmed; the views of both properties for 2027 and 2028 at both levels, and Financing's payments read.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM = '64b0c0ffee000000000000d9';

describe.skipIf(databaseUrl === undefined)('the interest of an allocated Loan in the tax-year view (VC-X-29) end to end', () => {
  const schema = testSchemaName('tax_year_loan_interest_e2e');
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
    mre = await startFakeMre([{ _id: REALM, name: 'A', members: member, applications: [], tenants: [] }]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const transactions = new PostgresTransactionRepository(db);
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
        loanDebt: { payments: getLoanPayments({ repository: new PostgresLoanDebtRepository(db) }) },
        taxation: { taxYear: getTaxYearView({ repository: new PostgresTaxClassificationRepository(db) }) },
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
  const A = (method: string, path: string, body?: unknown) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: REALM, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const eur = (amount: string) => ({ amount, currency: 'EUR' });

  it('the example of §58D: per property and per owner, by the set on each booking date; the debit before S1 not attributed', async () => {
    const property = async (n: number) =>
      (
        await pool.query(
          `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
          [REALM, `6512f0c2a1b2c3d4e5f6d00${n}`],
        )
      ).rows[0].id as string;
    const [P1, P2] = [await property(1), await property(2)].sort() as [string, string];
    const party = async (displayName: string) =>
      (await json<{ partyId: string }>(await A('POST', '/parties', { partyType: 'PERSON', displayName }), 201)).partyId;
    const [ownerA, ownerB] = [await party('Eigentümerin A'), await party('Eigentümer B')].sort() as [string, string];
    const ownerC = await party('Eigentümerin C');
    for (const [pr, ownerPartyId, share] of [
      [P1, ownerA, '1/2'],
      [P1, ownerB, '1/2'],
      [P2, ownerC, '1/1'],
    ] as const) {
      await json(await A('POST', '/ownerships', { propertyReferenceId: pr, ownerPartyId, share, validFrom: '2026-01-01' }), 201);
    }
    const bank = (await json<{ partyId: string }>(await A('POST', '/parties', { partyType: 'ORGANIZATION', displayName: 'Bank Beispiel' }), 201)).partyId;
    const L = (
      await json<{ loanId: string }>(
        await A('POST', '/loans', {
          lenderPartyId: bank,
          borrowerPartyIds: [ownerA, ownerB, ownerC],
          principalOriginal: eur('180000.00'),
          startDate: '2027-01-01',
        }),
        201,
      )
    ).loanId;
    await json(
      await A('POST', `/loans/${L}/terms`, { validFrom: '2027-01-01', interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-31' }),
      201,
    );
    const sets: string[] = [];
    for (const [validFrom, s1, s2] of [
      ['2027-02-01', '3/5', '2/5'],
      ['2027-07-01', '1/2', '1/2'],
      ['2028-01-01', '7/10', '3/10'],
    ] as const) {
      const body = {
        validFrom,
        basis: 'MANUAL',
        allocations: [
          { propertyReferenceId: P1, share: s1 },
          { propertyReferenceId: P2, share: s2 },
        ],
      };
      sets.push((await json<{ allocationSetId: string }>(await A('POST', `/loans/${L}/allocations`, body), 201)).allocationSetId);
    }
    const giro = (
      await json<{ financialAccountId: string }>(await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }), 201)
    ).financialAccountId;
    const debit = async (bookingDate: string, amount: string) => {
      const { transactionId } = await json<{ transactionId: string }>(
        await A('POST', '/transactions', { financialAccountId: giro, amount: eur(amount), direction: 'OUTFLOW', bookingDate }),
        201,
      );
      const set = await json<{ splits: { splitId: string }[] }>(
        await A('PUT', `/transactions/${transactionId}/splits`, { splits: [{ amount: eur(amount), financialCategoryCode: 'LOAN_INTEREST', loanId: L }] }),
        200,
      );
      await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
      return set.splits[0]?.splitId as string;
    };
    const before = await debit('2027-01-29', '451.20');
    const march = await debit('2027-03-31', '450.01');
    const july = await debit('2027-07-30', '449.99');
    const moved = await debit('2028-01-03', '448.00');

    const view = async (pr: string, year: number, ownerPartyId?: string) =>
      json<View>(await A('GET', `/property-references/${pr}/tax-years/${year}${ownerPartyId === undefined ? '' : `?ownerPartyId=${ownerPartyId}`}`), 200);
    const snapshot = await rowsSnapshot(pool);
    const [v1, v2] = [await view(P1, 2027), await view(P2, 2027)];
    const parts = (v: View) =>
      lineOf(v, 'LOAN_INTEREST').items.map((i) => [i.sourceId, i.date, i.taxYear, i.lineAmount?.amount, i.loanAllocation?.allocationSetId]);
    expect(parts(v1)).toEqual([
      [march, '2027-03-31', 2027, '270.01', sets[0]],
      [july, '2027-07-30', 2027, '225.00', sets[1]],
      [moved, '2028-01-03', 2027, '313.60', sets[2]],
    ]);
    expect(parts(v2).map((p) => p[3])).toEqual(['180.00', '224.99', '134.40']);
    expect([lineOf(v1, 'LOAN_INTEREST').total, lineOf(v2, 'LOAN_INTEREST').total]).toEqual([eur('808.61'), eur('539.39')]);
    expect(cents(lineOf(v1, 'LOAN_INTEREST').total) + cents(lineOf(v2, 'LOAN_INTEREST').total)).toBe(134800n);
    // The 10-day rule moved the 2028-01-03 debit into 2027 (due 2027-12-31), open while its origin is DEFAULT.
    expect(codes(lineOf(v1, 'LOAN_INTEREST').items[2]?.flags ?? [])).toEqual(['ATTRIBUTED_BY_10_DAY_RULE']);
    const owners = (v: View) => v.owners?.map((o) => [o.ownerPartyId, o.werbungskosten.total.amount]);
    expect([owners(v1), owners(v2)]).toEqual([
      [
        [ownerA, '404.31'],
        [ownerB, '404.30'],
      ],
      [[ownerC, '539.39']],
    ]);
    const a = await view(P1, 2027, ownerA);
    expect(lineOf(a, 'LOAN_INTEREST').items.map((i) => [i.lineAmount?.amount, i.share?.share, i.loanAllocation?.propertyPart?.amount])).toEqual([
      ['135.01', '1/2', '270.01'],
      ['112.50', '1/2', '225.00'],
      ['156.80', '1/2', '313.60'],
    ]);
    expect(lineOf(await view(P1, 2027, ownerB), 'LOAN_INTEREST').items.map((i) => i.lineAmount?.amount)).toEqual(['135.00', '112.50', '156.80']);
    for (const v of [v1, v2, a, await view(P2, 2027, ownerC)]) {
      expect(v.notAttributed.items.map((i) => [i.sourceId, i.lineAmount, i.share, i.reason, i.candidates])).toEqual([
        [before, null, null, 'NO_LOAN_ALLOCATION', [P1, P2]],
      ]);
      expect(v.flags.find((f) => f.code === 'LOAN_INTEREST_NOT_ATTRIBUTED')?.details).toEqual({
        loanIds: [L],
        interestTotal: eur('451.20'),
        splitIds: [before],
      });
      expect(v.review.open).toContainEqual({ code: 'LOAN_INTEREST_NOT_ATTRIBUTED', count: 1 });
      expect(v.review.final).toBe(false);
    }
    // 2028: the moved debit is 2027's; neither view lists or flags it.
    for (const pr of [P1, P2]) {
      const y2028 = await view(pr, 2028);
      expect([lineOf(y2028, 'LOAN_INTEREST').items, y2028.notAttributed.items, codes(y2028.flags)]).toEqual([[], [], ['DEPRECIATION_NOT_AVAILABLE']]);
    }
    // Financing's payments read refuses the year the view shows with its gap (§41.6).
    const payments = await json<{ error: { details: Record<string, unknown> } }>(await A('GET', `/loans/${L}/payments?year=2027&perProperty=true`), 409);
    expect(payments.error.details).toMatchObject({ reason: 'LOAN_NOT_ALLOCATED', bookingDate: '2027-01-29' });
    // The views wrote nothing.
    expect(await rowsSnapshot(pool)).toEqual(snapshot);
  });
});

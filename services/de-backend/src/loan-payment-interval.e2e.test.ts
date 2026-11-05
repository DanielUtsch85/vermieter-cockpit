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
  getLoanSchedule,
  getPaymentProposal,
  getRemainingDebt,
  getTaxYearView,
  listLoanTerms,
  setTransactionSplits,
  voidLoanTerms,
} from './application/index.js';
import { sha256Fingerprinter } from './infrastructure/hashing/index.js';
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
import type { Json as View } from './phase-8-acceptance.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-X-53 end to end (api-design.md §58O; Entscheidung des Projektinhabers, 2026-11-05, questions 1–12), wired as in
 * main.ts, synthetic values only: Loan Q quarterly through the HTTP API (terms, schedule, remaining debt at three dates,
 * per property), its 2027 tax-year view at both levels, the deviation flag's three cases, Loan F's stub through the
 * purpose text, the proposal, the rebase and the flag once, the reads writing nothing, and Realm isolation.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM_A = '64b0c0ffee0000000000f53a';
const REALM_B = '64b0c0ffee0000000000f53b';

describe.skipIf(databaseUrl === undefined)('the payment interval (VC-X-53) end to end', () => {
  const schema = testSchemaName('loan_payment_interval_e2e');
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
    const terms = new PostgresLoanTermsRepository(db);
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
        loanTerms: {
          create: createLoanTerms({ repository: terms }),
          void: voidLoanTerms({ repository: terms }),
          list: listLoanTerms({ repository: terms }),
          schedule: getLoanSchedule({ repository: terms }),
          proposal: getPaymentProposal({ repository: terms }),
        },
        loanDebt: { remainingDebt: getRemainingDebt({ repository: new PostgresLoanDebtRepository(db) }) },
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
  const json = async <T = View>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  let counter = 0;

  /** One Realm's world: P1 < P2, A and B owning P1 half each (A < B), C owning P2; S1 P1 from 2027-01-01, S2 half each from 2027-03-01. */
  async function world(realm: string) {
    const A = (method: string, path: string, body?: unknown) => call(realm, method, path, body);
    const property = async () =>
      (
        await pool.query(
          `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
          [realm, (0x6512f0c2a1b2c3d4e5f9f500n + BigInt(++counter)).toString(16).padStart(24, '0')],
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
    const giro = (
      await json<{ financialAccountId: string }>(await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }), 201)
    ).financialAccountId;
    const loan = async (terms: Record<string, unknown>, disbursementDate?: string) => {
      const loanId = (
        await json<{ loanId: string }>(
          await A('POST', '/loans', {
            lenderPartyId: await party('Bank Beispiel (synthetisch)', 'ORGANIZATION'),
            borrowerPartyIds: [a, b, c],
            principalOriginal: eur('120000.00'),
            startDate: '2027-01-01',
            ...(disbursementDate === undefined ? {} : { disbursementDate }),
          }),
          201,
        )
      ).loanId;
      const created = await json(
        await A('POST', `/loans/${loanId}/terms`, {
          validFrom: disbursementDate ?? '2027-01-01',
          interestRate: '3.000',
          repaymentModel: 'ANNUITY',
          ...terms,
        }),
        201,
      );
      // A Loan paid out later (Loan F) has one set from its debtFrom, P1 alone.
      const sets = disbursementDate === undefined ? undefined : ([[disbursementDate, [{ propertyReferenceId: P1, share: '1/1' }]]] as const);
      for (const [validFrom, allocations] of sets ??
        ([
          ['2027-01-01', [{ propertyReferenceId: P1, share: '1/1' }]],
          [
            '2027-03-01',
            [
              { propertyReferenceId: P1, share: '1/2' },
              { propertyReferenceId: P2, share: '1/2' },
            ],
          ],
        ] as const)) {
        await json(await A('POST', `/loans/${loanId}/allocations`, { validFrom, basis: 'MANUAL', allocations }), 201);
      }
      return { loanId, termsId: created.termsId as string, created };
    };
    const transaction = async (amount: string, bookingDate: string, description?: string) =>
      (
        await json<{ transactionId: string }>(
          await A('POST', '/transactions', {
            financialAccountId: giro,
            amount: eur(amount),
            direction: 'OUTFLOW',
            bookingDate,
            ...(description === undefined ? {} : { description }),
          }),
          201,
        )
      ).transactionId;
    const confirm = async (transactionId: string, splits: readonly View[]) => {
      const set = await json<{ splits: { splitId: string; financialCategoryCode: string }[] }>(
        await A('PUT', `/transactions/${transactionId}/splits`, { splits }),
        200,
      );
      await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
      return set.splits.find((s) => s.financialCategoryCode === 'LOAN_INTEREST')?.splitId as string;
    };
    const pay = async (loanId: string, bookingDate: string, interest: string, principal: string) => {
      const total = ((Math.round(Number(interest) * 100) + Math.round(Number(principal) * 100)) / 100).toFixed(2);
      return confirm(await transaction(total, bookingDate), [
        { amount: eur(interest), financialCategoryCode: 'LOAN_INTEREST', loanId },
        { amount: eur(principal), financialCategoryCode: 'LOAN_PRINCIPAL', loanId },
      ]);
    };
    const view = async (pr: string, year: number, ownerPartyId?: string) =>
      json(await A('GET', `/property-references/${pr}/tax-years/${year}${ownerPartyId === undefined ? '' : `?ownerPartyId=${ownerPartyId}`}`), 200);
    return { A, P1, P2, a, b, c, loan, transaction, confirm, pay, view };
  }
  const interest = (v: View): View[] => v.werbungskosten.lines.find((l: View) => l.taxCategory === 'LOAN_INTEREST')?.items ?? [];
  const amounts = (v: View) => interest(v).map((i: View) => i.lineAmount?.amount);
  const total = (v: View) => v.werbungskosten.lines.find((l: View) => l.taxCategory === 'LOAN_INTEREST')?.total.amount;
  const deviation = (v: View, sourceId: string) =>
    interest(v)
      .find((i: View) => i.sourceId === sourceId)
      ?.flags.find((f: View) => f.code === 'INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE');
  const quarterly = { scheduledPayment: eur('1800.00'), firstPaymentDate: '2027-03-31', paymentIntervalMonths: 3 };

  it('Loan Q: terms, schedule, remaining debt at three dates and per property, the 2027 view at both levels; reads write nothing', async () => {
    const w = await world(REALM_A);
    const Q = await w.loan(quarterly);
    expect(Q.created).toMatchObject({ paymentIntervalMonths: 3, scheduledPayment: eur('1800.00') });
    expect((await json(await w.A('GET', `/loans/${Q.loanId}/terms`), 200)).items.map((t: View) => t.paymentIntervalMonths)).toEqual([3]);
    const schedule = await json(await w.A('GET', `/loans/${Q.loanId}/schedule?to=2027-12-31`), 200);
    expect(schedule.items.map((e: View) => [e.paymentDate, e.interest.amount, e.principal.amount, e.balanceAfter.amount, e.flags])).toEqual([
      ['2027-03-31', '900.00', '900.00', '119100.00', []],
      ['2027-06-30', '893.25', '906.75', '118193.25', []],
      ['2027-09-30', '886.45', '913.55', '117279.70', []],
      ['2027-12-31', '879.60', '920.40', '116359.30', []],
    ]);
    expect(schedule.rebasedOn).toBeNull();
    const splits = [
      await w.pay(Q.loanId, '2027-03-31', '900.00', '900.00'),
      await w.pay(Q.loanId, '2027-06-30', '893.25', '906.75'),
      await w.pay(Q.loanId, '2027-09-30', '886.45', '913.55'),
      await w.pay(Q.loanId, '2027-12-31', '879.60', '920.40'),
    ];
    const snapshot = await rowsSnapshot(pool);
    const debt = async (asOf: string, perProperty = false) =>
      json(await w.A('GET', `/loans/${Q.loanId}/remaining-debt?asOf=${asOf}${perProperty ? '&perProperty=true' : ''}`), 200);
    for (const [asOf, balance] of [
      ['2027-02-15', '120000.00'],
      ['2027-05-15', '119100.00'],
      ['2027-12-31', '116359.30'],
    ] as const) {
      expect(await debt(asOf)).toMatchObject({
        actual: eur(balance),
        planned: eur(balance),
        difference: eur('0.00'),
        plannedAsContracted: eur(balance),
        differenceAsContracted: eur('0.00'),
      });
    }
    expect((await debt('2027-05-15', true)).items.map((i: View) => [i.actual.amount, i.planned.amount])).toEqual([
      ['59550.00', '59550.00'],
      ['59550.00', '59550.00'],
    ]);
    // Booked as planned: the schedule is the contract's, no flag.
    expect((await json(await w.A('GET', `/loans/${Q.loanId}/schedule?to=2027-12-31`), 200)).items.every((e: View) => e.flags.length === 0)).toBe(true);
    const [v1, v2] = [await w.view(w.P1, 2027), await w.view(w.P2, 2027)];
    expect(amounts(v1)).toEqual(['745.00', '446.63', '443.23', '439.80']);
    expect(amounts(v2)).toEqual(['155.00', '446.62', '443.22', '439.80']);
    expect([total(v1), total(v2)]).toEqual(['2074.66', '1484.64']);
    expect(interest(v1)[0].loanAllocation.interestPeriod).toEqual({ from: '2027-01-01', until: '2027-03-31', source: 'LOAN_SCHEDULE' });
    expect(amounts(await w.view(w.P1, 2027, w.a))).toEqual(['372.50', '223.32', '221.62', '219.90']);
    expect(amounts(await w.view(w.P2, 2027, w.c))).toEqual(['155.00', '446.62', '443.22', '439.80']);
    expect(interest(v1).map((i: View) => i.sourceId)).toEqual(splits);
    expect(await rowsSnapshot(pool)).toEqual(snapshot);
  });

  it('the deviation flag: entered without the interval and recorded as the quarter open; with the interval none; off by a day informative', async () => {
    const w = await world(REALM_A);
    const monthlyEntered = await w.loan({ ...quarterly, paymentIntervalMonths: undefined });
    const m = await w.pay(monthlyEntered.loanId, '2027-03-31', '300.00', '1500.00');
    await json(
      await w.A('POST', '/tax-classifications', {
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: m,
        taxCategory: 'LOAN_INTEREST',
        treatment: 'DEDUCTIBLE',
        sourceReferences: ['Zinsbescheinigung (synthetisch)'],
        interestPeriod: { from: '2027-01-01', until: '2027-03-31' },
      }),
      201,
    );
    const v1 = await w.view(w.P1, 2027);
    expect(deviation(v1, m)?.details).toMatchObject({
      loanId: monthlyEntered.loanId,
      recorded: { from: '2027-01-01', until: '2027-03-31' },
      schedule: { from: '2027-03-01', until: '2027-03-31' },
      termsId: monthlyEntered.termsId,
      paymentIntervalMonths: 1,
      partsDiffer: true,
    });
    expect(v1.review.open).toContainEqual({ code: 'INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE', count: 1 });
    expect(deviation(await w.view(w.P2, 2027, w.c), m)?.details.partsDiffer).toBe(true);

    const Q = await w.loan(quarterly);
    const q = await w.pay(Q.loanId, '2027-03-31', '900.00', '900.00');
    const june = await w.pay(Q.loanId, '2027-06-30', '893.25', '906.75');
    for (const [sourceId, from, until] of [
      [q, '2027-01-01', '2027-03-31'],
      [june, '2027-04-02', '2027-07-01'],
    ] as const) {
      await json(
        await w.A('POST', '/tax-classifications', {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId,
          taxCategory: 'LOAN_INTEREST',
          treatment: 'DEDUCTIBLE',
          sourceReferences: ['Zinsbescheinigung (synthetisch)'],
          interestPeriod: { from, until },
        }),
        201,
      );
    }
    const v = await w.view(w.P1, 2027);
    expect(deviation(v, q)).toBeUndefined();
    expect(interest(v).find((i: View) => i.sourceId === q)?.loanAllocation.interestPeriod.source).toBe('LOAN_SCHEDULE');
    expect(deviation(v, june)?.details.partsDiffer).toBe(false);
    expect(v.review.info).toContainEqual({ code: 'INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE', count: 1 });
  });

  it('Loan F: the stub from the purpose text, the rebase, the flag once; Realm isolation', async () => {
    const w = await world(REALM_A);
    const F = await w.loan({ scheduledPayment: eur('600.00'), firstPaymentDate: '2027-05-31' }, '2027-04-25');
    const text = 'BBBANK DARLEHEN RECHN.ZINS 360,00 TILG./ENTG. 240,00 TILGUNG PER 31.05.2027';
    const may = await w.transaction('600.00', '2027-05-31', text);
    const proposal = await json(await w.A('GET', `/loans/${F.loanId}/payment-proposal?transactionId=${may}`), 200);
    expect(proposal).toMatchObject({
      source: 'PURPOSE_TEXT',
      purposeFormat: 'BBBANK_LOAN_DEBIT',
      splits: [
        { financialCategoryCode: 'LOAN_INTEREST', amount: eur('360.00') },
        { financialCategoryCode: 'LOAN_PRINCIPAL', amount: eur('240.00') },
      ],
      scheduleSplit: { interest: eur('300.00'), principal: eur('300.00') },
      flags: [{ code: 'SPLIT_DIFFERS_FROM_SCHEDULE' }],
    });
    // Another Realm sees neither the Loan nor the Transaction.
    await json(await call(REALM_B, 'GET', `/loans/${F.loanId}/payment-proposal?transactionId=${may}`), 404);
    await w.confirm(may, proposal.splits);
    const june = await w.transaction('600.00', '2027-06-30', 'RECHN.ZINS 299,40 TILG./ENTG. 300,60 TILGUNG PER 30.06.2027');
    const juneProposal = await json(await w.A('GET', `/loans/${F.loanId}/payment-proposal?transactionId=${june}`), 200);
    expect(juneProposal).toMatchObject({ source: 'PURPOSE_TEXT', scheduleSplit: { interest: eur('299.25'), principal: eur('300.75') } });
    expect(await json(await w.A('GET', `/loans/${F.loanId}/remaining-debt?asOf=2027-06-15`), 200)).toMatchObject({
      actual: eur('119760.00'),
      planned: eur('119760.00'),
      difference: eur('0.00'),
      plannedAsContracted: eur('119700.00'),
      differenceAsContracted: eur('60.00'),
      rebasedOn: { bookingDate: '2027-05-31', entryNumber: 1, actualBalance: eur('119760.00'), flags: [{ code: 'BOOKED_SPLIT_DIFFERS_FROM_PLAN' }] },
    });
    await w.confirm(june, juneProposal.splits);
    const schedule = await json(await w.A('GET', `/loans/${F.loanId}/schedule?to=2027-07-31`), 200);
    expect(schedule.items.map((e: View) => [e.number, e.interest.amount, e.principal.amount, e.balanceAfter.amount, e.flags.map((f: View) => f.code)])).toEqual(
      [
        [1, '300.00', '300.00', '119700.00', ['BOOKED_SPLIT_DIFFERS_FROM_PLAN']],
        [2, '299.40', '300.60', '119459.40', []],
        [3, '298.65', '301.35', '119158.05', []],
      ],
    );
    expect(schedule.items[0].flags[0].details).toMatchObject({ booked: { interest: eur('360.00'), principal: eur('240.00') } });
    expect(schedule.rebasedOn).toMatchObject({ bookingDate: '2027-06-30', entryNumber: 2, actualBalance: eur('119459.40'), flags: [] });
    // The tax-year view: the debit's interest by its split (360.00), its §58L period the plan's month.
    const v = await w.view(w.P1, 2027);
    const stub = interest(v).find((i: View) => i.lineAmount?.amount === '360.00');
    expect(stub?.loanAllocation.interestPeriod).toEqual({ from: '2027-05-01', until: '2027-05-31', source: 'LOAN_SCHEDULE' });

    // Realm isolation: the same Loan in Realm B with the interval 12 changes nothing in A; A's Loan is not B's.
    const wb = await world(REALM_B);
    await wb.loan({ scheduledPayment: eur('7200.00'), firstPaymentDate: '2027-05-31', paymentIntervalMonths: 12 }, '2027-04-25');
    await json(await call(REALM_B, 'GET', `/loans/${F.loanId}/schedule`), 404);
    expect((await json(await w.A('GET', `/loans/${F.loanId}/schedule?to=2027-07-31`), 200)).items).toEqual(schedule.items);
  });

  it('a monthly Loan: the tax-year view with the interval omitted and with an explicit 1 is the same JSON byte for byte', async () => {
    const w = await world(REALM_A);
    const M = await w.loan({ repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-31' });
    for (const [bookingDate, amount] of [
      ['2027-03-31', '300.00'],
      ['2027-06-30', '300.00'],
      // The 10-day rule: due 2027-12-31, booked 2028-01-03, 2027.
      ['2028-01-03', '300.00'],
    ] as const)
      await w.confirm(await w.transaction(amount, bookingDate), [{ amount: eur(amount), financialCategoryCode: 'LOAN_INTEREST', loanId: M.loanId }]);
    const render = async () => [
      await (await w.A('GET', `/property-references/${w.P1}/tax-years/2027`)).text(),
      await (await w.A('GET', `/property-references/${w.P2}/tax-years/2027?ownerPartyId=${w.c}`)).text(),
    ];
    const omitted = await render();
    expect(JSON.parse(omitted[0] as string).werbungskosten.lines.find((l: View) => l.taxCategory === 'LOAN_INTEREST').items).toHaveLength(3);
    await json(await w.A('POST', `/loans/${M.loanId}/terms/${M.termsId}/void`, { reason: 'mit Intervall neu erfasst' }), 200);
    const again = await json(
      await w.A('POST', `/loans/${M.loanId}/terms`, {
        validFrom: '2027-01-01',
        interestRate: '3.000',
        repaymentModel: 'INTEREST_ONLY',
        firstPaymentDate: '2027-01-31',
        paymentIntervalMonths: 1,
      }),
      201,
    );
    expect(again.paymentIntervalMonths).toBe(1);
    // The void and the re-entry are LoanTerms records like any other: the same plan, so no split moves and no flag appears.
    expect(await render()).toEqual(omitted);
  });
});

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IdempotencyKeyConflictError,
  LoanClosedOnError,
  LoanNotActiveError,
  LoanNotFoundError,
  LoanTermsNotFoundError,
  NoScheduleError,
  PaymentNotProposableError,
  ProposalTransactionNotFoundError,
  TermsNotLastError,
  TermsRefusedError,
  VersionConflictError,
  type CreateLoanTermsInput,
  type LoanTermsView,
  type PaymentProposalResult,
  type Schedule,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-3-02 HTTP contract (api-design.md §41.2). */
const REALM = '64b0c0ffee0000000000000a';
const LOAN = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const TERMS = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const view = {
  id: TERMS,
  loanId: LOAN,
  mreRealmId: REALM,
  status: 'VALID',
  validFrom: '2026-09-01',
  validUntil: null,
  interestRate: 3450n,
  repaymentModel: 'ANNUITY',
  scheduledPayment: Money.of('1250.00', 'EUR'),
  firstPaymentDate: '2026-10-01',
  principalAtStart: null,
  fixedRateUntil: '2036-08-31',
  initialRepaymentRate: 2000n,
  specialRepaymentLimit: null,
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2026-08-20T10:00:00Z'),
  version: 1,
} as unknown as LoanTermsView;

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });
let server: Server | undefined;

async function start(commands: CommandOverrides): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith(commands) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const headers = { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json' };
const call = (base: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1${path}`, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; details?: unknown } }).error;
const body = {
  validFrom: '2026-09-01',
  interestRate: '3.45',
  repaymentModel: 'ANNUITY',
  scheduledPayment: { amount: '1250.00', currency: 'EUR' },
  firstPaymentDate: '2026-10-01',
  fixedRateUntil: '2036-08-31',
  initialRepaymentRate: '2',
};

describe('POST /api/v1/loans/{id}/terms', () => {
  it('201 with the period, rates with three decimals, ETag; a replay is marked', async () => {
    const seen: CreateLoanTermsInput[] = [];
    let replayed = false;
    const base = await start({
      loanTerms: {
        create: async (input) => {
          seen.push(input);
          const answer = { terms: view, replayed };
          replayed = true;
          return answer;
        },
      },
    });
    const res = await call(base, 'POST', `/loans/${LOAN}/terms`, body, { 'idempotency-key': 't1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.json()).toEqual({
      termsId: TERMS,
      loanId: LOAN,
      status: 'VALID',
      validFrom: '2026-09-01',
      validUntil: null,
      interestRate: '3.450',
      repaymentModel: 'ANNUITY',
      scheduledPayment: { amount: '1250.00', currency: 'EUR' },
      firstPaymentDate: '2026-10-01',
      principalAtStart: null,
      fixedRateUntil: '2036-08-31',
      initialRepaymentRate: '2.000',
      specialRepaymentLimit: null,
      notes: null,
      voidedAt: null,
      voidReason: null,
      createdAt: '2026-08-20T10:00:00.000Z',
      version: 1,
    });
    expect(seen[0]).toMatchObject({
      loanId: LOAN,
      interestRate: 3450n,
      initialRepaymentRate: 2000n,
      principalAtStart: null,
      specialRepaymentLimit: null,
      idempotencyKey: 't1',
    });
    expect((await call(base, 'POST', `/loans/${LOAN}/terms`, body, { 'idempotency-key': 't1' })).headers.get('idempotent-replayed')).toBe('true');
  });

  it('400 with the field codes', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', `/loans/${LOAN}/terms`, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({ ...body, interestRate: '100' })).toEqual([{ field: 'interestRate', code: 'OUT_OF_RANGE' }]);
    expect(await fieldsOf({ ...body, interestRate: '3.4567' })).toEqual([{ field: 'interestRate', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf({ ...body, interestRate: '-1' })).toEqual([{ field: 'interestRate', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf({ ...body, interestRate: 3.45 })).toEqual([{ field: 'interestRate', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf({ ...body, repaymentModel: 'LINEAR' })).toEqual([{ field: 'repaymentModel', code: 'INVALID_FORMAT' }]);
    const { scheduledPayment: _payment, ...withoutPayment } = body;
    expect(await fieldsOf(withoutPayment)).toEqual([{ field: 'scheduledPayment', code: 'REQUIRED' }]);
    expect(await fieldsOf({ ...body, repaymentModel: 'INTEREST_ONLY' })).toEqual([{ field: 'scheduledPayment', code: 'NOT_ALLOWED_FOR_MODEL' }]);
    expect(await fieldsOf({ ...body, scheduledPayment: { amount: '0.00', currency: 'EUR' } })).toEqual([
      { field: 'scheduledPayment.amount', code: 'NOT_POSITIVE' },
    ]);
    expect(await fieldsOf({ ...body, principalAtStart: { amount: '0.00', currency: 'EUR' } })).toEqual([
      { field: 'principalAtStart.amount', code: 'NOT_POSITIVE' },
    ]);
    expect(await fieldsOf({ ...body, firstPaymentDate: '2026-08-31' })).toEqual([{ field: 'firstPaymentDate', code: 'BEFORE_VALID_FROM' }]);
    expect(await fieldsOf({ ...body, fixedRateUntil: '2026-08-31' })).toEqual([{ field: 'fixedRateUntil', code: 'BEFORE_VALID_FROM' }]);
    await fieldsOf({ ...body, paymentFrequency: 'MONTHLY' });
    await fieldsOf({ ...body, validFrom: 'x' });
    expect((await call(base, 'POST', '/loans/x/terms', body)).status).toBe(400);
  });

  it.each([
    [new LoanNotFoundError(LOAN), 404, 'NOT_FOUND', { loanId: LOAN }],
    [new LoanNotActiveError(LOAN, 'VOID'), 409, 'CONFLICT', { reason: 'LOAN_NOT_ACTIVE', status: 'VOID' }],
    [new TermsRefusedError({ kind: 'TERMS_BEFORE_DEBT', debtFrom: '2026-09-01' as never }), 422, 'TERMS_BEFORE_DEBT', { debtFrom: '2026-09-01' }],
    [new TermsRefusedError({ kind: 'TERMS_NOT_APPENDED', lastValidFrom: '2026-09-01' as never }), 422, 'TERMS_NOT_APPENDED', { lastValidFrom: '2026-09-01' }],
    [
      new TermsRefusedError({ kind: 'PREVIOUS_TERMS_WITHOUT_PAYMENT', termsId: TERMS, firstPaymentDate: '2026-10-01' as never }),
      422,
      'PREVIOUS_TERMS_WITHOUT_PAYMENT',
      { termsId: TERMS, firstPaymentDate: '2026-10-01' },
    ],
    [new TermsRefusedError({ kind: 'PRINCIPAL_AT_START_ON_FIRST_TERMS' }), 422, 'PRINCIPAL_AT_START_ON_FIRST_TERMS', undefined],
    [
      new TermsRefusedError({ kind: 'PRINCIPAL_AT_START_EXCEEDS_ORIGINAL', principalOriginal: Money.of('100000.00', 'EUR') }),
      422,
      'PRINCIPAL_AT_START_EXCEEDS_ORIGINAL',
      { principalOriginal: { amount: '100000.00', currency: 'EUR' } },
    ],
    [
      new TermsRefusedError({ kind: 'PAYMENT_DOES_NOT_COVER_INTEREST', firstInterest: 24_875n, balance: 9_949_938n }),
      422,
      'PAYMENT_DOES_NOT_COVER_INTEREST',
      { firstInterest: { amount: '248.75', currency: 'EUR' }, balance: { amount: '99499.38', currency: 'EUR' } },
    ],
    [new IdempotencyKeyConflictError('x'), 409, 'CONFLICT', undefined],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ loanTerms: { create: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', `/loans/${LOAN}/terms`, body);
    expect(res.status).toBe(status);
    const answer = await errorOf(res);
    expect(answer.code).toBe(code);
    expect(answer.details).toEqual(details);
  });
});

describe('POST /api/v1/loans/{id}/terms/{termsId}/void', () => {
  it('200 with the period; the reason is required; If-Match carries the versions', async () => {
    const seen: unknown[] = [];
    const base = await start({
      loanTerms: {
        void: async (input) => {
          seen.push(input);
          return { terms: { ...view, status: 'VOID', voidReason: input.reason, version: 2 } as LoanTermsView, changed: true };
        },
      },
    });
    const res = await call(base, 'POST', `/loans/${LOAN}/terms/${TERMS}/void`, { reason: ' falsch ' }, { 'if-match': '"1"' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'VOID', voidReason: 'falsch', version: 2 });
    expect(seen[0]).toMatchObject({ loanId: LOAN, termsId: TERMS, expectedVersions: [1] });
    expect((await call(base, 'POST', `/loans/${LOAN}/terms/${TERMS}/void`, {})).status).toBe(400);
  });

  it.each([
    [new LoanTermsNotFoundError(TERMS), 404, 'NOT_FOUND', { termsId: TERMS }],
    [new LoanNotActiveError(LOAN, 'CLOSED'), 409, 'CONFLICT', { reason: 'LOAN_NOT_ACTIVE', status: 'CLOSED' }],
    [new TermsNotLastError(TERMS, LOAN), 409, 'CONFLICT', { reason: 'TERMS_NOT_LAST', laterTermsId: LOAN }],
    [new VersionConflictError([1], 2), 412, 'VERSION_CONFLICT', { expectedVersions: [1], currentVersion: 2 }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ loanTerms: { void: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', `/loans/${LOAN}/terms/${TERMS}/void`, { reason: 'x' });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});

describe('GET /api/v1/loans/{id}/terms', () => {
  it('the items; ?status reaches the read; unknown parameters 400; an unknown Loan 404', async () => {
    const seen: unknown[] = [];
    const base = await start({
      loanTerms: {
        list: async (input) => {
          seen.push(input);
          if (input.loanId !== LOAN) throw new LoanNotFoundError(input.loanId);
          return [view];
        },
      },
    });
    const res = await call(base, 'GET', `/loans/${LOAN}/terms?status=VALID`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ termsId: TERMS, interestRate: '3.450' }] });
    expect(seen[0]).toMatchObject({ loanId: LOAN, status: 'VALID' });
    expect((await call(base, 'GET', `/loans/${LOAN}/terms?page=1`)).status).toBe(400);
    expect((await call(base, 'GET', `/loans/${TERMS}/terms`)).status).toBe(404);
  });
});

describe('GET /api/v1/loans/{id}/schedule', () => {
  const schedule = {
    entries: [
      {
        number: 2,
        termsId: TERMS,
        paymentDate: '2027-02-28',
        balanceBefore: 70_500n,
        interest: 353n,
        principal: 29_647n,
        payment: 30_000n,
        balanceAfter: 40_853n,
      },
    ],
    summary: {
      payments: 4,
      firstPaymentDate: '2027-01-31',
      lastPaymentDate: '2027-04-30',
      totalInterest: 1_112n,
      totalPrincipal: 100_000n,
      balanceDue: 0n,
      endReason: 'PAID_OFF',
      fixedRateEnd: { date: '2027-02-28', balance: 40_853n },
    },
  } as unknown as Schedule;

  it('the items as Money with their numbers, the summary; from/to reach the read; BEFORE_FROM; unknown parameters 400; an unknown Loan 404', async () => {
    const seen: unknown[] = [];
    const base = await start({
      loanTerms: {
        schedule: async (input) => {
          seen.push(input);
          if (input.loanId !== LOAN) throw new LoanNotFoundError(input.loanId);
          return schedule;
        },
      },
    });
    const res = await call(base, 'GET', `/loans/${LOAN}/schedule?from=2027-02-01&to=2027-02-28`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      loanId: LOAN,
      from: '2027-02-01',
      to: '2027-02-28',
      items: [
        {
          number: 2,
          paymentDate: '2027-02-28',
          termsId: TERMS,
          balanceBefore: { amount: '705.00', currency: 'EUR' },
          interest: { amount: '3.53', currency: 'EUR' },
          principal: { amount: '296.47', currency: 'EUR' },
          payment: { amount: '300.00', currency: 'EUR' },
          balanceAfter: { amount: '408.53', currency: 'EUR' },
        },
      ],
      summary: {
        payments: 4,
        firstPaymentDate: '2027-01-31',
        lastPaymentDate: '2027-04-30',
        totalInterest: { amount: '11.12', currency: 'EUR' },
        totalPrincipal: { amount: '1000.00', currency: 'EUR' },
        balanceDue: { amount: '0.00', currency: 'EUR' },
        endReason: 'PAID_OFF',
        fixedRateEnd: { date: '2027-02-28', balance: { amount: '408.53', currency: 'EUR' } },
      },
    });
    expect(seen[0]).toMatchObject({ loanId: LOAN, from: '2027-02-01', to: '2027-02-28' });
    expect(await (await call(base, 'GET', `/loans/${LOAN}/schedule`)).json()).toMatchObject({ from: null, to: null });
    expect(seen[1]).not.toHaveProperty('from');
    expect(seen[1]).not.toHaveProperty('to');
    const reversed = await call(base, 'GET', `/loans/${LOAN}/schedule?from=2027-03-01&to=2027-02-28`);
    expect(reversed.status).toBe(400);
    expect(((await errorOf(reversed)).details as { fields: unknown[] }).fields).toEqual([{ field: 'to', code: 'BEFORE_FROM' }]);
    expect((await call(base, 'GET', `/loans/${LOAN}/schedule?from=2027-02-28&to=2027-02-28`)).status).toBe(200);
    expect((await call(base, 'GET', `/loans/${LOAN}/schedule?from=x`)).status).toBe(400);
    expect((await call(base, 'GET', `/loans/${LOAN}/schedule?version=1`)).status).toBe(400);
    expect((await call(base, 'GET', '/loans/x/schedule')).status).toBe(400);
    const missing = await call(base, 'GET', `/loans/${TERMS}/schedule`);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).details).toEqual({ loanId: TERMS });
  });
});

describe('GET /api/v1/loans/{id}/payment-proposal', () => {
  const TX = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
  const proposal = {
    kind: 'PROPOSAL',
    loanId: LOAN,
    transactionId: TX,
    bookingDate: '2027-03-01',
    amount: 40_000n,
    entry: {
      number: 2,
      paymentDate: '2027-02-28',
      termsId: TERMS,
      balanceBefore: 70_500n,
      interest: 353n,
      principal: 29_647n,
      payment: 30_000n,
      balanceAfter: 40_853n,
    },
    interest: 353n,
    principal: 39_647n,
    unallocated: 0n,
    flags: [{ code: 'AMOUNT_DIFFERS_FROM_SCHEDULE', difference: 10_000n }, { code: 'ALREADY_SPLIT' }],
  } as unknown as PaymentProposalResult;

  it('the proposal as Money with the entry and the flags; transactionId required; unknown parameters 400', async () => {
    const seen: unknown[] = [];
    const base = await start({
      loanTerms: {
        proposal: async (input) => {
          seen.push(input);
          return proposal;
        },
      },
    });
    const res = await call(base, 'GET', `/loans/${LOAN}/payment-proposal?transactionId=${TX.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      loanId: LOAN,
      transactionId: TX,
      bookingDate: '2027-03-01',
      amount: { amount: '400.00', currency: 'EUR' },
      scheduleEntry: {
        number: 2,
        paymentDate: '2027-02-28',
        termsId: TERMS,
        interest: { amount: '3.53', currency: 'EUR' },
        principal: { amount: '296.47', currency: 'EUR' },
        payment: { amount: '300.00', currency: 'EUR' },
        balanceBefore: { amount: '705.00', currency: 'EUR' },
      },
      splits: [
        { financialCategoryCode: 'LOAN_INTEREST', loanId: LOAN, amount: { amount: '3.53', currency: 'EUR' } },
        { financialCategoryCode: 'LOAN_PRINCIPAL', loanId: LOAN, amount: { amount: '396.47', currency: 'EUR' } },
      ],
      unallocated: { amount: '0.00', currency: 'EUR' },
      flags: [{ code: 'AMOUNT_DIFFERS_FROM_SCHEDULE', details: { difference: { amount: '100.00', currency: 'EUR' } } }, { code: 'ALREADY_SPLIT' }],
    });
    expect(seen[0]).toMatchObject({ loanId: LOAN, transactionId: TX });
    const missing = await call(base, 'GET', `/loans/${LOAN}/payment-proposal`);
    expect(missing.status).toBe(400);
    expect(((await errorOf(missing)).details as { fields: unknown[] }).fields).toEqual([{ field: 'transactionId', code: 'REQUIRED' }]);
    expect((await call(base, 'GET', `/loans/${LOAN}/payment-proposal?transactionId=x`)).status).toBe(400);
    expect((await call(base, 'GET', `/loans/${LOAN}/payment-proposal?transactionId=${TX}&asOf=2027-01-01`)).status).toBe(400);
    expect((await call(base, 'GET', `/loans/x/payment-proposal?transactionId=${TX}`)).status).toBe(400);
  });

  it('a negative difference, an INTEREST_ONLY rest and a zero principal left out', async () => {
    const base = await start({
      loanTerms: {
        proposal: async () =>
          ({
            ...proposal,
            amount: 29_000n,
            principal: 0n,
            unallocated: 28_647n,
            flags: [{ code: 'AMOUNT_DIFFERS_FROM_SCHEDULE', difference: -1_000n }, { code: 'REST_NOT_PLANNED' }],
          }) as unknown as PaymentProposalResult,
      },
    });
    const body = (await (await call(base, 'GET', `/loans/${LOAN}/payment-proposal?transactionId=${TX}`)).json()) as Record<string, unknown>;
    expect(body['splits']).toEqual([{ financialCategoryCode: 'LOAN_INTEREST', loanId: LOAN, amount: { amount: '3.53', currency: 'EUR' } }]);
    expect(body['unallocated']).toEqual({ amount: '286.47', currency: 'EUR' });
    expect(body['flags']).toEqual([
      { code: 'AMOUNT_DIFFERS_FROM_SCHEDULE', details: { difference: { amount: '-10.00', currency: 'EUR' } } },
      { code: 'REST_NOT_PLANNED' },
    ]);
  });

  it.each([
    [new LoanNotFoundError(LOAN), 404, 'NOT_FOUND', { loanId: LOAN }],
    [new ProposalTransactionNotFoundError(TERMS), 404, 'NOT_FOUND', { transactionId: TERMS }],
    [new LoanNotActiveError(LOAN, 'VOID'), 409, 'CONFLICT', { reason: 'LOAN_NOT_ACTIVE', status: 'VOID' }],
    [new PaymentNotProposableError(TERMS, 'INFLOW', 'CONFIRMED'), 409, 'CONFLICT', { reason: 'NOT_PROPOSABLE', direction: 'INFLOW', status: 'CONFIRMED' }],
    [new NoScheduleError(LOAN, 'NO_TERMS'), 409, 'CONFLICT', { reason: 'NO_SCHEDULE', endReason: 'NO_TERMS' }],
    [new LoanClosedOnError(LOAN, '2027-06-30' as never), 409, 'CONFLICT', { reason: 'LOAN_CLOSED', closingDate: '2027-06-30' }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ loanTerms: { proposal: async () => Promise.reject(error) } });
    const res = await call(base, 'GET', `/loans/${LOAN}/payment-proposal?transactionId=${TERMS}`);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});

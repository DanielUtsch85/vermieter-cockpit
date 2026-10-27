import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IdempotencyKeyConflictError,
  LoanNotActiveError,
  LoanNotFoundError,
  LoanTermsNotFoundError,
  TermsNotLastError,
  TermsRefusedError,
  VersionConflictError,
  type CreateLoanTermsInput,
  type LoanTermsView,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp, type AppDependencies } from './app.js';
import { unusedCommands } from './app.test-support.js';

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

async function start(commands: Partial<AppDependencies>): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...unusedCommands, ...commands }).listen(0, '127.0.0.1');
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
      createLoanTerms: async (input) => {
        seen.push(input);
        const answer = { terms: view, replayed };
        replayed = true;
        return answer;
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
    expect(seen[0]).toMatchObject({ loanId: LOAN, interestRate: 3450n, initialRepaymentRate: 2000n, principalAtStart: null, specialRepaymentLimit: null, idempotencyKey: 't1' });
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
    expect(await fieldsOf({ ...body, scheduledPayment: { amount: '0.00', currency: 'EUR' } })).toEqual([{ field: 'scheduledPayment.amount', code: 'NOT_POSITIVE' }]);
    expect(await fieldsOf({ ...body, principalAtStart: { amount: '0.00', currency: 'EUR' } })).toEqual([{ field: 'principalAtStart.amount', code: 'NOT_POSITIVE' }]);
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
    const base = await start({ createLoanTerms: async () => Promise.reject(error) });
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
      voidLoanTerms: async (input) => {
        seen.push(input);
        return { terms: { ...view, status: 'VOID', voidReason: input.reason, version: 2 } as LoanTermsView, changed: true };
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
    const base = await start({ voidLoanTerms: async () => Promise.reject(error) });
    const res = await call(base, 'POST', `/loans/${LOAN}/terms/${TERMS}/void`, { reason: 'x' });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});

describe('GET /api/v1/loans/{id}/terms', () => {
  it('the items; ?status reaches the read; unknown parameters 400; an unknown Loan 404', async () => {
    const seen: unknown[] = [];
    const base = await start({
      listLoanTerms: async (input) => {
        seen.push(input);
        if (input.loanId !== LOAN) throw new LoanNotFoundError(input.loanId);
        return [view];
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

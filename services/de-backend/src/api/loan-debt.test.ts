import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IdempotencyKeyConflictError,
  LoanBalanceStatementNotFoundError,
  LoanNotActiveError,
  LoanNotAllocatedError,
  LoanNotFoundError,
  StatementAfterClosingError,
  StatementBeforeDebtError,
  VersionConflictError,
  type CreateBalanceStatementInput,
  type PrincipalVerifier,
  type RemainingDebt,
  type RemainingDebtPerProperty,
  type StatementView,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp, type AppDependencies } from './app.js';
import { unusedCommands } from './app.test-support.js';

/** VC-3-06 HTTP contract (api-design.md §41.6). */
const REALM = '64b0c0ffee0000000000000a';
const LOAN = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const STATEMENT = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const statementView = {
  id: STATEMENT,
  loanId: LOAN,
  mreRealmId: REALM,
  status: 'VALID',
  statementDate: '2027-12-31',
  balance: Money.of('408.00', 'EUR'),
  source: 'Jahreskontoauszug 2027',
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2028-01-05T10:00:00Z'),
  version: 1,
  comparison: { actualOnDate: 40_853n, difference: -53n },
} as unknown as StatementView;
const debt = {
  asOf: '2027-03-15',
  debtFrom: '2027-01-01',
  principalOriginal: Money.of('1000.00', 'EUR'),
  principalPaid: 110_000n,
  actual: -10_000n,
  planned: 40_853n,
  difference: -50_853n,
  planEndReason: 'PAID_OFF',
  latestStatement: null,
  closing: null,
} as unknown as RemainingDebt;

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
const fieldsOf = async (res: Response) => ((await errorOf(res)).details as { fields: { field: string; code: string }[] }).fields;

describe('GET /api/v1/loans/{id}/remaining-debt', () => {
  it('200 with signed Money (a negative actual and difference), perProperty defaulting to false, asOf passed through', async () => {
    const seen: unknown[] = [];
    const base = await start({
      getRemainingDebt: async (input) => {
        seen.push({ asOf: input.asOf, perProperty: input.perProperty, loanId: input.loanId });
        return debt;
      },
    });
    const res = await call(base, 'GET', `/loans/${LOAN.toUpperCase()}/remaining-debt?asOf=2027-03-15`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      loanId: LOAN,
      asOf: '2027-03-15',
      debtFrom: '2027-01-01',
      principalOriginal: { amount: '1000.00', currency: 'EUR' },
      principalPaid: { amount: '1100.00', currency: 'EUR' },
      actual: { amount: '-100.00', currency: 'EUR' },
      planned: { amount: '408.53', currency: 'EUR' },
      difference: { amount: '-508.53', currency: 'EUR' },
      planEndReason: 'PAID_OFF',
      latestStatement: null,
      closing: null,
    });
    await call(base, 'GET', `/loans/${LOAN}/remaining-debt`);
    expect(seen).toEqual([
      { asOf: '2027-03-15', perProperty: false, loanId: LOAN },
      { asOf: undefined, perProperty: false, loanId: LOAN },
    ]);
  });

  it('perProperty=true: the items with shares and a null plan; the latest statement with its comparison', async () => {
    const perProperty = {
      ...debt,
      actual: -1n,
      planned: null,
      difference: null,
      planEndReason: 'NO_TERMS',
      latestStatement: statementView,
      closing: { closingDate: '2027-02-28', reason: 'REFINANCED', refinancedByLoanId: 'new', actualOnClosingDate: -1n },
      allocationSetId: 'set',
      items: [
        { propertyReferenceId: 'p-a', share: { numerator: 2n, denominator: 3n }, actual: -1n, planned: null, difference: null },
        { propertyReferenceId: 'p-b', share: { numerator: 1n, denominator: 3n }, actual: 0n, planned: null, difference: null },
      ],
    } as unknown as RemainingDebtPerProperty;
    const base = await start({ getRemainingDebt: async (input) => (input.perProperty ? perProperty : debt) });
    const body = (await (await call(base, 'GET', `/loans/${LOAN}/remaining-debt?perProperty=true`)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      actual: { amount: '-0.01', currency: 'EUR' },
      planned: null,
      difference: null,
      allocationSetId: 'set',
      items: [
        { propertyReferenceId: 'p-a', share: '2/3', actual: { amount: '-0.01', currency: 'EUR' }, planned: null, difference: null },
        { propertyReferenceId: 'p-b', share: '1/3', actual: { amount: '0.00', currency: 'EUR' }, planned: null, difference: null },
      ],
      latestStatement: { statementId: STATEMENT, comparison: { actualOnDate: { amount: '408.53', currency: 'EUR' }, difference: { amount: '-0.53', currency: 'EUR' } } },
      closing: { closingDate: '2027-02-28', reason: 'REFINANCED', refinancedByLoanId: 'new', actualOnClosingDate: { amount: '-0.01', currency: 'EUR' } },
    });
  });

  it('400 for a malformed id, asOf or perProperty and an unknown parameter; the refusals mapped', async () => {
    const base = await start({ getRemainingDebt: async () => Promise.reject(new LoanNotAllocatedError(LOAN, { asOf: '2027-01-31' as never })) });
    expect((await call(base, 'GET', '/loans/nope/remaining-debt')).status).toBe(400);
    expect(await fieldsOf(await call(base, 'GET', `/loans/${LOAN}/remaining-debt?asOf=2027-02-30`))).toEqual([{ field: 'asOf', code: 'INVALID_FORMAT' }]);
    expect((await fieldsOf(await call(base, 'GET', `/loans/${LOAN}/remaining-debt?perProperty=yes`)))[0]?.field).toBe('perProperty');
    expect((await call(base, 'GET', `/loans/${LOAN}/remaining-debt?from=2027-01-01`)).status).toBe(400);
    const res = await call(base, 'GET', `/loans/${LOAN}/remaining-debt?perProperty=true`);
    expect([res.status, await errorOf(res)]).toEqual([409, { code: 'CONFLICT', message: 'No allocation set covers the day.', details: { reason: 'LOAN_NOT_ALLOCATED', asOf: '2027-01-31' } }]);
  });

  it.each([
    [new LoanNotFoundError(LOAN), 404, 'NOT_FOUND', { loanId: LOAN }],
    [new LoanNotActiveError(LOAN, 'VOID'), 409, 'CONFLICT', { reason: 'LOAN_NOT_ACTIVE', status: 'VOID' }],
  ])('maps %s', async (error, status, code, details) => {
    const base = await start({ getRemainingDebt: async () => Promise.reject(error) });
    const res = await call(base, 'GET', `/loans/${LOAN}/remaining-debt`);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});

describe('GET /api/v1/loans/{id}/payments', () => {
  it('200 Loan level and per property', async () => {
    const base = await start({
      getLoanPayments: async ({ perProperty, year }) => ({
        year,
        interest: 853n,
        principal: 59_147n,
        payments: 2,
        ...(perProperty ? { items: [{ propertyReferenceId: 'p-a', interest: 853n, principal: 59_147n }] } : {}),
      }),
    });
    expect(await (await call(base, 'GET', `/loans/${LOAN}/payments?year=2027`)).json()).toEqual({
      loanId: LOAN,
      year: 2027,
      interest: { amount: '8.53', currency: 'EUR' },
      principal: { amount: '591.47', currency: 'EUR' },
      payments: 2,
    });
    expect(await (await call(base, 'GET', `/loans/${LOAN}/payments?year=2027&perProperty=true`)).json()).toMatchObject({
      items: [{ propertyReferenceId: 'p-a', interest: { amount: '8.53', currency: 'EUR' }, principal: { amount: '591.47', currency: 'EUR' } }],
    });
  });

  it('400: year missing, malformed or out of range; LOAN_NOT_ALLOCATED with bookingDate', async () => {
    const base = await start({ getLoanPayments: async () => Promise.reject(new LoanNotAllocatedError(LOAN, { bookingDate: '2027-01-31' as never })) });
    expect(await fieldsOf(await call(base, 'GET', `/loans/${LOAN}/payments`))).toEqual([{ field: 'year', code: 'REQUIRED' }]);
    expect(await fieldsOf(await call(base, 'GET', `/loans/${LOAN}/payments?year=27`))).toEqual([{ field: 'year', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf(await call(base, 'GET', `/loans/${LOAN}/payments?year=1999`))).toEqual([{ field: 'year', code: 'OUT_OF_RANGE' }]);
    expect(await fieldsOf(await call(base, 'GET', `/loans/${LOAN}/payments?year=2101`))).toEqual([{ field: 'year', code: 'OUT_OF_RANGE' }]);
    const res = await call(base, 'GET', `/loans/${LOAN}/payments?year=2100&perProperty=true`);
    expect([res.status, (await errorOf(res)).details]).toEqual([409, { reason: 'LOAN_NOT_ALLOCATED', bookingDate: '2027-01-31' }]);
  });
});

describe('balance statements', () => {
  const body = { statementDate: '2027-12-31', balance: { amount: '408.00', currency: 'EUR' }, source: '  Jahreskontoauszug 2027 ' };

  it('POST 201 with the comparison and ETag; trimmed source; notes default null; a replay is marked', async () => {
    const seen: CreateBalanceStatementInput[] = [];
    const base = await start({
      createBalanceStatement: async (input) => {
        seen.push(input);
        return { statement: statementView, replayed: input.idempotencyKey !== undefined };
      },
    });
    const res = await call(base, 'POST', `/loans/${LOAN}/balance-statements`, body);
    expect([res.status, res.headers.get('etag')]).toEqual([201, '"1"']);
    expect(await res.json()).toEqual({
      statementId: STATEMENT,
      loanId: LOAN,
      status: 'VALID',
      statementDate: '2027-12-31',
      balance: { amount: '408.00', currency: 'EUR' },
      source: 'Jahreskontoauszug 2027',
      notes: null,
      voidedAt: null,
      voidReason: null,
      createdAt: '2028-01-05T10:00:00.000Z',
      version: 1,
      comparison: { actualOnDate: { amount: '408.53', currency: 'EUR' }, difference: { amount: '-0.53', currency: 'EUR' } },
    });
    expect(seen[0]).toMatchObject({ source: 'Jahreskontoauszug 2027', notes: null, statementDate: '2027-12-31' });
    expect(seen[0]?.balance.amount).toBe('408.00');
    const replay = await call(base, 'POST', `/loans/${LOAN}/balance-statements`, body, { 'idempotency-key': 'k-1' });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });

  it('POST 400: strict body, a negative balance, a missing or too long source, a bad date', async () => {
    const base = await start({});
    const fields = async (b: unknown) => fieldsOf(await call(base, 'POST', `/loans/${LOAN}/balance-statements`, b));
    expect(await fields({ ...body, extra: 1 })).toEqual([{ field: '(body)', code: 'INVALID_FORMAT' }]);
    expect(await fields({ ...body, balance: { amount: '-1.00', currency: 'EUR' } })).toEqual([{ field: 'balance.amount', code: 'NEGATIVE_AMOUNT' }]);
    expect((await fields({ ...body, source: '   ' }))[0]?.field).toBe('source');
    expect((await fields({ ...body, source: 'x'.repeat(201) }))[0]?.field).toBe('source');
    expect((await fields({ ...body, statementDate: '2027-13-01' }))[0]?.field).toBe('statementDate');
    expect((await fields({ ...body, notes: 'x'.repeat(2001) }))[0]?.field).toBe('notes');
  });

  it.each([
    [new LoanNotFoundError(LOAN), 404, 'NOT_FOUND', { loanId: LOAN }],
    [new LoanNotActiveError(LOAN, 'VOID'), 409, 'CONFLICT', { reason: 'LOAN_NOT_ACTIVE', status: 'VOID' }],
    [new StatementBeforeDebtError('2027-02-01' as never), 422, 'STATEMENT_BEFORE_DEBT', { debtFrom: '2027-02-01' }],
    [new StatementAfterClosingError('2027-06-30' as never), 422, 'STATEMENT_AFTER_CLOSING', { closingDate: '2027-06-30' }],
    [new IdempotencyKeyConflictError('x'), 409, 'CONFLICT', undefined],
  ])('POST maps %s', async (error, status, code, details) => {
    const base = await start({ createBalanceStatement: async () => Promise.reject(error) });
    const res = await call(base, 'POST', `/loans/${LOAN}/balance-statements`, body);
    expect(res.status).toBe(status);
    const e = await errorOf(res);
    expect(e.code).toBe(code);
    if (details !== undefined) expect(e.details).toEqual(details);
  });

  it('void: 200 with If-Match passed; 404, 409, 412 mapped; reason required', async () => {
    const seen: unknown[] = [];
    let fail: Error | undefined;
    const base = await start({
      voidBalanceStatement: async (input) => {
        seen.push(input.expectedVersions);
        if (fail !== undefined) throw fail;
        return { statement: { ...statementView, status: 'VOID', version: 2 } as StatementView, changed: true };
      },
    });
    const path = `/loans/${LOAN}/balance-statements/${STATEMENT}/void`;
    const ok = await call(base, 'POST', path, { reason: 'Tippfehler' }, { 'if-match': '"1"' });
    expect([ok.status, ok.headers.get('etag'), ((await ok.json()) as { status: string }).status]).toEqual([200, '"2"', 'VOID']);
    expect(seen).toEqual([[1]]);
    expect((await call(base, 'POST', path, {})).status).toBe(400);
    expect((await call(base, 'POST', `/loans/${LOAN}/balance-statements/nope/void`, { reason: 'x' })).status).toBe(400);
    for (const [error, status, details] of [
      [new LoanBalanceStatementNotFoundError(STATEMENT), 404, { statementId: STATEMENT }],
      [new LoanNotActiveError(LOAN, 'VOID'), 409, { reason: 'LOAN_NOT_ACTIVE', status: 'VOID' }],
      [new VersionConflictError([1], 2), 412, { expectedVersions: [1], currentVersion: 2 }],
    ] as const) {
      fail = error;
      const res = await call(base, 'POST', path, { reason: 'x' });
      expect([res.status, (await errorOf(res)).details]).toEqual([status, details]);
    }
  });

  it('list: items with comparisons; status filter strict', async () => {
    const seen: unknown[] = [];
    const base = await start({
      listBalanceStatements: async (input) => {
        seen.push(input.status);
        return [statementView];
      },
    });
    const res = await call(base, 'GET', `/loans/${LOAN}/balance-statements?status=VALID`);
    expect(((await res.json()) as { items: { statementId: string }[] }).items.map((i) => i.statementId)).toEqual([STATEMENT]);
    expect(seen).toEqual(['VALID']);
    expect((await call(base, 'GET', `/loans/${LOAN}/balance-statements?status=OPEN`)).status).toBe(400);
  });
});

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessError,
  AlreadyMatchedError,
  IdempotencyKeyConflictError,
  MreRentTermNotFoundError,
  MreUnavailableError,
  NoRentCashError,
  NotReleasableError,
  ReconciliationNotFoundError,
  RentCashExceededError,
  TransactionNotCountedError,
  TransactionNotFoundError,
  TransactionNotInflowError,
  VersionConflictError,
  type CreateReconciliationInput,
  type PrincipalVerifier,
  type RentPaymentReconciliation,
  type TermCoverage,
  type TransactionCoverage,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp, type AppDependencies } from './app.js';
import { unusedCommands } from './app.test-support.js';

/** VC-4-01 HTTP contract (api-design.md §37.1). */
const REALM = '64b0c0ffee00000000000017';
const ID = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const TX = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
const eur = (amount: string) => Money.of(amount, 'EUR');
const reconciliation = {
  id: ID,
  mreRealmId: REALM,
  status: 'CONFIRMED',
  transactionId: TX,
  mreTenantId: TENANT,
  mreRentTerm: '2027010100',
  matchedAmount: eur('800.00'),
  confidence: null,
  suggestionReason: null,
  confirmedAt: new Date('2027-01-05T10:00:00Z'),
  confirmedBy: 'anna@example.com',
  releasedAt: null,
  releasedBy: null,
  releaseReason: null,
  notes: 'Januar',
  mreWriteBackState: 'NOT_WRITTEN',
  createdAt: new Date('2027-01-05T10:00:00Z'),
  version: 1,
} as unknown as RentPaymentReconciliation;

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
const body = { transactionId: TX.toUpperCase(), mreTenantId: TENANT, mreRentTerm: '2027010100', matchedAmount: { amount: '800.00', currency: 'EUR' }, notes: ' Januar ' };

describe('POST /api/v1/rent-reconciliations', () => {
  it('201 with the reconciliation and ETag; the caller\'s Authorization header and key are passed on; a replay is marked', async () => {
    const seen: CreateReconciliationInput[] = [];
    let replayed = false;
    const base = await start({
      createReconciliation: async (input) => {
        seen.push(input);
        const answer = { reconciliation, replayed };
        replayed = true;
        return answer;
      },
    });
    const res = await call(base, 'POST', '/rent-reconciliations', body, { 'idempotency-key': 'm1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.json()).toEqual({
      reconciliationId: ID,
      mreRealmId: REALM,
      status: 'CONFIRMED',
      transactionId: TX,
      mreTenantId: TENANT,
      mreRentTerm: '2027010100',
      matchedAmount: { amount: '800.00', currency: 'EUR' },
      confidence: null,
      suggestionReason: null,
      confirmedAt: '2027-01-05T10:00:00.000Z',
      confirmedBy: 'anna@example.com',
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
      notes: 'Januar',
      mreWriteBackState: 'NOT_WRITTEN',
      createdAt: '2027-01-05T10:00:00.000Z',
      version: 1,
    });
    expect(seen[0]).toMatchObject({ authorizationHeader: 'Bearer a.b.c', transactionId: TX, mreTenantId: TENANT, mreRentTerm: '2027010100', notes: 'Januar', idempotencyKey: 'm1' });
    expect(seen[0]?.matchedAmount.equals(eur('800.00'))).toBe(true);
    expect((await call(base, 'POST', '/rent-reconciliations', body, { 'idempotency-key': 'm1' })).headers.get('idempotent-replayed')).toBe('true');
  });

  it('400 with the field codes', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', '/rent-reconciliations', payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({ ...body, matchedAmount: { amount: '0.00', currency: 'EUR' } })).toEqual([{ field: 'matchedAmount.amount', code: 'NOT_POSITIVE' }]);
    expect(await fieldsOf({ ...body, mreRentTerm: '2027023100' })).toEqual([{ field: 'mreRentTerm', code: 'INVALID_TERM' }]);
    expect(await fieldsOf({ ...body, mreRentTerm: '202701' })).toEqual([{ field: 'mreRentTerm', code: 'INVALID_TERM' }]);
    for (const bad of [{ ...body, mreTenantId: 'Tina' }, { ...body, transactionId: 'x' }, { ...body, matchedAmount: 800 }, { ...body, status: 'CONFIRMED' }, { ...body, notes: 'x'.repeat(2001) }]) {
      await fieldsOf(bad);
    }
    const { transactionId: _t, ...withoutTransaction } = body;
    await fieldsOf(withoutTransaction);
  });

  it.each([
    [new TransactionNotFoundError(TX), 404, 'NOT_FOUND', { transactionId: TX }],
    [new TransactionNotCountedError('CONFIRMED', 'REVERSAL'), 409, 'CONFLICT', { reason: 'TRANSACTION_NOT_COUNTED', status: 'CONFIRMED', correctionRole: 'REVERSAL' }],
    [new TransactionNotInflowError('x'), 422, 'TRANSACTION_NOT_INFLOW', undefined],
    [new NoRentCashError('x'), 422, 'NO_RENT_CASH', undefined],
    [new AlreadyMatchedError(ID), 409, 'CONFLICT', { reason: 'ALREADY_MATCHED', reconciliationId: ID }],
    [
      new RentCashExceededError(eur('800.00'), eur('300.00')),
      409,
      'CONFLICT',
      { reason: 'RENT_CASH_EXCEEDED', rentCash: { amount: '800.00', currency: 'EUR' }, available: { amount: '300.00', currency: 'EUR' } },
    ],
    [new MreRentTermNotFoundError(TENANT, '2027010100'), 422, 'MRE_RENT_TERM_NOT_FOUND', { mreTenantId: TENANT, mreRentTerm: '2027010100' }],
    [new MreUnavailableError('down'), 503, 'EXTERNAL_SYSTEM_ERROR', undefined],
    [new AccessError('FORBIDDEN', 'MRE refused'), 403, 'FORBIDDEN', undefined],
    [new IdempotencyKeyConflictError('x'), 409, 'CONFLICT', undefined],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ createReconciliation: async () => Promise.reject(error) });
    const res = await call(base, 'POST', '/rent-reconciliations', body);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, ...(details === undefined ? {} : { details }) });
  });

  it('the 422 for a term MRE did not return is worded neutrally (MRE also answers 404 when its database fails)', async () => {
    const base = await start({ createReconciliation: async () => Promise.reject(new MreRentTermNotFoundError(TENANT, '2027010100')) });
    expect(((await errorOf(await call(base, 'POST', '/rent-reconciliations', body))) as unknown as { message: string }).message).toBe('MRE did not return this rent term.');
  });
});

describe('POST /api/v1/rent-reconciliations/{id}/release', () => {
  it('passes the reason and If-Match; 200 with ETag', async () => {
    const seen: unknown[] = [];
    const base = await start({
      releaseReconciliation: async (input) => {
        seen.push(input);
        return { reconciliation: { ...reconciliation, status: 'RELEASED', version: 2 } as RentPaymentReconciliation, changed: true };
      },
    });
    const res = await call(base, 'POST', `/rent-reconciliations/${ID}/release`, { reason: ' falscher Monat ' }, { 'if-match': '"1"' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(seen[0]).toMatchObject({ reconciliationId: ID, reason: 'falscher Monat', expectedVersions: [1] });
  });

  it('400 for a missing or long reason or another key; refusals mapped', async () => {
    const base = await start({ releaseReconciliation: async () => Promise.reject(new NotReleasableError('SUGGESTED')) });
    for (const bad of [{}, { reason: '' }, { reason: 'x'.repeat(501) }, { reason: 'x', status: 'RELEASED' }]) {
      expect((await call(base, 'POST', `/rent-reconciliations/${ID}/release`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(base, 'POST', '/rent-reconciliations/nope/release', { reason: 'x' })).status).toBe(400);
    const res = await call(base, 'POST', `/rent-reconciliations/${ID}/release`, { reason: 'x' });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: 'CONFLICT', details: { reason: 'NOT_RELEASABLE', status: 'SUGGESTED' } });
  });

  it.each([
    [new ReconciliationNotFoundError(ID), 404, 'NOT_FOUND'],
    [new VersionConflictError([1], 2), 412, 'VERSION_CONFLICT'],
  ])('%s → %i %s', async (error, status, code) => {
    const base = await start({ releaseReconciliation: async () => Promise.reject(error) });
    const res = await call(base, 'POST', `/rent-reconciliations/${ID}/release`, { reason: 'x' });
    expect(res.status).toBe(status);
    expect((await errorOf(res)).code).toBe(code);
  });
});

describe('GET /api/v1/rent-reconciliations', () => {
  it('one with ETag; unknown is 404; a malformed id is 400', async () => {
    const base = await start({
      getReconciliation: async ({ reconciliationId }) => {
        if (reconciliationId !== ID) throw new ReconciliationNotFoundError(reconciliationId);
        return reconciliation;
      },
    });
    const res = await call(base, 'GET', `/rent-reconciliations/${ID.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"1"');
    expect((await call(base, 'GET', `/rent-reconciliations/${TX}`)).status).toBe(404);
    expect((await call(base, 'GET', '/rent-reconciliations/x')).status).toBe(400);
  });

  it('the list passes its filters (status as a list) and paging; unknown parameters are 400', async () => {
    const seen: unknown[] = [];
    const base = await start({
      listReconciliations: async (input) => {
        seen.push(input);
        return { items: [reconciliation], page: 2, pageSize: 10, total: 11 };
      },
    });
    const res = await call(base, 'GET', `/rent-reconciliations?status=CONFIRMED,RELEASED&transactionId=${TX}&mreTenantId=${TENANT}&mreRentTerm=2027010100&page=2&pageSize=10`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ page: 2, pageSize: 10, total: 11, items: [{ reconciliationId: ID }] });
    expect(seen[0]).toMatchObject({ filter: { status: ['CONFIRMED', 'RELEASED'], transactionId: TX, mreTenantId: TENANT, mreRentTerm: '2027010100' }, page: { page: 2, pageSize: 10 } });
    for (const bad of ['status=OPEN', 'status=', 'mreRentTerm=2027', 'mreTenantId=x', 'pageSize=201', 'checkMre=true']) {
      expect((await call(base, 'GET', `/rent-reconciliations?${bad}`)).status, bad).toBe(400);
    }
  });
});

describe('GET /api/v1/rent-reconciliations/terms/{mreTenantId}/{mreRentTerm} (§37.2)', () => {
  const coverage: TermCoverage = {
    mreTenantId: TENANT,
    mreRentTerm: '2027010100',
    reconciliations: [reconciliation],
    matchedTotal: eur('800.00'),
    mreStatus: 'AVAILABLE',
    mre: { amountDue: eur('800.00'), payments: [{ date: '2027-01-05' as never, amount: eur('800.00'), type: 'transfer', reference: 'DE-RPR-x' }] },
    coverage: 'MATCHED',
    openAmount: eur('0.00'),
  };

  it('200 with both sides; the caller\'s Authorization header is passed on', async () => {
    const seen: unknown[] = [];
    const base = await start({
      getTermCoverage: async (input) => {
        seen.push(input);
        return coverage;
      },
    });
    const res = await call(base, 'GET', `/rent-reconciliations/terms/${TENANT}/2027010100`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mreTenantId: TENANT,
      mreRentTerm: '2027010100',
      reconciliations: [expect.objectContaining({ reconciliationId: ID })],
      matchedTotal: { amount: '800.00', currency: 'EUR' },
      mreStatus: 'AVAILABLE',
      mre: { amountDue: { amount: '800.00', currency: 'EUR' }, payments: [{ date: '2027-01-05', amount: { amount: '800.00', currency: 'EUR' }, type: 'transfer', reference: 'DE-RPR-x' }] },
      coverage: 'MATCHED',
      openAmount: { amount: '0.00', currency: 'EUR' },
    });
    expect(seen[0]).toMatchObject({ authorizationHeader: 'Bearer a.b.c', mreTenantId: TENANT, mreRentTerm: '2027010100' });
  });

  it('UNAVAILABLE answers nulls for the MRE side; a refused caller is 403', async () => {
    const base = await start({ getTermCoverage: async () => ({ ...coverage, mreStatus: 'UNAVAILABLE', mre: null, coverage: null, openAmount: null }) });
    expect(await (await call(base, 'GET', `/rent-reconciliations/terms/${TENANT}/2027010100`)).json()).toMatchObject({ mreStatus: 'UNAVAILABLE', mre: null, coverage: null, openAmount: null });
    await stopAndStart({ getTermCoverage: async () => Promise.reject(new AccessError('FORBIDDEN', 'x')) }).then(async (b) =>
      expect((await call(b, 'GET', `/rent-reconciliations/terms/${TENANT}/2027010100`)).status).toBe(403),
    );
  });

  it('400 for a malformed Tenant, a malformed term or a query parameter', async () => {
    const base = await start({});
    for (const path of [`/rent-reconciliations/terms/Tina/2027010100`, `/rent-reconciliations/terms/${TENANT}/2027013200`, `/rent-reconciliations/terms/${TENANT}/2027010100?checkMre=true`]) {
      expect((await call(base, 'GET', path)).status, path).toBe(400);
    }
  });
});

describe('GET /api/v1/transactions/{id}/rent-reconciliations (§37.2)', () => {
  const coverage: TransactionCoverage = {
    transactionId: TX,
    status: 'CONFIRMED',
    direction: 'INFLOW',
    correctionRole: null,
    counted: true,
    rentCash: eur('800.00'),
    matchedTotal: eur('300.00'),
    available: eur('500.00'),
    reconciliations: [reconciliation],
  };

  it('200 with the cash view; null amounts stay null; unknown is 404; malformed id or query is 400', async () => {
    const base = await start({
      getTransactionCoverage: async ({ transactionId }) => {
        if (transactionId !== TX) throw new TransactionNotFoundError(transactionId);
        return coverage;
      },
    });
    const res = await call(base, 'GET', `/transactions/${TX.toUpperCase()}/rent-reconciliations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transactionId: TX,
      status: 'CONFIRMED',
      direction: 'INFLOW',
      correctionRole: null,
      counted: true,
      rentCash: { amount: '800.00', currency: 'EUR' },
      matchedTotal: { amount: '300.00', currency: 'EUR' },
      available: { amount: '500.00', currency: 'EUR' },
      reconciliations: [expect.objectContaining({ reconciliationId: ID })],
    });
    expect((await call(base, 'GET', `/transactions/${ID}/rent-reconciliations`)).status).toBe(404);
    expect((await call(base, 'GET', '/transactions/x/rent-reconciliations')).status).toBe(400);
    expect((await call(base, 'GET', `/transactions/${TX}/rent-reconciliations?x=1`)).status).toBe(400);
    await stopAndStart({ getTransactionCoverage: async () => ({ ...coverage, rentCash: null, available: null, counted: false }) }).then(async (b) =>
      expect(await (await call(b, 'GET', `/transactions/${TX}/rent-reconciliations`)).json()).toMatchObject({ rentCash: null, available: null, counted: false }),
    );
  });
});

async function stopAndStart(commands: Partial<AppDependencies>): Promise<string> {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  return start(commands);
}

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcquisitionCancelledError,
  AcquisitionCostNotFoundError,
  AcquisitionNotFoundError,
  CostHasPaymentsError,
  PaymentRefusedError,
  TransactionNotFoundError,
  VersionConflictError,
  type AcquisitionCost,
  type AcquisitionPayment,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-2-06 HTTP contract (api-design.md §27.2). */
const REALM = '64b0c0ffee0000000000000a';
const ACQ = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const COST = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const TX = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const PAY = '3b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const eur = (amount: string) => Money.of(amount, 'EUR');
const cost: AcquisitionCost = {
  id: COST,
  mreRealmId: REALM,
  acquisitionId: ACQ,
  category: 'NOTARY',
  amount: eur('2450.10'),
  incurredDate: null,
  counterpartyPartyId: null,
  sourceReferences: [],
  notes: null,
  status: 'ACTIVE',
  voidedAt: null,
  voidReason: null,
  paidAmount: eur('0.00'),
  paymentStatus: 'EXPECTED',
  classification: null,
  createdAt: new Date('2026-10-26T08:00:00Z'),
  version: 1,
};
const payment: AcquisitionPayment = {
  id: PAY,
  mreRealmId: REALM,
  acquisitionId: ACQ,
  acquisitionCostId: null,
  transactionId: TX,
  amount: eur('1000.00'),
  counting: true,
  notCountingReason: null,
  transactionStatus: 'CONFIRMED',
  replacementTransactionId: null,
  unlinkedAt: null,
  unlinkReason: null,
  createdAt: new Date('2026-10-26T08:00:00Z'),
  version: 1,
};

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

describe('POST /api/v1/acquisitions/{id}/costs', () => {
  it('201 with the cost and ETag, the input normalized; a replay is marked', async () => {
    const seen: unknown[] = [];
    const base = await start({
      acquisitionCosts: {
        createCost: async (input) => {
          seen.push(input);
          return { cost, replayed: seen.length > 1 };
        },
      },
    });
    const body = { category: 'NOTARY', amount: { amount: '2450.10', currency: 'EUR' }, notes: '  Beurkundung ', sourceReferences: [' Rechnung 17 ', ''] };
    const res = await call(base, 'POST', `/acquisitions/${ACQ.toUpperCase()}/costs`, body, { 'idempotency-key': 'k1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.json()).toEqual({
      costId: COST,
      acquisitionId: ACQ,
      category: 'NOTARY',
      amount: { amount: '2450.10', currency: 'EUR' },
      incurredDate: null,
      counterpartyPartyId: null,
      sourceReferences: [],
      notes: null,
      status: 'ACTIVE',
      voidedAt: null,
      voidReason: null,
      paidAmount: { amount: '0.00', currency: 'EUR' },
      paymentStatus: 'EXPECTED',
      classification: null,
      createdAt: '2026-10-26T08:00:00.000Z',
      version: 1,
    });
    expect(seen[0]).toMatchObject({
      acquisitionId: ACQ,
      notes: 'Beurkundung',
      sourceReferences: ['Rechnung 17'],
      idempotencyKey: 'k1',
      incurredDate: null,
      counterpartyPartyId: null,
    });
    const again = await call(base, 'POST', `/acquisitions/${ACQ}/costs`, body, { 'idempotency-key': 'k1' });
    expect(again.headers.get('idempotent-replayed')).toBe('true');
  });

  it('400 for a bad body: unknown category, not positive, PURCHASE_PRICE, transactionSplitId, documentId', async () => {
    const base = await start({});
    const fields = async (body: unknown) => (await errorOf(await call(base, 'POST', `/acquisitions/${ACQ}/costs`, body))).details;
    const amount = { amount: '1.00', currency: 'EUR' };
    expect(await fields({ category: 'PURCHASE_PRICE', amount })).toMatchObject({ fields: [{ field: 'category' }] });
    expect(await fields({ category: 'NOTARY', amount: { amount: '0.00', currency: 'EUR' } })).toEqual({
      fields: [{ field: 'amount.amount', code: 'NOT_POSITIVE' }],
    });
    expect(await fields({ category: 'NOTARY', amount, transactionSplitId: TX })).toMatchObject({ fields: [{ field: '(body)' }] });
    expect(await fields({ category: 'NOTARY', amount, documentId: TX })).toEqual({ fields: [{ field: 'documentId', code: 'NOT_SUPPORTED' }] });
    expect((await call(base, 'POST', '/acquisitions/x/costs', { category: 'NOTARY', amount })).status).toBe(400);
  });

  it('404 and 409 refusals', async () => {
    const errors = [new AcquisitionNotFoundError(ACQ), new AcquisitionCancelledError(ACQ)];
    const base = await start({
      acquisitionCosts: {
        createCost: async () => {
          throw errors.shift();
        },
      },
    });
    const body = { category: 'NOTARY', amount: { amount: '1.00', currency: 'EUR' } };
    const notFound = await call(base, 'POST', `/acquisitions/${ACQ}/costs`, body);
    expect([notFound.status, await errorOf(notFound)]).toEqual([
      404,
      { code: 'NOT_FOUND', message: 'Acquisition not found.', details: { acquisitionId: ACQ } },
    ]);
    const cancelled = await call(base, 'POST', `/acquisitions/${ACQ}/costs`, body);
    expect(cancelled.status).toBe(409);
    expect(await errorOf(cancelled)).toMatchObject({ code: 'CONFLICT', details: { reason: 'ACQUISITION_CANCELLED' } });
  });
});

describe('POST /api/v1/acquisitions/{id}/costs/{costId}/void', () => {
  it('200 with the cost, If-Match passed on; 409 COST_HAS_PAYMENTS; 412 on a stale version; 404 for an unknown cost', async () => {
    const errors: unknown[] = [undefined, new CostHasPaymentsError(COST, [PAY]), new VersionConflictError([3], 1), new AcquisitionCostNotFoundError(COST)];
    const seen: unknown[] = [];
    const base = await start({
      acquisitionCosts: {
        voidCost: async (input) => {
          seen.push(input);
          const error = errors.shift();
          if (error !== undefined) throw error;
          return { cost: { ...cost, status: 'VOID', paymentStatus: null, version: 2 }, changed: true };
        },
      },
    });
    const path = `/acquisitions/${ACQ}/costs/${COST}/void`;
    const ok = await call(base, 'POST', path, { reason: ' falsch ' }, { 'if-match': '"1"' });
    expect([ok.status, ok.headers.get('etag')]).toEqual([200, '"2"']);
    expect(seen[0]).toMatchObject({ acquisitionId: ACQ, costId: COST, reason: 'falsch', expectedVersions: [1] });
    expect(await errorOf(await call(base, 'POST', path, { reason: 'x' }))).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'COST_HAS_PAYMENTS', paymentIds: [PAY] },
    });
    expect((await call(base, 'POST', path, { reason: 'x' })).status).toBe(412);
    expect(await errorOf(await call(base, 'POST', path, { reason: 'x' }))).toMatchObject({ code: 'NOT_FOUND', details: { acquisitionCostId: COST } });
    expect((await call(base, 'POST', path, {})).status).toBe(400);
  });
});

describe('POST /api/v1/acquisitions/{id}/payments', () => {
  it('201 with the payment; absent and null acquisitionCostId both mean the price', async () => {
    const seen: unknown[] = [];
    const base = await start({
      acquisitionCosts: {
        linkPayment: async (input) => {
          seen.push(input);
          return { payment, replayed: false };
        },
      },
    });
    const amount = { amount: '1000.00', currency: 'EUR' };
    const res = await call(base, 'POST', `/acquisitions/${ACQ}/payments`, { transactionId: TX.toUpperCase(), amount });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      paymentId: PAY,
      acquisitionId: ACQ,
      acquisitionCostId: null,
      transactionId: TX,
      amount,
      counting: true,
      notCountingReason: null,
      transactionStatus: 'CONFIRMED',
      replacementTransactionId: null,
      unlinkedAt: null,
      unlinkReason: null,
      createdAt: '2026-10-26T08:00:00.000Z',
      version: 1,
    });
    await call(base, 'POST', `/acquisitions/${ACQ}/payments`, { transactionId: TX, acquisitionCostId: null, amount });
    await call(base, 'POST', `/acquisitions/${ACQ}/payments`, { transactionId: TX, acquisitionCostId: COST, amount });
    expect(seen.map((s) => (s as { acquisitionCostId: unknown }).acquisitionCostId)).toEqual([null, null, COST]);
    expect(seen[0]).toMatchObject({ transactionId: TX });
  });

  it('maps every refusal of §27.2', async () => {
    const refusals: unknown[] = [
      new TransactionNotFoundError(TX),
      new AcquisitionCostNotFoundError(COST),
      new AcquisitionCancelledError(ACQ),
      new PaymentRefusedError({ kind: 'COST_VOID' }),
      new PaymentRefusedError({ kind: 'TRANSACTION_NOT_CURRENT', status: 'CORRECTED', correctionRole: null }),
      new PaymentRefusedError({ kind: 'NOT_OUTFLOW' }),
      new PaymentRefusedError({ kind: 'CURRENCY_MISMATCH' }),
      new PaymentRefusedError({ kind: 'PAYMENT_EXCEEDS_TRANSACTION', transactionAmount: eur('100.00'), linkedAmount: eur('80.00'), available: eur('20.00') }),
      new PaymentRefusedError({ kind: 'PAYMENT_EXCEEDS_PRICE', expected: eur('10.00'), paid: eur('4.00'), remaining: eur('6.00') }),
    ];
    const base = await start({
      acquisitionCosts: {
        linkPayment: async () => {
          throw refusals.shift();
        },
      },
    });
    const body = { transactionId: TX, amount: { amount: '1.00', currency: 'EUR' } };
    const next = async () => {
      const res = await call(base, 'POST', `/acquisitions/${ACQ}/payments`, body);
      return [res.status, await errorOf(res)] as const;
    };
    expect(await next()).toMatchObject([404, { code: 'NOT_FOUND', details: { transactionId: TX } }]);
    expect(await next()).toMatchObject([404, { code: 'NOT_FOUND', details: { acquisitionCostId: COST } }]);
    expect(await next()).toMatchObject([409, { code: 'CONFLICT', details: { reason: 'ACQUISITION_CANCELLED' } }]);
    expect(await next()).toMatchObject([409, { code: 'CONFLICT', details: { reason: 'COST_VOID' } }]);
    expect(await next()).toMatchObject([422, { code: 'TRANSACTION_NOT_CURRENT', details: { status: 'CORRECTED', correctionRole: null } }]);
    expect(await next()).toMatchObject([422, { code: 'NOT_OUTFLOW' }]);
    expect(await next()).toMatchObject([422, { code: 'CURRENCY_MISMATCH' }]);
    expect(await next()).toMatchObject([
      409,
      {
        code: 'INVARIANT_VIOLATION',
        details: {
          reason: 'PAYMENT_EXCEEDS_TRANSACTION',
          transactionAmount: { amount: '100.00', currency: 'EUR' },
          linkedAmount: { amount: '80.00', currency: 'EUR' },
          available: { amount: '20.00', currency: 'EUR' },
        },
      },
    ]);
    expect(await next()).toMatchObject([
      409,
      {
        code: 'INVARIANT_VIOLATION',
        details: { reason: 'PAYMENT_EXCEEDS_PRICE', expected: { amount: '10.00' }, paid: { amount: '4.00' }, remaining: { amount: '6.00' } },
      },
    ]);
  });

  it('400 for a bad body', async () => {
    const base = await start({});
    const fields = async (body: unknown) => (await errorOf(await call(base, 'POST', `/acquisitions/${ACQ}/payments`, body))).details;
    expect(await fields({ transactionId: TX, amount: { amount: '-1.00', currency: 'EUR' } })).toMatchObject({ fields: [{ field: 'amount.amount' }] });
    expect(await fields({ transactionId: 'x', amount: { amount: '1.00', currency: 'EUR' } })).toMatchObject({ fields: [{ field: 'transactionId' }] });
    expect(await fields({ transactionId: TX, amount: { amount: '1.00', currency: 'EUR' }, direction: 'OUTFLOW' })).toMatchObject({
      fields: [{ field: '(body)' }],
    });
  });
});

describe('unlink and the reads', () => {
  it('unlink: 200 with the payment, If-Match passed on', async () => {
    const seen: unknown[] = [];
    const base = await start({
      acquisitionCosts: {
        unlinkPayment: async (input) => {
          seen.push(input);
          return {
            payment: {
              ...payment,
              unlinkedAt: new Date('2026-10-26T09:00:00Z'),
              unlinkReason: 'falsch',
              counting: false,
              notCountingReason: 'UNLINKED',
              version: 2,
            },
            changed: true,
          };
        },
      },
    });
    const res = await call(base, 'POST', `/acquisitions/${ACQ}/payments/${PAY}/unlink`, { reason: 'falsch' }, { 'if-match': '"1"' });
    expect([res.status, res.headers.get('etag')]).toEqual([200, '"2"']);
    expect(await res.json()).toMatchObject({ unlinkedAt: '2026-10-26T09:00:00.000Z', notCountingReason: 'UNLINKED' });
    expect(seen[0]).toMatchObject({ acquisitionId: ACQ, paymentId: PAY, reason: 'falsch', expectedVersions: [1] });
  });

  it('GET …/costs and …/payments with their filters; the literal null names the price, an empty value is 400', async () => {
    const filters: unknown[] = [];
    const base = await start({
      acquisitionCosts: {
        listCosts: async ({ filter }) => {
          filters.push(filter);
          return [cost];
        },
        listPayments: async ({ filter }) => {
          filters.push(filter);
          return { purchasePrice: { amount: eur('300000.00'), paidAmount: eur('1000.00'), paymentStatus: 'PARTIALLY_PAID' }, items: [payment] };
        },
      },
    });
    const costs = await call(base, 'GET', `/acquisitions/${ACQ}/costs?status=ACTIVE`);
    expect(((await costs.json()) as { items: unknown[] }).items).toHaveLength(1);
    const payments = await call(base, 'GET', `/acquisitions/${ACQ}/payments?acquisitionCostId=null&counting=true`);
    expect(await payments.json()).toMatchObject({
      purchasePrice: { amount: { amount: '300000.00' }, paidAmount: { amount: '1000.00' }, paymentStatus: 'PARTIALLY_PAID' },
      items: [{ paymentId: PAY }],
    });
    await call(base, 'GET', `/acquisitions/${ACQ}/payments?acquisitionCostId=${COST.toUpperCase()}`);
    expect(filters).toEqual([{ status: 'ACTIVE' }, { acquisitionCostId: null, counting: true }, { acquisitionCostId: COST }]);
    expect((await call(base, 'GET', `/acquisitions/${ACQ}/payments?acquisitionCostId=`)).status).toBe(400);
    expect((await call(base, 'GET', `/acquisitions/${ACQ}/payments?counting=yes`)).status).toBe(400);
    expect((await call(base, 'GET', `/acquisitions/${ACQ}/costs?page=1`)).status).toBe(400);
  });
});

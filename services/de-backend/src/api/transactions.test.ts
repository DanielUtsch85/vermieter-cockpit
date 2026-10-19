import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  FinancialAccountClosedError,
  FinancialAccountNotFoundError,
  IdempotencyKeyConflictError,
  PropertyReferenceNotFoundError,
  type CreateManualTransaction,
  type CreateManualTransactionInput,
  type PrincipalVerifier,
  type Transaction,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { unusedCommands } from './app.test-support.js';

const REALM = '64b0c0ffee0000000000000a';
const ACCOUNT = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const PROPERTY = 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f';
const transaction = {
  id: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  mreRealmId: REALM,
  financialAccountId: ACCOUNT,
  amount: Money.of('1250.00', 'EUR'),
  direction: 'INFLOW',
  bookingDate: '2026-09-01',
  valueDate: null,
  description: 'Miete September',
  propertyReferenceId: PROPERTY,
  provenance: 'MANUAL',
  status: 'UNREVIEWED',
  createdAt: new Date('2026-10-19T08:00:00Z'),
  version: 1,
} as unknown as Transaction;

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({
  email: 'anna@example.com',
  mreRealmId: mreRealmId ?? '',
  mreRole: 'administrator',
});

let server: Server | undefined;

async function start(createManual: CreateManualTransaction): Promise<string> {
  server = createApp({
    isReady: async () => true,
    verifyPrincipal: admin,
    ...unusedCommands,
    createManualTransaction: createManual,
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const valid = {
  financialAccountId: ACCOUNT,
  amount: { amount: '1250.00', currency: 'EUR' },
  direction: 'INFLOW',
  bookingDate: '2026-09-01',
  description: 'Miete September',
  propertyReferenceId: PROPERTY,
  provenance: 'MANUAL',
};
const post = (base: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/transactions`, {
    method: 'POST',
    headers: { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });

describe('POST /api/v1/transactions', () => {
  it('201 with the Transaction; Money is a string pair, the use case gets parsed input and the key', async () => {
    const seen: CreateManualTransactionInput[] = [];
    const base = await start(async (input) => (seen.push(input), { transaction, replayed: false }));
    const res = await post(base, { ...valid, financialAccountId: ACCOUNT.toUpperCase() }, { 'idempotency-key': 'k-1' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      transactionId: transaction.id,
      mreRealmId: REALM,
      financialAccountId: ACCOUNT,
      amount: { amount: '1250.00', currency: 'EUR' },
      direction: 'INFLOW',
      bookingDate: '2026-09-01',
      valueDate: null,
      description: 'Miete September',
      propertyReferenceId: PROPERTY,
      provenance: 'MANUAL',
      status: 'UNREVIEWED',
      createdAt: '2026-10-19T08:00:00.000Z',
      version: 1,
    });
    expect(seen[0]).toMatchObject({
      financialAccountId: ACCOUNT,
      direction: 'INFLOW',
      bookingDate: '2026-09-01',
      valueDate: null,
      description: 'Miete September',
      propertyReferenceId: PROPERTY,
      idempotencyKey: 'k-1',
    });
    expect(seen[0]?.amount.toJSON()).toEqual({ amount: '1250.00', currency: 'EUR' });
  });

  it('explicit null for optional fields means omitted', async () => {
    const seen: CreateManualTransactionInput[] = [];
    const base = await start(async (input) => (seen.push(input), { transaction, replayed: false }));
    const res = await post(base, { ...valid, valueDate: null, description: null, propertyReferenceId: null });
    expect(res.status).toBe(201);
    expect(seen[0]).toMatchObject({ valueDate: null, description: null, propertyReferenceId: null });
  });

  it('a replay answers 201 like the original, marked Idempotent-Replayed', async () => {
    const base = await start(async () => ({ transaction, replayed: true }));
    const res = await post(base, valid, { 'idempotency-key': 'k-1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('idempotent-replayed')).toBe('true');
  });

  it.each([
    ['negative amount', { amount: { amount: '-1.00', currency: 'EUR' } }, [{ field: 'amount.amount', code: 'NEGATIVE_AMOUNT' }]],
    ['three decimals', { amount: { amount: '1.005', currency: 'EUR' } }, [{ field: 'amount.amount', code: 'SCALE_EXCEEDED' }]],
    ['amount as a JSON number', { amount: { amount: 1250, currency: 'EUR' } }, [{ field: 'amount.amount', code: 'INVALID_FORMAT' }]],
    ['exponent notation', { amount: { amount: '1e3', currency: 'EUR' } }, [{ field: 'amount.amount', code: 'INVALID_FORMAT' }]],
    ['unsupported currency', { amount: { amount: '1.00', currency: 'USD' } }, [{ field: 'amount.currency', code: 'UNSUPPORTED_CURRENCY' }]],
    ['too large', { amount: { amount: '1000000000000000000.00', currency: 'EUR' } }, [{ field: 'amount.amount', code: 'AMOUNT_OUT_OF_RANGE' }]],
    ['missing direction', { direction: undefined }, [{ field: 'direction', code: 'REQUIRED' }]],
    ['unknown direction', { direction: 'IN' }, [{ field: 'direction', code: 'INVALID_FORMAT' }]],
    ['missing bookingDate', { bookingDate: undefined }, [{ field: 'bookingDate', code: 'REQUIRED' }]],
    ['impossible bookingDate', { bookingDate: '2026-02-30' }, [{ field: 'bookingDate', code: 'INVALID_FORMAT' }]],
    ['typo year in bookingDate', { bookingDate: '0202-03-01' }, [{ field: 'bookingDate', code: 'OUT_OF_RANGE' }]],
    ['timestamp as valueDate', { valueDate: '2026-09-01T10:00:00Z' }, [{ field: 'valueDate', code: 'INVALID_FORMAT' }]],
    ['account id not a UUID', { financialAccountId: 'acc-1' }, [{ field: 'financialAccountId', code: 'INVALID_FORMAT' }]],
    ['rentalContractReferenceId (not supported yet)', { rentalContractReferenceId: PROPERTY }, [{ field: 'rentalContractReferenceId', code: 'NOT_SUPPORTED' }]],
    ['provenance other than MANUAL', { provenance: 'BANK_CSV' }, [{ field: 'provenance', code: 'INVALID_FORMAT' }]],
  ])('400 VALIDATION_ERROR: %s — the use case is not called', async (_label, change, fields) => {
    let called = false;
    const base = await start(async () => ((called = true), { transaction, replayed: false }));
    const res = await post(base, { ...valid, ...change });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed.', details: { fields } } });
    expect(called).toBe(false);
  });

  it.each([
    ['unknown account', new FinancialAccountNotFoundError(ACCOUNT), 404, 'NOT_FOUND'],
    ['unknown PropertyReference', new PropertyReferenceNotFoundError(PROPERTY), 404, 'NOT_FOUND'],
    ['closed account', new FinancialAccountClosedError(ACCOUNT), 409, 'CONFLICT'],
    ['key reused with another payload', new IdempotencyKeyConflictError('x'), 409, 'CONFLICT'],
    ['currency differs from the account', new CurrencyMismatchError('x'), 400, 'VALIDATION_ERROR'],
    ['unexpected', new Error('db down'), 500, 'INTERNAL_ERROR'],
  ])('%s → %i %s', async (_label, error, status, code) => {
    const base = await start(() => Promise.reject(error));
    const res = await post(base, valid);
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: { code: string; details?: Record<string, unknown> } };
    expect(body.error.code).toBe(code);
    if (error instanceof FinancialAccountClosedError) expect(body.error.details).toEqual({ reason: 'ACCOUNT_CLOSED', financialAccountId: ACCOUNT });
  });
});

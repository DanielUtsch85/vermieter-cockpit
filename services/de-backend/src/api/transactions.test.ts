import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  TransactionNotFoundError,
  type ListTransactions,
  type ListPropertyReferenceTransactions,
  FinancialAccountClosedError,
  FinancialAccountNotFoundError,
  IdempotencyKeyConflictError,
  PropertyReferenceNotFoundError,
  type CreateManualTransaction,
  type CreateManualTransactionInput,
  type Transaction,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';
import { REALM, ACCOUNT, PROPERTY, transaction, admin } from './transactions.test-support.js';

/** The read and create routes of `transactions.ts` (api-design.md §30–§31); splits and lifecycle have their own files (#104). */
let server: Server | undefined;

async function start(createManual: CreateManualTransaction): Promise<string> {
  server = createApp({
    isReady: async () => true,
    verifyPrincipal: admin,
    ...commandsWith({ transactions: { createManual } }),
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

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

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
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
      confirmedAt: null,
      confirmedBy: null,
      correctionOfTransactionId: null,
      correctionRole: null,
      reversalTransactionId: null,
      replacementTransactionId: null,
      counterpartyNameRaw: null,
      counterpartyIbanRaw: null,
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

describe('GET /api/v1/transactions(/{id}) (§30.1, VC-X-21)', () => {
  async function startWith(commands: CommandOverrides): Promise<string> {
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith(commands) }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const get = (base: string, path: string) => fetch(`${base}/api/v1${path}`, { headers: { authorization: 'Bearer a.b.c', organizationid: REALM } });

  it('one Transaction with its splits, counterparty and an ETag; 404 unknown, 400 malformed id', async () => {
    const split = {
      id: 's1',
      position: 1,
      amount: Money.of('1250.00', 'EUR'),
      financialCategoryCode: 'RENT_BASE',
      propertyReferenceId: null,
      loanId: null,
      securityDepositId: null,
      description: null,
    };
    const base = await startWith({
      transactions: {
        get: async ({ transactionId }) => {
          if (transactionId !== transaction.id) throw new TransactionNotFoundError(transactionId);
          return {
            transaction: { ...transaction, version: 3, counterpartyNameRaw: 'Erika Mieterin', counterpartyIbanRaw: 'DE02120300000000202051' } as Transaction,
            splits: [split],
          };
        },
      },
    });
    const res = await get(base, `/transactions/${transaction.id.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"3"');
    expect(await res.json()).toMatchObject({
      transactionId: transaction.id,
      version: 3,
      counterpartyNameRaw: 'Erika Mieterin',
      counterpartyIbanRaw: 'DE02120300000000202051',
      splits: [{ splitId: 's1', position: 1, amount: { amount: '1250.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE' }],
    });
    expect((await get(base, '/transactions/0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b')).status).toBe(404);
    expect((await get(base, '/transactions/nope')).status).toBe(400);
  });

  it('a page with the filters as given; reviewable is IMPORTED + UNREVIEWED and narrows status; defaults page 1 / 50', async () => {
    const seen: Parameters<ListTransactions>[0][] = [];
    const base = await startWith({
      transactions: {
        list: async (input) => {
          seen.push(input);
          return { items: [transaction], page: input.page.page, pageSize: input.page.pageSize, total: 7 };
        },
      },
    });
    const res = await get(
      base,
      `/transactions?financialAccountId=${ACCOUNT.toUpperCase()}&status=IMPORTED,CONFIRMED&propertyReferenceId=${PROPERTY}&financialCategoryCode=RENT_BASE&provenance=BANK_CSV,MANUAL&bookingDateFrom=2026-09-01&bookingDateTo=2026-09-30&page=2&pageSize=5`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ transactionId: transaction.id }], page: 2, pageSize: 5, total: 7 });
    expect(seen[0]).toMatchObject({
      filter: {
        financialAccountId: ACCOUNT,
        statuses: ['IMPORTED', 'CONFIRMED'],
        propertyReferenceId: PROPERTY,
        financialCategoryCode: 'RENT_BASE',
        provenances: ['BANK_CSV', 'MANUAL'],
        bookingDateFrom: '2026-09-01',
        bookingDateTo: '2026-09-30',
      },
      page: { page: 2, pageSize: 5 },
    });
    await get(base, '/transactions?reviewable=true');
    await get(base, '/transactions?reviewable=true&status=IMPORTED,CONFIRMED');
    expect(seen[1]).toMatchObject({ filter: { statuses: ['IMPORTED', 'UNREVIEWED'] }, page: { page: 1, pageSize: 50 } });
    expect(seen[2]?.filter).toEqual({ statuses: ['IMPORTED'] });
    // No overlap: the filter matches nothing (the repository answers an empty page, review on #26).
    expect((await get(base, '/transactions?reviewable=true&status=CONFIRMED')).status).toBe(200);
    expect(seen[3]?.filter).toEqual({ statuses: [] });
    // current=true is passed as such; the repository applies it together with status.
    await get(base, '/transactions?current=true&status=RECONCILED');
    expect(seen[4]?.filter).toEqual({ statuses: ['RECONCILED'], current: true });
  });

  it('GET /property-references/{id}/transactions: the same filters, the id from the path; 404 when unknown or foreign', async () => {
    const seen: Parameters<ListPropertyReferenceTransactions>[0][] = [];
    const base = await startWith({
      transactions: {
        listForPropertyReference: async (input) => {
          seen.push(input);
          if (input.propertyReferenceId !== PROPERTY) throw new PropertyReferenceNotFoundError(input.propertyReferenceId);
          return { items: [transaction], page: input.page.page, pageSize: input.page.pageSize, total: 1 };
        },
      },
    });
    const res = await get(base, `/property-references/${PROPERTY.toUpperCase()}/transactions?current=true&bookingDateFrom=2026-09-01&pageSize=5`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ transactionId: transaction.id }], page: 1, pageSize: 5, total: 1 });
    expect(seen[0]).toMatchObject({ propertyReferenceId: PROPERTY, filter: { current: true, bookingDateFrom: '2026-09-01' }, page: { page: 1, pageSize: 5 } });

    const unknown = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
    const missing = await get(base, `/property-references/${unknown}/transactions`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { details: unknown } }).error.details).toEqual({ propertyReferenceId: unknown });
    // The PropertyReference is the path: a query filter for it is unknown here, and a malformed id is 400.
    for (const path of [`/property-references/${PROPERTY}/transactions?propertyReferenceId=${PROPERTY}`, '/property-references/nope/transactions']) {
      expect((await get(base, path)).status, path).toBe(400);
    }
    expect(seen).toHaveLength(2);
  });

  it('400 for unknown parameters, bad values and an inverted date range', async () => {
    const base = await startWith({ transactions: { list: () => Promise.reject(new Error('unused')) } });
    for (const query of [
      'foo=1',
      'status=DONE',
      'pageSize=201',
      'page=0',
      'bookingDateFrom=2026-13-01',
      'reviewable=yes',
      'current=false',
      'financialCategoryCode=rent',
      'provenance=IMPORT',
      'financialAccountId=x',
      'bookingDateFrom=2026-09-02&bookingDateTo=2026-09-01',
    ]) {
      expect((await get(base, `/transactions?${query}`)).status, query).toBe(400);
    }
    const inverted = await get(base, '/transactions?bookingDateFrom=2026-09-02&bookingDateTo=2026-09-01');
    expect(((await inverted.json()) as { error: { details: unknown } }).error.details).toEqual({ fields: [{ field: 'bookingDateTo', code: 'INVALID_RANGE' }] });
  });
});

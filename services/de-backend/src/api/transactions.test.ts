import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  InactiveCategoryError,
  InvalidLoanSplitError,
  LoanNotActiveError,
  LoanNotFoundError,
  SplitSumMismatchError,
  SplitsMissingError,
  TransactionNotConfirmableError,
  TransactionNotFoundError,
  CorrectionNoChangeError,
  ImportedFieldsFixedError,
  TransactionNotAmendableError,
  TransactionNotIgnorableError,
  TransactionNotIgnoredError,
  VersionConflictError,
  type AmendTransaction,
  type IgnoreTransaction,
  type RestoreTransaction,
  FinancialCategoryNotFoundError,
  TransactionAlreadyCorrectedError,
  TransactionNotCorrectableError,
  type ConfirmTransaction,
  type CorrectTransaction,
  type ReverseTransaction,
  type ListTransactions,
  type ListPropertyReferenceTransactions,
  type CorrectTransactionInput,
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
  confirmedAt: null,
  confirmedBy: null,
  correctionOfTransactionId: null,
  correctionRole: null,
  reversalTransactionId: null,
  replacementTransactionId: null,
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
      confirmedAt: null,
      confirmedBy: null,
      correctionOfTransactionId: null,
      correctionRole: null,
      reversalTransactionId: null,
      replacementTransactionId: null,
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

describe('POST /api/v1/transactions/{transactionId}/confirm', () => {
  const confirmed = {
    ...transaction,
    status: 'CONFIRMED',
    version: 3,
    confirmedAt: new Date('2026-10-20T09:00:00Z'),
    confirmedBy: 'anna@example.com',
  } as unknown as Transaction;
  async function startConfirm(confirm: ConfirmTransaction): Promise<string> {
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...unusedCommands, confirmTransaction: confirm }).listen(
      0,
      '127.0.0.1',
    );
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const confirmAt = (base: string, id: string = transaction.id) =>
    fetch(`${base}/api/v1/transactions/${id}/confirm`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', organizationid: REALM },
    });

  it('200 with the confirmed Transaction; a repeat is marked as replayed', async () => {
    let replayed = false;
    const seen: string[] = [];
    const base = await startConfirm(async ({ transactionId }) => {
      seen.push(transactionId);
      const result = { transaction: confirmed, replayed };
      replayed = true;
      return result;
    });
    const first = await confirmAt(base, transaction.id.toUpperCase());
    expect(first.status).toBe(200);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    expect(await first.json()).toMatchObject({
      transactionId: transaction.id,
      status: 'CONFIRMED',
      version: 3,
      confirmedAt: '2026-10-20T09:00:00.000Z',
      confirmedBy: 'anna@example.com',
    });
    expect(seen).toEqual([transaction.id]);
    expect((await confirmAt(base)).headers.get('idempotent-replayed')).toBe('true');
  });

  it('maps 400 malformed id, 404, 409 not confirmable / splits missing / sum mismatch, 422 inactive category', async () => {
    const base0 = await startConfirm(() => Promise.reject(new Error('unused')));
    expect((await confirmAt(base0, 'nope')).status).toBe(400);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const cases = [
      [new TransactionNotFoundError(transaction.id), 404, { code: 'NOT_FOUND' }],
      [
        new TransactionNotConfirmableError(transaction.id, 'IGNORED'),
        409,
        { code: 'CONFLICT', details: { reason: 'NOT_CONFIRMABLE', status: 'IGNORED' } },
      ],
      [new SplitsMissingError(transaction.id), 409, { code: 'INVARIANT_VIOLATION', details: { reason: 'SPLITS_MISSING' } }],
      [
        new SplitSumMismatchError(Money.of('1250.00', 'EUR'), Money.of('1249.99', 'EUR')),
        409,
        { code: 'INVARIANT_VIOLATION', details: { reason: 'SPLIT_SUM_MISMATCH', difference: { amount: '0.01', currency: 'EUR' } } },
      ],
      [
        new InactiveCategoryError(['OLD']),
        422,
        { code: 'REVIEW_REQUIRED', details: { reason: 'INACTIVE_CATEGORY', financialCategoryCodes: ['OLD'] } },
      ],
    ] as const;
    for (const [error, status, body] of cases) {
      const base = await startConfirm(() => Promise.reject(error));
      const res = await confirmAt(base);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: unknown }).error).toMatchObject(body);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});

describe('POST /api/v1/transactions/{transactionId}/correct', () => {
  const REVERSAL = '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const REPLACEMENT = '2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const confirmedAt = new Date('2026-10-20T09:00:00Z');
  const result = {
    original: {
      ...transaction,
      status: 'CORRECTED',
      version: 4,
      confirmedAt,
      confirmedBy: 'anna@example.com',
      reversalTransactionId: REVERSAL,
      replacementTransactionId: REPLACEMENT,
    },
    reversal: {
      ...transaction,
      id: REVERSAL,
      direction: 'OUTFLOW',
      provenance: 'CORRECTION',
      status: 'CONFIRMED',
      confirmedAt,
      confirmedBy: 'anna@example.com',
      correctionOfTransactionId: transaction.id,
      correctionRole: 'REVERSAL',
    },
    replacement: {
      ...transaction,
      id: REPLACEMENT,
      bookingDate: '2026-09-03',
      provenance: 'CORRECTION',
      status: 'CONFIRMED',
      confirmedAt,
      confirmedBy: 'anna@example.com',
      correctionOfTransactionId: transaction.id,
      correctionRole: 'REPLACEMENT',
    },
  } as unknown as { original: Transaction; reversal: Transaction; replacement: Transaction };

  async function startCorrect(correct: CorrectTransaction): Promise<string> {
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...unusedCommands, correctTransaction: correct }).listen(
      0,
      '127.0.0.1',
    );
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const stop = () =>
    new Promise<void>((resolve) => server?.close(() => resolve())).then(() => {
      server = undefined;
    });
  const correctAt = (base: string, body: unknown, id: string = transaction.id, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/v1/transactions/${id}/correct`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });

  it('201 with original, reversal and replacement; omitted fields stay omitted, null clears, ids are lower-cased', async () => {
    const seen: CorrectTransactionInput[] = [];
    let replayed = false;
    const base = await startCorrect(async (input) => {
      seen.push(input);
      const answer = { ...result, replayed };
      replayed = true;
      return answer;
    });
    const res = await correctAt(
      base,
      {
        reason: '  Falsches Datum ',
        replacement: { bookingDate: '2026-09-03', valueDate: null, description: '', propertyReferenceId: PROPERTY.toUpperCase() },
      },
      transaction.id.toUpperCase(),
      { 'idempotency-key': 'k-9' },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(body['original']).toMatchObject({
      transactionId: transaction.id,
      status: 'CORRECTED',
      reversalTransactionId: REVERSAL,
      replacementTransactionId: REPLACEMENT,
      correctionOfTransactionId: null,
    });
    expect(body['reversal']).toMatchObject({ transactionId: REVERSAL, direction: 'OUTFLOW', correctionRole: 'REVERSAL', correctionOfTransactionId: transaction.id });
    expect(body['replacement']).toMatchObject({ transactionId: REPLACEMENT, bookingDate: '2026-09-03', correctionRole: 'REPLACEMENT' });
    expect(seen[0]).toEqual({
      principal: expect.anything(),
      transactionId: transaction.id,
      reason: 'Falsches Datum',
      replacement: { bookingDate: '2026-09-03', valueDate: null, description: null, propertyReferenceId: PROPERTY },
      idempotencyKey: 'k-9',
    });
    expect((await correctAt(base, { reason: 'x', replacement: { bookingDate: '2026-09-03' } })).headers.get('idempotent-replayed')).toBe('true');
  });

  it('400 for a malformed id or body: reason required, unknown keys, splits like §33', async () => {
    const base = await startCorrect(() => Promise.reject(new Error('unused')));
    expect((await correctAt(base, { reason: 'x', replacement: {} }, 'nope')).status).toBe(400);
    const fields = async (body: unknown) =>
      (((await (await correctAt(base, body)).json()) as { error: { details: { fields: { field: string; code: string }[] } } }).error.details.fields);
    expect(await fields({ replacement: {} })).toEqual([expect.objectContaining({ field: 'reason' })]);
    expect(await fields({ reason: '   ', replacement: {} })).toEqual([expect.objectContaining({ field: 'reason' })]);
    expect(await fields({ reason: 'x' })).toEqual([expect.objectContaining({ field: 'replacement' })]);
    expect((await fields({ reason: 'x', replacement: { status: 'CONFIRMED' } })).length).toBe(1);
    expect(await fields({ reason: 'x', replacement: { amount: 12.5 } })).toEqual([expect.objectContaining({ field: expect.stringMatching(/^replacement\.amount/) })]);
    expect(
      await fields({
        reason: 'x',
        replacement: { splits: [{ amount: { amount: '1', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE', direction: 'INFLOW' }] },
      }),
    ).toEqual([{ field: 'replacement.splits.0.direction', code: 'NOT_ALLOWED' }]);
  });

  it('maps the refusals of §35.4', async () => {
    const cases = [
      [new TransactionNotFoundError(transaction.id), 404, { code: 'NOT_FOUND', details: { transactionId: transaction.id } }],
      [new FinancialAccountNotFoundError(ACCOUNT), 404, { code: 'NOT_FOUND', details: { financialAccountId: ACCOUNT } }],
      [new PropertyReferenceNotFoundError(PROPERTY), 404, { code: 'NOT_FOUND', details: { propertyReferenceId: PROPERTY } }],
      [
        new TransactionAlreadyCorrectedError(transaction.id, REVERSAL, REPLACEMENT),
        409,
        { code: 'CONFLICT', details: { reason: 'ALREADY_CORRECTED', reversalTransactionId: REVERSAL, replacementTransactionId: REPLACEMENT } },
      ],
      [
        new TransactionNotCorrectableError(transaction.id, 'RECONCILED'),
        409,
        { code: 'CONFLICT', details: { reason: 'NOT_CORRECTABLE', status: 'RECONCILED' } },
      ],
      [
        new TransactionNotCorrectableError(transaction.id, 'CONFIRMED', 'REVERSAL'),
        409,
        { code: 'CONFLICT', details: { reason: 'NOT_CORRECTABLE', status: 'CONFIRMED', correctionRole: 'REVERSAL' } },
      ],
      [new CorrectionNoChangeError('same'), 409, { code: 'CONFLICT', details: { reason: 'NO_CHANGE' } }],
      [new FinancialAccountClosedError(ACCOUNT), 409, { code: 'CONFLICT', details: { reason: 'ACCOUNT_CLOSED', financialAccountId: ACCOUNT } }],
      [
        new SplitSumMismatchError(Money.of('1200.00', 'EUR'), Money.of('1250.00', 'EUR')),
        409,
        { code: 'INVARIANT_VIOLATION', details: { reason: 'SPLIT_SUM_MISMATCH', difference: { amount: '-50.00', currency: 'EUR' } } },
      ],
      [new IdempotencyKeyConflictError('x'), 409, { code: 'CONFLICT' }],
      [new InactiveCategoryError(['OLD']), 422, { code: 'REVIEW_REQUIRED', details: { reason: 'INACTIVE_CATEGORY', financialCategoryCodes: ['OLD'] } }],
      [new CurrencyMismatchError('x'), 400, { code: 'VALIDATION_ERROR' }],
      // §41.5: the replacement's splits with loanId.
      [new LoanNotFoundError(ACCOUNT), 404, { code: 'NOT_FOUND', details: { loanId: ACCOUNT } }],
      [new InvalidLoanSplitError(1, 'DIRECTION'), 422, { code: 'INVALID_LOAN_SPLIT', details: { position: 1, reason: 'DIRECTION' } }],
      [new LoanNotActiveError(ACCOUNT, 'VOID'), 409, { code: 'CONFLICT', details: { reason: 'LOAN_NOT_ACTIVE', loanId: ACCOUNT, status: 'VOID' } }],
    ] as const;
    for (const [error, status, body] of cases) {
      const base = await startCorrect(() => Promise.reject(error));
      const res = await correctAt(base, { reason: 'x', replacement: { bookingDate: '2026-09-03' } });
      expect(res.status, error.name).toBe(status);
      expect(((await res.json()) as { error: unknown }).error, error.name).toMatchObject(body);
      await stop();
    }

    const base = await startCorrect(() => Promise.reject(new FinancialCategoryNotFoundError(['NOPE'])));
    const res = await correctAt(base, {
      reason: 'x',
      replacement: { splits: [{ amount: { amount: '1250.00', currency: 'EUR' }, financialCategoryCode: 'NOPE' }] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({
      fields: [{ field: 'replacement.splits.0.financialCategoryCode', code: 'UNKNOWN_CATEGORY' }],
    });
    await stop();

    // A currency mismatch names the field (VC-X-18): a requested amount or split by its path, a copied one by the
    // account whose currency it no longer matches.
    const eurSplit = (amount: string) => ({ amount: { amount, currency: 'EUR' }, financialCategoryCode: 'OTHER' });
    const currencyCases = [
      [{ amount: true, splitPositions: [2] }, { amount: { amount: '1250.00', currency: 'EUR' }, splits: [eurSplit('1000.00'), eurSplit('250.00')] }, [
        'replacement.amount.currency',
        'replacement.splits.1.amount.currency',
      ]],
      [{ amount: true, splitPositions: [1, 2] }, { financialAccountId: ACCOUNT }, ['replacement.financialAccountId']],
      [{ amount: false, splitPositions: [1] }, { financialAccountId: ACCOUNT, splits: [eurSplit('1250.00')] }, ['replacement.splits.0.amount.currency']],
    ] as const;
    for (const [where, replacement, fields] of currencyCases) {
      const at = await startCorrect(() => Promise.reject(new CurrencyMismatchError('x', where)));
      const answer = await correctAt(at, { reason: 'x', replacement });
      expect(answer.status).toBe(400);
      expect(((await answer.json()) as { error: { details: unknown } }).error.details).toEqual({
        fields: fields.map((field) => ({ field, code: 'CURRENCY_MISMATCH' })),
      });
      await stop();
    }
  });
});

describe('amend / ignore / restore an unconfirmed Transaction (§31.3–31.4)', () => {
  async function startWith(commands: {
    amendTransaction?: AmendTransaction;
    ignoreTransaction?: IgnoreTransaction;
    restoreTransaction?: RestoreTransaction;
  }): Promise<string> {
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...unusedCommands, ...commands }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const stop = () =>
    new Promise<void>((resolve) => server?.close(() => resolve())).then(() => {
      server = undefined;
    });
  const postTo = (base: string, action: string, body?: unknown, id: string = transaction.id) =>
    fetch(`${base}/api/v1/transactions/${id}/${action}`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('amend: 200 with the Transaction; omitted keys stay omitted, null clears, ids lower-cased', async () => {
    const seen: Parameters<AmendTransaction>[0][] = [];
    const base = await startWith({
      amendTransaction: async (input) => {
        seen.push(input);
        return { transaction, changed: true, splitsDropped: true };
      },
    });
    const res = await postTo(base, 'amend', { valueDate: null, description: '', propertyReferenceId: PROPERTY.toUpperCase(), amount: { amount: '1200', currency: 'EUR' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ transactionId: transaction.id, splitsDropped: true });
    expect(seen[0]?.changes).toEqual({ valueDate: null, description: null, propertyReferenceId: PROPERTY, amount: Money.of('1200', 'EUR') });
  });

  it('amend: 400 for an empty or unknown body, 404/409 refusals', async () => {
    const base0 = await startWith({ amendTransaction: () => Promise.reject(new Error('unused')) });
    const fields = async (body: unknown) =>
      ((await (await postTo(base0, 'amend', body)).json()) as { error: { details: { fields: unknown[] } } }).error.details.fields;
    expect(await fields({})).toEqual([{ field: '(body)', code: 'REQUIRED' }]);
    expect(await fields({ status: 'CONFIRMED' })).toContainEqual({ field: '(body)', code: 'INVALID_FORMAT' });
    expect((await postTo(base0, 'amend', { description: 'x' }, 'nope')).status).toBe(400);
    await stop();

    const cases = [
      [new TransactionNotFoundError(transaction.id), 404, { code: 'NOT_FOUND' }],
      [new TransactionNotAmendableError(transaction.id, 'CONFIRMED'), 409, { code: 'CONFLICT', details: { reason: 'NOT_AMENDABLE', status: 'CONFIRMED' } }],
      [new ImportedFieldsFixedError(['amount']), 409, { code: 'CONFLICT', details: { reason: 'IMPORTED_FIELDS_FIXED', fields: ['amount'] } }],
      [new FinancialAccountClosedError(ACCOUNT), 409, { code: 'CONFLICT', details: { reason: 'ACCOUNT_CLOSED' } }],
      [new FinancialAccountNotFoundError(ACCOUNT), 404, { code: 'NOT_FOUND', details: { financialAccountId: ACCOUNT } }],
      [new PropertyReferenceNotFoundError(PROPERTY), 404, { code: 'NOT_FOUND', details: { propertyReferenceId: PROPERTY } }],
      [new CurrencyMismatchError('x'), 400, { code: 'VALIDATION_ERROR' }],
    ] as const;
    for (const [error, status, body] of cases) {
      const base = await startWith({ amendTransaction: () => Promise.reject(error) });
      const res = await postTo(base, 'amend', { description: 'x' });
      expect(res.status, error.name).toBe(status);
      expect(((await res.json()) as { error: unknown }).error, error.name).toMatchObject(body);
      await stop();
    }
  });

  it('ignore needs a reason; a repeat is marked replayed; confirmed is 409', async () => {
    let replayed = false;
    const base = await startWith({
      ignoreTransaction: async ({ reason }) => {
        expect(reason).toBe('Doppelt');
        const answer = { transaction, replayed };
        replayed = true;
        return answer;
      },
    });
    expect((await postTo(base, 'ignore', {})).status).toBe(400);
    const first = await postTo(base, 'ignore', { reason: ' Doppelt ' });
    expect(first.status).toBe(200);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    expect((await postTo(base, 'ignore', { reason: 'Doppelt' })).headers.get('idempotent-replayed')).toBe('true');
    await stop();

    const refused = await startWith({ ignoreTransaction: () => Promise.reject(new TransactionNotIgnorableError(transaction.id, 'CONFIRMED')) });
    const res = await postTo(refused, 'ignore', { reason: 'x' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({ details: { reason: 'NOT_IGNORABLE', status: 'CONFIRMED' } });
  });

  it('restore: 200, or 409 when not ignored', async () => {
    const base = await startWith({ restoreTransaction: async () => ({ transaction }) });
    expect((await postTo(base, 'restore')).status).toBe(200);
    await stop();
    const refused = await startWith({ restoreTransaction: () => Promise.reject(new TransactionNotIgnoredError(transaction.id, 'CLASSIFIED')) });
    const res = await postTo(refused, 'restore');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({ details: { reason: 'NOT_IGNORED', status: 'CLASSIFIED' } });
  });
});

describe('If-Match / ETag (api-design §16, VC-X-20)', () => {
  async function startWith(commands: Partial<Parameters<typeof createApp>[0]>): Promise<string> {
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...unusedCommands, ...commands }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const amendWith = (base: string, ifMatch?: string) =>
    fetch(`${base}/api/v1/transactions/${transaction.id}/amend`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer a.b.c',
        organizationid: REALM,
        'content-type': 'application/json',
        ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
      },
      body: JSON.stringify({ description: 'x' }),
    });

  it('passes the strong versions of If-Match (a list too; weak tags never match), none for * or no header; answers with an ETag', async () => {
    const seen: (readonly number[] | undefined)[] = [];
    const base = await startWith({
      amendTransaction: async (input) => {
        seen.push(input.expectedVersions);
        return { transaction: { ...transaction, version: 4 } as Transaction, changed: true, splitsDropped: false };
      },
    });
    for (const header of ['"3"', '"3", "4"', 'W/"3"', '"abc", W/"4", "5"', '"3", , "4",', '"a,b", "5"', '*', undefined]) {
      const res = await amendWith(base, header);
      expect(res.status, String(header)).toBe(200);
      expect(res.headers.get('etag')).toBe('"4"');
    }
    // Empty list elements are allowed and a tag may contain a comma (RFC 9110 §5.6.1, §8.8.3; review on #25).
    expect(seen).toEqual([[3], [3, 4], [], [5], [3, 4], [5], undefined, undefined]);
  });

  it('400 for an If-Match that is not a list of entity tags; 412 VERSION_CONFLICT names the versions', async () => {
    const base0 = await startWith({ amendTransaction: () => Promise.reject(new Error('unused')) });
    for (const header of ['3', 'abc', '"3', 'W/3', ',', '"3" "4"', '"3"x']) {
      const res = await amendWith(base0, header);
      expect(res.status, header).toBe(400);
      expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ fields: [{ field: 'If-Match', code: 'INVALID_FORMAT' }] });
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const error = new VersionConflictError([3], 5);
    const cases: [string, Partial<Parameters<typeof createApp>[0]>, string, unknown][] = [
      ['amend', { amendTransaction: () => Promise.reject(error) }, 'amend', { description: 'x' }],
      ['ignore', { ignoreTransaction: () => Promise.reject(error) }, 'ignore', { reason: 'x' }],
      ['restore', { restoreTransaction: () => Promise.reject(error) }, 'restore', undefined],
      ['confirm', { confirmTransaction: () => Promise.reject(error) }, 'confirm', undefined],
      ['correct', { correctTransaction: () => Promise.reject(error) }, 'correct', { reason: 'x', replacement: { bookingDate: '2026-09-03' } }],
    ];
    for (const [name, commands, action, body] of cases) {
      const base = await startWith(commands);
      const res = await fetch(`${base}/api/v1/transactions/${transaction.id}/${action}`, {
        method: 'POST',
        headers: { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json', 'if-match': '"3"' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status, name).toBe(412);
      expect(((await res.json()) as { error: unknown }).error, name).toMatchObject({
        code: 'VERSION_CONFLICT',
        details: { expectedVersions: [3], currentVersion: 5 },
      });
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    const base = await startWith({ setTransactionSplits: () => Promise.reject(error) });
    const res = await fetch(`${base}/api/v1/transactions/${transaction.id}/splits`, {
      method: 'PUT',
      headers: { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json', 'if-match': '"3"' },
      body: JSON.stringify({ splits: [{ amount: { amount: '1250.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE' }] }),
    });
    expect(res.status).toBe(412);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT');
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    // PUT splits: a split outside the Transaction's currency is named by its path (VC-X-18).
    const mismatch = await startWith({
      setTransactionSplits: () => Promise.reject(new CurrencyMismatchError('x', { amount: false, splitPositions: [2] })),
    });
    const refused = await fetch(`${mismatch}/api/v1/transactions/${transaction.id}/splits`, {
      method: 'PUT',
      headers: { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json' },
      body: JSON.stringify({ splits: [{ amount: { amount: '1250.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE' }] }),
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { details: unknown } }).error.details).toEqual({
      fields: [{ field: 'splits.1.amount.currency', code: 'CURRENCY_MISMATCH' }],
    });
  });
});

describe('GET /api/v1/transactions(/{id}) (§30.1, VC-X-21)', () => {
  async function startWith(commands: Partial<Parameters<typeof createApp>[0]>): Promise<string> {
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...unusedCommands, ...commands }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const get = (base: string, path: string) =>
    fetch(`${base}/api/v1${path}`, { headers: { authorization: 'Bearer a.b.c', organizationid: REALM } });

  it('one Transaction with its splits and an ETag; 404 unknown, 400 malformed id', async () => {
    const split = {
      id: 's1',
      position: 1,
      amount: Money.of('1250.00', 'EUR'),
      financialCategoryCode: 'RENT_BASE',
      propertyReferenceId: null,
      loanId: null,
      description: null,
    };
    const base = await startWith({
      getTransaction: async ({ transactionId }) => {
        if (transactionId !== transaction.id) throw new TransactionNotFoundError(transactionId);
        return { transaction: { ...transaction, version: 3 } as Transaction, splits: [split] };
      },
    });
    const res = await get(base, `/transactions/${transaction.id.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"3"');
    expect(await res.json()).toMatchObject({
      transactionId: transaction.id,
      version: 3,
      splits: [{ splitId: 's1', position: 1, amount: { amount: '1250.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE' }],
    });
    expect((await get(base, '/transactions/0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b')).status).toBe(404);
    expect((await get(base, '/transactions/nope')).status).toBe(400);
  });

  it('a page with the filters as given; reviewable is IMPORTED + UNREVIEWED and narrows status; defaults page 1 / 50', async () => {
    const seen: Parameters<ListTransactions>[0][] = [];
    const base = await startWith({
      listTransactions: async (input) => {
        seen.push(input);
        return { items: [transaction], page: input.page.page, pageSize: input.page.pageSize, total: 7 };
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
      listPropertyReferenceTransactions: async (input) => {
        seen.push(input);
        if (input.propertyReferenceId !== PROPERTY) throw new PropertyReferenceNotFoundError(input.propertyReferenceId);
        return { items: [transaction], page: input.page.page, pageSize: input.page.pageSize, total: 1 };
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
    const base = await startWith({ listTransactions: () => Promise.reject(new Error('unused')) });
    for (const query of ['foo=1', 'status=DONE', 'pageSize=201', 'page=0', 'bookingDateFrom=2026-13-01', 'reviewable=yes', 'current=false', 'financialCategoryCode=rent', 'provenance=IMPORT', 'financialAccountId=x', 'bookingDateFrom=2026-09-02&bookingDateTo=2026-09-01']) {
      expect((await get(base, `/transactions?${query}`)).status, query).toBe(400);
    }
    const inverted = await get(base, '/transactions?bookingDateFrom=2026-09-02&bookingDateTo=2026-09-01');
    expect(((await inverted.json()) as { error: { details: unknown } }).error.details).toEqual({ fields: [{ field: 'bookingDateTo', code: 'INVALID_RANGE' }] });
  });
});

describe('POST /api/v1/transactions/{id}/reverse (§35.9, VC-X-15)', () => {
  async function startWith(reverse: ReverseTransaction): Promise<string> {
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...unusedCommands, reverseTransaction: reverse }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const stop = () =>
    new Promise<void>((resolve) => server?.close(() => resolve())).then(() => {
      server = undefined;
    });
  const reverseAt = (base: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/v1/transactions/${transaction.id}/reverse`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('201 with original and reversal, replacement null; passes reason, key and If-Match', async () => {
    const seen: Parameters<ReverseTransaction>[0][] = [];
    const base = await startWith(async (input) => {
      seen.push(input);
      return {
        original: { ...transaction, status: 'CORRECTED' } as Transaction,
        reversal: { ...transaction, id: 'rev', direction: 'OUTFLOW', correctionRole: 'REVERSAL' } as unknown as Transaction,
        replacement: null,
        replayed: false,
      };
    });
    const res = await reverseAt(base, { reason: ' Doppelt ' }, { 'idempotency-key': 'k-1', 'if-match': '"2"' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ original: { status: 'CORRECTED' }, reversal: { transactionId: 'rev', correctionRole: 'REVERSAL' }, replacement: null });
    expect(seen[0]).toMatchObject({ transactionId: transaction.id, reason: 'Doppelt', idempotencyKey: 'k-1', expectedVersions: [2] });
    expect((await reverseAt(base, {})).status).toBe(400);
    expect((await reverseAt(base, { reason: 'x', replacement: {} })).status).toBe(400);
  });

  it('maps the refusals', async () => {
    const cases = [
      [new TransactionNotFoundError(transaction.id), 404, { code: 'NOT_FOUND' }],
      [new TransactionAlreadyCorrectedError(transaction.id, 'rev', null), 409, { details: { reason: 'ALREADY_CORRECTED', reversalTransactionId: 'rev', replacementTransactionId: null } }],
      [new TransactionNotCorrectableError(transaction.id, 'CONFIRMED', 'REVERSAL'), 409, { details: { reason: 'NOT_CORRECTABLE', correctionRole: 'REVERSAL' } }],
      [new VersionConflictError([2], 3), 412, { code: 'VERSION_CONFLICT' }],
      [new IdempotencyKeyConflictError('x'), 409, { code: 'CONFLICT' }],
    ] as const;
    for (const [error, status, body] of cases) {
      const base = await startWith(() => Promise.reject(error));
      const res = await reverseAt(base, { reason: 'x' });
      expect(res.status, error.name).toBe(status);
      expect(((await res.json()) as { error: unknown }).error, error.name).toMatchObject(body);
      await stop();
    }
  });
});

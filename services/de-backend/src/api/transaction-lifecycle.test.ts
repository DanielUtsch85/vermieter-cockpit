import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  InactiveCategoryError,
  InvalidLoanSplitError,
  LoanClosedOnError,
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
  FinancialCategoryNotFoundError,
  TransactionAlreadyCorrectedError,
  TransactionNotCorrectableError,
  TransactionRentReconciledError,
  type ConfirmTransaction,
  type CorrectTransaction,
  type ReverseTransaction,
  type CorrectTransactionInput,
  FinancialAccountClosedError,
  FinancialAccountNotFoundError,
  IdempotencyKeyConflictError,
  PropertyReferenceNotFoundError,
  type Transaction,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';
import { REALM, ACCOUNT, PROPERTY, transaction, admin } from './transactions.test-support.js';

/** The lifecycle routes of `transaction-lifecycle.ts`: confirm, correct, reverse, amend, ignore, restore and If-Match (api-design.md §16, §31.3–§35) (#104). */
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
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
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith({ transactions: { confirm } }) }).listen(0, '127.0.0.1');
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
      [new TransactionNotConfirmableError(transaction.id, 'IGNORED'), 409, { code: 'CONFLICT', details: { reason: 'NOT_CONFIRMABLE', status: 'IGNORED' } }],
      [new SplitsMissingError(transaction.id), 409, { code: 'INVARIANT_VIOLATION', details: { reason: 'SPLITS_MISSING' } }],
      [
        new SplitSumMismatchError(Money.of('1250.00', 'EUR'), Money.of('1249.99', 'EUR')),
        409,
        { code: 'INVARIANT_VIOLATION', details: { reason: 'SPLIT_SUM_MISMATCH', difference: { amount: '0.01', currency: 'EUR' } } },
      ],
      [new InactiveCategoryError(['OLD']), 422, { code: 'REVIEW_REQUIRED', details: { reason: 'INACTIVE_CATEGORY', financialCategoryCodes: ['OLD'] } }],
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
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith({ transactions: { correct } }) }).listen(0, '127.0.0.1');
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
    expect(body['reversal']).toMatchObject({
      transactionId: REVERSAL,
      direction: 'OUTFLOW',
      correctionRole: 'REVERSAL',
      correctionOfTransactionId: transaction.id,
    });
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
      ((await (await correctAt(base, body)).json()) as { error: { details: { fields: { field: string; code: string }[] } } }).error.details.fields;
    expect(await fields({ replacement: {} })).toEqual([expect.objectContaining({ field: 'reason' })]);
    expect(await fields({ reason: '   ', replacement: {} })).toEqual([expect.objectContaining({ field: 'reason' })]);
    expect(await fields({ reason: 'x' })).toEqual([expect.objectContaining({ field: 'replacement' })]);
    expect((await fields({ reason: 'x', replacement: { status: 'CONFIRMED' } })).length).toBe(1);
    expect(await fields({ reason: 'x', replacement: { amount: 12.5 } })).toEqual([
      expect.objectContaining({ field: expect.stringMatching(/^replacement\.amount/) }),
    ]);
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
      [
        new TransactionRentReconciledError(transaction.id, ['r1', 'r2']),
        409,
        { code: 'CONFLICT', details: { reason: 'TRANSACTION_RENT_RECONCILED', reconciliationIds: ['r1', 'r2'] } },
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
      [
        new LoanClosedOnError(ACCOUNT, '2027-06-30' as never),
        409,
        { code: 'CONFLICT', details: { reason: 'LOAN_CLOSED', loanId: ACCOUNT, closingDate: '2027-06-30' } },
      ],
      // §41.5: the replacement's splits with loanId.
      [new LoanNotFoundError(ACCOUNT), 404, { code: 'NOT_FOUND', details: { loanId: ACCOUNT } }],
      [new InvalidLoanSplitError(1, 'DIRECTION'), 422, { code: 'INVALID_LOAN_SPLIT', details: { position: 1, reason: 'DIRECTION' } }],
      [new LoanNotActiveError(ACCOUNT, 'VOID'), 409, { code: 'CONFLICT', details: { reason: 'LOAN_NOT_ACTIVE', loanId: ACCOUNT, status: 'VOID' } }],
      [
        new LoanClosedOnError(ACCOUNT, '2027-06-30' as never),
        409,
        { code: 'CONFLICT', details: { reason: 'LOAN_CLOSED', loanId: ACCOUNT, closingDate: '2027-06-30' } },
      ],
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
      [
        { amount: true, splitPositions: [2] },
        { amount: { amount: '1250.00', currency: 'EUR' }, splits: [eurSplit('1000.00'), eurSplit('250.00')] },
        ['replacement.amount.currency', 'replacement.splits.1.amount.currency'],
      ],
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
  async function startWith(commands: CommandOverrides): Promise<string> {
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith(commands) }).listen(0, '127.0.0.1');
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
      transactions: {
        amend: async (input) => {
          seen.push(input);
          return { transaction, changed: true, splitsDropped: true };
        },
      },
    });
    const res = await postTo(base, 'amend', {
      valueDate: null,
      description: '',
      propertyReferenceId: PROPERTY.toUpperCase(),
      amount: { amount: '1200', currency: 'EUR' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ transactionId: transaction.id, splitsDropped: true });
    expect(seen[0]?.changes).toEqual({ valueDate: null, description: null, propertyReferenceId: PROPERTY, amount: Money.of('1200', 'EUR') });
  });

  it('amend: 400 for an empty or unknown body, 404/409 refusals', async () => {
    const base0 = await startWith({ transactions: { amend: () => Promise.reject(new Error('unused')) } });
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
      const base = await startWith({ transactions: { amend: () => Promise.reject(error) } });
      const res = await postTo(base, 'amend', { description: 'x' });
      expect(res.status, error.name).toBe(status);
      expect(((await res.json()) as { error: unknown }).error, error.name).toMatchObject(body);
      await stop();
    }
  });

  it('ignore needs a reason; a repeat is marked replayed; confirmed is 409', async () => {
    let replayed = false;
    const base = await startWith({
      transactions: {
        ignore: async ({ reason }) => {
          expect(reason).toBe('Doppelt');
          const answer = { transaction, replayed };
          replayed = true;
          return answer;
        },
      },
    });
    expect((await postTo(base, 'ignore', {})).status).toBe(400);
    const first = await postTo(base, 'ignore', { reason: ' Doppelt ' });
    expect(first.status).toBe(200);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    expect((await postTo(base, 'ignore', { reason: 'Doppelt' })).headers.get('idempotent-replayed')).toBe('true');
    await stop();

    const refused = await startWith({ transactions: { ignore: () => Promise.reject(new TransactionNotIgnorableError(transaction.id, 'CONFIRMED')) } });
    const res = await postTo(refused, 'ignore', { reason: 'x' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({ details: { reason: 'NOT_IGNORABLE', status: 'CONFIRMED' } });
  });

  it('restore: 200, or 409 when not ignored', async () => {
    const base = await startWith({ transactions: { restore: async () => ({ transaction }) } });
    expect((await postTo(base, 'restore')).status).toBe(200);
    await stop();
    const refused = await startWith({ transactions: { restore: () => Promise.reject(new TransactionNotIgnoredError(transaction.id, 'CLASSIFIED')) } });
    const res = await postTo(refused, 'restore');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({ details: { reason: 'NOT_IGNORED', status: 'CLASSIFIED' } });
  });
});

describe('If-Match / ETag (api-design §16, VC-X-20)', () => {
  async function startWith(commands: CommandOverrides): Promise<string> {
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith(commands) }).listen(0, '127.0.0.1');
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
      transactions: {
        amend: async (input) => {
          seen.push(input.expectedVersions);
          return { transaction: { ...transaction, version: 4 } as Transaction, changed: true, splitsDropped: false };
        },
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
    const base0 = await startWith({ transactions: { amend: () => Promise.reject(new Error('unused')) } });
    for (const header of ['3', 'abc', '"3', 'W/3', ',', '"3" "4"', '"3"x']) {
      const res = await amendWith(base0, header);
      expect(res.status, header).toBe(400);
      expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ fields: [{ field: 'If-Match', code: 'INVALID_FORMAT' }] });
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const error = new VersionConflictError([3], 5);
    const cases: [string, CommandOverrides, string, unknown][] = [
      ['amend', { transactions: { amend: () => Promise.reject(error) } }, 'amend', { description: 'x' }],
      ['ignore', { transactions: { ignore: () => Promise.reject(error) } }, 'ignore', { reason: 'x' }],
      ['restore', { transactions: { restore: () => Promise.reject(error) } }, 'restore', undefined],
      ['confirm', { transactions: { confirm: () => Promise.reject(error) } }, 'confirm', undefined],
      ['correct', { transactions: { correct: () => Promise.reject(error) } }, 'correct', { reason: 'x', replacement: { bookingDate: '2026-09-03' } }],
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
    const base = await startWith({ transactions: { setSplits: () => Promise.reject(error) } });
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
      transactions: { setSplits: () => Promise.reject(new CurrencyMismatchError('x', { amount: false, splitPositions: [2] })) },
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

describe('POST /api/v1/transactions/{id}/reverse (§35.9, VC-X-15)', () => {
  async function startWith(reverse: ReverseTransaction): Promise<string> {
    server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith({ transactions: { reverse } }) }).listen(0, '127.0.0.1');
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
    expect(await res.json()).toMatchObject({
      original: { status: 'CORRECTED' },
      reversal: { transactionId: 'rev', correctionRole: 'REVERSAL' },
      replacement: null,
    });
    expect(seen[0]).toMatchObject({ transactionId: transaction.id, reason: 'Doppelt', idempotencyKey: 'k-1', expectedVersions: [2] });
    expect((await reverseAt(base, {})).status).toBe(400);
    expect((await reverseAt(base, { reason: 'x', replacement: {} })).status).toBe(400);
  });

  it('maps the refusals', async () => {
    const cases = [
      [new TransactionNotFoundError(transaction.id), 404, { code: 'NOT_FOUND' }],
      [
        new TransactionAlreadyCorrectedError(transaction.id, 'rev', null),
        409,
        { details: { reason: 'ALREADY_CORRECTED', reversalTransactionId: 'rev', replacementTransactionId: null } },
      ],
      [
        new TransactionNotCorrectableError(transaction.id, 'CONFIRMED', 'REVERSAL'),
        409,
        { details: { reason: 'NOT_CORRECTABLE', correctionRole: 'REVERSAL' } },
      ],
      [new TransactionRentReconciledError(transaction.id, ['r1']), 409, { details: { reason: 'TRANSACTION_RENT_RECONCILED', reconciliationIds: ['r1'] } }],
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

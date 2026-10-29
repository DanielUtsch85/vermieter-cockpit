import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  DepositNotActiveError,
  FinancialCategoryNotFoundError,
  InvalidLoanSplitError,
  InvalidSecurityDepositSplitError,
  LoanClosedOnError,
  LoanNotActiveError,
  LoanNotFoundError,
  PropertyReferenceNotFoundError,
  SecurityDepositNotFoundError,
  SplitSumMismatchError,
  TransactionFrozenError,
  TransactionNotFoundError,
  type PrincipalVerifier,
  type SetTransactionSplits,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

const REALM = '64b0c0ffee0000000000000a';
const TX = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PROPERTY = 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f';
const LOAN = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const DEPOSIT = '5c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({
  email: 'anna@example.com',
  mreRealmId: mreRealmId ?? '',
  mreRole: 'administrator',
});
const auth = { authorization: 'Bearer a.b.c', organizationid: REALM };

let server: Server | undefined;
async function start(overrides: CommandOverrides): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith(overrides) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; details: Record<string, unknown> } }).error;

const loanSplits = {
  splits: [
    { amount: { amount: '600.00', currency: 'EUR' }, financialCategoryCode: 'LOAN_INTEREST', propertyReferenceId: PROPERTY.toUpperCase() },
    {
      amount: { amount: '600.00', currency: 'EUR' },
      financialCategoryCode: 'LOAN_PRINCIPAL',
      description: '  Rate 10  ',
      propertyReferenceId: null,
      loanId: LOAN.toUpperCase(),
    },
  ],
};
const put = (base: string, body: unknown, id = TX) =>
  fetch(`${base}/api/v1/transactions/${id}/splits`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('PUT /api/v1/transactions/{transactionId}/splits', () => {
  it('200 with the stored set; the use case gets parsed, normalized splits', async () => {
    const seen: Parameters<SetTransactionSplits>[0][] = [];
    const base = await start({
      transactions: {
        setSplits: async (input) => {
          seen.push(input);
          return {
            transaction: { id: TX, amount: Money.of('1200.00', 'EUR'), direction: 'OUTFLOW', status: 'CLASSIFIED', version: 2 } as never,
            splits: input.splits.map((s, i) => ({ ...s, id: `s-${i + 1}`, position: i + 1 })),
          };
        },
      },
    });
    const res = await put(base, loanSplits, TX.toUpperCase());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transactionId: TX,
      amount: { amount: '1200.00', currency: 'EUR' },
      direction: 'OUTFLOW',
      status: 'CLASSIFIED',
      version: 2,
      splits: [
        {
          splitId: 's-1',
          position: 1,
          amount: { amount: '600.00', currency: 'EUR' },
          financialCategoryCode: 'LOAN_INTEREST',
          propertyReferenceId: PROPERTY,
          loanId: null,
          securityDepositId: null,
          description: null,
        },
        {
          splitId: 's-2',
          position: 2,
          amount: { amount: '600.00', currency: 'EUR' },
          financialCategoryCode: 'LOAN_PRINCIPAL',
          propertyReferenceId: null,
          loanId: LOAN,
          securityDepositId: null,
          description: 'Rate 10',
        },
      ],
    });
    expect(seen[0]?.transactionId).toBe(TX);
    expect(seen[0]?.splits.map((s) => s.loanId)).toEqual([null, LOAN]);
    expect(seen[0]?.principal.mreRealmId).toBe(REALM);
  });

  it('400 for negative, unscaled or numeric amounts, a direction, unsupported references, unknown keys and an empty list', async () => {
    const base = await start({});
    const one = (extra: Record<string, unknown>) => ({
      splits: [{ amount: { amount: '1.00', currency: 'EUR' }, financialCategoryCode: 'OTHER', ...extra }],
    });
    const cases: [unknown, { field: string; code: string }[]][] = [
      [one({ amount: { amount: '-1.00', currency: 'EUR' } }), [{ field: 'splits.0.amount.amount', code: 'NEGATIVE_AMOUNT' }]],
      [one({ amount: { amount: '1.005', currency: 'EUR' } }), [{ field: 'splits.0.amount.amount', code: 'SCALE_EXCEEDED' }]],
      [one({ amount: { amount: 1, currency: 'EUR' } }), [{ field: 'splits.0.amount.amount', code: 'INVALID_FORMAT' }]],
      [one({ direction: 'OUTFLOW' }), [{ field: 'splits.0.direction', code: 'NOT_ALLOWED' }]],
      [one({ wegId: TX }), [{ field: 'splits.0.wegId', code: 'NOT_SUPPORTED' }]],
      [one({ loanId: 'x' }), [{ field: 'splits.0.loanId', code: 'INVALID_FORMAT' }]],
      // A Loan reaches its properties only through its allocation (§41.5).
      [one({ loanId: LOAN, propertyReferenceId: PROPERTY }), [{ field: 'splits.0.propertyReferenceId', code: 'NOT_ALLOWED_WITH_LOAN' }]],
      [one({ financialCategoryCode: 'loan interest' }), [{ field: 'splits.0.financialCategoryCode', code: 'INVALID_FORMAT' }]],
      [one({ colour: 'red' }), [{ field: 'splits.0', code: 'INVALID_FORMAT' }]],
      [{ splits: [] }, [{ field: 'splits', code: 'INVALID_FORMAT' }]],
      [{}, [{ field: 'splits', code: 'REQUIRED' }]],
    ];
    for (const [body, fields] of cases) {
      const res = await put(base, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).details['fields']).toEqual(fields);
    }
    expect((await put(base, loanSplits, 'nope')).status).toBe(400);
  });

  it('maps not found, unknown category, currency, frozen, sum mismatch and the Loan refusals of §41.5', async () => {
    const cases = [
      [new LoanNotFoundError(LOAN), 404, { code: 'NOT_FOUND', details: { loanId: LOAN } }],
      [new InvalidLoanSplitError(2, 'CATEGORY'), 422, { code: 'INVALID_LOAN_SPLIT', details: { position: 2, reason: 'CATEGORY' } }],
      [new InvalidLoanSplitError(1, 'DIRECTION'), 422, { code: 'INVALID_LOAN_SPLIT', details: { position: 1, reason: 'DIRECTION' } }],
      [new LoanNotActiveError(LOAN, 'VOID'), 409, { code: 'CONFLICT', details: { reason: 'LOAN_NOT_ACTIVE', loanId: LOAN, status: 'VOID' } }],
      [
        new LoanClosedOnError(LOAN, '2027-06-30' as never),
        409,
        { code: 'CONFLICT', details: { reason: 'LOAN_CLOSED', loanId: LOAN, closingDate: '2027-06-30' } },
      ],
      [new TransactionNotFoundError(TX), 404, { code: 'NOT_FOUND' }],
      [new PropertyReferenceNotFoundError(PROPERTY), 404, { code: 'NOT_FOUND', details: { propertyReferenceId: PROPERTY } }],
      [
        new FinancialCategoryNotFoundError(['LOAN_PRINCIPAL']),
        400,
        { code: 'VALIDATION_ERROR', details: { fields: [{ field: 'splits.1.financialCategoryCode', code: 'UNKNOWN_CATEGORY' }] } },
      ],
      [new CurrencyMismatchError('x'), 400, { details: { fields: [{ field: 'splits', code: 'CURRENCY_MISMATCH' }] } }],
      [new TransactionFrozenError(TX, 'CONFIRMED'), 409, { code: 'CONFLICT', details: { reason: 'TRANSACTION_FROZEN', status: 'CONFIRMED' } }],
      [
        new SplitSumMismatchError(Money.of('1200.00', 'EUR'), Money.of('1199.99', 'EUR')),
        409,
        {
          code: 'INVARIANT_VIOLATION',
          details: {
            reason: 'SPLIT_SUM_MISMATCH',
            expected: { amount: '1200.00', currency: 'EUR' },
            actual: { amount: '1199.99', currency: 'EUR' },
            difference: { amount: '0.01', currency: 'EUR' },
          },
        },
      ],
    ] as const;
    for (const [error, status, body] of cases) {
      const base = await start({ transactions: { setSplits: () => Promise.reject(error) } });
      const res = await put(base, loanSplits);
      expect(res.status).toBe(status);
      expect(await errorOf(res)).toMatchObject(body);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});

describe('PUT /api/v1/transactions/{transactionId}/splits with securityDepositId (§47.2)', () => {
  const depositSplits = {
    splits: [
      { amount: { amount: '650.00', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE' },
      { amount: { amount: '1500.00', currency: 'EUR' }, financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: DEPOSIT.toUpperCase() },
    ],
  };

  it('200: the id reaches the use case lower-cased and comes back on each split', async () => {
    const seen: Parameters<SetTransactionSplits>[0][] = [];
    const base = await start({
      transactions: {
        setSplits: async (input) => {
          seen.push(input);
          return {
            transaction: { id: TX, amount: Money.of('2150.00', 'EUR'), direction: 'INFLOW', status: 'CLASSIFIED', version: 2 } as never,
            splits: input.splits.map((s, i) => ({ ...s, id: `s-${i + 1}`, position: i + 1 })),
          };
        },
      },
    });
    const res = await put(base, depositSplits);
    expect(res.status).toBe(200);
    expect(seen[0]?.splits.map((s) => [s.loanId, s.securityDepositId])).toEqual([
      [null, null],
      [null, DEPOSIT],
    ]);
    expect(((await res.json()) as { splits: { securityDepositId: string | null }[] }).splits.map((s) => s.securityDepositId)).toEqual([null, DEPOSIT]);
  });

  it('400: a malformed id; never with a PropertyReference or a Loan', async () => {
    const base = await start({});
    const one = (extra: Record<string, unknown>) => ({
      splits: [{ amount: { amount: '1.00', currency: 'EUR' }, financialCategoryCode: 'SECURITY_DEPOSIT', ...extra }],
    });
    const cases: [unknown, { field: string; code: string }[]][] = [
      [one({ securityDepositId: 'x' }), [{ field: 'splits.0.securityDepositId', code: 'INVALID_FORMAT' }]],
      [
        one({ securityDepositId: DEPOSIT, propertyReferenceId: PROPERTY }),
        [{ field: 'splits.0.propertyReferenceId', code: 'NOT_ALLOWED_WITH_SECURITY_DEPOSIT' }],
      ],
      [one({ securityDepositId: DEPOSIT, loanId: LOAN }), [{ field: 'splits.0.loanId', code: 'NOT_ALLOWED_WITH_SECURITY_DEPOSIT' }]],
    ];
    for (const [body, fields] of cases) {
      const res = await put(base, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).details['fields']).toEqual(fields);
    }
    // A null id is no deposit and passes the schema.
    expect((await put(base, one({ securityDepositId: null, propertyReferenceId: PROPERTY }))).status).not.toBe(400);
  });

  it('maps the deposit refusals of §47.2', async () => {
    const cases = [
      [new SecurityDepositNotFoundError(DEPOSIT), 404, { code: 'NOT_FOUND', details: { securityDepositId: DEPOSIT } }],
      [new InvalidSecurityDepositSplitError(2, 'CATEGORY'), 422, { code: 'INVALID_SECURITY_DEPOSIT_SPLIT', details: { position: 2, reason: 'CATEGORY' } }],
      [new InvalidSecurityDepositSplitError(1, 'DIRECTION'), 422, { code: 'INVALID_SECURITY_DEPOSIT_SPLIT', details: { position: 1, reason: 'DIRECTION' } }],
      [
        new DepositNotActiveError(DEPOSIT, 'VOID'),
        409,
        { code: 'CONFLICT', details: { reason: 'DEPOSIT_NOT_ACTIVE', securityDepositId: DEPOSIT, status: 'VOID' } },
      ],
    ] as const;
    for (const [error, status, body] of cases) {
      const base = await start({ transactions: { setSplits: () => Promise.reject(error) } });
      const res = await put(base, depositSplits);
      expect(res.status).toBe(status);
      expect(await errorOf(res)).toMatchObject(body);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});

describe('GET /api/v1/financial-categories', () => {
  const category = { code: 'LOAN_INTEREST', name: 'Darlehenszinsen', categoryType: 'FINANCING', active: true } as const;

  it('lists the catalog and serves one code; unknown → 404, malformed → 400', async () => {
    const base = await start({
      financialCategories: {
        list: async () => [category],
        get: async (code) => {
          if (code === 'LOAN_INTEREST') return category;
          throw new FinancialCategoryNotFoundError([code]);
        },
      },
    });
    const list = await fetch(`${base}/api/v1/financial-categories`, { headers: auth });
    expect(await list.json()).toEqual({ items: [category] });
    expect(await (await fetch(`${base}/api/v1/financial-categories/LOAN_INTEREST`, { headers: auth })).json()).toEqual(category);
    expect((await fetch(`${base}/api/v1/financial-categories/NOPE`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/api/v1/financial-categories/x-y`, { headers: auth })).status).toBe(400);
  });
});

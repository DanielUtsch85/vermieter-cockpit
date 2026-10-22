import { describe, expect, it } from 'vitest';
import {
  correctionFingerprint,
  type BusinessDate,
  type CorrectionRepository,
  type CorrectionRequest,
  type CorrectionResult,
  type CorrectOutcome,
  type TransactionId,
} from '../domains/ledger/index.js';
import { Money, type AuditActor } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import {
  CorrectionNoChangeError,
  TransactionAlreadyCorrectedError,
  TransactionNotCorrectableError,
  correctTransaction,
  reverseTransaction,
} from './correct-transaction.js';
import { IdempotencyKeyConflictError } from './errors.js';
import { FinancialAccountNotFoundError } from './financial-accounts.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { FinancialCategoryNotFoundError, SplitSumMismatchError, TransactionNotFoundError } from './transaction-splits.js';
import { CurrencyMismatchError, FinancialAccountClosedError, InactiveCategoryError } from './transactions.js';

const REALM = '64b0c0ffee0000000000000a';
const ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const replacement = { bookingDate: '2026-09-03' as BusinessDate };

function answering(outcome: CorrectOutcome) {
  const calls: { originalId: string; mreRealmId: string; request: CorrectionRequest; actor: AuditActor; idempotency: unknown }[] = [];
  const repository: CorrectionRepository = {
    correct: async (originalId, mreRealmId, request, actor, idempotency) => {
      calls.push({ originalId, mreRealmId, request, actor, idempotency });
      return outcome;
    },
  };
  return { repository, calls };
}

describe('correctTransaction (api-design.md §35)', () => {
  it('passes Realm, actor and the key with the request fingerprint; returns the three records', async () => {
    const result = { original: {}, reversal: {}, replacement: {} } as unknown as CorrectionResult;
    const { repository, calls } = answering({ kind: 'CORRECTED', result, replayed: true });
    const answer = await correctTransaction({ repository })({ principal, transactionId: ID, reason: 'Datum', replacement, idempotencyKey: 'k' });
    expect(answer).toEqual({ ...result, replayed: true });
    expect(calls).toEqual([
      {
        originalId: ID,
        mreRealmId: REALM,
        request: { reason: 'Datum', replacement },
        actor: { actorType: 'USER', actorId: 'anna@example.com' },
        idempotency: { key: 'k', fingerprint: correctionFingerprint(ID, { reason: 'Datum', replacement }) },
      },
    ]);
  });

  it('turns each refusal into its error', async () => {
    const eur = (amount: string) => Money.of(amount, 'EUR');
    const cases: [CorrectOutcome, new (...args: never[]) => Error][] = [
      [{ kind: 'NOT_FOUND' }, TransactionNotFoundError],
      [{ kind: 'IDEMPOTENCY_CONFLICT' }, IdempotencyKeyConflictError],
      [{ kind: 'ALREADY_CORRECTED', reversalTransactionId: 'r' as TransactionId, replacementTransactionId: 'n' as TransactionId }, TransactionAlreadyCorrectedError],
      [{ kind: 'NOT_CORRECTABLE', status: 'IGNORED' }, TransactionNotCorrectableError],
      [{ kind: 'NO_CHANGE' }, CorrectionNoChangeError],
      [{ kind: 'ACCOUNT_NOT_FOUND', financialAccountId: 'a' }, FinancialAccountNotFoundError],
      [{ kind: 'ACCOUNT_CLOSED', financialAccountId: 'a' }, FinancialAccountClosedError],
      [{ kind: 'CURRENCY_MISMATCH', amount: false, positions: [2] }, CurrencyMismatchError],
      [{ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceIds: ['p'] }, PropertyReferenceNotFoundError],
      [{ kind: 'UNKNOWN_CATEGORY', codes: ['X'] }, FinancialCategoryNotFoundError],
      [{ kind: 'INACTIVE_CATEGORY', codes: ['X'] }, InactiveCategoryError],
      [{ kind: 'SUM_MISMATCH', expected: eur('1'), actual: eur('2') }, SplitSumMismatchError],
    ];
    for (const [outcome, type] of cases) {
      await expect(
        correctTransaction(answering(outcome))({ principal, transactionId: ID, reason: 'x', replacement }),
        outcome.kind,
      ).rejects.toBeInstanceOf(type);
    }
    await expect(
      correctTransaction(answering({ kind: 'ALREADY_CORRECTED', reversalTransactionId: 'r' as TransactionId, replacementTransactionId: 'n' as TransactionId }))({
        principal,
        transactionId: ID,
        reason: 'x',
        replacement,
      }),
    ).rejects.toMatchObject({ reversalTransactionId: 'r', replacementTransactionId: 'n' });
    await expect(
      correctTransaction(answering({ kind: 'CURRENCY_MISMATCH', amount: false, positions: [2] }))({ principal, transactionId: ID, reason: 'x', replacement }),
    ).rejects.toMatchObject({ where: { amount: false, splitPositions: [2] } });
  });

  it('reverse: the same correction without a replacement, with its own fingerprint', async () => {
    const result = { original: {}, reversal: {}, replacement: null } as unknown as CorrectionResult;
    const { repository, calls } = answering({ kind: 'CORRECTED', result, replayed: false });
    expect(await reverseTransaction({ repository })({ principal, transactionId: ID, reason: 'Doppelt', idempotencyKey: 'k' })).toEqual({
      ...result,
      replayed: false,
    });
    expect(calls[0]).toMatchObject({
      request: { reason: 'Doppelt', replacement: null },
      idempotency: { key: 'k', fingerprint: correctionFingerprint(ID, { reason: 'Doppelt', replacement: null }) },
    });
  });
});

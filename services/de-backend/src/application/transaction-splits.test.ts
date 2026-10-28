import { describe, expect, it } from 'vitest';
import type { FinancialCategoryRepository, ReplaceSplitsOutcome, SplitInput, TransactionSplitRepository } from '../domains/ledger/index.js';
import { Money, type AuditActor } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import {
  FinancialCategoryNotFoundError,
  SplitSumMismatchError,
  TransactionFrozenError,
  TransactionNotFoundError,
  getFinancialCategory,
  listFinancialCategories,
  setTransactionSplits,
} from './transaction-splits.js';
import { CurrencyMismatchError } from './transactions.js';

const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: '64b0c0ffee0000000000000a', mreRole: 'administrator' };
const splits: SplitInput[] = [{ amount: Money.of('1.00', 'EUR'), financialCategoryCode: 'OTHER', propertyReferenceId: null, loanId: null, description: null }];

function repositoryAnswering(outcome: ReplaceSplitsOutcome) {
  const calls: { transactionId: string; mreRealmId: string; actor: AuditActor }[] = [];
  const repository: TransactionSplitRepository = {
    replaceSplits: async (transactionId, mreRealmId, _splits, actor) => {
      calls.push({ transactionId, mreRealmId, actor });
      return outcome;
    },
  };
  return { repository, calls };
}

describe('setTransactionSplits', () => {
  it('replaces in the caller Realm as the caller and returns the stored set', async () => {
    const transaction = { id: 't-1', amount: Money.of('1.00', 'EUR'), direction: 'INFLOW', status: 'CLASSIFIED', version: 2 } as const;
    const { repository, calls } = repositoryAnswering({ kind: 'REPLACED', transaction: transaction as never, splits: [], changed: true });
    expect(await setTransactionSplits({ repository })({ principal, transactionId: 't-1', splits })).toEqual({ transaction, splits: [] });
    expect(calls).toEqual([{ transactionId: 't-1', mreRealmId: principal.mreRealmId, actor: { actorType: 'USER', actorId: 'anna@example.com' } }]);
  });

  it.each([
    [{ kind: 'NOT_FOUND' }, TransactionNotFoundError],
    [{ kind: 'FROZEN', status: 'CONFIRMED' }, TransactionFrozenError],
    [{ kind: 'SUM_MISMATCH', expected: Money.of('2', 'EUR'), actual: Money.of('1', 'EUR') }, SplitSumMismatchError],
    [{ kind: 'CURRENCY_MISMATCH', positions: [1] }, CurrencyMismatchError],
    [{ kind: 'UNKNOWN_CATEGORY', codes: ['X1'] }, FinancialCategoryNotFoundError],
    [{ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceIds: ['p'] }, PropertyReferenceNotFoundError],
  ] as const)('maps %o', async (outcome, error) => {
    const { repository } = repositoryAnswering(outcome as ReplaceSplitsOutcome);
    await expect(setTransactionSplits({ repository })({ principal, transactionId: 't-1', splits })).rejects.toBeInstanceOf(error);
  });
});

describe('financial categories', () => {
  const category = { code: 'OTHER', name: 'Sonstiges', categoryType: 'OTHER', active: true } as const;
  const categories: FinancialCategoryRepository = {
    list: async () => [category],
    findByCode: async (code) => (code === 'OTHER' ? category : undefined),
  };

  it('lists and finds; an unknown code is not found', async () => {
    expect(await listFinancialCategories({ categories })()).toEqual([category]);
    expect(await getFinancialCategory({ categories })('OTHER')).toEqual(category);
    await expect(getFinancialCategory({ categories })('NOPE')).rejects.toBeInstanceOf(FinancialCategoryNotFoundError);
  });
});

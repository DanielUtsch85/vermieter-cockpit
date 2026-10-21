import { describe, expect, it } from 'vitest';
import type { Transaction, TransactionQueries } from '../domains/ledger/index.js';
import type { RealmPrincipal } from './access.js';
import { getTransaction, listTransactions } from './read-transactions.js';
import { TransactionNotFoundError } from './transaction-splits.js';

const REALM = '64b0c0ffee0000000000000a';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };

describe('read Transactions (api-design.md §30.1)', () => {
  it('reads in the caller Realm; an unknown one is not found', async () => {
    const calls: unknown[][] = [];
    const queries: TransactionQueries = {
      get: async (...args) => (calls.push(args), undefined),
      list: async (...args) => (calls.push(args), { items: [] as Transaction[], page: 1, pageSize: 50, total: 0 }),
    };
    await expect(getTransaction({ queries })({ principal, transactionId: 't1' })).rejects.toBeInstanceOf(TransactionNotFoundError);
    expect(await listTransactions({ queries })({ principal, filter: { statuses: ['CONFIRMED'] }, page: { page: 1, pageSize: 50 } })).toMatchObject({ total: 0 });
    expect(calls).toEqual([
      ['t1', REALM],
      [REALM, { statuses: ['CONFIRMED'] }, { page: 1, pageSize: 50 }],
    ]);
  });
});

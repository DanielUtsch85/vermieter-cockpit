import { describe, expect, it } from 'vitest';
import type { Transaction, TransactionQueries } from '../domains/ledger/index.js';
import type { RealmPrincipal } from './access.js';
import { getTransaction, listPropertyReferenceTransactions, listTransactions } from './read-transactions.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
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
    expect(await listTransactions({ queries })({ principal, filter: { statuses: ['CONFIRMED'] }, page: { page: 1, pageSize: 50 } })).toMatchObject({
      total: 0,
    });
    expect(calls).toEqual([
      ['t1', REALM],
      [REALM, { statuses: ['CONFIRMED'] }, { page: 1, pageSize: 50 }],
    ]);
  });

  it('the PropertyReference subresource: lists by its id in the caller Realm; unknown or foreign is not found', async () => {
    const calls: unknown[][] = [];
    const queries: TransactionQueries = {
      get: async () => undefined,
      list: async (...args) => (calls.push(args), { items: [] as Transaction[], page: 1, pageSize: 50, total: 0 }),
    };
    const lookups: unknown[][] = [];
    const known = 'b1d6a5c8-0a3e-4f0e-9a51-6b7c2d3e4f50';
    const propertyReferences = {
      findById: async (id: string, mreRealmId: string) => (lookups.push([id, mreRealmId]), id === known ? ({ id } as never) : undefined),
    };
    const list = listPropertyReferenceTransactions({ queries, propertyReferences });
    await list({ principal, propertyReferenceId: known, filter: { current: true }, page: { page: 2, pageSize: 10 } });
    expect(calls).toEqual([[REALM, { current: true, propertyReferenceId: known }, { page: 2, pageSize: 10 }]]);
    await expect(list({ principal, propertyReferenceId: 'other', filter: {}, page: { page: 1, pageSize: 50 } })).rejects.toBeInstanceOf(
      PropertyReferenceNotFoundError,
    );
    expect(lookups).toEqual([
      [known, REALM],
      ['other', REALM],
    ]);
    expect(calls).toHaveLength(1);
  });
});

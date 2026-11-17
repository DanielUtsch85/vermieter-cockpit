import { describe, expect, it } from 'vitest';
import type { ListedRentSums, Transaction, TransactionQueries } from '../domains/ledger/index.js';
import { Money } from '../shared/index.js';
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
      list: async (...args) => (calls.push(args), { items: [] as Transaction[], page: 1, pageSize: 50, total: 0, rentSums: new Map() }),
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
      list: async (...args) => (calls.push(args), { items: [] as Transaction[], page: 1, pageSize: 50, total: 0, rentSums: new Map() }),
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

  it('§30.1A: each item gets rentAllocation from the page s rent sums by the rule of §37.2 (counted, INFLOW, rent cash > 0)', async () => {
    const eur = (amount: string) => Money.of(amount, 'EUR');
    const tx = (id: string, fields: Partial<Transaction>) =>
      ({ id, status: 'CONFIRMED', direction: 'INFLOW', correctionRole: null, ...fields }) as unknown as Transaction;
    const items = [
      tx('none', {}),
      tx('partial', { status: 'RECONCILED' }),
      tx('full', {}),
      tx('unconfirmed', { status: 'UNREVIEWED' }),
      tx('reversal', { correctionRole: 'REVERSAL' }),
      tx('outflow', { direction: 'OUTFLOW' }),
      tx('no-rent', {}),
      tx('zero-rent', {}),
    ];
    const sums: [string, ListedRentSums][] = [
      ['none', { rentCash: eur('850.00'), matchedTotal: eur('0.00') }],
      ['partial', { rentCash: eur('850.00'), matchedTotal: eur('600.00') }],
      ['full', { rentCash: eur('850.00'), matchedTotal: eur('850.00') }],
      ['unconfirmed', { rentCash: eur('850.00'), matchedTotal: eur('0.00') }],
      ['reversal', { rentCash: eur('850.00'), matchedTotal: eur('0.00') }],
      ['outflow', { rentCash: eur('850.00'), matchedTotal: eur('0.00') }],
      ['no-rent', { rentCash: null, matchedTotal: eur('0.00') }],
      ['zero-rent', { rentCash: eur('0.00'), matchedTotal: eur('0.00') }],
    ];
    const queries: TransactionQueries = { get: async () => undefined, list: async () => ({ items, page: 1, pageSize: 50, total: 8, rentSums: new Map(sums) }) };
    const page = await listTransactions({ queries })({ principal, filter: {}, page: { page: 1, pageSize: 50 } });
    expect(page.total).toBe(8);
    expect(page.items.map((i) => [i.transaction.id, i.rentAllocation?.state ?? null, i.rentAllocation?.freeAmount.amount ?? null])).toEqual([
      ['none', 'NONE', '850.00'],
      ['partial', 'PARTIAL', '250.00'],
      ['full', 'FULL', '0.00'],
      ['unconfirmed', null, null],
      ['reversal', null, null],
      ['outflow', null, null],
      ['no-rent', null, null],
      ['zero-rent', null, null],
    ]);
    // The PropertyReference's list applies the same rule.
    const propertyReferences = { findById: async (id: string) => ({ id }) as never };
    const sub = await listPropertyReferenceTransactions({ queries, propertyReferences })({
      principal,
      propertyReferenceId: 'p',
      filter: {},
      page: { page: 1, pageSize: 50 },
    });
    expect(sub.items.map((i) => i.rentAllocation?.state ?? null)).toEqual(['NONE', 'PARTIAL', 'FULL', null, null, null, null, null]);
    // A page whose sums miss an item is an error, never a silent null.
    const missing: TransactionQueries = { get: async () => undefined, list: async () => ({ items, page: 1, pageSize: 50, total: 8, rentSums: new Map() }) };
    await expect(listTransactions({ queries: missing })({ principal, filter: {}, page: { page: 1, pageSize: 50 } })).rejects.toThrow(/no rent sums/);
  });
});

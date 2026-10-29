import { describe, expect, it } from 'vitest';
import type { Transaction, TransactionQueries, TransactionSplit } from '../domains/ledger/index.js';
import type { RentTermTotals } from '../domains/rent-reconciliation/index.js';
import { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { MreRentTermNotFoundError } from './rent-reconciliations.js';
import { RentNotProposableError, getRentSplitProposal } from './rent-split-proposal.js';
import { TransactionNotFoundError } from './transaction-splits.js';

/** §37.6's split proposal use case (#126): refusals in order, MRE asked only after the DE checks. */
const eur = (amount: string) => Money.of(amount, 'EUR');
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: 'r', mreRole: 'administrator' };
const totals: RentTermTotals = { rent: eur('650.00'), charges: eur('150.00'), due: eur('800.00') };
const tx = (overrides: Partial<Transaction> = {}) =>
  ({ id: 't1', amount: eur('800.00'), direction: 'INFLOW', status: 'IMPORTED', ...overrides }) as unknown as Transaction;
const input = { principal, authorizationHeader: 'Bearer t', transactionId: 't1', mreTenantId: '6512f0c2a1b2c3d4e5f60a01', mreRentTerm: '2027020100' };

function setup(
  found: { readonly transaction: Transaction; readonly splits: readonly TransactionSplit[] } | undefined,
  breakdown: RentTermTotals | 'none' = totals,
) {
  const asked: unknown[] = [];
  const queries = { get: async () => found } as unknown as TransactionQueries;
  const propose = getRentSplitProposal({
    queries,
    readBreakdown: async (...args) => {
      asked.push(args);
      return breakdown === 'none' ? undefined : breakdown;
    },
  });
  return { propose, asked };
}

describe('getRentSplitProposal (§37.6)', () => {
  it('proposes from the term read with the caller header, Realm, Tenant and term', async () => {
    const { propose, asked } = setup({ transaction: tx(), splits: [] });
    const p = await propose(input);
    expect(p).toMatchObject({ transactionId: 't1', mreTenantId: input.mreTenantId, mreRentTerm: '2027020100', flags: [] });
    expect(p.splits.map((s) => [s.financialCategoryCode, s.amount.amount])).toEqual([
      ['RENT_BASE', '650.00'],
      ['RENT_OPERATING_COST_ADVANCE', '150.00'],
    ]);
    expect(asked).toEqual([['Bearer t', 'r', input.mreTenantId, '2027020100']]);
  });

  it('refuses in order without asking MRE: unknown Transaction, then not an unconfirmed INFLOW', async () => {
    for (const [found, error] of [
      [undefined, TransactionNotFoundError],
      [{ transaction: tx({ direction: 'OUTFLOW' }), splits: [] }, RentNotProposableError],
      [{ transaction: tx({ status: 'CONFIRMED' }), splits: [] }, RentNotProposableError],
    ] as const) {
      const { propose, asked } = setup(found);
      await expect(propose(input)).rejects.toBeInstanceOf(error);
      expect(asked).toEqual([]);
    }
  });

  it('a term MRE does not return → MRE_RENT_TERM_NOT_FOUND; a split Transaction is flagged', async () => {
    await expect(setup({ transaction: tx(), splits: [] }, 'none').propose(input)).rejects.toBeInstanceOf(MreRentTermNotFoundError);
    const split = await setup({ transaction: tx({ status: 'CLASSIFIED' }), splits: [{} as TransactionSplit] }).propose(input);
    expect(split.flags).toEqual([{ code: 'ALREADY_SPLIT' }]);
  });
});

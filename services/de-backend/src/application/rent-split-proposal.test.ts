import { describe, expect, it } from 'vitest';
import type { Transaction, TransactionQueries, TransactionSplit } from '../domains/ledger/index.js';
import type { RentTermBreakdown } from '../domains/rent-reconciliation/index.js';
import { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { MreRentTermNotFoundError } from './rent-reconciliations.js';
import { RentNotProposableError, getRentSplitProposal } from './rent-split-proposal.js';
import { TransactionNotFoundError } from './transaction-splits.js';

/** §37.6's split proposal use case (#126): refusals in order, MRE asked only after the DE checks. */
const eur = (amount: string) => Money.of(amount, 'EUR');
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: 'r', mreRole: 'administrator' };
const FLAT = '6a0000000000000000000001';
const GARAGE = '6a0000000000000000000002';
const totals: RentTermBreakdown = { rent: eur('650.00'), charges: eur('150.00'), due: eur('800.00'), mrePropertyIds: [FLAT] };
const tx = (overrides: Partial<Transaction> = {}) =>
  ({ id: 't1', amount: eur('800.00'), direction: 'INFLOW', status: 'IMPORTED', ...overrides }) as unknown as Transaction;
const input = { principal, authorizationHeader: 'Bearer t', transactionId: 't1', mreTenantId: '6512f0c2a1b2c3d4e5f60a01', mreRentTerm: '2027020100' };

function setup(
  found: { readonly transaction: Transaction; readonly splits: readonly TransactionSplit[] } | undefined,
  breakdown: RentTermBreakdown | 'none' = totals,
  links: Readonly<Record<string, Readonly<Record<string, string>>>> = { r: { [FLAT]: 'p-1' } },
) {
  const asked: unknown[] = [];
  const linkReads: unknown[] = [];
  const queries = { get: async () => found } as unknown as TransactionQueries;
  const propose = getRentSplitProposal({
    queries,
    readBreakdown: async (...args) => {
      asked.push(args);
      return breakdown === 'none' ? undefined : breakdown;
    },
    findLinkedPropertyReference: async (mreRealmId, mrePropertyId) => {
      linkReads.push([mreRealmId, mrePropertyId]);
      return links[mreRealmId]?.[mrePropertyId];
    },
  });
  return { propose, asked, linkReads };
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
      const { propose, asked, linkReads } = setup(found);
      await expect(propose(input)).rejects.toBeInstanceOf(error);
      expect(asked).toEqual([]);
      expect(linkReads).toEqual([]);
    }
  });

  it('a term MRE does not return → MRE_RENT_TERM_NOT_FOUND; a split Transaction is flagged', async () => {
    const missing = setup({ transaction: tx(), splits: [] }, 'none');
    await expect(missing.propose(input)).rejects.toBeInstanceOf(MreRentTermNotFoundError);
    expect(missing.linkReads).toEqual([]);
    const split = await setup({ transaction: tx({ status: 'CLASSIFIED' }), splits: [{} as TransactionSplit] }).propose(input);
    expect(split.flags).toEqual([{ code: 'ALREADY_SPLIT' }]);
  });

  it('#368: the one linked property of the term, read in the caller Realm after MRE, on the proposal and every split', async () => {
    const { propose, linkReads } = setup({ transaction: tx(), splits: [] });
    const p = await propose(input);
    expect(p.property).toEqual({ mrePropertyIds: [FLAT], propertyReferenceId: 'p-1' });
    expect(p.splits.map((s) => s.propertyReferenceId)).toEqual(['p-1', 'p-1']);
    expect(p.flags).toEqual([]);
    expect(linkReads).toEqual([['r', FLAT]]);
  });

  it.each([
    ['NO_PROPERTY_FOR_TERM', [], 0],
    ['SEVERAL_PROPERTIES', [FLAT, GARAGE], 0],
    ['PROPERTY_NOT_LINKED', [GARAGE], 1],
  ] as const)('#368: %s, no property on any split and the flag with its details', async (reason, mrePropertyIds, reads) => {
    const { propose, linkReads } = setup({ transaction: tx(), splits: [] }, { ...totals, mrePropertyIds });
    const p = await propose(input);
    expect(p.property).toEqual({ mrePropertyIds, propertyReferenceId: null });
    expect(p.splits.map((s) => s.propertyReferenceId)).toEqual([null, null]);
    expect(p.flags).toEqual([{ code: 'NO_PROPERTY_REFERENCE', details: { reason, mrePropertyIds } }]);
    expect(linkReads).toHaveLength(reads);
  });

  it('#368: two properties are SEVERAL_PROPERTIES even when only the first is linked', async () => {
    const p = await setup({ transaction: tx(), splits: [] }, { ...totals, mrePropertyIds: [FLAT, GARAGE] }).propose(input);
    expect(p.flags).toEqual([{ code: 'NO_PROPERTY_REFERENCE', details: { reason: 'SEVERAL_PROPERTIES', mrePropertyIds: [FLAT, GARAGE] } }]);
  });

  it('#368: another Realm link of the same MRE property is not taken', async () => {
    const p = await setup({ transaction: tx(), splits: [] }, totals, { other: { [FLAT]: 'p-other' } }).propose(input);
    expect(p.property.propertyReferenceId).toBeNull();
    expect(p.flags).toEqual([{ code: 'NO_PROPERTY_REFERENCE', details: { reason: 'PROPERTY_NOT_LINKED', mrePropertyIds: [FLAT] } }]);
  });
});

import type { PageRequest, Transaction, TransactionFilter, TransactionPage, TransactionQueries, TransactionSplit } from '../domains/ledger/index.js';
import type { PropertyReferenceRepository } from '../domains/property-reference/index.js';
import { isCounted, rentAllocationOf, type RentAllocation } from '../domains/rent-reconciliation/index.js';
import type { RealmPrincipal } from './access.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { TransactionNotFoundError } from './transaction-splits.js';

/** Read Transactions (api-design.md §30.1, backlog VC-X-21), in the caller's verified Realm. */

export type GetTransaction = (input: {
  readonly principal: RealmPrincipal;
  readonly transactionId: string;
}) => Promise<{ readonly transaction: Transaction; readonly splits: readonly TransactionSplit[] }>;

export function getTransaction(deps: { readonly queries: TransactionQueries }): GetTransaction {
  return async ({ principal, transactionId }) => {
    const found = await deps.queries.get(transactionId, principal.mreRealmId);
    if (found === undefined) throw new TransactionNotFoundError(transactionId);
    return found;
  };
}

/** A list item (§30.1, §30.1A): the Transaction and its rent allocation, `null` when it has nothing to allocate. */
export interface TransactionListItem {
  readonly transaction: Transaction;
  readonly rentAllocation: RentAllocation | null;
}

export interface TransactionListPage {
  readonly items: readonly TransactionListItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/**
 * §30.1A: each item's `rentAllocation` from the page's rent sums (read in the list's snapshot) by rent-reconciliation's
 * rule, the one §37.2's per-Transaction read uses, so the list and the detail agree.
 */
function withRentAllocation(page: TransactionPage): TransactionListPage {
  const items = page.items.map((transaction) => {
    const sums = page.rentSums.get(transaction.id);
    if (sums === undefined) throw new Error(`the list read no rent sums for Transaction ${transaction.id}`);
    const rentAllocation = rentAllocationOf({
      counted: isCounted(transaction.status, transaction.correctionRole),
      direction: transaction.direction,
      rentCash: sums.rentCash,
      matchedTotal: sums.matchedTotal,
    });
    return { transaction, rentAllocation };
  });
  return { items, page: page.page, pageSize: page.pageSize, total: page.total };
}

export type ListTransactions = (input: {
  readonly principal: RealmPrincipal;
  readonly filter: TransactionFilter;
  readonly page: PageRequest;
}) => Promise<TransactionListPage>;

export function listTransactions(deps: { readonly queries: TransactionQueries }): ListTransactions {
  return async ({ principal, filter, page }) => withRentAllocation(await deps.queries.list(principal.mreRealmId, filter, page));
}

export type ListPropertyReferenceTransactions = (input: {
  readonly principal: RealmPrincipal;
  readonly propertyReferenceId: string;
  readonly filter: Omit<TransactionFilter, 'propertyReferenceId'>;
  readonly page: PageRequest;
}) => Promise<TransactionListPage>;

/**
 * `GET /property-references/{id}/transactions` (api-design.md §30.1): the list filtered by the PropertyReference,
 * as a subresource. An unknown or foreign PropertyReference is `PropertyReferenceNotFoundError` (404), not an
 * empty list.
 */
export function listPropertyReferenceTransactions(deps: {
  readonly queries: TransactionQueries;
  readonly propertyReferences: Pick<PropertyReferenceRepository, 'findById'>;
}): ListPropertyReferenceTransactions {
  return async ({ principal, propertyReferenceId, filter, page }) => {
    const reference = await deps.propertyReferences.findById(propertyReferenceId, principal.mreRealmId);
    if (reference === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
    return withRentAllocation(await deps.queries.list(principal.mreRealmId, { ...filter, propertyReferenceId: reference.id }, page));
  };
}

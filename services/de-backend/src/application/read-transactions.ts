import type {
  PageRequest,
  Transaction,
  TransactionFilter,
  TransactionPage,
  TransactionQueries,
  TransactionSplit,
} from '../domains/ledger/index.js';
import type { PropertyReferenceRepository } from '../domains/property-reference/index.js';
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

export type ListTransactions = (input: {
  readonly principal: RealmPrincipal;
  readonly filter: TransactionFilter;
  readonly page: PageRequest;
}) => Promise<TransactionPage>;

export function listTransactions(deps: { readonly queries: TransactionQueries }): ListTransactions {
  return ({ principal, filter, page }) => deps.queries.list(principal.mreRealmId, filter, page);
}

export type ListPropertyReferenceTransactions = (input: {
  readonly principal: RealmPrincipal;
  readonly propertyReferenceId: string;
  readonly filter: Omit<TransactionFilter, 'propertyReferenceId'>;
  readonly page: PageRequest;
}) => Promise<TransactionPage>;

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
    return deps.queries.list(principal.mreRealmId, { ...filter, propertyReferenceId: reference.id }, page);
  };
}

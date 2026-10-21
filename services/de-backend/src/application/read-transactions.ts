import type {
  PageRequest,
  Transaction,
  TransactionFilter,
  TransactionPage,
  TransactionQueries,
  TransactionSplit,
} from '../domains/ledger/index.js';
import type { RealmPrincipal } from './access.js';
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

import type { TransactionQueries } from '../domains/ledger/index.js';
import { proposeRentSplit, type RentSplitProposal, type RentTermTotals } from '../domains/rent-reconciliation/index.js';
import type { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { MreRentTermNotFoundError } from './rent-reconciliations.js';
import { TransactionNotFoundError } from './transaction-splits.js';

/**
 * A rent payment's split proposal (api-design.md §37.6, #126): a read, never a write. The DE side first, then MRE's
 * term totals with the caller's token, outside any database transaction.
 */

/**
 * One rent term's totals of a Tenant, read with the caller's own MRE credentials; undefined when MRE has no such
 * Tenant or term in the Realm. Throws AccessError when MRE refuses the caller and MreUnavailableError when MRE cannot
 * be asked.
 */
export type MreRentBreakdownReader = (
  authorizationHeader: string,
  mreRealmId: string,
  mreTenantId: string,
  mreRentTerm: string,
) => Promise<RentTermTotals | undefined>;

/** The Transaction is not an unconfirmed `INFLOW` (→ 409 NOT_PROPOSABLE, §37.6). */
export class RentNotProposableError extends Error {
  override readonly name = 'RentNotProposableError';

  constructor(
    readonly transactionId: string,
    readonly direction: string,
    readonly status: string,
  ) {
    super(`Transaction ${transactionId} is ${direction} and ${status}; no rent split is proposed`);
  }
}

const UNCONFIRMED = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'];

export interface RentSplitProposalView extends RentSplitProposal {
  readonly transactionId: string;
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
  readonly amount: Money;
}

export type GetRentSplitProposal = (input: {
  readonly principal: RealmPrincipal;
  readonly authorizationHeader: string;
  readonly transactionId: string;
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
}) => Promise<RentSplitProposalView>;

export function getRentSplitProposal(deps: { readonly queries: TransactionQueries; readonly readBreakdown: MreRentBreakdownReader }): GetRentSplitProposal {
  return async ({ principal, authorizationHeader, transactionId, mreTenantId, mreRentTerm }) => {
    const found = await deps.queries.get(transactionId, principal.mreRealmId);
    if (found === undefined) throw new TransactionNotFoundError(transactionId);
    const { transaction, splits } = found;
    if (transaction.direction !== 'INFLOW' || !UNCONFIRMED.includes(transaction.status)) {
      throw new RentNotProposableError(transactionId, transaction.direction, transaction.status);
    }
    const totals = await deps.readBreakdown(authorizationHeader, principal.mreRealmId, mreTenantId, mreRentTerm);
    if (totals === undefined) throw new MreRentTermNotFoundError(mreTenantId, mreRentTerm);
    return {
      transactionId: transaction.id,
      mreTenantId,
      mreRentTerm,
      amount: transaction.amount,
      ...proposeRentSplit(transaction.amount, totals, splits.length > 0),
    };
  };
}

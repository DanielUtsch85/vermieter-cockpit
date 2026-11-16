import type { TransactionQueries } from '../domains/ledger/index.js';
import {
  proposeRentSplit,
  soleTermProperty,
  type RENT_CATEGORIES,
  type RentSplitProposal,
  type RentTermBreakdown,
} from '../domains/rent-reconciliation/index.js';
import type { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { MreRentTermNotFoundError } from './rent-reconciliations.js';
import { TransactionNotFoundError } from './transaction-splits.js';

/**
 * A rent payment's split proposal (api-design.md §37.6, #126): a read, never a write. The DE side first, then MRE's
 * term totals with the caller's token, outside any database transaction, then the link of the lease's property (#368).
 */

/**
 * One rent term's totals of a Tenant and the MRE properties they are summed from, read with the caller's own MRE
 * credentials; undefined when MRE has no such Tenant or term in the Realm. Throws AccessError when MRE refuses the
 * caller and MreUnavailableError when MRE cannot be asked.
 */
export type MreRentBreakdownReader = (
  authorizationHeader: string,
  mreRealmId: string,
  mreTenantId: string,
  mreRentTerm: string,
) => Promise<RentTermBreakdown | undefined>;

/**
 * The Realm's PropertyReferences of these `mrePropertyId`s (§23.1's natural key, so at most one each), whatever their
 * state, in one short read of its own after the MRE read (§37.6, #368): MRE property id → PropertyReference id; an id
 * without a link in the Realm is absent.
 */
export type LinkedPropertyReferenceReader = (mreRealmId: string, mrePropertyIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;

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

/** The rent categories (P4-D3, api-design.md §37.1), for the client contract (#368: the hint before saving). */
export type RentCategoryCode = (typeof RENT_CATEGORIES)[number];

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

export function getRentSplitProposal(deps: {
  readonly queries: TransactionQueries;
  readonly readBreakdown: MreRentBreakdownReader;
  readonly findLinkedPropertyReference: LinkedPropertyReferenceReader;
}): GetRentSplitProposal {
  return async ({ principal, authorizationHeader, transactionId, mreTenantId, mreRentTerm }) => {
    const found = await deps.queries.get(transactionId, principal.mreRealmId);
    if (found === undefined) throw new TransactionNotFoundError(transactionId);
    const { transaction, splits } = found;
    if (transaction.direction !== 'INFLOW' || !UNCONFIRMED.includes(transaction.status)) {
      throw new RentNotProposableError(transactionId, transaction.direction, transaction.status);
    }
    const totals = await deps.readBreakdown(authorizationHeader, principal.mreRealmId, mreTenantId, mreRentTerm);
    if (totals === undefined) throw new MreRentTermNotFoundError(mreTenantId, mreRentTerm);
    const { mrePropertyIds } = totals;
    // The link per id (Entscheidung des Projektinhabers, 2026-11-16); no DE read when MRE names no property.
    const links = mrePropertyIds.length === 0 ? new Map<string, string>() : await deps.findLinkedPropertyReference(principal.mreRealmId, mrePropertyIds);
    const property = soleTermProperty(mrePropertyIds, links);
    return {
      transactionId: transaction.id,
      mreTenantId,
      mreRentTerm,
      amount: transaction.amount,
      ...proposeRentSplit(transaction.amount, totals, splits.length > 0, property),
    };
  };
}

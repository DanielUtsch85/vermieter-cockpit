import type { TransactionQueries } from '../domains/ledger/index.js';
import {
  proposeRentSplit,
  soleTermProperty,
  type ProposalProperty,
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
 * The id of the Realm's PropertyReference with this `mrePropertyId` (§23.1's natural key), whatever its state, in a
 * short read of its own after the MRE read (§37.6, #368); undefined when the Realm has none.
 */
export type LinkedPropertyReferenceReader = (mreRealmId: string, mrePropertyId: string) => Promise<string | undefined>;

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
    const sole = soleTermProperty(mrePropertyIds);
    let property: ProposalProperty;
    if ('reason' in sole) {
      property = { mrePropertyIds, reason: sole.reason };
    } else {
      const propertyReferenceId = await deps.findLinkedPropertyReference(principal.mreRealmId, sole.mrePropertyId);
      property = propertyReferenceId === undefined ? { mrePropertyIds, reason: 'PROPERTY_NOT_LINKED' } : { mrePropertyIds, propertyReferenceId };
    }
    return {
      transactionId: transaction.id,
      mreTenantId,
      mreRentTerm,
      amount: transaction.amount,
      ...proposeRentSplit(transaction.amount, totals, splits.length > 0, property),
    };
  };
}

import { Money } from '../../shared/index.js';

/**
 * A rent payment's split proposal (api-design.md §37.6, #126): MRE's term broken into rent and charges, proposed as
 * `RENT_BASE` and `RENT_OPERATING_COST_ADVANCE` for the Transaction's amount. A read, never a write.
 */

/**
 * A term as the MRE client reads it (§37.6), each Money rounded half-up to the cent: the lease's rent and charges for
 * the term, and the amount due without the balance carried over.
 */
export interface RentTermTotals {
  readonly rent: Money;
  readonly charges: Money;
  readonly due: Money;
}

/** The term's totals with the MRE properties `rent` is summed from (§37.6, #368): distinct `_id`s, in lease order. */
export interface RentTermBreakdown extends RentTermTotals {
  readonly mrePropertyIds: readonly string[];
}

/** Why the proposal names no PropertyReference (§37.6, #368). */
export type NoPropertyReason = 'NO_PROPERTY_FOR_TERM' | 'SEVERAL_PROPERTIES' | 'PROPERTY_NOT_LINKED';

/**
 * The lease's property for the proposal (§37.6, #368): the linked PropertyReference of the one MRE property that
 * encloses the term, or the reason there is none.
 */
export type ProposalProperty =
  | { readonly mrePropertyIds: readonly string[]; readonly propertyReferenceId: string }
  | { readonly mrePropertyIds: readonly string[]; readonly reason: NoPropertyReason };

export type SplitProposalFlag =
  | { readonly code: 'AMOUNT_DIFFERS_FROM_TERM'; readonly details: { readonly difference: Money } }
  | { readonly code: 'TERM_HAS_ADJUSTMENTS'; readonly details: { readonly adjustments: Money } }
  | { readonly code: 'ALREADY_SPLIT' }
  | { readonly code: 'NO_PROPERTY_REFERENCE'; readonly details: { readonly reason: NoPropertyReason; readonly mrePropertyIds: readonly string[] } };

export interface RentSplitProposal {
  readonly term: { readonly rent: Money; readonly charges: Money; readonly adjustments: Money; readonly due: Money };
  readonly property: { readonly mrePropertyIds: readonly string[]; readonly propertyReferenceId: string | null };
  readonly splits: readonly {
    readonly financialCategoryCode: 'RENT_BASE' | 'RENT_OPERATING_COST_ADVANCE';
    readonly amount: Money;
    readonly propertyReferenceId: string | null;
  }[];
  readonly unallocated: Money;
  readonly flags: readonly SplitProposalFlag[];
}

/**
 * §37.6 (#368): the one MRE property whose link is looked up, only when exactly one encloses the term; otherwise the
 * reason, and no PropertyReference is read.
 */
export function soleTermProperty(mrePropertyIds: readonly string[]): { readonly mrePropertyId: string } | { readonly reason: NoPropertyReason } {
  if (mrePropertyIds.length === 0) return { reason: 'NO_PROPERTY_FOR_TERM' };
  if (mrePropertyIds.length > 1) return { reason: 'SEVERAL_PROPERTIES' };
  return { mrePropertyId: mrePropertyIds[0] as string };
}

const nonNegative = (m: Money) => (m.isNegative() ? Money.zero(m.currency) : m);
const min = (a: Money, b: Money) => (a.compare(b) <= 0 ? a : b);

/**
 * §37.6: `RENT_BASE` = min(rent, amount), the advance = min(charges, the rest), the rest `unallocated`; zero splits left
 * out. Every split carries the property's PropertyReference, or none with the flag `NO_PROPERTY_REFERENCE` (#368).
 */
export function proposeRentSplit(amount: Money, totals: RentTermTotals, alreadySplit: boolean, property: ProposalProperty): RentSplitProposal {
  const { rent, charges, due } = totals;
  const adjustments = due.subtract(rent).subtract(charges);
  const base = min(nonNegative(rent), amount);
  const advance = min(nonNegative(charges), amount.subtract(base));
  const propertyReferenceId = 'propertyReferenceId' in property ? property.propertyReferenceId : null;
  const splits = [
    { financialCategoryCode: 'RENT_BASE' as const, amount: base, propertyReferenceId },
    { financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' as const, amount: advance, propertyReferenceId },
  ].filter((s) => s.amount.isPositive());
  const unallocated = amount.subtract(base).subtract(advance);
  const flags: SplitProposalFlag[] = [];
  const difference = amount.subtract(due);
  if (!difference.isZero()) flags.push({ code: 'AMOUNT_DIFFERS_FROM_TERM', details: { difference } });
  if (!adjustments.isZero()) flags.push({ code: 'TERM_HAS_ADJUSTMENTS', details: { adjustments } });
  if (alreadySplit) flags.push({ code: 'ALREADY_SPLIT' });
  const { mrePropertyIds } = property;
  if ('reason' in property) flags.push({ code: 'NO_PROPERTY_REFERENCE', details: { reason: property.reason, mrePropertyIds } });
  return { term: { rent, charges, adjustments, due }, property: { mrePropertyIds, propertyReferenceId }, splits, unallocated, flags };
}

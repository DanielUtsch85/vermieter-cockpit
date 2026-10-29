import { Money } from '../../shared/index.js';

/**
 * A rent payment's split proposal (api-design.md §37.6, #126): MRE's term broken into rent and charges, proposed as
 * `RENT_BASE` and `RENT_OPERATING_COST_ADVANCE` for the Transaction's amount. A read, never a write.
 */

/** A term's totals as the MRE client reads them (§37.6), each Money rounded half-up to the cent. */
export interface RentTermTotals {
  readonly preTaxAmount: Money;
  readonly charges: Money;
  readonly debts: Money;
  readonly discount: Money;
  readonly vat: Money;
  readonly balance: Money;
  readonly grandTotal: Money;
}

export type SplitProposalFlag =
  | { readonly code: 'AMOUNT_DIFFERS_FROM_TERM'; readonly details: { readonly difference: Money } }
  | { readonly code: 'TERM_HAS_ADJUSTMENTS'; readonly details: { readonly adjustments: Money } }
  | { readonly code: 'ALREADY_SPLIT' };

export interface RentSplitProposal {
  readonly term: { readonly rent: Money; readonly charges: Money; readonly adjustments: Money; readonly due: Money };
  readonly splits: readonly { readonly financialCategoryCode: 'RENT_BASE' | 'RENT_OPERATING_COST_ADVANCE'; readonly amount: Money }[];
  readonly unallocated: Money;
  readonly flags: readonly SplitProposalFlag[];
}

const nonNegative = (m: Money) => (m.isNegative() ? Money.zero(m.currency) : m);
const min = (a: Money, b: Money) => (a.compare(b) <= 0 ? a : b);

/** §37.6: `RENT_BASE` = min(rent, amount), the advance = min(charges, the rest), the rest `unallocated`; zero splits left out. */
export function proposeRentSplit(amount: Money, totals: RentTermTotals, alreadySplit: boolean): RentSplitProposal {
  const rent = totals.preTaxAmount;
  const charges = totals.charges;
  const due = totals.grandTotal.subtract(totals.balance);
  const adjustments = due.subtract(rent).subtract(charges);
  const base = min(nonNegative(rent), amount);
  const advance = min(nonNegative(charges), amount.subtract(base));
  const splits = [
    { financialCategoryCode: 'RENT_BASE' as const, amount: base },
    { financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' as const, amount: advance },
  ].filter((s) => s.amount.isPositive());
  const unallocated = amount.subtract(base).subtract(advance);
  const flags: SplitProposalFlag[] = [];
  const difference = amount.subtract(due);
  if (!difference.isZero()) flags.push({ code: 'AMOUNT_DIFFERS_FROM_TERM', details: { difference } });
  if (!adjustments.isZero()) flags.push({ code: 'TERM_HAS_ADJUSTMENTS', details: { adjustments } });
  if (alreadySplit) flags.push({ code: 'ALREADY_SPLIT' });
  return { term: { rent, charges, adjustments, due }, splits, unallocated, flags };
}

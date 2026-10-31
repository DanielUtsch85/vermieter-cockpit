import { centsOf, type Money } from '../../shared/index.js';
import type { Direction } from '../ledger/index.js';
import type { RefundInfo } from './cash-timing.js';
import type { TaxCategory, Treatment } from './vocabulary.js';

/**
 * The tax-year view's lines and placement (api-design.md §58C "Placement", "Signs"): which line or place each item
 * goes to, and the sign of its contribution there.
 */

/** The Einnahmen lines, in the order of §58C's table. */
export const EINNAHMEN_LINES = [
  'RENT',
  'OPERATING_COST_ADVANCES',
  'OPERATING_COST_SETTLEMENT',
  'OTHER_INCOME',
  'RETAINED_DEPOSIT_RENT',
  'RETAINED_DEPOSIT_DAMAGES',
  'REFUNDS_OF_EARLIER_YEARS',
] as const satisfies readonly TaxCategory[];

/** The Werbungskosten lines, in the order of §58C's table. */
export const WERBUNGSKOSTEN_LINES = [
  'LOAN_INTEREST',
  'FINANCING_COSTS',
  'WEG_HAUSGELD',
  'WEG_SPENDING',
  'MAINTENANCE',
  'ADMINISTRATION',
  'INSURANCE',
  'PROPERTY_TAX',
  'BANK_FEES',
  'TAX_ADVICE',
  'TRAVEL',
  'OTHER_EXPENSE',
] as const satisfies readonly TaxCategory[];

/** The lines with `subtotals` (taxation.md §5: deducted at once, or a part of a § 82b distribution). */
export const SUBTOTAL_LINES: readonly TaxCategory[] = ['WEG_SPENDING', 'MAINTENANCE'];

export type Section = 'EINNAHMEN' | 'WERBUNGSKOSTEN' | 'NOT_IN_VIEW' | 'UNCLASSIFIED';

/** Where each `taxCategory` goes (§58C's placement table); a `Record`, so no category can be left unplaced. */
export const TAX_YEAR_PLACES: Readonly<Record<TaxCategory, Section>> = {
  ...(Object.fromEntries(EINNAHMEN_LINES.map((c) => [c, 'EINNAHMEN'])) as Record<(typeof EINNAHMEN_LINES)[number], Section>),
  ...(Object.fromEntries(WERBUNGSKOSTEN_LINES.map((c) => [c, 'WERBUNGSKOSTEN'])) as Record<(typeof WERBUNGSKOSTEN_LINES)[number], Section>),
  NOT_RELEVANT: 'NOT_IN_VIEW',
  UNCLASSIFIED: 'UNCLASSIFIED',
};

export type Placement =
  | { readonly place: 'LINE'; readonly section: 'EINNAHMEN' | 'WERBUNGSKOSTEN'; readonly line: TaxCategory }
  | { readonly place: 'CAPITALIZED'; readonly line: TaxCategory }
  | { readonly place: 'NOT_IN_VIEW' }
  | { readonly place: 'UNCLASSIFIED' };

/**
 * The one place of an item (§58C): its line when its treatment is summed there (`INCOME` on an income line,
 * `DEDUCTIBLE` or `DISTRIBUTED_82B` on an expense line; a refund of an earlier year on `refund.line`), `capitalized`
 * for `CAPITALIZED`, `notInView` for `NOT_RELEVANT`, `unclassified` without a treatment.
 */
export function placementOf(meaning: {
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly refund?: Pick<RefundInfo, 'presentation' | 'line'> | null;
}): Placement {
  const section = TAX_YEAR_PLACES[meaning.taxCategory];
  if (section === 'UNCLASSIFIED' || meaning.treatment === null) return { place: 'UNCLASSIFIED' };
  if (section === 'NOT_IN_VIEW' || meaning.treatment === 'NOT_RELEVANT') return { place: 'NOT_IN_VIEW' };
  if (meaning.treatment === 'CAPITALIZED') return { place: 'CAPITALIZED', line: meaning.taxCategory };
  if (section === 'EINNAHMEN' && meaning.treatment === 'INCOME') return { place: 'LINE', section, line: meaning.taxCategory };
  if (section === 'WERBUNGSKOSTEN' && (meaning.treatment === 'DEDUCTIBLE' || meaning.treatment === 'DISTRIBUTED_82B')) {
    const line = meaning.refund?.presentation === 'INCOME' ? meaning.refund.line : meaning.taxCategory;
    return { place: 'LINE', section: TAX_YEAR_PLACES[line] === 'EINNAHMEN' ? 'EINNAHMEN' : 'WERBUNGSKOSTEN', line };
  }
  // A meaning §56's fit does not allow is never stored; should one appear, it needs a person.
  return { place: 'UNCLASSIFIED' };
}

/**
 * The signed amount an item contributes to its place, in cents (§58C "Signs"): on an income line an `INFLOW` counts
 * positive and a repayment negative; a refund of an earlier year counts positive on `REFUNDS_OF_EARLIER_YEARS`; on an
 * expense line and in `capitalized` an `OUTFLOW` counts positive and a refund negative. A deposit closing, a withdrawal
 * and a use have no direction: positive.
 */
export function signedCents(
  item: { readonly amount: Money; readonly direction: Direction | null; readonly taxCategory: TaxCategory },
  placement: Placement,
): bigint {
  const cents = centsOf(item.amount);
  if (item.direction === null) return cents;
  if (placement.place === 'LINE' && placement.section === 'EINNAHMEN') {
    // Its own income line, or a refund (an INFLOW) placed on REFUNDS_OF_EARLIER_YEARS.
    return item.direction === 'INFLOW' ? cents : -cents;
  }
  return item.direction === 'OUTFLOW' ? cents : -cents;
}

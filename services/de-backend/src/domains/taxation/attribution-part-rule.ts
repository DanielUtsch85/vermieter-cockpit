import { centsOf, moneyOfCents, type BusinessDate, type Money } from '../../shared/index.js';
import { withValidUntil, type LoanAllocationSet } from '../financing/index.js';
import { distributeOverPeriod, type InterestPeriod } from './loan-interest-periods.js';

/**
 * P's state and part of an item on one side of a part change (api-design.md §58G's table), and when it moved; shared by
 * the allocation sets (§58G), the deposit's PropertyReference (§58H Part 2, `attribution-deposits.ts`) and the split
 * corrections (§58I Part 2, `attribution-corrections.ts`).
 */

export const PART_STATES = ['ATTRIBUTED', 'NOT_ATTRIBUTED', 'NONE'] as const;
export type PartState = (typeof PART_STATES)[number];

export interface Part {
  readonly state: PartState;
  readonly part: Money | null;
}

/**
 * P's part of a split under the Loan's `VALID` sets of one side (§58G's table, §58D's three cases, §58L): the view's own
 * `distributeOverPeriod` over the split's interest period (or its booking date without one, rule 8), `validUntil`
 * derived over these sets, P's part by one `distribute` over the weights; a covered split without a weight of P is
 * `NONE`; with a day without a usable set `NOT_ATTRIBUTED` while a set of the side names P, else `NONE`.
 */
export function partOn(
  propertyReferenceId: string,
  valid: readonly LoanAllocationSet[],
  candidate: { readonly bookingDate: BusinessDate; readonly amount: Money; readonly period: InterestPeriod | null },
): Part {
  const sets = withValidUntil(valid.map((s) => ({ ...s, status: 'VALID' as const })));
  const d = distributeOverPeriod(sets, centsOf(candidate.amount), candidate.period, candidate.bookingDate);
  if (d.kind === 'COVERED') {
    const weight = d.weights.find((w) => w.propertyReferenceId === propertyReferenceId);
    return weight === undefined ? { state: 'NONE', part: null } : { state: 'ATTRIBUTED', part: moneyOfCents(weight.cents, candidate.amount.currency) };
  }
  return sets.some((s) => s.allocations.some((a) => a.propertyReferenceId === propertyReferenceId))
    ? { state: 'NOT_ATTRIBUTED', part: null }
    : { state: 'NONE', part: null };
}

/** Whether P's part moved: the states differ (not between `NOT_ATTRIBUTED` and `NONE`), or both attributed with other amounts. */
export function partMoved(before: Part, after: Part): boolean {
  if (before.state !== after.state) return before.state === 'ATTRIBUTED' || after.state === 'ATTRIBUTED';
  return before.state === 'ATTRIBUTED' && centsOf(before.part as Money) !== centsOf(after.part as Money);
}

import { centsOf, moneyOfCents, type BusinessDate, type Money } from '../../shared/index.js';
import { distribute, setOn, sumsToOne, withValidUntil, type LoanAllocationSet } from '../financing/index.js';

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
 * P's part of a split under the Loan's `VALID` sets of one side (§58G's table, §58D's three cases): the set covering the
 * booking date (`validUntil` derived over these sets), usable when its shares sum to `1/1`, P's part by `distribute`
 * over the whole set; without a usable set `NOT_ATTRIBUTED` while a set of the side names P; else `NONE`.
 */
export function partOn(
  propertyReferenceId: string,
  valid: readonly LoanAllocationSet[],
  candidate: { readonly bookingDate: BusinessDate; readonly amount: Money },
): Part {
  const sets = withValidUntil(valid.map((s) => ({ ...s, status: 'VALID' as const })));
  const set = setOn(sets, candidate.bookingDate);
  if (set !== null && sumsToOne(set.allocations.map((a) => a.share))) {
    const index = set.allocations.findIndex((a) => a.propertyReferenceId === propertyReferenceId);
    if (index < 0) return { state: 'NONE', part: null };
    const cents = distribute(centsOf(candidate.amount), set.allocations)[index] as bigint;
    return { state: 'ATTRIBUTED', part: moneyOfCents(cents, candidate.amount.currency) };
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

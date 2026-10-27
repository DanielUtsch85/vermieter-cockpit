import type { BusinessDate } from '../../shared/index.js';
import type { NumberedScheduleEntry, RepaymentModel, Schedule, ScheduleEndReason } from './terms.js';

/**
 * The payment proposal of api-design.md §41.5 (P3-D4): for an unconfirmed `OUTFLOW` Transaction, the interest and
 * principal splits the schedule (§41.4) suggests. A read only; DE never writes splits on its own (ADR-015). Amounts in
 * cents.
 */

/** The Transaction as far as a proposal needs it. */
export interface ProposalTransaction {
  readonly id: string;
  readonly bookingDate: BusinessDate;
  /** Cents. */
  readonly amount: bigint;
  readonly direction: string;
  readonly status: string;
  /** How many splits it has now (any, with or without a Loan). */
  readonly splitCount: number;
}

/** The unconfirmed statuses whose splits may still change (§33.2). */
const PROPOSABLE_STATUSES = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'];

export type ProposalFlag =
  /** `difference` = amount − the entry's payment, signed, in cents; the principal absorbs it. */
  | { readonly code: 'AMOUNT_DIFFERS_FROM_SCHEDULE'; readonly difference: bigint }
  | { readonly code: 'AMOUNT_BELOW_INTEREST' }
  | { readonly code: 'REST_NOT_PLANNED' }
  | { readonly code: 'ALREADY_SPLIT' };

export type PaymentProposal =
  | {
      readonly kind: 'PROPOSAL';
      readonly entry: NumberedScheduleEntry;
      readonly interest: bigint;
      readonly principal: bigint;
      readonly unallocated: bigint;
      readonly flags: readonly ProposalFlag[];
    }
  | { readonly kind: 'NOT_PROPOSABLE'; readonly direction: string; readonly status: string }
  | { readonly kind: 'NO_SCHEDULE'; readonly endReason: ScheduleEndReason };

const dayNumber = (date: BusinessDate) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/** The payment whose `paymentDate` is nearest to `day`; on a tie the earlier one. */
export function nearestEntry(entries: readonly NumberedScheduleEntry[], day: BusinessDate): NumberedScheduleEntry | undefined {
  let best: NumberedScheduleEntry | undefined;
  for (const entry of entries) {
    // Entries are in date order, so a strictly smaller distance is needed to replace an earlier one.
    if (best === undefined || Math.abs(dayNumber(entry.paymentDate) - dayNumber(day)) < Math.abs(dayNumber(best.paymentDate) - dayNumber(day))) {
      best = entry;
    }
  }
  return best;
}

/**
 * §41.5's refusals 4 and 5 and the proposal: interest = min(entry.interest, amount); for `ANNUITY` the rest is
 * principal, for `INTEREST_ONLY` it stays unallocated. `modelOf` gives the repayment model of an entry's period.
 */
export function proposePayment(schedule: Schedule, transaction: ProposalTransaction, modelOf: (termsId: string) => RepaymentModel): PaymentProposal {
  if (transaction.direction !== 'OUTFLOW' || !PROPOSABLE_STATUSES.includes(transaction.status)) {
    return { kind: 'NOT_PROPOSABLE', direction: transaction.direction, status: transaction.status };
  }
  const entry = nearestEntry(schedule.entries, transaction.bookingDate);
  if (entry === undefined) return { kind: 'NO_SCHEDULE', endReason: schedule.summary.endReason };
  const amount = transaction.amount;
  const interest = entry.interest < amount ? entry.interest : amount;
  const interestOnly = modelOf(entry.termsId) === 'INTEREST_ONLY';
  const principal = interestOnly ? 0n : amount - interest;
  const flags: ProposalFlag[] = [];
  if (amount !== entry.payment) flags.push({ code: 'AMOUNT_DIFFERS_FROM_SCHEDULE', difference: amount - entry.payment });
  if (amount < entry.interest) flags.push({ code: 'AMOUNT_BELOW_INTEREST' });
  if (interestOnly && amount > entry.interest) flags.push({ code: 'REST_NOT_PLANNED' });
  if (transaction.splitCount > 0) flags.push({ code: 'ALREADY_SPLIT' });
  return { kind: 'PROPOSAL', entry, interest, principal, unallocated: amount - interest - principal, flags };
}

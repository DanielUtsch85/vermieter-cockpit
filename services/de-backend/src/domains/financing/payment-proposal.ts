import type { BusinessDate } from '../../shared/index.js';
import { readPurpose } from './purpose-formats.js';
import type { NumberedScheduleEntry, RepaymentModel, Schedule, ScheduleEndReason } from './terms.js';

/**
 * The payment proposal of api-design.md §41.5 (P3-D4): for an unconfirmed `OUTFLOW` Transaction, the interest and
 * principal splits the schedule (§41.4) suggests. A read only; DE never writes splits on its own (ADR-015). Amounts in
 * cents. Where a named bank format (`purpose-formats.ts`) reads the split from the purpose text and it adds up to the
 * amount, that split is proposed (`source = PURPOSE_TEXT`; §58O question 12 (a)); else the plan's (`SCHEDULE`), which is
 * always computed beside it as the counter-check (`scheduleSplit`).
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
  /** The purpose text (`ledger_transaction.description`). */
  readonly description: string | null;
}

/** Where the proposed split comes from (§58O question 12 (a)). */
export type ProposalSource = 'PURPOSE_TEXT' | 'SCHEDULE';

/** The unconfirmed statuses whose splits may still change (§33.2). */
const PROPOSABLE_STATUSES = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'];

export type ProposalFlag =
  /** `difference` = amount − the entry's payment, signed, in cents; the principal absorbs it. */
  | { readonly code: 'AMOUNT_DIFFERS_FROM_SCHEDULE'; readonly difference: bigint }
  | { readonly code: 'AMOUNT_BELOW_INTEREST' }
  | { readonly code: 'REST_NOT_PLANNED' }
  | { readonly code: 'ALREADY_SPLIT' }
  /** Informative: a format recognised the text, but its split is unreadable or does not add up to the amount. */
  | { readonly code: 'PURPOSE_SPLIT_NOT_MATCHING'; readonly format: string; readonly stated: { readonly interest: bigint; readonly principal: bigint } | null }
  /** Informative: the purpose text's split, proposed, differs from the plan's. */
  | {
      readonly code: 'SPLIT_DIFFERS_FROM_SCHEDULE';
      readonly purposeText: { readonly interest: bigint; readonly principal: bigint };
      readonly schedule: { readonly interest: bigint; readonly principal: bigint };
    };

export type PaymentProposal =
  | {
      readonly kind: 'PROPOSAL';
      readonly entry: NumberedScheduleEntry;
      readonly interest: bigint;
      readonly principal: bigint;
      readonly unallocated: bigint;
      readonly source: ProposalSource;
      /** The name of the format that read the split (`PURPOSE_TEXT`), else null. */
      readonly purposeFormat: string | null;
      /** The plan's split, the counter-check (§58O question 12 (a)). */
      readonly scheduleSplit: { readonly interest: bigint; readonly principal: bigint };
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
  const scheduleInterest = entry.interest < amount ? entry.interest : amount;
  const interestOnly = modelOf(entry.termsId) === 'INTEREST_ONLY';
  const schedulePrincipal = interestOnly ? 0n : amount - scheduleInterest;
  const scheduleSplit = { interest: scheduleInterest, principal: schedulePrincipal };
  const flags: ProposalFlag[] = [];
  if (amount !== entry.payment) flags.push({ code: 'AMOUNT_DIFFERS_FROM_SCHEDULE', difference: amount - entry.payment });
  if (amount < entry.interest) flags.push({ code: 'AMOUNT_BELOW_INTEREST' });
  if (interestOnly && amount > entry.interest) flags.push({ code: 'REST_NOT_PLANNED' });
  if (transaction.splitCount > 0) flags.push({ code: 'ALREADY_SPLIT' });
  const reading = readPurpose(transaction.description);
  if (reading.kind === 'SPLIT' && reading.interest + reading.principal === amount) {
    const purposeText = { interest: reading.interest, principal: reading.principal };
    if (purposeText.interest !== scheduleInterest || purposeText.principal !== schedulePrincipal) {
      flags.push({ code: 'SPLIT_DIFFERS_FROM_SCHEDULE', purposeText, schedule: scheduleSplit });
    }
    return { kind: 'PROPOSAL', entry, ...purposeText, unallocated: 0n, source: 'PURPOSE_TEXT', purposeFormat: reading.format, scheduleSplit, flags };
  }
  if (reading.kind !== 'NOT_RECOGNISED') {
    const stated = reading.kind === 'SPLIT' ? { interest: reading.interest, principal: reading.principal } : null;
    flags.push({ code: 'PURPOSE_SPLIT_NOT_MATCHING', format: reading.format, stated });
  }
  return {
    kind: 'PROPOSAL',
    entry,
    ...scheduleSplit,
    unallocated: amount - scheduleInterest - schedulePrincipal,
    source: 'SCHEDULE',
    purposeFormat: null,
    scheduleSplit,
    flags,
  };
}

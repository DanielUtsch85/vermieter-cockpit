import type { BusinessDate, Money } from '../../shared/index.js';
import type { Origin, ReviewState } from './vocabulary.js';

/**
 * The proposal of the 10-day rule (api-design.md §58F, VC-X-39; owner decisions 2026-11-02): a rent without a recorded
 * due date counts in its booking year and carries the item flag `PROPOSED_BY_10_DAY_RULE`. The proposal is open until
 * a person decides the year: a confirmed classification that sets `taxYear` (either year; then informative), or a
 * recorded due day (then the flag is no longer raised). A confirmed classification without `taxYear` decides nothing.
 *
 * Both years the proposal names show it: the year it counts in by the item flag, the other one by the year flag of the
 * same code, which names the split and its amount without counting it (never counted twice). Neither year is `final`
 * while the proposal is open.
 */

export const PROPOSED_BY_10_DAY_RULE = 'PROPOSED_BY_10_DAY_RULE';

/** What decides the proposal's level: the item's classification and whether its `taxYear` overrides the year. */
export interface ProposalState {
  readonly origin: Origin;
  readonly reviewState: ReviewState;
  readonly attribution: unknown;
}

const overridden = (attribution: unknown) => (attribution as { readonly overridden?: unknown } | null | undefined)?.overridden === true;

/** Open unless a current classification in `USER_CONFIRMED` or `ADVISOR_CONFIRMED` sets `taxYear` (§58F's review table). */
export function proposalIsOpen(item: ProposalState): boolean {
  const confirmed = item.origin === 'CLASSIFICATION' && (item.reviewState === 'USER_CONFIRMED' || item.reviewState === 'ADVISOR_CONFIRMED');
  return !(confirmed && overridden(item.attribution));
}

/** A meaning as the other year reads it: a counting split with its derived year, attribution and flags. */
export interface ProposalCandidate extends ProposalState {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly amount: Money;
  readonly counts: boolean;
  readonly taxYear: number;
  readonly flags: readonly { readonly code: string; readonly details?: unknown }[];
}

/** One split of the year flag `PROPOSED_BY_10_DAY_RULE` (§58F): not counted in this year; `open` gives its level. */
export interface ProposedSplit {
  readonly sourceId: string;
  readonly bookingDate: BusinessDate;
  readonly bookingYear: number;
  readonly proposedYear: number;
  /** For information only: the amount counts in `countedInYear`, never here. */
  readonly amount: Money;
  readonly countedInYear: number;
  readonly open: boolean;
}

/**
 * The splits counted in another year whose proposal names `year` (as its booking year or its proposed year), sorted by
 * `sourceId`. A split counted in `year` itself carries the item flag and is not repeated here.
 */
export function proposedSplits(candidates: readonly ProposalCandidate[], year: number): ProposedSplit[] {
  return candidates
    .flatMap((m) => {
      if (m.sourceType !== 'TRANSACTION_SPLIT' || !m.counts || m.taxYear === year) return [];
      const flag = m.flags.find((f) => f.code === PROPOSED_BY_10_DAY_RULE);
      if (flag === undefined) return [];
      const { bookingDate, proposedYear } = flag.details as { readonly bookingDate: BusinessDate; readonly proposedYear: number };
      const bookingYear = Number(bookingDate.slice(0, 4));
      if (year !== bookingYear && year !== proposedYear) return [];
      return [{ sourceId: m.sourceId, bookingDate, bookingYear, proposedYear, amount: m.amount, countedInYear: m.taxYear, open: proposalIsOpen(m) }];
    })
    .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
}

/** The year flag's level: open while one of its splits is open. */
export const yearProposalIsOpen = (details: unknown): boolean =>
  ((details as { readonly items?: readonly { readonly open?: unknown }[] } | null | undefined)?.items ?? []).some((i) => i.open === true);

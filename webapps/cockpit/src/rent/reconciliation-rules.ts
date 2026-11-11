import { ApiError } from '../api/errors';
import type { MoneyValue } from '../format/money';
import { compareCents, decimalToCents, parseAmountInput, type AmountProblem } from '../transactions/split-amount';

/**
 * The rules of step 6 (ui-guide.md §6.6, §11; api-design.md §37.1–§37.5) as pure functions: the suggest window, the
 * amount of a confirmation, the reason of a rejection or release, and which of the three separate actions a
 * reconciliation offers in its state. The server stays the judge; these rules only keep the client from offering what
 * the server is sure to refuse, and from offering anything for a state it does not know (§7.4).
 */

/** `YYYY-MM` with a real month, as the backend reads it (`suggestBody`). */
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** At most twelve months, inclusive (§37.3: `RANGE_TOO_LONG`). */
export const MAX_SUGGEST_MONTHS = 12;

export type WindowProblem = 'FROM_INVALID' | 'TO_INVALID' | 'INVERTED' | 'TOO_LONG';

const monthIndex = (ym: string): number | undefined => {
  const match = YEAR_MONTH.exec(ym);
  return match === null ? undefined : Number(match[1]) * 12 + Number(match[2]) - 1;
};

/** Why a window cannot be sent, or undefined when it can. */
export function checkSuggestWindow(from: string, to: string): WindowProblem | undefined {
  const first = monthIndex(from);
  const last = monthIndex(to);
  if (first === undefined) return 'FROM_INVALID';
  if (last === undefined) return 'TO_INVALID';
  if (last < first) return 'INVERTED';
  return last - first >= MAX_SUGGEST_MONTHS ? 'TOO_LONG' : undefined;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const daysIn = (year: number, month: number) =>
  month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/**
 * The booking range a suggest run looks at (§37.3, §37.6): from the 15th of the month before `from` to the last day of
 * `to`. Its `skipped` counts inflows of that range, so a link to the Buchungen list filters by it. Business dates as
 * text, never through `Date` (§5.2).
 */
export function suggestBookingRange(from: string, to: string): { readonly bookingDateFrom: string; readonly bookingDateTo: string } | undefined {
  const first = monthIndex(from);
  const last = monthIndex(to);
  if (first === undefined || last === undefined) return undefined;
  const before = first - 1;
  const fromYear = Math.floor(before / 12);
  const toYear = Math.floor(last / 12);
  const toMonth = (last % 12) + 1;
  return {
    bookingDateFrom: `${pad(fromYear, 4)}-${pad((before % 12) + 1)}-15`,
    bookingDateTo: `${pad(toYear, 4)}-${pad(toMonth)}-${pad(daysIn(toYear, toMonth))}`,
  };
}

/** MRE's term key `YYYYMMDDHH` as the business date it names (`2026030100` → `2026-03-01`); undefined when it is none. */
export function termDate(term: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(term);
  if (match === null) return undefined;
  const [, year = '', month = '', day = '', hour = ''] = match;
  const m = Number(month);
  if (m < 1 || m > 12 || Number(day) < 1 || Number(day) > daysIn(Number(year), m) || Number(hour) > 23) return undefined;
  return `${year}-${month}-${day}`;
}

export type AmountCheck =
  { readonly ok: true; readonly amount: MoneyValue } | { readonly ok: false; readonly problem: AmountProblem | 'NOT_POSITIVE' | 'ABOVE_SUGGESTION' };

/**
 * The amount of „Zuordnung bestätigen“ (§37.3, P4-D5): typed in German, more than zero, and at most the suggested one,
 * compared on whole cents as digit strings (no float). Equal is the suggestion confirmed as it is; less is a lower
 * confirmation; one cent more is refused before anything is sent.
 */
export function checkConfirmAmount(input: string, suggested: MoneyValue): AmountCheck {
  const parsed = parseAmountInput(input);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  if (!/[1-9]/.test(parsed.cents)) return { ok: false, problem: 'NOT_POSITIVE' };
  const limit = decimalToCents(suggested.amount);
  if (limit === undefined || compareCents(parsed.cents, limit) > 0) return { ok: false, problem: 'ABOVE_SUGGESTION' };
  return { ok: true, amount: { amount: parsed.amount, currency: suggested.currency } };
}

/** A reason of reject and release: 1–500 characters after trimming (§37.1, §37.3). */
export const MAX_REASON = 500;
export type ReasonProblem = 'REASON_MISSING' | 'REASON_TOO_LONG';

export function checkReason(text: string): ReasonProblem | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return 'REASON_MISSING';
  return [...trimmed].length > MAX_REASON ? 'REASON_TOO_LONG' : undefined;
}

/** The facts the offers read: status, write-back state and the leases (§37.4, §37.5). */
export interface OfferFacts {
  readonly status: string;
  readonly mreWriteBackState: string;
  readonly mreWriteBackLeaseUntil: string | null;
}

/** `offer`: the button; `running`: an MRE write of this reconciliation is under way (wait, read again); `none`: nothing. */
export type Offer = 'offer' | 'running' | 'none';

/** A lease that has not ended yet; a lease that cannot be read counts as running (never act on what is not understood). */
function leaseLive(until: string | null, now: number): boolean {
  if (until === null) return false;
  const end = Date.parse(until);
  return Number.isNaN(end) || end > now;
}

/** „Zuordnung bestätigen“ and „Ablehnen“: only a suggestion (§37.3). */
export const decidable = (r: Pick<OfferFacts, 'status'>): boolean => r.status === 'SUGGESTED';

/**
 * „An MRE übertragen“ (§37.4): a `CONFIRMED` match that is `NOT_WRITTEN` or `FAILED`, or `PENDING` whose lease ended
 * (its own retry). `WRITTEN` has nothing to do; a live `PENDING` is running. Any other status or state: nothing.
 */
export function writeBackOffer(r: OfferFacts, now: number): Offer {
  if (r.status !== 'CONFIRMED') return 'none';
  if (r.mreWriteBackState === 'NOT_WRITTEN' || r.mreWriteBackState === 'FAILED') return 'offer';
  if (r.mreWriteBackState === 'PENDING') return leaseLive(r.mreWriteBackLeaseUntil, now) ? 'running' : 'offer';
  return 'none';
}

/**
 * „Zuordnung aufheben“ (§37.1, §37.4): a `CONFIRMED` match in a known write-back state; refused by the server while a
 * write-back runs, so then `running`. Release is DE only and never removes anything from MRE.
 */
export function releaseOffer(r: OfferFacts, now: number): Offer {
  if (r.status !== 'CONFIRMED') return 'none';
  if (r.mreWriteBackState === 'PENDING') return leaseLive(r.mreWriteBackLeaseUntil, now) ? 'running' : 'offer';
  return ['NOT_WRITTEN', 'WRITTEN', 'FAILED'].includes(r.mreWriteBackState) ? 'offer' : 'none';
}

/**
 * „Aus MRE entfernen“ (§37.5): only after the release, when DE's payment is or may be in MRE: `REMOVAL_REQUIRED`,
 * `REMOVAL_FAILED`, or `REMOVING` whose lease ended. `NOT_WRITTEN` (nothing was ever in MRE) and `REMOVED` have nothing.
 */
export function removalOffer(r: OfferFacts, now: number): Offer {
  if (r.status !== 'RELEASED') return 'none';
  if (r.mreWriteBackState === 'REMOVAL_REQUIRED' || r.mreWriteBackState === 'REMOVAL_FAILED') return 'offer';
  if (r.mreWriteBackState === 'REMOVING') return leaseLive(r.mreWriteBackLeaseUntil, now) ? 'running' : 'offer';
  return 'none';
}

/**
 * When an MRE action refused for a concurrent write may be offered again, in seconds from now (ui-guide.md §6.6: respect
 * `Retry-After`, read the detail again, no tight loop). `Retry-After` when the answer has one; `REMOVAL_TOO_EARLY` until
 * its `details.notBefore`; `WRITE_BACK_IN_PROGRESS` and a `503` without the header at least `MIN_WAIT_SECONDS`. Nothing
 * is ever sent again by itself: after the wait the button is offered, and only a click sends.
 */
export const MIN_WAIT_SECONDS = 5;

export function waitAfter(error: unknown, now: number): number {
  if (!(error instanceof ApiError)) return 0;
  if (error.retryAfterSeconds !== undefined) return error.retryAfterSeconds;
  const reason = error.details?.['reason'];
  if (reason === 'REMOVAL_TOO_EARLY') {
    const notBefore = error.details?.['notBefore'];
    const end = typeof notBefore === 'string' ? Date.parse(notBefore) : Number.NaN;
    return Number.isNaN(end) ? MIN_WAIT_SECONDS : Math.max(0, Math.ceil((end - now) / 1000));
  }
  if (reason === 'WRITE_BACK_IN_PROGRESS' || error.status === 503) return MIN_WAIT_SECONDS;
  return 0;
}

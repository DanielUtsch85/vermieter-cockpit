import { centsOf, moneyOfCents, type BusinessDate, type Money } from '../../shared/index.js';
import type { LoanAllocationSetView } from '../financing/index.js';
import type { MarkedChange } from './attribution-changes.js';
import type { TaxListItem, TaxMeaning } from './classification.js';
import {
  distributeOverPeriod,
  setsOfSegments,
  type InterestPeriod,
  type PeriodDeviation,
  type PeriodDistribution,
  type PeriodSegment,
} from './loan-interest-periods.js';
import { deriveItem, itemAt, type Derived } from './tax-year-items.js';
import type { TaxYearItem, TaxYearLoanAllocation, ViewFlag } from './tax-year-response.js';
import { confirmationMark, type LoanAllocationTaxConfirmation } from './tax-statements.js';
import type { ViewOwnership } from './tax-year-shares.js';

/**
 * The interest of an allocated Loan in the tax-year view (api-design.md §58D, VC-X-29; §58L, VC-X-40). A split with a
 * `loanId` carries no PropertyReference (0027): it reaches a property through the Loan's allocation sets valid on each
 * day of its **interest period** (§58L, decision 1 as amended by the owner on 2026-11-04, L1), by one `distribute` over
 * the exact weights (§58L rule 5, decision 6, §41.6: largest remainder, ties by `propertyReferenceId`), and then the
 * owners on its booking date by §58C's `shareOut` (decision 3, L6), as any item. Without a period (rule 8) the set on the
 * booking date, flagged `INTEREST_PERIOD_UNKNOWN`. Any complete set counts, `PURCHASE_PRICE` included (decided
 * 2026-10-31, third set; ADR-038's one key), a multi-entry one flagged open. A period with a day without a usable set
 * leaves the split listed as not attributed and estimated nowhere (decision 5, L3). An attribution changes neither the
 * item's meaning nor its review state (decision 7); the interest period never moves a split between years (rule 10).
 */

/** A counting interest split of a candidate Loan whose tax year is the view's (§58D "What the view reads"). */
export interface LoanInterestSplit {
  readonly item: TaxListItem;
  readonly loanId: string;
  /** §58L rule 1 (`interestPeriodOf`): the recorded or the schedule's period, clipped at `debtFrom`; `null` without (rule 8). */
  readonly period: InterestPeriod | null;
  /** §58O: the recorded period where it deviates from the plan's (the view's reads only; absent elsewhere). */
  readonly deviation?: PeriodDeviation | null;
  /** §58P: the classification's recorded `interestPeriod` as stored (the part change judges it on each side's plan; reads only). */
  readonly recordedPeriod?: { readonly from: BusinessDate; readonly until: BusinessDate } | null;
}

/** §58O: `INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE`'s details; `partsDiffer` decides its level (open when true). */
export interface DeviationDetails {
  readonly loanId: string;
  readonly recorded: { readonly from: BusinessDate; readonly until: BusinessDate };
  readonly schedule: { readonly from: BusinessDate; readonly until: BusinessDate };
  readonly termsId: string | null;
  readonly paymentIntervalMonths: number;
  readonly partsDiffer: boolean;
}

export type NotAttributedReason = 'NO_LOAN_ALLOCATION' | 'ALLOCATION_SUM_NOT_ONE';

/** The three cases of a split for the view's PropertyReference (§58D's table). */
export type LoanInterestCase =
  | {
      readonly kind: 'ATTRIBUTED';
      readonly split: LoanInterestSplit;
      /** §58L: the distinct sets of the period's segments, by `from` (one set in the common case). */
      readonly sets: readonly LoanAllocationSetView[];
      /** The Loan's `VALID` sets (§58L rule 8: `INTEREST_PERIOD_UNKNOWN` open with more than one). */
      readonly validSets: number;
      /** The property's non-negative part of the split's amount (one `distribute` over the weights). */
      readonly propertyCents: bigint;
      readonly allocation: TaxYearLoanAllocation;
      readonly deviation: DeviationDetails | null;
    }
  | { readonly kind: 'ELSEWHERE'; readonly split: LoanInterestSplit }
  | {
      readonly kind: 'NOT_ATTRIBUTED';
      readonly split: LoanInterestSplit;
      readonly reason: NotAttributedReason;
      /** The PropertyReferences named by any `VALID` set of the Loan, sorted. */
      readonly candidates: readonly string[];
      readonly allocation: TaxYearLoanAllocation;
      /** §58L: the days of the period without a set (`[]` for `ALLOCATION_SUM_NOT_ONE`). */
      readonly uncovered: readonly { readonly from: BusinessDate; readonly until: BusinessDate }[];
      readonly deviation: DeviationDetails | null;
    };

/** The open item flag on interest attributed by a `PURCHASE_PRICE` set with more than one entry (§58D, third set). */
export const LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY = 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY';
/**
 * The open item flag on attributed interest placed in `capitalized` that did not provably enter P's building basis exactly
 * once (§58D open question 4, decided by the owner on 2026-11-01; raised or dropped by §59E's `withLoanInterestFlags`).
 */
export const LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS = 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS';
/** §58L rule 8 (L8): a split distributed by its booking date's set, its Loan without a schedule; open with several `VALID` sets. */
export const INTEREST_PERIOD_UNKNOWN = 'INTEREST_PERIOD_UNKNOWN';
/**
 * §58O (Entscheidung des Projektinhabers, 2026-11-05, questions 6, 7, 11): a recorded `interestPeriod` that deviates
 * from the Loan's plan; open where the two periods give different parts for some PropertyReference (or one is covered
 * and the other not), informative where every part is the same; no acknowledgement.
 */
export const INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE = 'INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE';
/**
 * §58V (VC-X-43; Entscheidung des Projektinhabers, 2026-11-07, question 6): the **informative** year flag of a view with
 * an attributed split that has a part outside letting. The interest is accounted for, nothing is missing; it holds no
 * year open and its total is summed into nothing.
 */
export const LOAN_INTEREST_OUTSIDE_LETTING = 'LOAN_INTEREST_OUTSIDE_LETTING';

/** Whether two distributions of one split give different parts (the whole distribution, so the level is the same in every view). */
function partsDiffer(a: PeriodDistribution, b: PeriodDistribution): boolean {
  if (a.kind !== b.kind) return true;
  if (a.kind !== 'COVERED' || b.kind !== 'COVERED') return false;
  const parts = (d: Extract<PeriodDistribution, { kind: 'COVERED' }>) =>
    new Map(d.weights.filter((w) => w.cents !== 0n).map((w) => [w.propertyReferenceId, w.cents]));
  const [x, y] = [parts(a), parts(b)];
  return x.size !== y.size || [...x].some(([id, cents]) => y.get(id) !== cents);
}

const bookingDateOf = (item: TaxListItem): BusinessDate => (item as TaxMeaning).bookingDate;
const shareText = (s: { numerator: bigint; denominator: bigint }) => `${s.numerator}/${s.denominator}`;

/** The item's allocation: the one set covering the whole period (or the booking date), else `null`s; the period and segments. */
const allocationOf = (
  propertyReferenceId: string,
  split: LoanInterestSplit,
  segments: readonly PeriodSegment[],
  single: LoanAllocationSetView | null,
): TaxYearLoanAllocation => ({
  loanId: split.loanId,
  interestPeriod: split.period === null ? null : { from: split.period.from, until: split.period.until, source: split.period.source },
  segments:
    split.period === null
      ? []
      : segments.map((s) => {
          const entry = s.set.allocations.find((a) => a.propertyReferenceId === propertyReferenceId);
          return {
            from: s.from,
            until: s.until,
            allocationSetId: s.set.id,
            basis: s.set.basis,
            share: entry === undefined ? null : shareText(entry.share),
            outsideLettingShare: s.set.outsideLetting == null ? null : shareText(s.set.outsideLetting.share),
          };
        }),
  allocationSetId: single?.id ?? null,
  validFrom: single?.validFrom ?? null,
  validUntil: single?.validUntil ?? null,
  basis: single?.basis ?? null,
  share: null,
  propertyPart: null,
  taxConfirmation: null,
  outsideLetting: null,
});

/**
 * Each split's case for `propertyReferenceId` (§58L): `distributeOverPeriod` over its period (or its booking date, rule
 * 8) and the Loan's sets (`setOn` per day: `VALID`, `validFrom ≤ day ≤ validUntil`; a `VOID` set covers nothing),
 * usable when each set's shares sum to exactly `1/1` (`sumsToOne`, defensive: 0026 refuses any other at commit). `sets`
 * are every set of each Loan, with `validUntil` derived over the `VALID` ones.
 */
export function loanInterestOf(
  propertyReferenceId: string,
  splits: readonly LoanInterestSplit[],
  sets: ReadonlyMap<string, readonly LoanAllocationSetView[]>,
): LoanInterestCase[] {
  return splits.map((split): LoanInterestCase => {
    const loanSets = sets.get(split.loanId) ?? [];
    const d = distributeOverPeriod(loanSets, centsOf(split.item.amount), split.period, bookingDateOf(split.item));
    const dev = split.deviation ?? null;
    // §58O: the split distributed once more by the schedule's period, for the flag's level.
    const deviation: DeviationDetails | null =
      dev === null
        ? null
        : {
            loanId: split.loanId,
            recorded: dev.recorded,
            schedule: { from: dev.schedule.from, until: dev.schedule.until },
            termsId: dev.termsId,
            paymentIntervalMonths: dev.paymentIntervalMonths,
            partsDiffer: partsDiffer(d, distributeOverPeriod(loanSets, centsOf(split.item.amount), dev.schedule, bookingDateOf(split.item))),
          };
    const used = setsOfSegments(d.segments);
    const single = used.length === 1 && (d.kind === 'COVERED' || d.reason === 'ALLOCATION_SUM_NOT_ONE') ? (used[0] ?? null) : null;
    const allocation = allocationOf(propertyReferenceId, split, d.segments, single);
    if (d.kind === 'UNCOVERED') {
      const candidates = [...new Set(loanSets.filter((s) => s.status === 'VALID').flatMap((s) => s.allocations.map((a) => a.propertyReferenceId)))].sort();
      return {
        kind: 'NOT_ATTRIBUTED',
        split,
        reason: d.reason,
        candidates,
        allocation,
        uncovered: d.reason === 'NO_LOAN_ALLOCATION' ? d.uncovered : [],
        deviation,
      };
    }
    const weight = d.weights.find((w) => w.propertyReferenceId === propertyReferenceId);
    if (weight === undefined) return { kind: 'ELSEWHERE', split };
    return {
      kind: 'ATTRIBUTED',
      split,
      sets: used,
      validSets: loanSets.filter((s) => s.status === 'VALID').length,
      propertyCents: weight.cents,
      allocation: {
        ...allocation,
        share: shareText(weight.share),
        propertyPart: moneyOfCents(weight.cents, split.item.amount.currency),
        // §58V: listed on the item, the same in every view of the split; never P's part.
        outsideLetting:
          d.outsideLetting === null
            ? null
            : { share: shareText(d.outsideLetting.share), part: moneyOfCents(d.outsideLetting.cents, split.item.amount.currency) },
      },
      deviation,
    };
  });
}

/**
 * An attributed split as an item of the view (§58D "The arithmetic"): §58C's derivation with the property's part in
 * place of the split's amount, its meaning's flags, and the flag about the Loan's allocation itself. Whether a
 * `CAPITALIZED` item is in P's basis is §59E's, decided once the AfA is read (`withLoanInterestFlags`).
 */
export function deriveLoanItem(
  c: Extract<LoanInterestCase, { kind: 'ATTRIBUTED' }>,
  year: number,
  ownerships: readonly ViewOwnership[],
  changed: readonly MarkedChange[],
  confirmations: ReadonlyMap<string, LoanAllocationTaxConfirmation> = new Map(),
): Derived | undefined {
  const derived = deriveItem(c.split.item, year, ownerships, changed, c.propertyCents);
  if (derived === undefined) return undefined;
  const flags: ViewFlag[] = [...derived.flags];
  let allocation = c.allocation;
  // §58L: one entry per multi-entry PURCHASE_PRICE set among the segments (§58E Part 3: a confirmation clears its own).
  for (const set of c.sets) {
    if (set.basis !== 'PURCHASE_PRICE' || set.allocations.length <= 1) continue;
    // §58E Part 3: the set's ACTIVE confirmation, or null; the flag is informative with one, open without.
    const confirmation = confirmationMark(confirmations.get(set.id));
    flags.push({ code: LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY, details: { loanId: c.split.loanId, allocationSetId: set.id, confirmation } });
    if (c.sets.length === 1) allocation = { ...allocation, taxConfirmation: confirmation };
  }
  // §58L rule 8 (L8): open with more than one VALID set, informative with exactly one.
  if (c.split.period === null) {
    flags.push({ code: INTEREST_PERIOD_UNKNOWN, details: { loanId: c.split.loanId, reason: 'NO_SCHEDULE', validAllocationSets: c.validSets } });
  }
  // §58O: open where the parts differ, informative where they are the same.
  if (c.deviation !== null) flags.push({ code: INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE, details: c.deviation });
  return { ...derived, flags, loanAllocation: allocation };
}

/**
 * A split not attributed, as an entry of `notAttributed` (§58D "API shape"): its meaning as it is, `lineAmount` and
 * `share` `null` at both levels, summed nowhere, with the reason, the candidates and the Loan's allocations on the day.
 */
export function notAttributedLoanItem(c: Extract<LoanInterestCase, { kind: 'NOT_ATTRIBUTED' }>, year: number): TaxYearItem {
  const m = c.split.item;
  const flags: ViewFlag[] = [
    ...(m.reviewState === 'NEEDS_REVIEW' ? [{ code: 'NEEDS_REVIEW', details: {} }] : []),
    ...(m.treatment === null ? [{ code: 'UNCLASSIFIED', details: {} }] : []),
    // §58O: listed informative on a not attributed entry (the year is open by LOAN_INTEREST_NOT_ATTRIBUTED anyway).
    ...(c.deviation === null ? [] : [{ code: INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE, details: { ...c.deviation, notAttributed: true } }]),
  ];
  const derived: Derived = {
    source: m,
    placement: { place: 'UNCLASSIFIED' },
    date: bookingDateOf(m),
    participants: [],
    lineCents: null,
    parts: new Map(),
    folded: null,
    flags,
    loanAllocation: c.allocation,
  };
  return {
    ...itemAt(derived, year, m.amount.currency, undefined),
    notAttributed: {
      reason: c.reason,
      candidates: c.candidates,
      href: `/api/v1/loans/${c.split.loanId}/allocations?asOf=${bookingDateOf(m)}`,
      // §58L: the period and the days without a set.
      interestPeriod: c.allocation.interestPeriod,
      uncovered: c.uncovered,
    },
  };
}

/** `LOAN_INTEREST_NOT_ATTRIBUTED`'s details (§58D "Flags"): only the splits not attributed, an `INFLOW` subtracted. */
export function notAttributedInterestDetails(cases: readonly Extract<LoanInterestCase, { kind: 'NOT_ATTRIBUTED' }>[], currency: string) {
  const total = cases.reduce((s, c) => {
    const cents = centsOf(c.split.item.amount);
    return s + ((c.split.item as TaxMeaning).direction === 'INFLOW' ? -cents : cents);
  }, 0n);
  return {
    loanIds: [...new Set(cases.map((c) => c.split.loanId))].sort(),
    interestTotal: moneyOfCents(total, currency).toJSON(),
    splitIds: cases.map((c) => c.split.item.sourceId).sort(),
  };
}

/**
 * `LOAN_INTEREST_OUTSIDE_LETTING`'s details (§58V rule 6): the view's attributed splits with a part outside letting,
 * `interestTotal` the signed sum of their parts outside letting (an `INFLOW` subtracted); `undefined` without one.
 */
export function outsideLettingDetails(attributed: readonly Derived[], currency: string) {
  const outside = attributed.filter((d) => d.loanAllocation?.outsideLetting != null);
  if (outside.length === 0) return undefined;
  const total = outside.reduce((s, d) => {
    const cents = centsOf((d.loanAllocation?.outsideLetting as { part: Money }).part);
    return s + ((d.source as TaxMeaning).direction === 'INFLOW' ? -cents : cents);
  }, 0n);
  return {
    loanIds: [...new Set(outside.map((d) => d.loanAllocation?.loanId as string))].sort(),
    interestTotal: moneyOfCents(total, currency).toJSON(),
    splitIds: outside.map((d) => d.source.sourceId).sort(),
  };
}

/**
 * The attributed items merged into the list's items in §58C's order (by date, then Transaction, then position; on one
 * date splits before deposits, withdrawals and uses). Both inputs are in that order.
 */
export function inListOrder(listed: readonly Derived[], loans: readonly Derived[]): Derived[] {
  const before = (l: Derived, b: Derived) => {
    if (l.date !== b.date) return l.date < b.date;
    if (b.source.sourceType !== 'TRANSACTION_SPLIT') return true;
    const [lm, bm] = [l.source as TaxMeaning, b.source as TaxMeaning];
    return lm.transactionId !== bm.transactionId ? lm.transactionId < bm.transactionId : lm.position < bm.position;
  };
  const merged: Derived[] = [];
  let next = 0;
  for (const b of listed) {
    while (next < loans.length && before(loans[next] as Derived, b)) merged.push(loans[next++] as Derived);
    merged.push(b);
  }
  return [...merged, ...loans.slice(next)];
}

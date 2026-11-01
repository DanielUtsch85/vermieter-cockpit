import { centsOf, moneyOfCents, type BusinessDate } from '../../shared/index.js';
import { distribute, setOn, sumsToOne, type LoanAllocationSetView } from '../financing/index.js';
import type { AttributionChange } from './attribution-changes.js';
import type { TaxListItem, TaxMeaning } from './classification.js';
import { deriveItem, itemAt, type Derived } from './tax-year-items.js';
import type { TaxYearItem, TaxYearLoanAllocation, ViewFlag } from './tax-year-response.js';
import type { ViewOwnership } from './tax-year-shares.js';

/**
 * The interest of an allocated Loan in the tax-year view (api-design.md §58D, VC-X-29). A split with a `loanId` carries no
 * PropertyReference (0027): it reaches a property through the Loan's allocation set valid on its **booking date**
 * (decision 1), by Financing's `distribute` over the whole set (decision 6, §41.6: largest remainder, ties by
 * `propertyReferenceId`), and then the owners on that date by §58C's `shareOut` (decision 3), as any item. Any complete
 * set counts, `PURCHASE_PRICE` included (decided 2026-10-31, third set; ADR-038's one key), a multi-entry one flagged
 * open. Without a usable set the split is listed as not attributed and estimated nowhere (decision 5). An attribution
 * changes neither the item's meaning nor its review state (decision 7).
 */

/** A counting interest split of a candidate Loan whose tax year is the view's (§58D "What the view reads"). */
export interface LoanInterestSplit {
  readonly item: TaxListItem;
  readonly loanId: string;
}

export type NotAttributedReason = 'NO_LOAN_ALLOCATION' | 'ALLOCATION_SUM_NOT_ONE';

/** The three cases of a split for the view's PropertyReference (§58D's table). */
export type LoanInterestCase =
  | {
      readonly kind: 'ATTRIBUTED';
      readonly split: LoanInterestSplit;
      readonly set: LoanAllocationSetView;
      /** The property's non-negative part of the split's amount (`distribute` over the set's entries). */
      readonly propertyCents: bigint;
      readonly allocation: TaxYearLoanAllocation;
    }
  | { readonly kind: 'ELSEWHERE'; readonly split: LoanInterestSplit }
  | {
      readonly kind: 'NOT_ATTRIBUTED';
      readonly split: LoanInterestSplit;
      readonly reason: NotAttributedReason;
      /** The PropertyReferences named by any `VALID` set of the Loan, sorted. */
      readonly candidates: readonly string[];
      readonly allocation: TaxYearLoanAllocation;
    };

/** The open item flag on interest attributed by a `PURCHASE_PRICE` set with more than one entry (§58D, third set). */
export const LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY = 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY';
/**
 * The open item flag on attributed interest placed in `capitalized` that did not provably enter P's building basis exactly
 * once (§58D open question 4, decided by the owner on 2026-11-01; raised or dropped by §59E's `withLoanInterestFlags`).
 */
export const LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS = 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS';

const bookingDateOf = (item: TaxListItem): BusinessDate => (item as TaxMeaning).bookingDate;

const allocationOf = (loanId: string, set: LoanAllocationSetView | null): TaxYearLoanAllocation => ({
  loanId,
  allocationSetId: set?.id ?? null,
  validFrom: set?.validFrom ?? null,
  validUntil: set?.validUntil ?? null,
  basis: set?.basis ?? null,
  share: null,
  propertyPart: null,
});

/**
 * Each split's case for `propertyReferenceId`: the set covering its booking date (`setOn`: `VALID`, `validFrom ≤ day ≤
 * validUntil`; a `VOID` set covers nothing), usable when its shares sum to exactly `1/1` (`sumsToOne`, defensive: 0026
 * refuses any other at commit). `sets` are every set of each Loan, with `validUntil` derived over the `VALID` ones.
 */
export function loanInterestOf(
  propertyReferenceId: string,
  splits: readonly LoanInterestSplit[],
  sets: ReadonlyMap<string, readonly LoanAllocationSetView[]>,
): LoanInterestCase[] {
  return splits.map((split): LoanInterestCase => {
    const loanSets = sets.get(split.loanId) ?? [];
    const set = setOn(loanSets, bookingDateOf(split.item));
    if (set === null || !sumsToOne(set.allocations.map((a) => a.share))) {
      const candidates = [...new Set(loanSets.filter((s) => s.status === 'VALID').flatMap((s) => s.allocations.map((a) => a.propertyReferenceId)))].sort();
      return {
        kind: 'NOT_ATTRIBUTED',
        split,
        reason: set === null ? 'NO_LOAN_ALLOCATION' : 'ALLOCATION_SUM_NOT_ONE',
        candidates,
        allocation: allocationOf(split.loanId, set),
      };
    }
    const index = set.allocations.findIndex((a) => a.propertyReferenceId === propertyReferenceId);
    if (index < 0) return { kind: 'ELSEWHERE', split };
    // Over the whole set, so every view of its PropertyReferences computes the same parts, summing to the split.
    const propertyCents = distribute(centsOf(split.item.amount), set.allocations)[index] as bigint;
    const share = set.allocations[index]?.share as { numerator: bigint; denominator: bigint };
    return {
      kind: 'ATTRIBUTED',
      split,
      set,
      propertyCents,
      allocation: {
        ...allocationOf(split.loanId, set),
        share: `${share.numerator}/${share.denominator}`,
        propertyPart: moneyOfCents(propertyCents, split.item.amount.currency),
      },
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
  changed: readonly AttributionChange[],
): Derived | undefined {
  const derived = deriveItem(c.split.item, year, ownerships, changed, c.propertyCents);
  if (derived === undefined) return undefined;
  const details = { loanId: c.split.loanId, allocationSetId: c.set.id };
  const flags: ViewFlag[] = [...derived.flags];
  if (c.set.basis === 'PURCHASE_PRICE' && c.set.allocations.length > 1) flags.push({ code: LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY, details });
  return { ...derived, flags, loanAllocation: c.allocation };
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
    notAttributed: { reason: c.reason, candidates: c.candidates, href: `/api/v1/loans/${c.split.loanId}/allocations?asOf=${bookingDateOf(m)}` },
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

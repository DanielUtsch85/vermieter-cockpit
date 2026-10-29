import { Money, type BusinessDate } from '../../shared/index.js';

/**
 * The suggestion rule of api-design.md §37.3 (phase-4-plan P4-D4): deterministic, independent of the input's order,
 * and never authoritative. A suggestion is only made for an exact amount whose pair is unique, made unique by the month
 * in the purpose text or by the IBAN history, or assigned in order from an anchor (#125); open suggestions stay in the
 * graph as competition (review on #80).
 */

export const SUGGESTION_REASONS = ['EXACT_AMOUNT', 'EXACT_AMOUNT_IBAN_HISTORY', 'EXACT_AMOUNT_PURPOSE_MONTH', 'EXACT_AMOUNT_IN_ORDER'] as const;
export type SuggestionReason = (typeof SUGGESTION_REASONS)[number];
export type Confidence = 'HIGH' | 'MEDIUM';

/** An MRE term with its open amount (MRE's amount due − DE's `CONFIRMED` matches for it). */
export interface SuggestionTerm {
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
  readonly openAmount: Money;
  /** False for the month before `from` and after `to`: read for the uniqueness check only, never suggested. */
  readonly inWindow: boolean;
}

/** A counted `INFLOW` Transaction of the Realm with available rent cash. */
export interface SuggestionCandidate {
  readonly transactionId: string;
  readonly bookingDate: BusinessDate;
  readonly available: Money;
  readonly counterpartyIban: string | null;
  /** The Transaction's purpose text, read for a month only (#125). */
  readonly description: string | null;
}

export interface SuggestionPair {
  readonly transactionId: string;
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
}

export interface SuggestionInput {
  readonly terms: readonly SuggestionTerm[];
  readonly candidates: readonly SuggestionCandidate[];
  /** Pairs with a `REJECTED`, `RELEASED` or `CONFIRMED` reconciliation: no fit, never suggested again. */
  readonly handled: readonly SuggestionPair[];
  /** Pairs with an open `SUGGESTED` reconciliation: edges of the graph, never written again. */
  readonly open: readonly SuggestionPair[];
  /** `mreTenantId` and `counterparty_iban_raw` of the Transactions of the Realm's earlier `CONFIRMED` reconciliations. */
  readonly history: readonly { readonly mreTenantId: string; readonly counterpartyIban: string }[];
}

export interface Suggestion extends SuggestionPair {
  readonly matchedAmount: Money;
  readonly confidence: Confidence;
  readonly suggestionReason: SuggestionReason;
}

const termKey = (p: { readonly mreTenantId: string; readonly mreRentTerm: string }) => `${p.mreTenantId}/${p.mreRentTerm}`;
const pairKey = (p: SuggestionPair) => `${p.transactionId}|${termKey(p)}`;

/**
 * The booking window of a term: from the 15th of the month before its month (the `YYYYMM` of its key) to the last
 * day of its month, as business dates.
 */
export function bookingWindow(mreRentTerm: string): { readonly from: BusinessDate; readonly to: BusinessDate } {
  const year = Number(mreRentTerm.slice(0, 4));
  const month = Number(mreRentTerm.slice(4, 6));
  const before = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${before.year}-${pad(before.month)}-15` as BusinessDate,
    to: `${year}-${pad(month)}-${pad(lastDay)}` as BusinessDate,
  };
}

const GERMAN_MONTHS: readonly (readonly string[])[] = [
  ['januar', 'jan'],
  ['februar', 'feb'],
  ['märz', 'maerz', 'marz', 'mär', 'mrz'],
  ['april', 'apr'],
  ['mai'],
  ['juni', 'jun'],
  ['juli', 'jul'],
  ['august', 'aug'],
  ['september', 'sept', 'sep'],
  ['oktober', 'okt'],
  ['november', 'nov'],
  ['dezember', 'dez'],
];
const NAMED_MONTH = new RegExp(
  `(?<!\\p{L})(${GERMAN_MONTHS.flat()
    .sort((a, b) => b.length - a.length)
    .join('|')})\\.?\\s*(\\d{4})(?!\\d)`,
  'giu',
);

/**
 * The months (`YYYYMM`) a purpose text names (#125): `MM.YYYY`, `MM/YYYY`, `YYYY-MM`, or a German month name with a
 * four-digit year (`Oktober 2026`, `Okt. 2026`). A name without a year is not read: `Jan` and `August` are first names.
 * A full date `DD.MM.YYYY` names its month.
 */
export function monthsInText(text: string | null): ReadonlySet<string> {
  const months = new Set<string>();
  if (text === null) return months;
  const add = (year: string, month: number) => {
    if (month >= 1 && month <= 12) months.add(`${year}${String(month).padStart(2, '0')}`);
  };
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[./](\d{4})(?!\d)/g)) add(m[2] as string, Number(m[1]));
  for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{2})(?![\d-])/g)) add(m[1] as string, Number(m[2]));
  for (const m of text.matchAll(NAMED_MONTH)) {
    const name = (m[1] as string).toLowerCase();
    add(m[2] as string, GERMAN_MONTHS.findIndex((names) => names.includes(name)) + 1);
  }
  return months;
}

const monthOf = (mreRentTerm: string) => mreRentTerm.slice(0, 6);
const nextMonth = (yyyymm: string, delta: number) => {
  const index = Number(yyyymm.slice(0, 4)) * 12 + Number(yyyymm.slice(4, 6)) - 1 + delta;
  return `${Math.floor(index / 12)}${String((index % 12) + 1).padStart(2, '0')}`;
};
const byDateThenId = (a: SuggestionCandidate, b: SuggestionCandidate) =>
  a.bookingDate !== b.bookingDate
    ? a.bookingDate < b.bookingDate
      ? -1
      : 1
    : a.transactionId < b.transactionId
      ? -1
      : a.transactionId > b.transactionId
        ? 1
        : 0;

interface Edge extends SuggestionPair {
  readonly candidate?: SuggestionCandidate;
  readonly term?: SuggestionTerm;
  readonly history: boolean;
  /** The purpose text's month removed the candidate's other fits (#125). */
  readonly purposeMonth?: boolean;
  readonly inOrder?: boolean;
}

/** The suggestions of one run, in Transaction id, then term order. */
export function suggestPairs(input: SuggestionInput): readonly Suggestion[] {
  const handled = new Set(input.handled.map(pairKey));
  const open = new Set(input.open.map(pairKey));
  const history = new Set(input.history.map((h) => `${h.mreTenantId}|${h.counterpartyIban}`));
  const hasHistory = (mreTenantId: string, iban: string | null) => iban !== null && history.has(`${mreTenantId}|${iban}`);

  const fits: Edge[] = [];
  for (const term of input.terms) {
    if (!term.openAmount.isPositive()) continue;
    const window = bookingWindow(term.mreRentTerm);
    for (const candidate of input.candidates) {
      const pair = { transactionId: candidate.transactionId, mreTenantId: term.mreTenantId, mreRentTerm: term.mreRentTerm };
      if (handled.has(pairKey(pair)) || open.has(pairKey(pair))) continue;
      if (!candidate.available.equals(term.openAmount)) continue;
      if (candidate.bookingDate < window.from || candidate.bookingDate > window.to) continue;
      fits.push({ ...pair, candidate, term, history: hasHistory(term.mreTenantId, candidate.counterpartyIban) });
    }
  }
  // The purpose text's month (#125): a candidate whose text names the month of some of its fits keeps only those.
  for (const candidate of input.candidates) {
    const named = monthsInText(candidate.description);
    const own = fits.filter((e) => e.transactionId === candidate.transactionId);
    const kept = own.filter((e) => named.has(monthOf(e.mreRentTerm)));
    if (kept.length === 0 || kept.length === own.length) continue;
    for (const e of own) fits.splice(fits.indexOf(e), 1);
    fits.push(...kept.map((e) => ({ ...e, purposeMonth: true })));
  }
  // Open suggestions are edges whether or not their amounts still match: they block, they are never written.
  const openEdges: Edge[] = input.open.map((p) => ({ ...p, history: false }));

  const degrees = (edges: readonly Edge[]) => {
    const byTransaction = new Map<string, number>();
    const byTerm = new Map<string, number>();
    for (const e of edges) {
      byTransaction.set(e.transactionId, (byTransaction.get(e.transactionId) ?? 0) + 1);
      byTerm.set(termKey(e), (byTerm.get(termKey(e)) ?? 0) + 1);
    }
    return (e: Edge) => byTransaction.get(e.transactionId) === 1 && byTerm.get(termKey(e)) === 1;
  };

  const uniqueIn = degrees([...fits, ...openEdges]);
  const unique = fits.filter(uniqueIn);
  const rest = fits.filter((e) => !uniqueIn(e));
  const historyFits = rest.filter((e) => e.history);
  const uniqueInHistory = degrees([...historyFits, ...openEdges]);
  const decided = historyFits.filter(uniqueInHistory);
  const inOrder = assignInOrder(input, fits, [...unique, ...decided], openEdges);

  return [...unique, ...decided, ...inOrder]
    .filter((e) => e.term?.inWindow === true)
    .map(
      (e): Suggestion => ({
        transactionId: e.transactionId,
        mreTenantId: e.mreTenantId,
        mreRentTerm: e.mreRentTerm,
        matchedAmount: e.term?.openAmount ?? Money.zero('EUR'),
        confidence: e.history ? 'HIGH' : 'MEDIUM',
        suggestionReason:
          e.inOrder === true
            ? 'EXACT_AMOUNT_IN_ORDER'
            : e.purposeMonth === true
              ? 'EXACT_AMOUNT_PURPOSE_MONTH'
              : e.history
                ? 'EXACT_AMOUNT_IBAN_HISTORY'
                : 'EXACT_AMOUNT',
      }),
    )
    .sort((a, b) =>
      a.transactionId !== b.transactionId ? (a.transactionId < b.transactionId ? -1 : 1) : termKey(a) < termKey(b) ? -1 : termKey(a) > termKey(b) ? 1 : 0,
    );
}

/**
 * In order from an anchor (#125): a Tenant who pays before the month makes a chain (Apr 28 – May – May 28 – Jun – …) in
 * which no pair is unique. Counting alone cannot place it: a chain read from its middle is off by one month. So a walk
 * starts only at an open term whose month before is known to be done for that Tenant: its term is settled (open ≤ 0),
 * decided in this run, or has an open suggestion. A lease start is no anchor: if its first payment is missing from the
 * imports, the whole chain would shift by one month. From there each consecutive
 * month takes the oldest remaining candidate that fits it, as long as that candidate:
 * - has a counterparty IBAN, the same for all of the Tenant's walks;
 * - fits no other Tenant's term and no earlier open term;
 * - has no open suggestion; nor has the term.
 * The walk stops at the first month that has no such candidate.
 */
function assignInOrder(input: SuggestionInput, fits: readonly Edge[], decided: readonly Edge[], openEdges: readonly Edge[]): Edge[] {
  const usedTransactions = new Set([...decided, ...openEdges].map((e) => e.transactionId));
  const usedTerms = new Set([...decided, ...openEdges].map(termKey));
  const assigned: Edge[] = [];
  const tenants = [...new Set(input.terms.map((t) => t.mreTenantId))].sort();
  for (const tenant of tenants) {
    const byMonth = new Map(input.terms.filter((t) => t.mreTenantId === tenant).map((t) => [monthOf(t.mreRentTerm), t]));
    const isOpen = (t: SuggestionTerm | undefined): t is SuggestionTerm => t !== undefined && t.openAmount.isPositive() && !usedTerms.has(termKey(t));
    const months = [...byMonth.keys()].sort();
    // One IBAN per Tenant across its walks: a walk restarted after a stop must not take the payment that stopped it.
    let iban: string | null = null;
    for (const month of months) {
      const start = byMonth.get(month);
      if (!isOpen(start)) continue;
      const previous = byMonth.get(nextMonth(month, -1));
      if (previous === undefined || isOpen(previous)) continue;
      for (let current: SuggestionTerm | undefined = start; isOpen(current); current = byMonth.get(nextMonth(monthOf(current.mreRentTerm), 1))) {
        const term: SuggestionTerm = current;
        const pick = fits
          .filter((e) => termKey(e) === termKey(term) && !usedTransactions.has(e.transactionId))
          .map((e) => e.candidate as SuggestionCandidate)
          .sort(byDateThenId)[0];
        if (pick === undefined || pick.counterpartyIban === null || (iban !== null && pick.counterpartyIban !== iban)) break;
        const ownFits = fits.filter((e) => e.transactionId === pick.transactionId);
        if (ownFits.some((e) => e.mreTenantId !== tenant || (e.mreRentTerm < term.mreRentTerm && isOpen(e.term)))) break;
        const edge = ownFits.find((e) => termKey(e) === termKey(term)) as Edge;
        iban = pick.counterpartyIban;
        usedTransactions.add(pick.transactionId);
        usedTerms.add(termKey(term));
        assigned.push({ ...edge, inOrder: true });
      }
    }
  }
  return assigned;
}

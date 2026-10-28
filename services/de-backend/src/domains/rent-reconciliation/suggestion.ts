import { Money, type BusinessDate } from '../../shared/index.js';

/**
 * The suggestion rule of api-design.md §37.3 (phase-4-plan P4-D4): deterministic, independent of the input's order,
 * and never authoritative. A suggestion is only made for an exact amount whose pair is unique, or made unique by the
 * IBAN history; open suggestions stay in the graph as competition (review on #80).
 */

export const SUGGESTION_REASONS = ['EXACT_AMOUNT', 'EXACT_AMOUNT_IBAN_HISTORY'] as const;
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

interface Edge extends SuggestionPair {
  readonly candidate?: SuggestionCandidate;
  readonly term?: SuggestionTerm;
  readonly history: boolean;
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

  return [...unique, ...decided]
    .filter((e) => e.term?.inWindow === true)
    .map((e): Suggestion => ({
      transactionId: e.transactionId,
      mreTenantId: e.mreTenantId,
      mreRentTerm: e.mreRentTerm,
      matchedAmount: e.term?.openAmount ?? Money.zero('EUR'),
      confidence: e.history ? 'HIGH' : 'MEDIUM',
      suggestionReason: e.history ? 'EXACT_AMOUNT_IBAN_HISTORY' : 'EXACT_AMOUNT',
    }))
    .sort((a, b) => (a.transactionId !== b.transactionId ? (a.transactionId < b.transactionId ? -1 : 1) : termKey(a) < termKey(b) ? -1 : termKey(a) > termKey(b) ? 1 : 0));
}

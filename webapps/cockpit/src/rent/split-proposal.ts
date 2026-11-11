import type { RentSplitProposalDto, RentTermRef } from '../api/rent-reconciliations';
import type { MoneyValue } from '../format/money';
import { MAX_SPLITS, type DraftRow } from '../transactions/split-draft';
import { compareCents, decimalToCents, decimalToInput, differenceAsDecimal, parseAmountInput, type AmountProblem } from '../transactions/split-amount';
import { termDate } from './reconciliation-rules';

/**
 * Step 8 (Entscheidung des Projektinhabers, 2026-11-11; ui-guide.md §6.6 steps 2 and 3, §6.4): the split proposal of one
 * or more MRE terms for one unconfirmed inflow, and the manual match. Pure functions on digit strings: no `parseFloat`,
 * no `Number` on an amount, no floating point (§5.2). The server stays the judge; these rules only keep the client from
 * sending what the server is sure to refuse.
 */

/** An MRE id as the backend reads it (`MRE_EXTERNAL_ID`, api-design.md §20.1): 24 lowercase hex digits. */
const MRE_ID = /^[0-9a-f]{24}$/;

export type TenantIdProblem = 'TENANT_MISSING' | 'TENANT_INVALID';
export type TermProblem = 'TERM_MISSING' | 'TERM_INVALID';

/** Why a typed MRE Tenant id is not one; the id is never derived from a name (ui-guide.md §5.1, §6.6). */
export function checkTenantId(text: string): TenantIdProblem | undefined {
  const value = text.trim();
  if (value === '') return 'TENANT_MISSING';
  return MRE_ID.test(value) ? undefined : 'TENANT_INVALID';
}

/** Why a typed term key is not MRE's `YYYYMMDDHH` with a real date and hour (§37.1 `INVALID_TERM`; ui-guide.md §5.2). */
export function checkTermKey(text: string): TermProblem | undefined {
  const value = text.trim();
  if (value === '') return 'TERM_MISSING';
  return termDate(value) === undefined ? 'TERM_INVALID' : undefined;
}

export const sameTerm = (a: RentTermRef, b: RentTermRef): boolean => a.mreTenantId === b.mreTenantId && a.mreRentTerm === b.mreRentTerm;

/** One line of the combined proposal: a split's category and amount, with the term it came from (its source). */
export interface ProposalLine {
  readonly financialCategoryCode: string;
  /** The API's decimal string, two places. */
  readonly amount: string;
  readonly source: RentTermRef;
  /** The term's own split was larger; what was left of the payment covered only this much. */
  readonly cut: boolean;
}

export interface CombinedProposal {
  readonly lines: readonly ProposalLine[];
  /** What the lines leave of the Transaction's amount (`0.00` when they cover it exactly); never negative. */
  readonly remainder: string;
}

const centsOf = (money: MoneyValue): string | undefined => decimalToCents(money.amount);
const minCents = (a: string, b: string): string => (compareCents(a, b) <= 0 ? a : b);
const asDecimal = (cents: string): string => differenceAsDecimal(cents, '0');

/**
 * The proposals of several terms for one payment (a collective payment: several months or Tenants in one transfer),
 * applied in the order the user added them. The first is the server's proposal as it is (§37.6: `RENT_BASE` = min(rent,
 * amount), the advance = min(charges, the rest)); each further one takes its splits from what the earlier ones left of
 * the amount, each split cut at that rest, so the sum never exceeds the amount and the server's rule is the same for
 * every term. A split of 0,00 € is left out. Undefined when an amount is not readable or a currency differs.
 */
export function combineProposals(amount: MoneyValue, proposals: readonly RentSplitProposalDto[]): CombinedProposal | undefined {
  const total = centsOf(amount);
  if (total === undefined) return undefined;
  let left = total;
  const lines: ProposalLine[] = [];
  for (const proposal of proposals) {
    for (const split of proposal.splits) {
      const wanted = split.amount.currency === amount.currency ? centsOf(split.amount) : undefined;
      if (wanted === undefined) return undefined;
      const taken = minCents(wanted, left);
      if (!/[1-9]/.test(taken)) continue;
      lines.push({
        financialCategoryCode: split.financialCategoryCode,
        amount: asDecimal(taken),
        source: { mreTenantId: proposal.mreTenantId, mreRentTerm: proposal.mreRentTerm },
        cut: taken !== wanted,
      });
      left = decimalToCents(differenceAsDecimal(left, taken)) ?? '0';
    }
  }
  return { lines, remainder: asDecimal(left) };
}

/**
 * The split editor's draft for a combined proposal (§6.4: "Vorschlag ist editierbarer Formularentwurf"): one row per line
 * with its category and amount and no reference, and, when the lines leave a remainder, one more row over exactly that
 * remainder without a category, so the draft's sum is the Transaction's amount and the user decides what the rest is.
 * Undefined when there is nothing to take over or the rows would exceed the editor's 100 splits. Nothing is sent: the
 * draft is saved only by „Aufteilung speichern“ (`PUT …/splits`).
 */
export function draftFromProposal(combined: CombinedProposal, newKey: () => string): DraftRow[] | undefined {
  const rest = decimalToCents(combined.remainder);
  const restRow = rest !== undefined && /[1-9]/.test(rest);
  if (combined.lines.length === 0 || combined.lines.length + (restRow ? 1 : 0) > MAX_SPLITS) return undefined;
  const row = (amount: string, financialCategoryCode: string): DraftRow => ({
    key: newKey(),
    amount: decimalToInput(amount) ?? amount,
    financialCategoryCode,
    reference: { kind: 'none' },
    kept: undefined,
    description: '',
  });
  const rows = combined.lines.map((line) => row(line.amount, line.financialCategoryCode));
  return restRow ? [...rows, row(combined.remainder, '')] : rows;
}

export type MatchAmountProblem = AmountProblem | 'NOT_POSITIVE' | 'ABOVE_AVAILABLE';

export type MatchAmountCheck = { readonly ok: true; readonly amount: MoneyValue } | { readonly ok: false; readonly problem: MatchAmountProblem };

/**
 * The amount of „Manuell zuordnen“ (§37.1): typed in German, more than zero (`NOT_POSITIVE`), and at most the rent cash
 * still free on the booking (`RENT_CASH_EXCEEDED` otherwise). Less is a partial match; the rest stays free.
 */
export function checkMatchAmount(input: string, available: MoneyValue): MatchAmountCheck {
  const parsed = parseAmountInput(input);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  if (!/[1-9]/.test(parsed.cents)) return { ok: false, problem: 'NOT_POSITIVE' };
  const limit = decimalToCents(available.amount);
  if (limit === undefined || compareCents(parsed.cents, limit) > 0) return { ok: false, problem: 'ABOVE_AVAILABLE' };
  return { ok: true, amount: { amount: parsed.amount, currency: available.currency } };
}

/** Whether a free amount is above zero, i.e. there is rent cash left to match. */
export const hasFreeCash = (available: MoneyValue | null): available is MoneyValue => {
  const cents = available === null ? undefined : decimalToCents(available.amount);
  return cents !== undefined && /[1-9]/.test(cents);
};

import type { BusinessDate, Money } from '../../shared/index.js';
import type { Classification, StatementView } from './annual-statement.js';
import { centsOf, eur } from './economic-plan.js';
import type { Mea } from './mea.js';

/**
 * The ledger effects of a Jahresabrechnung (api-design.md §51, phase-6-plan P6-D6): the comparison of the year's counted
 * advances with the statement's actual costs per class, the settlement over the chain of superseded statements, the
 * reserve withdrawals with the unit's share, and the split proposal for the settlement payment. Reads only: a statement
 * never creates cash and never re-splits a confirmed split (BR-WEG-007).
 */

/** The split categories and their classes (§51). */
export const CLASS_OF_CATEGORY = {
  WEG_RECOVERABLE: 'RECOVERABLE',
  WEG_NON_RECOVERABLE: 'NON_RECOVERABLE',
  WEG_RESERVE_CONTRIBUTION: 'RESERVE',
} as const satisfies Record<string, Classification>;

export type WegCategory = keyof typeof CLASS_OF_CATEGORY;

/** A counted split, signed: an `OUTFLOW` positive, an `INFLOW` negative. */
export interface CountedWegSplit {
  readonly transactionId: string;
  readonly bookingDate: BusinessDate;
  readonly category: WegCategory;
  readonly amount: Money;
}

export interface Settlement {
  readonly transactionId: string;
  readonly statementId: string;
  readonly bookingDate: BusinessDate;
  /** Signed as above. */
  readonly amount: Money;
}

export interface ClassFigures {
  readonly paid: Money;
  readonly actual: Money;
  readonly difference: Money;
}

export interface ReserveWithdrawal {
  readonly position: number;
  readonly description: string;
  readonly withdrawal: Money;
  readonly unitShare: Money;
}

export type ComparisonFlag =
  | { readonly code: 'PEAK_IDENTITY_DIFFERS'; readonly details: { readonly derived: Money; readonly printed: Money } }
  | {
      readonly code: 'PAID_DIFFERS_FROM_PRINTED';
      readonly details: { readonly block: 'HAUSGELD' | 'RESERVE'; readonly counted: Money; readonly printed: Money };
    }
  | { readonly code: 'RESERVE_COUNTED_TWICE'; readonly details: { readonly lines: Money; readonly printed: Money } }
  | { readonly code: 'UNCOUNTED_WEG_SPLITS'; readonly details: { readonly transactionIds: readonly string[] } }
  | { readonly code: 'SETTLED_AGAINST_SUPERSEDED'; readonly details: { readonly transactionIds: readonly string[] } }
  | { readonly code: 'SUPERSEDED'; readonly details: { readonly supersededBy: string } };

export interface Comparison {
  readonly classes: Readonly<Record<Classification, ClassFigures>>;
  readonly advances: { readonly requested: Money; readonly counted: Money; readonly unpaidAdvances: Money };
  readonly settlementPeak: Money;
  readonly settlement: { readonly settledBy: readonly Settlement[]; readonly settled: Money; readonly open: Money };
  readonly reserveWithdrawals: readonly ReserveWithdrawal[];
  readonly flags: readonly ComparisonFlag[];
}

const sum = (amounts: readonly Money[]): bigint => amounts.reduce((total, m) => total + centsOf(m), 0n);
const CLASSES = ['RECOVERABLE', 'NON_RECOVERABLE', 'RESERVE'] as const;

/** A quantity of up to three decimals in thousandths, exact. */
const thousandths = (quantity: string): bigint => {
  const [whole, fraction = ''] = quantity.split('.') as [string, string?];
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
};

/** `cents × part / whole`, rounded half away from zero; `whole > 0`. */
function share(cents: bigint, part: bigint, whole: bigint): bigint {
  const magnitude = (2n * (cents < 0n ? -cents : cents) * part + whole) / (2n * whole);
  return cents < 0n ? -magnitude : magnitude;
}

/**
 * The comparison of §51. `chain` is the statement and the statements it supersedes, transitively; `settlements` are the
 * current splits naming one of them. The reserve's actual is its lines when a line is classified `RESERVE`, else the
 * printed reserve advance (review on #151): never both, so the class differences stay right; `requested` follows the
 * same choice, so `Σ difference = settlementPeak + unpaidAdvances` holds exactly whenever the lines sum to the total.
 */
export function deriveComparison(input: {
  readonly statement: StatementView;
  readonly mea: Mea;
  readonly advances: readonly CountedWegSplit[];
  readonly settlements: readonly Settlement[];
  readonly uncountedTransactionIds: readonly string[];
}): Comparison {
  const { statement } = input;
  const flags: ComparisonFlag[] = [];
  const reserveLines = statement.costLines.some((line) => line.classification === 'RESERVE');
  const printedReserve = statement.reserveRequested === null ? 0n : centsOf(statement.reserveRequested);
  if (reserveLines && printedReserve !== 0n) {
    flags.push({ code: 'RESERVE_COUNTED_TWICE', details: { lines: statement.byClassification.RESERVE, printed: statement.reserveRequested as Money } });
  }
  const reserveAdvance = reserveLines ? 0n : printedReserve;
  const classes = Object.fromEntries(
    CLASSES.map((c) => {
      const paid = sum(input.advances.filter((s) => CLASS_OF_CATEGORY[s.category] === c).map((s) => s.amount));
      const actual = centsOf(statement.byClassification[c]) + (c === 'RESERVE' ? reserveAdvance : 0n);
      return [c, { paid: eur(paid), actual: eur(actual), difference: eur(actual - paid) }];
    }),
  ) as Record<Classification, ClassFigures>;
  const counted = sum(input.advances.map((s) => s.amount));
  const requested = centsOf(statement.hausgeldRequested) + reserveAdvance;
  const unpaid = requested - counted;
  const differences = CLASSES.reduce((total, c) => total + centsOf(classes[c].difference), 0n);
  const peak = centsOf(statement.settlementPeak);
  if (differences - unpaid !== peak)
    flags.push({ code: 'PEAK_IDENTITY_DIFFERS', details: { derived: eur(differences - unpaid), printed: statement.settlementPeak } });
  const paidHausgeld = centsOf(classes.RECOVERABLE.paid) + centsOf(classes.NON_RECOVERABLE.paid);
  if (paidHausgeld !== centsOf(statement.hausgeldPaid)) {
    flags.push({ code: 'PAID_DIFFERS_FROM_PRINTED', details: { block: 'HAUSGELD', counted: eur(paidHausgeld), printed: statement.hausgeldPaid } });
  }
  if (statement.reservePaid !== null && centsOf(classes.RESERVE.paid) !== centsOf(statement.reservePaid)) {
    flags.push({ code: 'PAID_DIFFERS_FROM_PRINTED', details: { block: 'RESERVE', counted: classes.RESERVE.paid, printed: statement.reservePaid } });
  }
  if (input.uncountedTransactionIds.length > 0) {
    flags.push({ code: 'UNCOUNTED_WEG_SPLITS', details: { transactionIds: [...new Set(input.uncountedTransactionIds)].sort() } });
  }
  // One entry per Transaction and statement: a refund split over both Hausgeld classes is one settlement.
  const grouped = new Map<string, Settlement>();
  for (const s of input.settlements) {
    const key = `${s.transactionId}|${s.statementId}`;
    const seen = grouped.get(key);
    grouped.set(key, seen === undefined ? s : { ...seen, amount: eur(centsOf(seen.amount) + centsOf(s.amount)) });
  }
  const settledBy = [...grouped.values()].sort((a, b) =>
    a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0,
  );
  const older = [...new Set(settledBy.filter((s) => s.statementId !== statement.id).map((s) => s.transactionId))].sort();
  if (older.length > 0) flags.push({ code: 'SETTLED_AGAINST_SUPERSEDED', details: { transactionIds: older } });
  if (statement.supersededBy !== null) flags.push({ code: 'SUPERSEDED', details: { supersededBy: statement.supersededBy } });
  const settled = sum(settledBy.map((s) => s.amount));
  const numerator = thousandths(input.mea.numerator);
  const denominator = thousandths(input.mea.denominator);
  const reserveWithdrawals = (statement.reserve?.lines ?? []).flatMap((line) =>
    line.kind === 'WITHDRAWAL' && line.withdrawal !== null
      ? [
          {
            position: line.position,
            description: line.description,
            withdrawal: line.withdrawal,
            unitShare: eur(share(centsOf(line.withdrawal), numerator, denominator)),
          },
        ]
      : [],
  );
  return {
    classes,
    advances: { requested: eur(requested), counted: eur(counted), unpaidAdvances: eur(unpaid) },
    settlementPeak: statement.settlementPeak,
    settlement: { settledBy, settled: eur(settled), open: eur(peak - settled) },
    reserveWithdrawals,
    flags,
  };
}

export interface ProposedSettlementSplit {
  readonly financialCategoryCode: 'WEG_RECOVERABLE' | 'WEG_NON_RECOVERABLE';
  readonly amount: Money;
}

export type SettlementFlag =
  | { readonly code: 'AMOUNT_DIFFERS_FROM_PEAK'; readonly details: { readonly difference: Money } }
  | { readonly code: 'MIXED_DIFFERENCES'; readonly details: Record<string, never> }
  | { readonly code: 'NO_MATCHING_DIFFERENCE'; readonly details: Record<string, never> };

/**
 * The settlement proposal of §51 for an amount A (≥ 0) in a direction: over the two Hausgeld classes whose difference
 * has the payment's sign (> 0 for an `OUTFLOW`, < 0 for an `INFLOW`), in proportion to their magnitudes, each rounded
 * half-up, the rest on the larger part (the first of equals); none of them → all on `NON_RECOVERABLE`, never claimed
 * recoverable without a reason. A share of 0 is left out.
 */
export function proposeSettlement(
  amount: Money,
  direction: 'INFLOW' | 'OUTFLOW',
  comparison: Pick<Comparison, 'classes' | 'settlementPeak'>,
): { readonly splits: readonly ProposedSettlementSplit[]; readonly flags: readonly SettlementFlag[] } {
  const a = centsOf(amount);
  const sign = direction === 'OUTFLOW' ? 1n : -1n;
  const flags: SettlementFlag[] = [];
  const peak = centsOf(comparison.settlementPeak);
  const magnitude = peak < 0n ? -peak : peak;
  if (a !== magnitude) flags.push({ code: 'AMOUNT_DIFFERS_FROM_PEAK', details: { difference: eur(a - magnitude) } });
  const parts = [
    ['WEG_RECOVERABLE', centsOf(comparison.classes.RECOVERABLE.difference)],
    ['WEG_NON_RECOVERABLE', centsOf(comparison.classes.NON_RECOVERABLE.difference)],
  ] as const;
  const [recoverable, nonRecoverable] = [parts[0][1], parts[1][1]];
  if ((recoverable > 0n && nonRecoverable < 0n) || (recoverable < 0n && nonRecoverable > 0n)) flags.push({ code: 'MIXED_DIFFERENCES', details: {} });
  const matching = parts.filter(([, d]) => d * sign > 0n).map(([code, d]) => [code, d * sign] as [ProposedSettlementSplit['financialCategoryCode'], bigint]);
  if (matching.length === 0) {
    flags.push({ code: 'NO_MATCHING_DIFFERENCE', details: {} });
    return { splits: a === 0n ? [] : [{ financialCategoryCode: 'WEG_NON_RECOVERABLE', amount: amount }], flags };
  }
  const whole = matching.reduce((total, [, d]) => total + d, 0n);
  const shares = matching.map(([code, d]) => [code, share(a, d, whole)] as [ProposedSettlementSplit['financialCategoryCode'], bigint]);
  const largest = matching.reduce((best, [, d], i) => (d > (matching[best]?.[1] ?? -1n) ? i : best), 0);
  const target = shares[largest];
  if (target !== undefined) target[1] += a - shares.reduce((total, [, cents]) => total + cents, 0n);
  return { splits: shares.filter(([, cents]) => cents !== 0n).map(([financialCategoryCode, cents]) => ({ financialCategoryCode, amount: eur(cents) })), flags };
}

/** What the comparison reads in one snapshot (§51), or why it cannot compare. */
export type ComparisonContext =
  | {
      readonly kind: 'FOUND';
      readonly statement: StatementView;
      readonly propertyReferenceId: string;
      readonly mea: Mea;
      readonly advances: readonly CountedWegSplit[];
      readonly settlements: readonly Settlement[];
      readonly uncountedTransactionIds: readonly string[];
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'STATEMENT_NOT_CONFIRMED'; readonly status: string };

/** What the settlement proposal reads in one snapshot (§51), or why it cannot propose. */
export type SettlementContext =
  | {
      readonly kind: 'FOUND';
      readonly transactionId: string;
      readonly amount: Money;
      readonly direction: 'INFLOW' | 'OUTFLOW';
      readonly alreadySplit: boolean;
      readonly comparison: Extract<ComparisonContext, { kind: 'FOUND' }>;
    }
  | { readonly kind: 'TRANSACTION_NOT_FOUND' }
  | { readonly kind: 'STATEMENT_NOT_FOUND' }
  | { readonly kind: 'NOT_PROPOSABLE'; readonly status: string }
  | { readonly kind: 'STATEMENT_NOT_CURRENT'; readonly status: string; readonly supersededBy: string | null };

import { centsOf, type BusinessDate, type Money } from '../../shared/index.js';
import type { LoanAllocationSet } from '../financing/index.js';
import type { HistoryRecord } from './attribution-history.js';
import { partMoved, partOn, type Part } from './attribution-part-rule.js';
import { recordedAfter } from './attribution-rule.js';
import type { InterestPeriod } from './loan-interest-periods.js';

/**
 * A split correction as an input of `PROPERTY_PART_CHANGED` (api-design.md §58I Part 2, VC-X-50; Entscheidung des
 * Projektinhabers, 2026-11-03, Fragen 5 und 6). A confirmed Transaction's splits move only by a correction: one
 * `Transaction` AuditRecord `CORRECTED` (with a replacement) or `REVERSED` (without) on the original. Before it the
 * original's splits count and the replacement does not exist; after it the replacement's splits count and the
 * original's do not. P's part of a split is §58G's (`ATTRIBUTED` with its amount when its PropertyReference is P; a
 * `LOAN_INTEREST` split by its Loan's `VALID` sets now, `partOn`; `NONE` otherwise or on the side it does not count).
 * The record is a change of P's view of `year` when it lies after 31 December of `year` and, for some financial category
 * and direction, the sum of P's parts of the splits whose tax year (§58A, derived now as if counting) is `year` differs
 * between the two sides (Frage 6: a PropertyReference, an amount, a category, a direction or a booking date across the
 * year's edge; a description alone moves no sum); its items are the splits whose state or part moved (`partMoved`).
 * Each step of a chain is judged alone. The history is consistent when the Transaction is `CORRECTED` now with exactly
 * one such record whose links are the Transaction's; otherwise `ATTRIBUTION_HISTORY_INCONSISTENT` with `Transaction`.
 */

/** A split of the original or of its replacement, with its tax year derived now as if it counted. */
export interface CorrectionSplit {
  readonly sourceId: string;
  readonly side: 'ORIGINAL' | 'REPLACEMENT';
  readonly taxYear: number;
  readonly financialCategoryCode: string;
  readonly direction: string;
  readonly amount: Money;
  readonly bookingDate: BusinessDate;
  readonly propertyReferenceId: string | null;
  readonly loanId: string | null;
  /** A `LOAN_INTEREST` split's Loan's `VALID` sets now (§58D); absent: none. */
  readonly loanSets?: readonly LoanAllocationSet[];
  /** §58L: a `LOAN_INTEREST` split's interest period by its own booking date and classification; absent or `null`: none. */
  readonly period?: InterestPeriod | null;
}

/** A `CORRECTED`/`REVERSED` record with its metadata's links and reason. */
export interface CorrectionRecord extends HistoryRecord {
  readonly reversalTransactionId: string | null;
  readonly replacementTransactionId: string | null;
  readonly reason: string | null;
}

/** A Transaction of the Realm whose own split or whose replacement's split can count in `year` for P. */
export interface CorrectionHistory {
  readonly transactionId: string;
  readonly status: string;
  /** The Transaction's links now (`correction_of_transaction_id` of its reversal and replacement). */
  readonly reversalTransactionId: string | null;
  readonly replacementTransactionId: string | null;
  readonly records: readonly CorrectionRecord[];
  readonly splits: readonly CorrectionSplit[];
}

/** One correction that changed P's sums of `year`: the record and every split whose part moved. */
export interface CorrectionStep {
  readonly kind: 'TRANSACTION_CORRECTED' | 'TRANSACTION_REVERSED';
  readonly history: CorrectionHistory;
  readonly record: CorrectionRecord;
  readonly splits: readonly { readonly sourceId: string; readonly before: Part; readonly after: Part }[];
}

const NONE: Part = { state: 'NONE', part: null };

/** P's part of a split on a side where it counts (§58G's states; §58D for a Loan's interest). */
export function splitPartOn(propertyReferenceId: string, split: CorrectionSplit): Part {
  if (split.loanId !== null)
    return split.financialCategoryCode === 'LOAN_INTEREST'
      ? partOn(propertyReferenceId, split.loanSets ?? [], { ...split, period: split.period ?? null })
      : NONE;
  return split.propertyReferenceId === propertyReferenceId ? { state: 'ATTRIBUTED', part: split.amount } : NONE;
}

/** The sums of the attributed parts per financial category and direction, in cents. */
function sums(parts: readonly { readonly split: CorrectionSplit; readonly part: Part }[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const { split, part } of parts) {
    if (part.state !== 'ATTRIBUTED') continue;
    const key = `${split.financialCategoryCode}/${split.direction}`;
    out.set(key, (out.get(key) ?? 0n) + centsOf(part.part as Money));
  }
  return out;
}

const sumsDiffer = (a: Map<string, bigint>, b: Map<string, bigint>) =>
  [...new Set([...a.keys(), ...b.keys()])].some((k) => (a.get(k) ?? 0n) !== (b.get(k) ?? 0n));

/** The record of a consistent history, or `undefined` (§58I Part 2 "The history"). */
export function correctionRecordOf(history: CorrectionHistory): CorrectionRecord | undefined {
  const [record, ...more] = history.records;
  if (history.status !== 'CORRECTED' || record === undefined || more.length > 0) return undefined;
  if (record.action !== 'CORRECTED' && record.action !== 'REVERSED') return undefined;
  const replacement = record.action === 'CORRECTED' ? record.replacementTransactionId : null;
  if (record.action === 'CORRECTED' && replacement === null) return undefined;
  if (record.reversalTransactionId === null || record.reversalTransactionId !== history.reversalTransactionId) return undefined;
  return replacement === history.replacementTransactionId ? record : undefined;
}

/**
 * Every correction of the candidates that changed P's sums of `year`, recorded after its 31 December; and the
 * Transactions whose history is unusable, named where a split of theirs is P's in `year` on its counting side.
 */
export function correctionSteps(
  corrections: readonly CorrectionHistory[] | undefined,
  year: number,
  propertyReferenceId: string,
): { steps: CorrectionStep[]; inconsistent: { readonly entityType: 'Transaction'; readonly entityId: string }[] } {
  const steps: CorrectionStep[] = [];
  const inconsistent: { readonly entityType: 'Transaction'; readonly entityId: string }[] = [];
  for (const history of [...(corrections ?? [])].sort((a, b) => (a.transactionId < b.transactionId ? -1 : 1))) {
    const candidates = history.splits.filter((s) => s.taxYear === year);
    const record = correctionRecordOf(history);
    if (record === undefined) {
      if (candidates.some((s) => splitPartOn(propertyReferenceId, s).state !== 'NONE'))
        inconsistent.push({ entityType: 'Transaction', entityId: history.transactionId });
      continue;
    }
    if (!recordedAfter(record.occurredAt, year)) continue;
    const parts = candidates.map((split) => {
      const own = splitPartOn(propertyReferenceId, split);
      return { split, before: split.side === 'ORIGINAL' ? own : NONE, after: split.side === 'REPLACEMENT' ? own : NONE };
    });
    const [before, after] = [sums(parts.map((p) => ({ split: p.split, part: p.before }))), sums(parts.map((p) => ({ split: p.split, part: p.after })))];
    if (!sumsDiffer(before, after)) continue;
    const moved = parts.filter((p) => partMoved(p.before, p.after));
    if (moved.length === 0) continue;
    steps.push({
      kind: record.action === 'CORRECTED' ? 'TRANSACTION_CORRECTED' : 'TRANSACTION_REVERSED',
      history,
      record,
      splits: moved.map((p) => ({ sourceId: p.split.sourceId, before: p.before, after: p.after })),
    });
  }
  return { steps, inconsistent };
}

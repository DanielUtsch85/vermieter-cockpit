import type { BusinessDate, RuleRegistry } from '../../shared/index.js';
import { firstIntervalOf, loanSchedule, type LoanAllocationSet, type SchedulePeriod } from '../financing/index.js';
import { replay, walk, type HistoryRecord, type LoanTermsHistory, type TermsHistory } from './attribution-history.js';
import { partMoved, partOn } from './attribution-part-rule.js';
import type { LoanSetsHistory, PartItem } from './attribution-parts.js';
import { recordedAfter } from './attribution-rule.js';
import { attributeTaxYear, interestTiming } from './cash-timing.js';
import { interestPeriodOf, type LoanPeriodFacts } from './loan-interest-periods.js';

/**
 * A Loan's terms record or closing as a part change (api-design.md §58P, VC-X-54; Entscheidung des Projektinhabers,
 * 2026-11-05, §58P Fragen 1–11, alle wie vorgeschlagen). Each `LoanTerms` `CREATED`/`VOIDED` and the Loan's `CLOSED`
 * AuditRecord recorded after 31 December of `year` (Europe/Berlin, for every record, also those before the deployment,
 * Frage 6) is judged alone (§58E Part 1): for each counting `LOAN_INTEREST` split of the Loan whose tax year is `year`
 * on both sides (a split whose year moves is the year kind's, not a part item, Frage 4), P's part is computed with the
 * split's interest period over that side's **contract** plan (§58L rule 1 with §58O's interval and precedence; §58O
 * question 12 (b): never the rebased plan), everything else as read now (the sets, `debtFrom`, the recorded
 * `interestPeriod` and `taxYear` override). A terms record reads the closing as now, the closing the terms as now. The
 * kinds by record action (Frage 1), voids count (Frage 2): `LOAN_TERMS_PART_ADDED`, `LOAN_TERMS_PART_VOIDED`,
 * `LOAN_CLOSED_PART`. No interest period in the items, the fingerprint is §58G's (Frage 8). The year kinds of §58E
 * Part 1 stay beside them (Frage 3).
 */

/** What §58P reads of a Loan beyond its sets: the terms with their records, the closing record and `debtFrom`. */
export interface LoanScheduleHistory {
  readonly loan: LoanTermsHistory['loan'];
  /** §41.1: the day the debt starts; no interest period begins before it. */
  readonly debtFrom: BusinessDate;
  /** Every terms period of the Loan (`VALID` and `VOID`) with its `CREATED`/`VOIDED` records. */
  readonly terms: readonly TermsHistory[];
  /** The Loan's `CLOSED` AuditRecords (at most one is consistent, §41.7). */
  readonly closing: readonly HistoryRecord[];
}

export type ScheduleKind = 'LOAN_TERMS_PART_ADDED' | 'LOAN_TERMS_PART_VOIDED' | 'LOAN_CLOSED_PART';

export interface ScheduleStep {
  readonly kind: ScheduleKind;
  readonly entityType: 'LoanTerms' | 'Loan';
  readonly entityId: string;
  readonly record: HistoryRecord;
  readonly keys:
    | { readonly loanId: string; readonly termsId: string; readonly validFrom: BusinessDate }
    | { readonly loanId: string; readonly closingDate: BusinessDate | null; readonly closingReason: string | null };
  /** Sorted by `sourceId` (all `TRANSACTION_SPLIT`). */
  readonly items: readonly PartItem[];
}

/**
 * What the interest period reads of one side's plan (§58L rule 1, §58O): the contract schedule of the given `VALID`
 * terms, cut at the closing of a `CLOSED` Loan (§41.7). Shared with the view's read (`loanPeriodFactsOf`), so both sides
 * and the view's own period are computed alike.
 */
export function planFactsOf(loan: LoanTermsHistory['loan'], debtFrom: BusinessDate, valid: readonly SchedulePeriod[]): LoanPeriodFacts {
  const periods = [...valid].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
  const schedule = loanSchedule(loan, periods);
  const intervalOf = new Map(periods.map((p) => [p.id as string, p.paymentIntervalMonths]));
  return {
    debtFrom,
    paymentDates: schedule.entries.map((e) => e.paymentDate),
    firstIntervalMonths: firstIntervalOf(schedule, periods),
    entryTerms: schedule.entries.map((e) => ({ termsId: e.termsId, paymentIntervalMonths: intervalOf.get(e.termsId) ?? 1 })),
    closingDate: loan.status === 'CLOSED' ? loan.closingDate : null,
  };
}

const byId = (a: { readonly sourceId: string }, b: { readonly sourceId: string }) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

/** §58P's steps of one Loan for P and `year`, and the terms and the Loan whose histories do not fit. */
export function scheduleSteps(
  loan: LoanSetsHistory,
  year: number,
  propertyReferenceId: string,
  registry: RuleRegistry | undefined,
): { steps: ScheduleStep[]; inconsistent: { readonly entityType: 'LoanTerms' | 'Loan'; readonly entityId: string }[] } {
  const history = loan.schedule;
  const steps: ScheduleStep[] = [];
  const inconsistent: { readonly entityType: 'LoanTerms' | 'Loan'; readonly entityId: string }[] = [];
  if (history === undefined) return { steps, inconsistent };
  const termsRecords = new Map<string, readonly HistoryRecord[] | undefined>();
  for (const t of [...history.terms].sort((a, b) => (a.period.id < b.period.id ? -1 : 1))) {
    const records = replay(t.records, 'CREATED', 'VOIDED', t.validNow);
    termsRecords.set(t.period.id, records);
    if (records === undefined) inconsistent.push({ entityType: 'LoanTerms', entityId: t.period.id });
  }
  // `CLOSED` is final (§41.7): a second record, or one on a Loan not closed, does not fit (as `closingChanges`).
  const closing = replay(history.closing, 'CLOSED', 'CLOSED_UNDONE', history.loan.status === 'CLOSED');
  if (closing === undefined) inconsistent.push({ entityType: 'Loan', entityId: loan.loanId });
  if (loan.candidates.length === 0) return { steps, inconsistent };
  if (registry === undefined) throw new Error('§58P: a terms record or closing is judged with the rule registry');
  const sets: LoanAllocationSet[] = loan.sets.filter((h) => h.set.status === 'VALID').map((h) => h.set);
  const sideOf = (l: LoanTermsHistory['loan'], terms: readonly TermsHistory[]) =>
    planFactsOf(
      l,
      history.debtFrom,
      terms.map((t) => t.period),
    );
  const itemsOf = (before: LoanPeriodFacts, after: LoanPeriodFacts): PartItem[] =>
    loan.candidates
      .flatMap((c): PartItem[] => {
        const split = { bookingDate: c.bookingDate, financialCategoryCode: c.financialCategoryCode ?? 'LOAN_INTEREST' };
        const yearOn = (facts: LoanPeriodFacts) =>
          attributeTaxYear(split, interestTiming(c.bookingDate, facts.paymentDates, facts.firstIntervalMonths ?? 1), c.taxYearOverride ?? null, registry)
            .taxYear;
        // Rule 5 (Frage 4): a split whose year moves is the year kind's, never a part item.
        if (yearOn(before) !== year || yearOn(after) !== year) return [];
        const partBy = (facts: LoanPeriodFacts) =>
          partOn(propertyReferenceId, sets, { ...c, period: interestPeriodOf(c.bookingDate, c.recordedPeriod ?? null, facts) });
        const [b, a] = [partBy(before), partBy(after)];
        if (!partMoved(b, a)) return [];
        return [
          {
            sourceType: 'TRANSACTION_SPLIT',
            sourceId: c.sourceId,
            taxYear: year,
            stateBefore: b.state,
            partBefore: b.part,
            stateAfter: a.state,
            partAfter: a.part,
          },
        ];
      })
      .sort(byId);
  // Each terms record alone, the terms just before and just after it, the closing as now.
  for (const step of walk(
    history.terms,
    (t) => t.period.id,
    (t) => termsRecords.get(t.period.id),
    (t) => t.validNow,
    'CREATED',
  )) {
    if (!recordedAfter(step.record.occurredAt, year)) continue;
    const items = itemsOf(sideOf(history.loan, step.before), sideOf(history.loan, step.after));
    if (items.length === 0) continue;
    const t = step.entity.period;
    steps.push({
      kind: step.record.action === 'CREATED' ? 'LOAN_TERMS_PART_ADDED' : 'LOAN_TERMS_PART_VOIDED',
      entityType: 'LoanTerms',
      entityId: t.id,
      record: step.record,
      keys: { loanId: loan.loanId, termsId: t.id, validFrom: t.validFrom },
      items,
    });
  }
  // The closing: the terms as now, the Loan without and with the closing.
  const [record] = closing ?? [];
  if (record !== undefined && recordedAfter(record.occurredAt, year)) {
    const valid = history.terms.filter((t) => t.validNow);
    const items = itemsOf(sideOf({ ...history.loan, status: 'ACTIVE', closingDate: null }, valid), sideOf(history.loan, valid));
    if (items.length > 0) {
      steps.push({
        kind: 'LOAN_CLOSED_PART',
        entityType: 'Loan',
        entityId: loan.loanId,
        record,
        keys: { loanId: loan.loanId, closingDate: history.loan.closingDate, closingReason: history.loan.closingReason ?? null },
        items,
      });
    }
  }
  return { steps, inconsistent };
}

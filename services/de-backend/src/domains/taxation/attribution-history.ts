import type { BusinessDate, RuleRegistry } from '../../shared/index.js';
import { loanSchedule, setOn, sumsToOne, type Loan, type LoanAllocationSetView, type SchedulePeriod } from '../financing/index.js';
import type { RentDueDay } from '../rental-contract-reference/index.js';
import { movedItems, recordedAfter, type ChangeKind, type InconsistentHistory, type RawChange } from './attribution-rule.js';
import { attributeTaxYear, interestTiming, rentTiming, type TimingInput } from './cash-timing.js';

/**
 * The widened kinds of `ATTRIBUTION_INPUT_CHANGED` (api-design.md §58E Part 1, §58C decision 8): a reconciliation
 * confirmed or released, a Loan terms period added or voided. The input, the Transaction's set of `CONFIRMED` pairs or
 * the Loan's `VALID` periods, is rebuilt from the entities' AuditRecords in `(occurred_at, id)` order; each record is a
 * change, judged alone with the input just before and just after it, everything else as read now. An entity whose
 * records do not end in its current row is `ATTRIBUTION_HISTORY_INCONSISTENT`: its records are unused and its current
 * state holds throughout.
 */

export interface HistoryRecord {
  readonly auditRecordId: string;
  readonly action: string;
  readonly occurredAt: Date;
}

/** A reconciliation of a candidate Transaction that is or was `CONFIRMED`, with its `CONFIRMED`/`RELEASED` records. */
export interface ReconciliationHistory {
  readonly reconciliationId: string;
  readonly transactionId: string;
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
  /** Its status now is `CONFIRMED`. */
  readonly confirmedNow: boolean;
  readonly records: readonly HistoryRecord[];
}

/** A counting rent split of the PropertyReference in a window whose Transaction has such a reconciliation. */
export interface ReconciliationCandidate {
  readonly sourceId: string;
  readonly transactionId: string;
  readonly bookingDate: BusinessDate;
  readonly financialCategoryCode: string;
  readonly taxYearOverride: number | null;
}

export interface ReconciliationInput {
  readonly candidates: readonly ReconciliationCandidate[];
  readonly reconciliations: readonly ReconciliationHistory[];
  /** The current `rentDueDays` of each Tenant's reference (the due day of a pair is the reference's current one). */
  readonly rentDueDays: readonly { readonly mreTenantId: string; readonly rentDueDays: readonly RentDueDay[] }[];
}

/** A terms period of a candidate Loan with its `CREATED`/`VOIDED` records. */
export interface TermsHistory {
  readonly period: SchedulePeriod;
  /** Its status now is `VALID`. */
  readonly validNow: boolean;
  readonly records: readonly HistoryRecord[];
}

/** A `LOAN_INTEREST` split of a candidate Loan in a window (§58D's candidates; which concern P is decided below). */
export interface LoanInterestCandidate {
  readonly sourceId: string;
  readonly bookingDate: BusinessDate;
  readonly financialCategoryCode: string;
  readonly taxYearOverride: number | null;
}

export interface LoanTermsHistory {
  readonly loanId: string;
  readonly loan: Pick<Loan, 'principalOriginal' | 'maturityDate' | 'status' | 'closingDate'>;
  readonly terms: readonly TermsHistory[];
  readonly candidates: readonly LoanInterestCandidate[];
  /** Every set of the Loan with `validUntil` (§41.3), to decide which candidates concern the PropertyReference. */
  readonly sets: readonly LoanAllocationSetView[];
}

const byRecord = (a: HistoryRecord, b: HistoryRecord) =>
  a.occurredAt.getTime() !== b.occurredAt.getTime() ? a.occurredAt.getTime() - b.occurredAt.getTime() : a.auditRecordId < b.auditRecordId ? -1 : 1;

/**
 * Replays one entity's records from "not there": `on` turns it on, `off` off, anything else does not fit. `undefined`
 * when a step does not fit or the end is not its state now.
 */
export function replay(records: readonly HistoryRecord[], on: string, off: string, now: boolean): readonly HistoryRecord[] | undefined {
  let state = false;
  const sorted = [...records].sort(byRecord);
  for (const r of sorted) {
    if (r.action === on && !state) state = true;
    else if (r.action === off && state) state = false;
    else return undefined;
  }
  return state === now ? sorted : undefined;
}

/**
 * Walks the merged records of a group of entities in `(occurred_at, id)` order; for each record, the set of entities on
 * just before and just after it. The inconsistent entities keep their state now throughout.
 */
export function walk<E>(
  entities: readonly E[],
  idOf: (e: E) => string,
  history: (e: E) => readonly HistoryRecord[] | undefined,
  now: (e: E) => boolean,
  on: string,
): { record: HistoryRecord; entity: E; before: E[]; after: E[] }[] {
  const steps: { record: HistoryRecord; entity: E }[] = [];
  const state = new Map<string, boolean>();
  for (const e of entities) {
    const records = history(e);
    state.set(idOf(e), records === undefined ? now(e) : false);
    for (const record of records ?? []) steps.push({ record, entity: e });
  }
  steps.sort((a, b) => byRecord(a.record, b.record));
  const onNow = () => entities.filter((e) => state.get(idOf(e)) === true);
  return steps.map(({ record, entity }) => {
    const before = onNow();
    state.set(idOf(entity), record.action === on);
    return { record, entity, before, after: onNow() };
  });
}

/** `RECONCILIATION_CONFIRMED`, `RECONCILIATION_RELEASED` (§58E Part 1), per Transaction. */
export function reconciliationChanges(
  input: ReconciliationInput,
  year: number,
  registry: RuleRegistry,
): { changes: RawChange[]; inconsistent: InconsistentHistory[] } {
  const changes: RawChange[] = [];
  const inconsistent: InconsistentHistory[] = [];
  const histories = new Map<string, readonly HistoryRecord[] | undefined>();
  for (const r of [...input.reconciliations].sort((a, b) => (a.reconciliationId < b.reconciliationId ? -1 : 1))) {
    const records = replay(r.records, 'CONFIRMED', 'RELEASED', r.confirmedNow);
    histories.set(r.reconciliationId, records);
    if (records === undefined) inconsistent.push({ entityType: 'RentPaymentReconciliation', entityId: r.reconciliationId });
  }
  const dueDays = new Map(input.rentDueDays.map((d) => [d.mreTenantId, d.rentDueDays]));
  // The Transaction's CONFIRMED pairs (§58A): one pair, the term's month and the current due day; none or several, no period.
  const timingOf = (confirmed: readonly ReconciliationHistory[]): TimingInput => {
    const pairs = new Map(confirmed.map((c) => [`${c.mreTenantId}/${c.mreRentTerm}`, c] as const));
    const [only] = pairs.values();
    if (only === undefined) return { kind: 'NO_ECONOMIC_PERIOD', reason: 'NO_RECONCILIATION' };
    if (pairs.size > 1) return { kind: 'NO_ECONOMIC_PERIOD', reason: 'SEVERAL_TERMS' };
    return rentTiming(only.mreRentTerm, dueDays.get(only.mreTenantId) ?? null);
  };
  for (const transactionId of [...new Set(input.candidates.map((c) => c.transactionId))].sort()) {
    const candidates = input.candidates.filter((c) => c.transactionId === transactionId);
    const own = input.reconciliations.filter((r) => r.transactionId === transactionId);
    for (const step of walk(
      own,
      (r) => r.reconciliationId,
      (r) => histories.get(r.reconciliationId),
      (r) => r.confirmedNow,
      'CONFIRMED',
    )) {
      if (!recordedAfter(step.record.occurredAt, year)) continue;
      const [before, after] = [timingOf(step.before), timingOf(step.after)];
      const items = movedItems(candidates, year, (c, side) => attributeTaxYear(c, side === 'BEFORE' ? before : after, c.taxYearOverride, registry).taxYear);
      if (items.length === 0) continue;
      const r = step.entity;
      changes.push({
        kind: (step.record.action === 'CONFIRMED' ? 'RECONCILIATION_CONFIRMED' : 'RECONCILIATION_RELEASED') satisfies ChangeKind,
        entityType: 'RentPaymentReconciliation',
        entityId: r.reconciliationId,
        auditRecordId: step.record.auditRecordId,
        amendedAt: step.record.occurredAt,
        keys: { reconciliationId: r.reconciliationId, transactionId: r.transactionId, mreTenantId: r.mreTenantId, mreRentTerm: r.mreRentTerm },
        items,
      });
    }
  }
  return { changes, inconsistent };
}

/**
 * Whether a split of the Loan concerns the PropertyReference (§58E Part 1, §58D): the set covering its booking date names
 * it, or the split is not attributed (no usable set) and the PropertyReference is among the `VALID` sets' entries.
 */
function concerns(propertyReferenceId: string, sets: readonly LoanAllocationSetView[], day: BusinessDate): boolean {
  const set = setOn(sets, day);
  if (set !== null && sumsToOne(set.allocations.map((a) => a.share))) return set.allocations.some((a) => a.propertyReferenceId === propertyReferenceId);
  return sets.some((s) => s.status === 'VALID' && s.allocations.some((a) => a.propertyReferenceId === propertyReferenceId));
}

/** `LOAN_TERMS_ADDED`, `LOAN_TERMS_VOIDED` (§58E Part 1), per Loan: the schedule derived per state of its periods. */
export function termsChanges(
  loans: readonly LoanTermsHistory[],
  year: number,
  registry: RuleRegistry,
  propertyReferenceId: string,
): { changes: RawChange[]; inconsistent: InconsistentHistory[] } {
  const changes: RawChange[] = [];
  const inconsistent: InconsistentHistory[] = [];
  for (const loan of [...loans].sort((a, b) => (a.loanId < b.loanId ? -1 : 1))) {
    const histories = new Map<string, readonly HistoryRecord[] | undefined>();
    for (const t of [...loan.terms].sort((a, b) => (a.period.id < b.period.id ? -1 : 1))) {
      const records = replay(t.records, 'CREATED', 'VOIDED', t.validNow);
      histories.set(t.period.id, records);
      if (records === undefined) inconsistent.push({ entityType: 'LoanTerms', entityId: t.period.id });
    }
    const candidates = loan.candidates.filter((c) => concerns(propertyReferenceId, loan.sets, c.bookingDate));
    if (candidates.length === 0) continue;
    const paymentDatesOf = (valid: readonly TermsHistory[]) =>
      loanSchedule(
        loan.loan,
        valid.map((t) => t.period).sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1)),
      ).entries.map((e) => e.paymentDate);
    for (const step of walk(
      loan.terms,
      (t) => t.period.id,
      (t) => histories.get(t.period.id),
      (t) => t.validNow,
      'CREATED',
    )) {
      if (!recordedAfter(step.record.occurredAt, year)) continue;
      const [before, after] = [paymentDatesOf(step.before), paymentDatesOf(step.after)];
      const items = movedItems(
        candidates,
        year,
        (c, side) => attributeTaxYear(c, interestTiming(c.bookingDate, side === 'BEFORE' ? before : after), c.taxYearOverride, registry).taxYear,
      );
      if (items.length === 0) continue;
      const t = step.entity.period;
      changes.push({
        kind: (step.record.action === 'CREATED' ? 'LOAN_TERMS_ADDED' : 'LOAN_TERMS_VOIDED') satisfies ChangeKind,
        entityType: 'LoanTerms',
        entityId: t.id,
        auditRecordId: step.record.auditRecordId,
        amendedAt: step.record.occurredAt,
        keys: { loanId: loan.loanId, termsId: t.id, validFrom: t.validFrom },
        items,
      });
    }
  }
  return { changes, inconsistent };
}

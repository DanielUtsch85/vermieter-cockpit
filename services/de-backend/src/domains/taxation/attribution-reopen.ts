import type { BusinessDate, Money } from '../../shared/index.js';
import type { HistoryRecord } from './attribution-history.js';
import { movedItems, recordedAfter, type ChangeKind, type InconsistentHistory, type RawChange } from './attribution-rule.js';
import { yearOf } from './cash-timing.js';

/**
 * A deposit reopened and closed anew as an input of `ATTRIBUTION_INPUT_CHANGED` (api-design.md §58I Part 1, VC-X-50;
 * Entscheidung des Projektinhabers, 2026-11-03, Fragen 1–3). A retained deposit's tax year is its closing date's
 * (§58A); between a reopen and the next closing it is in no year (`null`). The deposit's closing is replayed from its
 * `SecurityDeposit` AuditRecords in `(occurred_at, id)` order: `CLOSED` sets it from its metadata, `REOPENED` clears it,
 * `CREATED` starts without one, `VOIDED` keeps none, `AMENDED` leaves it. Each `CLOSED` and `REOPENED` record is a
 * change judged alone by §58E's rule (Frage 1), the first closing included (Frage 2); its year item names no source
 * type (Frage 3). Only deposits attributed to P now are candidates (`NOT_ATTRIBUTED` ↔ `NONE` moves no figure, §58G
 * Frage 3). A history that does not end in the deposit's status and closing now, or whose `REOPENED` clears another
 * closing than the one it follows, is `ATTRIBUTION_HISTORY_INCONSISTENT` with `SecurityDeposit`: its records unused.
 */

/** A closing as the records and the row carry it (§47.4); its retained amount is `retainedAmountOf`'s. */
export interface DepositClosingState {
  readonly closingDate: BusinessDate;
  readonly reason: string;
  readonly heldAtClosing: Money;
}

/** A `SecurityDeposit` record; `closing` is a `CLOSED` record's closing or a `REOPENED` record's `cleared`, else `null`. */
export interface DepositClosingRecord extends HistoryRecord {
  readonly closing: DepositClosingState | null;
}

/** A deposit of the Realm attributed to P now with at least one `CLOSED` record, its row now and its records. */
export interface DepositClosingHistory {
  readonly securityDepositId: string;
  readonly mreTenantId: string;
  readonly status: string;
  /** The row's closing now (`closing_date`, `closing_reason`, `held_at_closing`); `null` while not `CLOSED`. */
  readonly closing: DepositClosingState | null;
  readonly records: readonly DepositClosingRecord[];
}

const byRecord = (a: HistoryRecord, b: HistoryRecord) =>
  a.occurredAt.getTime() !== b.occurredAt.getTime() ? a.occurredAt.getTime() - b.occurredAt.getTime() : a.auditRecordId < b.auditRecordId ? -1 : 1;

const sameClosing = (a: DepositClosingState | null, b: DepositClosingState | null) =>
  a === null || b === null
    ? a === b
    : a.closingDate === b.closingDate &&
      a.reason === b.reason &&
      a.heldAtClosing.currency === b.heldAtClosing.currency &&
      a.heldAtClosing.equals(b.heldAtClosing);

/** The deposit's tax year under a closing (§58A, `retainedAmountOf` > 0); `null` in no year (Frage 1). */
export function closingYear(closing: DepositClosingState | null): number | null {
  if (closing === null || closing.reason === 'RETURNED' || !closing.heldAtClosing.isPositive()) return null;
  return yearOf(closing.closingDate);
}

/** One `CLOSED` or `REOPENED` record with the closing just before and just after it. */
export interface ClosingStep {
  readonly record: DepositClosingRecord;
  readonly before: DepositClosingState | null;
  readonly after: DepositClosingState | null;
}

/** The deposit's closing replayed from "no closing"; `undefined` when a step does not fit or the end is not the row's. */
export function replayClosing(deposit: DepositClosingHistory): ClosingStep[] | undefined {
  let state: DepositClosingState | null = null;
  const steps: ClosingStep[] = [];
  const sorted = [...deposit.records].sort(byRecord);
  for (const [index, r] of sorted.entries()) {
    if (r.action === 'CREATED') {
      if (index !== 0) return undefined;
    } else if (r.action === 'CLOSED') {
      // §47.4: only an ACTIVE deposit is closed, so a closing follows no closing.
      if (state !== null || r.closing === null) return undefined;
      steps.push({ record: r, before: null, after: r.closing });
      state = r.closing;
    } else if (r.action === 'REOPENED') {
      if (state === null || !sameClosing(r.closing, state)) return undefined;
      steps.push({ record: r, before: state, after: null });
      state = null;
    } else if (r.action === 'VOIDED') {
      if (state !== null) return undefined;
    } else if (r.action !== 'AMENDED') {
      return undefined;
    }
  }
  return sameClosing(state, deposit.status === 'CLOSED' ? deposit.closing : null) ? steps : undefined;
}

/**
 * `DEPOSIT_REOPENED`, `DEPOSIT_CLOSED` (§58I Part 1), per deposit: flagged when the two years differ (`null` a value),
 * one of them is `year` and the record lies after 31 December of `year`. An inconsistent history is named where it
 * concerns `year`: the deposit's year now, or the year of a closing one of its records names, is `year`.
 */
export function depositClosingChanges(deposits: readonly DepositClosingHistory[], year: number): { changes: RawChange[]; inconsistent: InconsistentHistory[] } {
  const changes: RawChange[] = [];
  const inconsistent: InconsistentHistory[] = [];
  for (const deposit of [...deposits].sort((a, b) => (a.securityDepositId < b.securityDepositId ? -1 : 1))) {
    const steps = replayClosing(deposit);
    if (steps === undefined) {
      const years = [deposit.status === 'CLOSED' ? closingYear(deposit.closing) : null, ...deposit.records.map((r) => closingYear(r.closing))];
      if (years.includes(year)) inconsistent.push({ entityType: 'SecurityDeposit', entityId: deposit.securityDepositId });
      continue;
    }
    for (const step of steps) {
      if (!recordedAfter(step.record.occurredAt, year)) continue;
      const items = movedItems([{ sourceId: deposit.securityDepositId }], year, (_, side) => closingYear(side === 'BEFORE' ? step.before : step.after));
      if (items.length === 0) continue;
      // The record's closing: the new one for CLOSED, the cleared one for REOPENED.
      const closing = (step.record.action === 'CLOSED' ? step.after : step.before) as DepositClosingState;
      changes.push({
        kind: (step.record.action === 'CLOSED' ? 'DEPOSIT_CLOSED' : 'DEPOSIT_REOPENED') satisfies ChangeKind,
        entityType: 'SecurityDeposit',
        entityId: deposit.securityDepositId,
        auditRecordId: step.record.auditRecordId,
        amendedAt: step.record.occurredAt,
        keys: { securityDepositId: deposit.securityDepositId, mreTenantId: deposit.mreTenantId, closingDate: closing.closingDate, reason: closing.reason },
        items,
      });
    }
  }
  return { changes, inconsistent };
}

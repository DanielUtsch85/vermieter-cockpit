import { canonicalJson, type BusinessDate, type Fingerprinter, type RuleRegistry } from '../../shared/index.js';
import type { ChangedEntry, RentDueDay } from '../rental-contract-reference/index.js';
import { closingChanges, reconciliationChanges, termsChanges, type LoanTermsHistory, type ReconciliationInput } from './attribution-history.js';
import { depositClosingChanges, type DepositClosingHistory } from './attribution-reopen.js';
import { movedItems, recordedAfter, type ChangeItem, type ChangeKind, type InconsistentHistory, type RawChange } from './attribution-rule.js';
import { attributeTaxYear, rentTiming } from './cash-timing.js';

export { CHANGE_KINDS, movedItems, recordedAfter } from './attribution-rule.js';
export type { ChangeEntityType, ChangeItem, ChangeKind, InconsistentHistory, RawChange } from './attribution-rule.js';

/**
 * `ATTRIBUTION_INPUT_CHANGED` (api-design.md §58C, §58E Part 1): an input of the attribution recorded after a year's end
 * moves the tax year of an item derived on read, and nothing per split records it. A *change* is one AuditRecord of such
 * an input; each candidate's year is computed with the input as it stood just before and just after the record,
 * everything else as read now, and the year is flagged when the two differ, one of them is the year and the record was
 * made after its 31 December (Europe/Berlin). The kinds: a RentalContractReference's `rentDueDays` created or amended
 * (here), a reconciliation confirmed or released, a Loan terms period added or voided and a Loan closed (§58H Part 1)
 * (`attribution-history.ts`), a deposit reopened or closed (§58I Part 1, `attribution-reopen.ts`).
 * Derived, never stored; a change is acknowledged by its fingerprint (§58E Part 2).
 */

/** One `AMENDED` AuditRecord of a reference with `changedEntries`. */
export interface ReferenceAmendment {
  readonly auditRecordId: string;
  readonly newVersion: number;
  /** The AuditRecord's `occurred_at`. */
  readonly amendedAt: Date;
  readonly changedEntries: readonly ChangedEntry[];
}

/** A RentalContractReference of the Realm with its history. */
export interface ReferenceHistory {
  readonly rentalContractReferenceId: string;
  readonly mreTenantId: string;
  /** The current list. */
  readonly rentDueDays: readonly RentDueDay[];
  /** The `CREATED` record's list; `null` without one. */
  readonly created: readonly RentDueDay[] | null;
  /** The `CREATED` record itself (§58E, decided 2026-11-02: a change of its own); absent or `null` without one. */
  readonly createdRecord?: { readonly auditRecordId: string; readonly createdAt: Date } | null;
  readonly amendments: readonly ReferenceAmendment[];
}

/**
 * A counting rent split (`RENT_BASE`, `RENT_OPERATING_COST_ADVANCE`) of the PropertyReference booked in a window at an
 * edge of the year, with its one `CONFIRMED` reconciliation term, and its classification's `taxYear` override.
 */
export interface AttributionCandidate {
  readonly sourceId: string;
  readonly bookingDate: BusinessDate;
  readonly financialCategoryCode: string;
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
  readonly taxYearOverride: number | null;
}

export interface AttributionInput {
  readonly references: readonly ReferenceHistory[];
  readonly candidates: readonly AttributionCandidate[];
  /** §58E: the reconciliations of the candidate Transactions with their AuditRecords; absent: none. */
  readonly reconciliations?: ReconciliationInput;
  /** §58E: the candidate Loans with their terms and AuditRecords; absent: none. */
  readonly loans?: readonly LoanTermsHistory[];
  /** §58I Part 1: the deposits attributed to P now with a `CLOSED` record, with their records; absent: none. */
  readonly deposits?: readonly DepositClosingHistory[];
}

export interface AttributionChange extends RawChange {
  /** SHA-256 of the canonical `{ propertyReferenceId, year, auditRecordId, kind, items }` (§58E Part 2). */
  readonly changeFingerprint: string;
}

export interface AttributionChanges {
  /** `ATTRIBUTION_INPUT_CHANGED`'s entries, by `amendedAt`, then `auditRecordId`. */
  readonly changes: readonly AttributionChange[];
  /** The entities whose history does not end in their current row (`ATTRIBUTION_HISTORY_INCONSISTENT`). */
  readonly inconsistent: readonly InconsistentHistory[];
}

const normalized = (days: readonly RentDueDay[]) =>
  JSON.stringify([...days].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0)).map((d) => [d.validFrom, d.day]));

/**
 * The list before an amendment: the list after it with each changed entry undone (`to` removed, `from` restored);
 * `undefined` when the list after does not hold the entry's `to` (the history does not fit).
 */
export function listBefore(after: readonly RentDueDay[], changed: readonly ChangedEntry[]): RentDueDay[] | undefined {
  const days = new Map(after.map((e) => [e.validFrom as string, e.day]));
  for (const entry of changed) {
    if ((days.get(entry.validFrom) ?? null) !== entry.to) return undefined;
    if (entry.from === null) days.delete(entry.validFrom);
    else days.set(entry.validFrom, entry.from);
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([validFrom, day]) => ({ validFrom: validFrom as BusinessDate, day }));
}

/**
 * The amendments of each reference with their lists before (B) and after (A), newest first, going back from the
 * current list; `undefined` when the oldest list reached is not the `CREATED` record's.
 */
export function amendmentLists(
  reference: ReferenceHistory,
): { readonly amendment: ReferenceAmendment; readonly before: readonly RentDueDay[]; readonly after: readonly RentDueDay[] }[] | undefined {
  const found: { amendment: ReferenceAmendment; before: readonly RentDueDay[]; after: readonly RentDueDay[] }[] = [];
  let after: readonly RentDueDay[] = reference.rentDueDays;
  for (const amendment of [...reference.amendments].sort((a, b) => b.newVersion - a.newVersion)) {
    const before = listBefore(after, amendment.changedEntries);
    if (before === undefined) return undefined;
    found.push({ amendment, before, after });
    after = before;
  }
  if (reference.created === null || normalized(reference.created) !== normalized(after)) return undefined;
  return found;
}

/**
 * The `rentDueDays` kinds (§58E Part 1): each amendment with `changedEntries` (an evidence-only amend has none and is no
 * change, decided 2026-11-02, 237-4), and the `CREATED` record against no reference at all (decided 2026-11-02).
 */
function rentDueDayChanges(input: AttributionInput, year: number, registry: RuleRegistry): { changes: RawChange[]; inconsistent: InconsistentHistory[] } {
  const changes: RawChange[] = [];
  const inconsistent: InconsistentHistory[] = [];
  for (const reference of [...input.references].sort((a, b) => (a.rentalContractReferenceId < b.rentalContractReferenceId ? -1 : 1))) {
    const lists = amendmentLists(reference);
    if (lists === undefined) {
      inconsistent.push({ entityType: 'RentalContractReference', entityId: reference.rentalContractReferenceId });
      continue;
    }
    const candidates = input.candidates.filter((c) => c.mreTenantId === reference.mreTenantId);
    const judge = (
      kind: ChangeKind,
      auditRecordId: string,
      at: Date,
      changedEntries: readonly ChangedEntry[],
      before: readonly RentDueDay[] | null,
      after: readonly RentDueDay[],
    ) => {
      if (!recordedAfter(at, year)) return;
      const items = movedItems(
        candidates,
        year,
        (c, side) => attributeTaxYear(c, rentTiming(c.mreRentTerm, side === 'BEFORE' ? before : after), c.taxYearOverride, registry).taxYear,
      );
      if (items.length === 0) return;
      const id = reference.rentalContractReferenceId;
      changes.push({
        kind,
        entityType: 'RentalContractReference',
        entityId: id,
        auditRecordId,
        amendedAt: at,
        keys: { rentalContractReferenceId: id, changedEntries },
        items,
      });
    };
    const record = reference.createdRecord ?? null;
    if (record !== null) {
      const created = reference.created ?? [];
      // Before the reference there is no due day for any term (§58F: the booking year, PROPOSED_BY_10_DAY_RULE).
      const entries = created.map((e) => ({ validFrom: e.validFrom, from: null, to: e.day }));
      judge('RENT_DUE_DAYS_CREATED', record.auditRecordId, record.createdAt, entries, null, created);
    }
    for (const { amendment, before, after } of [...lists].reverse()) {
      judge('RENT_DUE_DAYS_AMENDED', amendment.auditRecordId, amendment.amendedAt, amendment.changedEntries, before, after);
    }
  }
  return { changes, inconsistent };
}

/** The change fingerprint (§58E Part 2): SHA-256 of the canonical JSON, the items by `sourceId`; ids as stored (lower-case). */
export function changeFingerprint(
  fingerprinter: Fingerprinter,
  change: {
    readonly propertyReferenceId: string;
    readonly year: number;
    readonly auditRecordId: string;
    /** A kind of §58E Part 1, or §58N's `OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER` (no items). */
    readonly kind: ChangeKind | 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER';
    readonly items: readonly ChangeItem[];
  },
): string {
  const items = [...change.items]
    .map((i) => ({ sourceId: i.sourceId.toLowerCase(), yearBefore: i.yearBefore, yearAfter: i.yearAfter }))
    .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  return fingerprinter.sha256Hex(
    canonicalJson({
      propertyReferenceId: change.propertyReferenceId.toLowerCase(),
      year: change.year,
      auditRecordId: change.auditRecordId.toLowerCase(),
      kind: change.kind,
      items,
    }),
  );
}

/**
 * Every change of `year` (§58E Part 1), each judged alone by the one rule, with its fingerprint; and the entities whose
 * history is unusable. Entries by `amendedAt`, then `auditRecordId`.
 */
export function attributionChanges(
  input: AttributionInput,
  year: number,
  registry: RuleRegistry,
  context: { readonly propertyReferenceId: string; readonly fingerprinter: Fingerprinter },
): AttributionChanges {
  const rent = rentDueDayChanges(input, year, registry);
  const reconciliations =
    input.reconciliations === undefined ? { changes: [], inconsistent: [] } : reconciliationChanges(input.reconciliations, year, registry);
  const terms = termsChanges(input.loans ?? [], year, registry, context.propertyReferenceId);
  // §58H Part 1: a Loan closed after the year's end.
  const closings = closingChanges(input.loans ?? [], year, registry, context.propertyReferenceId);
  // §58I Part 1: a deposit reopened or closed after the year's end.
  const deposits = depositClosingChanges(input.deposits ?? [], year);
  const raw = [...rent.changes, ...reconciliations.changes, ...terms.changes, ...closings.changes, ...deposits.changes].sort((a, b) =>
    a.amendedAt.getTime() !== b.amendedAt.getTime() ? a.amendedAt.getTime() - b.amendedAt.getTime() : a.auditRecordId < b.auditRecordId ? -1 : 1,
  );
  return {
    changes: raw.map((c) => ({
      ...c,
      changeFingerprint: changeFingerprint(context.fingerprinter, {
        propertyReferenceId: context.propertyReferenceId,
        year,
        auditRecordId: c.auditRecordId,
        kind: c.kind,
        items: c.items,
      }),
    })),
    inconsistent: [...rent.inconsistent, ...reconciliations.inconsistent, ...terms.inconsistent, ...closings.inconsistent, ...deposits.inconsistent],
  };
}

/** A change with the `ACTIVE` acknowledgement that matches it (§58E Part 2), or `null`. */
export type MarkedChange = AttributionChange & { readonly acknowledgement: unknown };

/** A change's keys in a flag (§58E "The flag, additively"): the kind, the entity, the kind's keys, the record, the fingerprint, the acknowledgement. */
export function changeKeys(change: MarkedChange) {
  return {
    kind: change.kind,
    entityType: change.entityType,
    entityId: change.entityId,
    ...change.keys,
    auditRecordId: change.auditRecordId,
    amendedAt: change.amendedAt.toISOString(),
    changeFingerprint: change.changeFingerprint,
    acknowledgement: change.acknowledgement,
  };
}

/** A change as an entry of the year flag `ATTRIBUTION_INPUT_CHANGED`: its keys and the items it moves. */
export const changeEntry = (change: MarkedChange) => ({ ...changeKeys(change), items: change.items });

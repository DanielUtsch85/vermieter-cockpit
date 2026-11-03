import { canonicalJson, centsOf, moneyOfCents, type BusinessDate, type Fingerprinter, type Money, type MoneyJson } from '../../shared/index.js';
import { distribute, setOn, sumsToOne, withValidUntil, type LoanAllocationSet } from '../financing/index.js';
import { replay, walk, type HistoryRecord } from './attribution-history.js';
import { recordedAfter } from './attribution-rule.js';

/**
 * `PROPERTY_PART_CHANGED` (api-design.md §58G, VC-X-48): a Loan allocation set appended with a `validFrom` in the past,
 * or the last set voided, re-attributes interest already booked between the views of the sets' PropertyReferences; the
 * item's tax year stays (§58D decision 4). A *part change* is one `LoanAllocationSet` AuditRecord: for each counting
 * `LOAN_INTEREST` split of `year` of a Loan any of whose sets names P, P's part is computed with the Loan's `VALID` sets
 * just before and just after the record (everything else as read now), and P's view of `year` is flagged when the part
 * differs and the record lies after 31 December of `year` (§58E's 31-December rule). A step between `NOT_ATTRIBUTED` and
 * `NONE` moves no figure of P and is no change; every other step is (Entscheidung des Projektinhabers, 2026-11-03,
 * Frage 3). One code for every input that moves a part between views (Frage 1). Derived, never stored; acknowledged by
 * its fingerprint with §58E's routes (Frage 2).
 */

export const PROPERTY_PART_CHANGED = 'PROPERTY_PART_CHANGED';
export const PART_CHANGE_KINDS = ['LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED'] as const;
export type PartChangeKind = (typeof PART_CHANGE_KINDS)[number];
export type PartChangeEntityType = 'LoanAllocationSet';
export const PART_STATES = ['ATTRIBUTED', 'NOT_ATTRIBUTED', 'NONE'] as const;
export type PartState = (typeof PART_STATES)[number];

export const isPartKind = (kind: string): kind is PartChangeKind => (PART_CHANGE_KINDS as readonly string[]).includes(kind);

/** One item a part change moved (§58G "The flag"): P's state and part on both sides; a part exactly on `ATTRIBUTED`. */
export interface PartItem {
  readonly sourceType: 'TRANSACTION_SPLIT';
  readonly sourceId: string;
  readonly taxYear: number;
  readonly stateBefore: PartState;
  readonly partBefore: Money | null;
  readonly stateAfter: PartState;
  readonly partAfter: Money | null;
}

/** A counting `LOAN_INTEREST` split of the Loan whose tax year (§58A, derived now) is the view's. */
export interface PartCandidate {
  readonly sourceId: string;
  readonly bookingDate: BusinessDate;
  /** The split's whole amount, distributed over the set as the view does (`distribute`). */
  readonly amount: Money;
}

/** A set of the Loan (`VALID` or `VOID`) with its `CREATED`/`VOIDED` records. */
export interface AllocationSetHistory {
  readonly set: LoanAllocationSet;
  readonly records: readonly HistoryRecord[];
}

/** A Loan any of whose sets names the PropertyReference, with its candidates of `year` and every set's history. */
export interface LoanSetsHistory {
  readonly loanId: string;
  readonly candidates: readonly PartCandidate[];
  readonly sets: readonly AllocationSetHistory[];
}

export interface PartChangeInput {
  readonly loans: readonly LoanSetsHistory[];
}

export interface PartChange {
  readonly kind: PartChangeKind;
  readonly entityType: PartChangeEntityType;
  readonly entityId: string;
  readonly auditRecordId: string;
  readonly amendedAt: Date;
  readonly keys: { readonly loanId: string; readonly allocationSetId: string; readonly validFrom: BusinessDate };
  readonly items: readonly PartItem[];
  /** SHA-256 of the canonical `{ propertyReferenceId, year, auditRecordId, kind, items }`, parts as exact cents (§58G). */
  readonly changeFingerprint: string;
}

export interface PartChanges {
  readonly changes: readonly PartChange[];
  /** The sets whose records do not end in their current status (`ATTRIBUTION_HISTORY_INCONSISTENT`). */
  readonly inconsistent: readonly { readonly entityType: PartChangeEntityType; readonly entityId: string }[];
}

interface Part {
  readonly state: PartState;
  readonly part: Money | null;
}

/**
 * P's part of a split under the Loan's `VALID` sets of one side (§58G's table, §58D's three cases): the set covering the
 * booking date (`validUntil` derived over these sets), usable when its shares sum to `1/1`, P's part by `distribute`
 * over the whole set; without a usable set `NOT_ATTRIBUTED` while a set of the side names P; else `NONE`.
 */
export function partOn(propertyReferenceId: string, valid: readonly LoanAllocationSet[], candidate: PartCandidate): Part {
  const sets = withValidUntil(valid.map((s) => ({ ...s, status: 'VALID' as const })));
  const set = setOn(sets, candidate.bookingDate);
  if (set !== null && sumsToOne(set.allocations.map((a) => a.share))) {
    const index = set.allocations.findIndex((a) => a.propertyReferenceId === propertyReferenceId);
    if (index < 0) return { state: 'NONE', part: null };
    const cents = distribute(centsOf(candidate.amount), set.allocations)[index] as bigint;
    return { state: 'ATTRIBUTED', part: moneyOfCents(cents, candidate.amount.currency) };
  }
  return sets.some((s) => s.allocations.some((a) => a.propertyReferenceId === propertyReferenceId))
    ? { state: 'NOT_ATTRIBUTED', part: null }
    : { state: 'NONE', part: null };
}

/** Whether P's part moved: the states differ (not between `NOT_ATTRIBUTED` and `NONE`), or both attributed with other amounts. */
export function partMoved(before: Part, after: Part): boolean {
  if (before.state !== after.state) return before.state === 'ATTRIBUTED' || after.state === 'ATTRIBUTED';
  return before.state === 'ATTRIBUTED' && centsOf(before.part as Money) !== centsOf(after.part as Money);
}

const byIdentity = (a: PartItem, b: PartItem) =>
  a.sourceType !== b.sourceType ? (a.sourceType < b.sourceType ? -1 : 1) : a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;

/** The part change's fingerprint (§58G): the items by `sourceType`, then `sourceId`, ids lower-case, parts as cents. */
export function partChangeFingerprint(
  fingerprinter: Fingerprinter,
  change: {
    readonly propertyReferenceId: string;
    readonly year: number;
    readonly auditRecordId: string;
    readonly kind: PartChangeKind;
    readonly items: readonly PartItem[];
  },
): string {
  const items = [...change.items].map((i) => ({ ...i, sourceId: i.sourceId.toLowerCase() })).sort(byIdentity);
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

/** Every part change of `year` for the PropertyReference, each judged alone; entries by `amendedAt`, then `auditRecordId`. */
export function partChanges(
  input: PartChangeInput | undefined,
  year: number,
  context: { readonly propertyReferenceId: string; readonly fingerprinter: Fingerprinter },
): PartChanges {
  const changes: PartChange[] = [];
  const inconsistent: PartChanges['inconsistent'][number][] = [];
  const pr = context.propertyReferenceId;
  for (const loan of [...(input?.loans ?? [])].sort((a, b) => (a.loanId < b.loanId ? -1 : 1))) {
    const histories = new Map<string, readonly HistoryRecord[] | undefined>();
    for (const h of [...loan.sets].sort((a, b) => (a.set.id < b.set.id ? -1 : 1))) {
      const records = replay(h.records, 'CREATED', 'VOIDED', h.set.status === 'VALID');
      histories.set(h.set.id, records);
      if (records === undefined) inconsistent.push({ entityType: 'LoanAllocationSet', entityId: h.set.id });
    }
    if (loan.candidates.length === 0) continue;
    for (const step of walk(
      loan.sets,
      (h) => h.set.id,
      (h) => histories.get(h.set.id),
      (h) => h.set.status === 'VALID',
      'CREATED',
    )) {
      if (!recordedAfter(step.record.occurredAt, year)) continue;
      const [before, after] = [step.before.map((h) => h.set), step.after.map((h) => h.set)];
      const items = loan.candidates.flatMap((c): PartItem[] => {
        const [b, a] = [partOn(pr, before, c), partOn(pr, after, c)];
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
      });
      if (items.length === 0) continue;
      const set = step.entity.set;
      const kind: PartChangeKind = step.record.action === 'CREATED' ? 'LOAN_ALLOCATION_SET_ADDED' : 'LOAN_ALLOCATION_SET_VOIDED';
      const sorted = [...items].sort(byIdentity);
      changes.push({
        kind,
        entityType: 'LoanAllocationSet',
        entityId: set.id,
        auditRecordId: step.record.auditRecordId,
        amendedAt: step.record.occurredAt,
        keys: { loanId: loan.loanId, allocationSetId: set.id, validFrom: set.validFrom },
        items: sorted,
        changeFingerprint: partChangeFingerprint(context.fingerprinter, {
          propertyReferenceId: pr,
          year,
          auditRecordId: step.record.auditRecordId,
          kind,
          items: sorted,
        }),
      });
    }
  }
  changes.sort((a, b) =>
    a.amendedAt.getTime() !== b.amendedAt.getTime() ? a.amendedAt.getTime() - b.amendedAt.getTime() : a.auditRecordId < b.auditRecordId ? -1 : 1,
  );
  return { changes, inconsistent };
}

/** A part change with the `ACTIVE` acknowledgement that matches it, or `null`. */
export type MarkedPartChange = PartChange & { readonly acknowledgement: unknown };

const moneyJson = (m: Money | null): MoneyJson | null => (m === null ? null : m.toJSON());

/** An item in the part shape as the view and the DTO show it (Money as `{ amount, currency }`). */
export const partItemJson = (i: PartItem) => ({
  sourceType: i.sourceType,
  sourceId: i.sourceId,
  taxYear: i.taxYear,
  stateBefore: i.stateBefore,
  partBefore: moneyJson(i.partBefore),
  stateAfter: i.stateAfter,
  partAfter: moneyJson(i.partAfter),
});

const partChangeKeys = (c: MarkedPartChange) => ({
  kind: c.kind,
  entityType: c.entityType,
  entityId: c.entityId,
  ...c.keys,
  auditRecordId: c.auditRecordId,
  amendedAt: c.amendedAt.toISOString(),
  changeFingerprint: c.changeFingerprint,
  acknowledgement: c.acknowledgement,
});

/** A change as an entry of the year flag `PROPERTY_PART_CHANGED`: its keys and the items it moved. */
export const partChangeEntry = (c: MarkedPartChange) => ({ ...partChangeKeys(c), items: c.items.map(partItemJson) });

/** The item flag on an item now in P's view that a change moved: one entry per such change, with the item's two parts. */
export function partItemFlags(sourceId: string, changes: readonly MarkedPartChange[]): { code: string; details: unknown }[] {
  const moved = changes.flatMap((c) =>
    c.items
      .filter((i) => i.sourceId === sourceId)
      .map((i) => ({
        ...partChangeKeys(c),
        stateBefore: i.stateBefore,
        partBefore: moneyJson(i.partBefore),
        stateAfter: i.stateAfter,
        partAfter: moneyJson(i.partAfter),
      })),
  );
  return moved.length === 0 ? [] : [{ code: PROPERTY_PART_CHANGED, details: moved }];
}

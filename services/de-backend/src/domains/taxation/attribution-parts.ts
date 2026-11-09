import { canonicalJson, type BusinessDate, type Fingerprinter, type Money, type MoneyJson, type RuleRegistry } from '../../shared/index.js';
import type { LoanAllocationSet } from '../financing/index.js';
import { partMoved, partOn, type PartState } from './attribution-part-rule.js';
import { correctionSteps, type CorrectionHistory } from './attribution-corrections.js';
import type { InterestPeriod } from './loan-interest-periods.js';
import { depositSteps, type DepositPartHistory } from './attribution-deposits.js';
import { scheduleSteps, type LoanScheduleHistory } from './attribution-loan-schedule-parts.js';
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
 * its fingerprint with §58E's routes (Frage 2). §58H Part 2 (VC-X-49) adds the deposit's PropertyReference moving with a
 * reconciliation confirmed or released (`attribution-deposits.ts`; Entscheidung des Projektinhabers, 2026-11-03, §58H
 * Frage 2): the kinds `DEPOSIT_RECONCILIATION_CONFIRMED`, `DEPOSIT_RECONCILIATION_RELEASED`, items `DEPOSIT_CLOSING`.
 * §58I Part 2 (VC-X-50) adds the split correction (`attribution-corrections.ts`; Entscheidung des Projektinhabers,
 * 2026-11-03, §58I Fragen 5 und 6): the kinds `TRANSACTION_CORRECTED`, `TRANSACTION_REVERSED`, items `TRANSACTION_SPLIT`.
 * §58P (VC-X-54) adds a Loan's terms record and closing (`attribution-loan-schedule-parts.ts`; Entscheidung des
 * Projektinhabers, 2026-11-05, §58P Fragen 1–11): the kinds `LOAN_TERMS_PART_ADDED`, `LOAN_TERMS_PART_VOIDED`,
 * `LOAN_CLOSED_PART`, items `TRANSACTION_SPLIT`.
 */

export const PROPERTY_PART_CHANGED = 'PROPERTY_PART_CHANGED';
export const PART_CHANGE_KINDS = [
  'LOAN_ALLOCATION_SET_ADDED',
  'LOAN_ALLOCATION_SET_VOIDED',
  'DEPOSIT_RECONCILIATION_CONFIRMED',
  'DEPOSIT_RECONCILIATION_RELEASED',
  'TRANSACTION_CORRECTED',
  'TRANSACTION_REVERSED',
  'LOAN_TERMS_PART_ADDED',
  'LOAN_TERMS_PART_VOIDED',
  'LOAN_CLOSED_PART',
] as const;
export type PartChangeKind = (typeof PART_CHANGE_KINDS)[number];
export type PartChangeEntityType = 'LoanAllocationSet' | 'RentPaymentReconciliation' | 'Transaction' | 'LoanTerms' | 'Loan';

export { PART_STATES, partMoved, partOn } from './attribution-part-rule.js';
export type { Part, PartState } from './attribution-part-rule.js';

export const isPartKind = (kind: string): kind is PartChangeKind => (PART_CHANGE_KINDS as readonly string[]).includes(kind);

/** One item a part change moved (§58G "The flag"): P's state and part on both sides; a part exactly on `ATTRIBUTED`. */
export interface PartItem {
  /** A Loan's interest split (§58G) or any split a correction moved (§58I), or a deposit closing (§58H). */
  readonly sourceType: 'TRANSACTION_SPLIT' | 'DEPOSIT_CLOSING';
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
  /** The split's whole amount, distributed over the sets as the view does (`distributeOverPeriod`). */
  readonly amount: Money;
  /** §58L: the split's interest period as the view reads it; `null` without one (rule 8). */
  readonly period: InterestPeriod | null;
  /** §58P: the classification's recorded `interestPeriod` (VC-X-40), whatever the plan says; absent: none. */
  readonly recordedPeriod?: { readonly from: BusinessDate; readonly until: BusinessDate } | null;
  /** §58P: the split's category and `taxYear` override, for its year on each side (§58A); absent: `LOAN_INTEREST`, none. */
  readonly financialCategoryCode?: string;
  readonly taxYearOverride?: number | null;
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
  /** §58P: the Loan's terms and closing histories and `debtFrom`; absent: no terms record or closing is judged. */
  readonly schedule?: LoanScheduleHistory;
}

export interface PartChangeInput {
  readonly loans: readonly LoanSetsHistory[];
  /** §58H Part 2: the counting deposit closings of the Realm in `year` with their Tenants' reconciliations; absent: none. */
  readonly deposits?: readonly DepositPartHistory[];
  /** §58I Part 2: the Realm's corrected Transactions with a split (original or replacement) that can count in `year` for P. */
  readonly corrections?: readonly CorrectionHistory[];
}

export interface PartChange {
  readonly kind: PartChangeKind;
  readonly entityType: PartChangeEntityType;
  readonly entityId: string;
  readonly auditRecordId: string;
  readonly amendedAt: Date;
  /** The kind's own keys: the set's (§58G), the reconciliation's and the deposits' (§58H Part 2), or the correction's (§58I). */
  readonly keys:
    | { readonly loanId: string; readonly allocationSetId: string; readonly validFrom: BusinessDate }
    | {
        readonly reconciliationId: string;
        readonly transactionId: string;
        readonly mreTenantId: string;
        readonly mreRentTerm: string;
        readonly securityDepositIds: readonly string[];
      }
    | {
        readonly transactionId: string;
        readonly reversalTransactionId: string | null;
        readonly replacementTransactionId: string | null;
        readonly reason: string | null;
      }
    | { readonly loanId: string; readonly termsId: string; readonly validFrom: BusinessDate }
    | { readonly loanId: string; readonly closingDate: BusinessDate | null; readonly closingReason: string | null };
  readonly items: readonly PartItem[];
  /** SHA-256 of the canonical `{ propertyReferenceId, year, auditRecordId, kind, items }`, parts as exact cents (§58G). */
  readonly changeFingerprint: string;
}

export interface PartChanges {
  readonly changes: readonly PartChange[];
  /** The sets whose records do not end in their current status (`ATTRIBUTION_HISTORY_INCONSISTENT`). */
  readonly inconsistent: readonly { readonly entityType: PartChangeEntityType; readonly entityId: string }[];
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
  context: { readonly propertyReferenceId: string; readonly fingerprinter: Fingerprinter; readonly registry?: RuleRegistry },
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
    // §58P: the Loan's terms records and closing, each one change with the parts it moved.
    const schedule = scheduleSteps(loan, year, pr, context.registry);
    inconsistent.push(...schedule.inconsistent);
    for (const step of schedule.steps) {
      changes.push({
        kind: step.kind,
        entityType: step.entityType,
        entityId: step.entityId,
        auditRecordId: step.record.auditRecordId,
        amendedAt: step.record.occurredAt,
        keys: step.keys,
        items: step.items,
        changeFingerprint: partChangeFingerprint(context.fingerprinter, {
          propertyReferenceId: pr,
          year,
          auditRecordId: step.record.auditRecordId,
          kind: step.kind,
          items: step.items,
        }),
      });
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
  // §58H Part 2: the deposits' PropertyReference, one change per record of a Tenant's reconciliations.
  const deposits = depositSteps(input?.deposits, year, pr);
  for (const step of deposits.steps) {
    const items = step.deposits
      .filter((d) => partMoved(d.before, d.after))
      .map((d): PartItem => ({
        sourceType: 'DEPOSIT_CLOSING',
        sourceId: d.securityDepositId,
        taxYear: year,
        stateBefore: d.before.state,
        partBefore: d.before.part,
        stateAfter: d.after.state,
        partAfter: d.after.part,
      }))
      .sort(byIdentity);
    if (items.length === 0) continue;
    const r = step.reconciliation;
    changes.push({
      kind: step.kind,
      entityType: 'RentPaymentReconciliation',
      entityId: r.reconciliationId,
      auditRecordId: step.record.auditRecordId,
      amendedAt: step.record.occurredAt,
      keys: {
        reconciliationId: r.reconciliationId,
        transactionId: r.transactionId,
        mreTenantId: step.mreTenantId,
        mreRentTerm: r.mreRentTerm,
        securityDepositIds: items.map((i) => i.sourceId),
      },
      items,
      changeFingerprint: partChangeFingerprint(context.fingerprinter, {
        propertyReferenceId: pr,
        year,
        auditRecordId: step.record.auditRecordId,
        kind: step.kind,
        items,
      }),
    });
  }
  inconsistent.push(...deposits.inconsistent);
  // §58I Part 2: one change per correction that changed P's sums of `year`.
  const corrections = correctionSteps(input?.corrections, year, pr);
  for (const step of corrections.steps) {
    const items = step.splits
      .map((d): PartItem => ({
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: d.sourceId,
        taxYear: year,
        stateBefore: d.before.state,
        partBefore: d.before.part,
        stateAfter: d.after.state,
        partAfter: d.after.part,
      }))
      .sort(byIdentity);
    const h = step.history;
    changes.push({
      kind: step.kind,
      entityType: 'Transaction',
      entityId: h.transactionId,
      auditRecordId: step.record.auditRecordId,
      amendedAt: step.record.occurredAt,
      keys: {
        transactionId: h.transactionId,
        reversalTransactionId: step.record.reversalTransactionId,
        replacementTransactionId: step.kind === 'TRANSACTION_CORRECTED' ? step.record.replacementTransactionId : null,
        reason: step.record.reason,
      },
      items,
      changeFingerprint: partChangeFingerprint(context.fingerprinter, {
        propertyReferenceId: pr,
        year,
        auditRecordId: step.record.auditRecordId,
        kind: step.kind,
        items,
      }),
    });
  }
  inconsistent.push(...corrections.inconsistent);
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

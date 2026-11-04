import { addDays, type BusinessDate, type Fingerprinter } from '../../shared/index.js';
import { changeFingerprint } from './attribution-changes.js';

/**
 * `OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER` in the tax-year view (api-design.md §58N; Entscheidung des Projektinhabers,
 * 2026-11-04, §58N Frage 5): an Acquisition of the PropertyReference whose `economicTransferDate` was recorded later
 * than its Ownerships began (`ownershipStart`, the contract date). Between the two days nobody gets AfA (§59A: the
 * buyers' start is the transfer, a seller's tenure ends on `contractDate − 1`). The year flag names it in every year the
 * gap `[ownershipStart, economicTransferDate − 1]` touches. Its entry is `OPEN` when a seller of the Acquisition holds a
 * part of an AfA component of the PropertyReference in the Realm (a `VALID` Ownership carrying another, not cancelled
 * Acquisition), `INFORMATIVE` otherwise; an `OPEN` entry is closed by an acknowledgement of §58E Part 2 with the kind
 * `OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER` (the change is the record `ECONOMIC_TRANSFER_DATE_RECORDED`, it moves no
 * item). Derived, never stored.
 */

export const OWNERSHIP_START_FLAG = 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER';
export type OwnershipStartKind = typeof OWNERSHIP_START_FLAG;

/** One Acquisition of the PropertyReference dated by the command, its dates differing (read in the caller's snapshot). */
export interface OwnershipStartFact {
  readonly acquisitionId: string;
  readonly ownershipStart: BusinessDate;
  readonly economicTransferDate: BusinessDate;
  readonly sellerHasAfaComponent: boolean;
  /** The `ECONOMIC_TRANSFER_DATE_RECORDED` AuditRecord. */
  readonly auditRecordId: string;
  readonly recordedAt: Date;
}

export interface OwnershipStartChange {
  readonly kind: OwnershipStartKind;
  readonly entityType: 'Acquisition';
  readonly entityId: string;
  readonly auditRecordId: string;
  readonly amendedAt: Date;
  readonly keys: { readonly acquisitionId: string; readonly ownershipStart: BusinessDate; readonly economicTransferDate: BusinessDate };
  readonly level: 'OPEN' | 'INFORMATIVE';
  /** Always empty: the change moves no item (0067's shape guard refuses any). */
  readonly items: readonly never[];
  readonly changeFingerprint: string;
}

const yearOf = (d: BusinessDate) => Number(d.slice(0, 4));

/** The facts whose gap touches `year`, as changes with their fingerprints (§58E Part 2), by `acquisitionId`. */
export function ownershipStartChanges(
  facts: readonly OwnershipStartFact[] | undefined,
  year: number,
  context: { readonly propertyReferenceId: string; readonly fingerprinter: Fingerprinter },
): OwnershipStartChange[] {
  return [...(facts ?? [])]
    .filter((f) => f.economicTransferDate > f.ownershipStart)
    .filter((f) => yearOf(f.ownershipStart) <= year && year <= yearOf(addDays(f.economicTransferDate, -1)))
    .sort((a, b) => (a.acquisitionId < b.acquisitionId ? -1 : a.acquisitionId > b.acquisitionId ? 1 : 0))
    .map((f) => ({
      kind: OWNERSHIP_START_FLAG,
      entityType: 'Acquisition',
      entityId: f.acquisitionId,
      auditRecordId: f.auditRecordId,
      amendedAt: f.recordedAt,
      keys: { acquisitionId: f.acquisitionId, ownershipStart: f.ownershipStart, economicTransferDate: f.economicTransferDate },
      level: f.sellerHasAfaComponent ? 'OPEN' : 'INFORMATIVE',
      items: [],
      changeFingerprint: changeFingerprint(context.fingerprinter, {
        propertyReferenceId: context.propertyReferenceId,
        year,
        auditRecordId: f.auditRecordId,
        kind: OWNERSHIP_START_FLAG,
        items: [],
      }),
    }));
}

/** The year flag's entry (§58N): the keys, the level, the record, the fingerprint and the matching acknowledgement. */
export const ownershipStartEntry = (change: OwnershipStartChange & { readonly acknowledgement: unknown }) => ({
  ...change.keys,
  level: change.level,
  auditRecordId: change.auditRecordId,
  recordedAt: change.amendedAt.toISOString(),
  changeFingerprint: change.changeFingerprint,
  acknowledgement: change.acknowledgement,
});

/** Open while an `OPEN` entry has no matching acknowledgement; informative otherwise. */
export function ownershipStartIsOpen(details: unknown): boolean {
  if (!Array.isArray(details)) return true;
  return details.some((e) => {
    const entry = e as { level?: unknown; acknowledgement?: unknown } | null;
    return entry?.level === 'OPEN' && entry.acknowledgement == null;
  });
}

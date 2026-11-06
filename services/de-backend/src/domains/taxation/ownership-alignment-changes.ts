import { addDays, type BusinessDate, type Fingerprinter } from '../../shared/index.js';
import { changeFingerprint } from './attribution-changes.js';
import { recordedAfter } from './attribution-rule.js';

/**
 * `OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER` in the tax-year view (api-design.md §58Q open question 7; Entscheidung des
 * Projektinhabers, 2026-11-05, Frage 7: „Jahresflag `OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER`, offen nach dem 31.12.,
 * Quittierung mit neuem Kind.“): an Acquisition of the PropertyReference whose Ownerships §58Q's act aligned to the
 * transfer. The act moves the owners' parts of every item in the former gap `[contractDate, economicTransferDate − 1]`
 * and the seller's AfA, in years that may have ended, and no change kind covers Ownership records. The flag names it in
 * every year the former gap touches; its entry is `OPEN` when the act lies after that year's 31 December
 * (Europe/Berlin), `INFORMATIVE` otherwise, and an `OPEN` entry is closed by an acknowledgement of §58E Part 2 with the
 * kind `OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER` (the change is the record `OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER`,
 * `items: []`, 0072's shape guard refuses any). Derived, never stored.
 */

export const OWNERSHIP_EXTENDED_FLAG = 'OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER';
export type OwnershipAlignmentKind = typeof OWNERSHIP_EXTENDED_FLAG;

/** One aligned Acquisition of the PropertyReference (read in the caller's snapshot). */
export interface OwnershipAlignmentFact {
  readonly acquisitionId: string;
  /** The former `ownershipStart` (§58N (b)): the first day of the former gap. */
  readonly contractDate: BusinessDate;
  readonly economicTransferDate: BusinessDate;
  /** The `OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER` AuditRecord. */
  readonly auditRecordId: string;
  /** The act's time (`ownershipAlignedAt`). */
  readonly alignedAt: Date;
}

export interface OwnershipAlignmentChange {
  readonly kind: OwnershipAlignmentKind;
  readonly entityType: 'Acquisition';
  readonly entityId: string;
  readonly auditRecordId: string;
  readonly amendedAt: Date;
  readonly keys: { readonly acquisitionId: string; readonly contractDate: BusinessDate; readonly economicTransferDate: BusinessDate };
  readonly level: 'OPEN' | 'INFORMATIVE';
  /** Always empty: the change is named by its record, not by items (0072's shape guard refuses any). */
  readonly items: readonly never[];
  readonly changeFingerprint: string;
}

const yearOf = (d: BusinessDate) => Number(d.slice(0, 4));

/** The facts whose former gap touches `year`, as changes with their fingerprints (§58E Part 2), by `acquisitionId`. */
export function ownershipAlignmentChanges(
  facts: readonly OwnershipAlignmentFact[] | undefined,
  year: number,
  context: { readonly propertyReferenceId: string; readonly fingerprinter: Fingerprinter },
): OwnershipAlignmentChange[] {
  return [...(facts ?? [])]
    .filter((f) => f.economicTransferDate > f.contractDate)
    .filter((f) => yearOf(f.contractDate) <= year && year <= yearOf(addDays(f.economicTransferDate, -1)))
    .sort((a, b) => (a.acquisitionId < b.acquisitionId ? -1 : a.acquisitionId > b.acquisitionId ? 1 : 0))
    .map((f) => ({
      kind: OWNERSHIP_EXTENDED_FLAG,
      entityType: 'Acquisition',
      entityId: f.acquisitionId,
      auditRecordId: f.auditRecordId,
      amendedAt: f.alignedAt,
      keys: { acquisitionId: f.acquisitionId, contractDate: f.contractDate, economicTransferDate: f.economicTransferDate },
      level: recordedAfter(f.alignedAt, year) ? 'OPEN' : 'INFORMATIVE',
      items: [],
      changeFingerprint: changeFingerprint(context.fingerprinter, {
        propertyReferenceId: context.propertyReferenceId,
        year,
        auditRecordId: f.auditRecordId,
        kind: OWNERSHIP_EXTENDED_FLAG,
        items: [],
      }),
    }));
}

/** The year flag's entry: the keys, the level, the record, the fingerprint and the matching acknowledgement. */
export const ownershipAlignmentEntry = (change: OwnershipAlignmentChange & { readonly acknowledgement: unknown }) => ({
  ...change.keys,
  level: change.level,
  auditRecordId: change.auditRecordId,
  alignedAt: change.amendedAt.toISOString(),
  changeFingerprint: change.changeFingerprint,
  acknowledgement: change.acknowledgement,
});

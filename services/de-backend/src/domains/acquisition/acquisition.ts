import type { AuditActor, BusinessDate, Money, VersionConflict } from '../../shared/index.js';

/**
 * Acquisition (data-model.md §13, api-design.md §27.1, backlog VC-2-05): the purchase of a share of a PropertyReference.
 * Its status is a workflow (`DRAFT` → `CONFIRMED` / `CANCELLED`, both final); the legal milestones are dates
 * (phase-2-plan P2-D6). It never creates or changes Ownerships; they link it by `acquisitionId` (P2-D8).
 */

export type AcquisitionId = string & { readonly __brand: 'AcquisitionId' };

export const ACQUISITION_STATUSES = ['DRAFT', 'CONFIRMED', 'CANCELLED'] as const;
export type AcquisitionStatus = (typeof ACQUISITION_STATUSES)[number];

/** The acquired share of the PropertyReference: a reduced fraction, as an Ownership share (P2-D3). */
export interface AcquiredShare {
  readonly numerator: number;
  readonly denominator: number;
}

export interface AcquisitionData {
  readonly propertyReferenceId: string;
  /** > 0, in the Realm's currency (EUR in Phase 2). */
  readonly purchasePrice: Money;
  readonly acquiredShare: AcquiredShare;
  readonly contractDate: BusinessDate;
  readonly economicTransferDate: BusinessDate | null;
  readonly landRegistryTransferDate: BusinessDate | null;
  readonly buyerPartyIds: readonly string[];
  readonly sellerPartyIds: readonly string[];
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

export interface Acquisition extends AcquisitionData {
  readonly id: AcquisitionId;
  readonly mreRealmId: string;
  readonly status: AcquisitionStatus;
  readonly cancelledAt: Date | null;
  readonly cancellationReason: string | null;
  readonly confirmedAt: Date | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A validated, normalized Acquisition about to be created. */
export interface NewAcquisition extends AcquisitionData {
  readonly mreRealmId: string;
}

/** The transfer date: `economicTransferDate`, or `contractDate` while that is unset (P2-D6). */
export function transferDate(acquisition: Pick<AcquisitionData, 'contractDate' | 'economicTransferDate'>): BusinessDate {
  return acquisition.economicTransferDate ?? acquisition.contractDate;
}

/** Identity of a create request for `Idempotency-Key` replays: the normalized payload. */
export function createFingerprint(acquisition: NewAcquisition): string {
  return JSON.stringify([
    acquisition.propertyReferenceId,
    acquisition.purchasePrice.amount,
    acquisition.purchasePrice.currency,
    acquisition.acquiredShare.numerator,
    acquisition.acquiredShare.denominator,
    acquisition.contractDate,
    acquisition.economicTransferDate,
    acquisition.landRegistryTransferDate,
    acquisition.buyerPartyIds,
    acquisition.sellerPartyIds,
    acquisition.sourceReferences,
    acquisition.notes,
  ]);
}

export type CancelPlan =
  | { readonly kind: 'CANCEL'; readonly next: Acquisition }
  /** Already cancelled: a 200 no-op whatever the reason or version; the first reason and time stay. */
  | { readonly kind: 'UNCHANGED' }
  /** Confirmed is final (→ 409 ACQUISITION_CONFIRMED). */
  | { readonly kind: 'ACQUISITION_CONFIRMED' }
  /** `VALID` Ownerships still carry its id: void them first (→ 409, review on #46). */
  | { readonly kind: 'ACQUISITION_HAS_VALID_OWNERSHIPS'; readonly ownershipIds: readonly string[] };

export function planCancel(current: Acquisition, reason: string, at: Date, validOwnershipIds: readonly string[]): CancelPlan {
  if (current.status === 'CANCELLED') return { kind: 'UNCHANGED' };
  if (current.status === 'CONFIRMED') return { kind: 'ACQUISITION_CONFIRMED' };
  if (validOwnershipIds.length > 0) return { kind: 'ACQUISITION_HAS_VALID_OWNERSHIPS', ownershipIds: [...validOwnershipIds].sort() };
  return { kind: 'CANCEL', next: { ...current, status: 'CANCELLED', cancelledAt: at, cancellationReason: reason, version: current.version + 1 } };
}

export type CreateAcquisitionOutcome =
  | { readonly kind: 'CREATED'; readonly acquisition: Acquisition }
  | { readonly kind: 'REPLAYED'; readonly acquisition: Acquisition }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND' }
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | { readonly kind: 'PARTY_INACTIVE'; readonly partyId: string };

export type CancelAcquisitionOutcome =
  | { readonly kind: 'CANCELLED'; readonly acquisition: Acquisition; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<CancelPlan, { kind: 'CANCEL' | 'UNCHANGED' }>
  | VersionConflict;

export interface AcquisitionFilter {
  readonly status?: AcquisitionStatus;
  readonly propertyReferenceId?: string;
  /** Buyer or seller. */
  readonly partyId?: string;
}

export interface AcquisitionPage {
  readonly items: readonly Acquisition[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface AcquisitionRepository {
  /**
   * In one READ COMMITTED transaction: claims the key, checks the PropertyReference, locks the Parties `FOR SHARE` in
   * id order (a buyer cannot turn inactive meanwhile), writes the draft with its parties and an AuditRecord.
   */
  create(
    acquisition: NewAcquisition,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateAcquisitionOutcome>;
  findById(id: string, mreRealmId: string): Promise<Acquisition | undefined>;
  /** Ordered by `contractDate` (newest first), `createdAt` (newest first), id; count and page in one snapshot. */
  list(mreRealmId: string, filter: AcquisitionFilter, page: { readonly page: number; readonly pageSize: number }): Promise<AcquisitionPage>;
  /**
   * Locks in the order of every Ownership writer (PropertyReference, then the Acquisition `FOR UPDATE`), reads the
   * `VALID` Ownerships carrying its id, then applies `planCancel`; the version is checked only when it changes.
   */
  cancel(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<CancelAcquisitionOutcome>;
}

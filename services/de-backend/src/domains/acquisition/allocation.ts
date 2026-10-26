import { RoundingMode, type AuditActor, type BusinessDate, type Money } from '../../shared/index.js';
import type { AcquisitionStatus } from './acquisition.js';

/**
 * Land/building allocation (data-model.md §15, api-design.md §27.3, phase-2-plan P2-D9): recorded as entered, never
 * computed from price and costs; `land + building = total` exactly; a correction is a new allocation that supersedes
 * the current one, which keeps its data. At most one is current per Acquisition.
 */

export const ALLOCATION_METHODS = ['PURCHASE_CONTRACT', 'BMF_TOOL', 'APPRAISAL', 'ADVISOR', 'OTHER'] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

/** data-model §6.7 without `SUGGESTED`, which is reserved for machine suggestions. */
export const ALLOCATION_REVIEW_STATES = ['UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'ADVISOR_CONFIRMED'] as const;
export type AllocationReviewState = (typeof ALLOCATION_REVIEW_STATES)[number];

export interface AllocationData {
  readonly totalAllocableAmount: Money;
  readonly landAmount: Money;
  readonly buildingAmount: Money;
  readonly method: AllocationMethod;
  readonly reviewState: AllocationReviewState;
  /** `null`: the Acquisition's transfer date (P2-D6), resolved when stored. */
  readonly effectiveDate: BusinessDate | null;
  readonly advisorPartyId: string | null;
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
  /** The current allocation this one replaces; `null` for the first. */
  readonly supersedes: string | null;
}

export interface NewAllocation extends AllocationData {
  readonly mreRealmId: string;
  readonly acquisitionId: string;
}

export interface LandBuildingAllocation extends Omit<AllocationData, 'effectiveDate' | 'supersedes'> {
  readonly id: string;
  readonly mreRealmId: string;
  readonly acquisitionId: string;
  readonly effectiveDate: BusinessDate;
  readonly supersedesId: string | null;
  readonly supersededAt: Date | null;
  /** Derived: the allocation whose `supersedesId` names this one (no stored back-pointer, review on #52). */
  readonly supersededById: string | null;
  readonly current: boolean;
  readonly createdAt: Date;
}

/** `part / total` as a §87 decimal string, rounded half-even to four places; for display only. */
export function shareOf(part: Money, total: Money): string {
  return part.toExactDecimal().dividedBy(total.toExactDecimal(), 4, RoundingMode.HALF_EVEN).toFixed(4);
}

export type AllocationRefusal =
  | { readonly kind: 'ACQUISITION_CANCELLED' }
  /** `supersedes` does not name the current allocation (→ 409 CURRENT_ALLOCATION_CHANGED). */
  | { readonly kind: 'CURRENT_ALLOCATION_CHANGED'; readonly currentAllocationId: string | null };

/** The checks of §27.3 after the 404s; `undefined` = the allocation may be written. */
export function checkAllocation(acquisitionStatus: AcquisitionStatus, currentId: string | null, supersedes: string | null): AllocationRefusal | undefined {
  if (acquisitionStatus === 'CANCELLED') return { kind: 'ACQUISITION_CANCELLED' };
  if (supersedes !== currentId) return { kind: 'CURRENT_ALLOCATION_CHANGED', currentAllocationId: currentId };
  return undefined;
}

/** Identity of a create for `Idempotency-Key` replays: the Acquisition and the normalized payload. */
export function allocationFingerprint(a: NewAllocation): string {
  return JSON.stringify([
    a.acquisitionId,
    a.totalAllocableAmount.amount,
    a.landAmount.amount,
    a.buildingAmount.amount,
    a.totalAllocableAmount.currency,
    a.method,
    a.reviewState,
    a.effectiveDate,
    a.advisorPartyId,
    a.sourceReferences,
    a.notes,
    a.supersedes,
  ]);
}

export type CreateAllocationOutcome =
  | { readonly kind: 'CREATED'; readonly allocation: LandBuildingAllocation }
  | { readonly kind: 'REPLAYED'; readonly allocation: LandBuildingAllocation }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'ACQUISITION_NOT_FOUND' }
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | AllocationRefusal;

/** Persistence port, implemented in infrastructure/postgres; scoped to the Realm. */
export interface LandBuildingAllocationRepository {
  /**
   * One READ COMMITTED transaction: claims the key, writes the Acquisition row (the serialising no-op of §27.2), reads
   * the current allocation, checks, sets the old one's `supersededAt`, inserts the new one, writes the AuditRecords.
   */
  create(allocation: NewAllocation, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateAllocationOutcome>;
  /** The current allocation and the history, newest first, in one snapshot; `undefined` for an unknown Acquisition. */
  list(
    acquisitionId: string,
    mreRealmId: string,
  ): Promise<{ readonly current: LandBuildingAllocation | null; readonly items: readonly LandBuildingAllocation[] } | undefined>;
}

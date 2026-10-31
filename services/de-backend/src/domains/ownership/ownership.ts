import { type AuditActor, type BusinessDate, type VersionConflict } from '../../shared/index.js';
import { ZERO, compareToOne, sumShares, type Fraction, type Share } from './share.js';

/**
 * Ownership (data-model.md §12, api-design.md §26.1, backlog VC-2-03): a Party holds a share of a PropertyReference
 * for a period of inclusive business dates. A close only sets or shortens the period (a real change); a void marks
 * a recording error, which then counts nowhere (phase-2-plan P2-D4).
 */

export type OwnershipId = string & { readonly __brand: 'OwnershipId' };

export const OWNERSHIP_STATUSES = ['VALID', 'VOID'] as const;
export type OwnershipStatus = (typeof OWNERSHIP_STATUSES)[number];

export interface Ownership {
  readonly id: OwnershipId;
  readonly mreRealmId: string;
  readonly propertyReferenceId: string;
  readonly ownerPartyId: string;
  readonly share: Share;
  readonly validFrom: BusinessDate;
  readonly validUntil: BusinessDate | null;
  readonly status: OwnershipStatus;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  /** The Acquisition the Ownership results from (P2-D8); set at creation, fixed afterwards. */
  readonly acquisitionId: string | null;
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A validated, normalized Ownership about to be created (share reduced, texts trimmed). */
export interface NewOwnership {
  readonly mreRealmId: string;
  readonly propertyReferenceId: string;
  readonly ownerPartyId: string;
  readonly share: Share;
  readonly validFrom: BusinessDate;
  readonly validUntil: BusinessDate | null;
  /** A `DRAFT` Acquisition of the same Realm and PropertyReference, or null (§27.1). */
  readonly acquisitionId: string | null;
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

/** Identity of a create request for `Idempotency-Key` replays: the normalized payload, share reduced. */
export function createFingerprint(ownership: NewOwnership): string {
  return JSON.stringify([
    ownership.propertyReferenceId,
    ownership.ownerPartyId,
    ownership.share.numerator,
    ownership.share.denominator,
    ownership.validFrom,
    ownership.validUntil,
    ownership.acquisitionId,
    ownership.sourceReferences,
    ownership.notes,
  ]);
}

/** A period of inclusive business dates; `until` null is open-ended. ISO dates compare as strings. */
interface Period {
  readonly from: BusinessDate;
  readonly until: BusinessDate | null;
}

const covers = (period: Period, day: BusinessDate) => period.from <= day && (period.until === null || day <= period.until);
const overlaps = (a: Period, b: Period) => (a.until === null || b.from <= a.until) && (b.until === null || a.from <= b.until);
const periodOf = (o: Pick<Ownership, 'validFrom' | 'validUntil'>): Period => ({ from: o.validFrom, until: o.validUntil });

export type InvariantViolation =
  | { readonly kind: 'OVERLAPPING_OWNERSHIP'; readonly ownershipId: OwnershipId }
  | { readonly kind: 'OWNERSHIP_TOTAL_EXCEEDS_ONE'; readonly date: BusinessDate; readonly shareSum: Fraction };

/**
 * The rules of §26.1 for a new period among the PropertyReference's Ownerships (`VOID` ones are ignored): no overlap
 * with the same owner, then no day above 1. A day's sum only rises where a period starts, so the new period's
 * `validFrom` and every other start inside it are the days to check.
 */
export function checkInvariants(
  existing: readonly Ownership[],
  candidate: { readonly ownerPartyId: string; readonly share: Share; readonly validFrom: BusinessDate; readonly validUntil: BusinessDate | null },
): InvariantViolation | undefined {
  const valid = existing.filter((o) => o.status === 'VALID');
  const period = periodOf(candidate);
  const overlap = valid.find((o) => o.ownerPartyId === candidate.ownerPartyId && overlaps(periodOf(o), period));
  if (overlap !== undefined) return { kind: 'OVERLAPPING_OWNERSHIP', ownershipId: overlap.id };
  const days = [...new Set([candidate.validFrom, ...valid.map((o) => o.validFrom).filter((day) => covers(period, day))])].sort();
  for (const day of days) {
    const shareSum = sumShares([candidate.share, ...valid.filter((o) => covers(periodOf(o), day)).map((o) => o.share)]);
    if (compareToOne(shareSum) > 0) return { kind: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', date: day, shareSum };
  }
  return undefined;
}

export type Completeness = 'COMPLETE' | 'INCOMPLETE' | 'NONE';

export interface OwnershipDay {
  readonly asOf: BusinessDate;
  readonly completeness: Completeness;
  readonly shareSum: Fraction;
  /** The `VALID` Ownerships covering the day, by `validFrom`, then id. */
  readonly items: readonly Ownership[];
}

/** The ownership of a PropertyReference on one day; completeness is derived, never stored (P2-D4). */
export function ownershipOn(ownerships: readonly Ownership[], asOf: BusinessDate): OwnershipDay {
  const items = ownerships
    .filter((o) => o.status === 'VALID' && covers(periodOf(o), asOf))
    .sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (items.length === 0) return { asOf, completeness: 'NONE', shareSum: ZERO, items };
  const shareSum = sumShares(items.map((o) => o.share));
  return { asOf, completeness: compareToOne(shareSum) === 0 ? 'COMPLETE' : 'INCOMPLETE', shareSum, items };
}

/** Why a close is refused (`422 INVALID_OWNERSHIP`, the reasons of P2-D5). */
export type InvalidOwnershipReason = 'VOID' | 'STARTS_ON_OR_AFTER_EFFECTIVE_DATE' | 'ALREADY_ENDED';

export type ClosePlan =
  | { readonly kind: 'CLOSE'; readonly next: Ownership }
  /** Already ends on that day: a 200 no-op whatever the version. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'INVALID_OWNERSHIP'; readonly reason: InvalidOwnershipReason };

/** Sets or shortens `validUntil`; history before it stays, and a close never extends a period (§26.1). */
export function planClose(current: Ownership, validUntil: BusinessDate): ClosePlan {
  if (current.status === 'VOID') return { kind: 'INVALID_OWNERSHIP', reason: 'VOID' };
  if (validUntil < current.validFrom) return { kind: 'INVALID_OWNERSHIP', reason: 'STARTS_ON_OR_AFTER_EFFECTIVE_DATE' };
  if (current.validUntil === validUntil) return { kind: 'UNCHANGED' };
  if (current.validUntil !== null && current.validUntil < validUntil) return { kind: 'INVALID_OWNERSHIP', reason: 'ALREADY_ENDED' };
  return { kind: 'CLOSE', next: { ...current, validUntil, version: current.version + 1 } };
}

export type VoidPlan =
  | { readonly kind: 'VOID'; readonly next: Ownership }
  /** Already void: a 200 no-op whatever the reason or version; the first reason and time stay. */
  | { readonly kind: 'UNCHANGED' };

export function planVoid(current: Ownership, reason: string, at: Date): VoidPlan {
  if (current.status === 'VOID') return { kind: 'UNCHANGED' };
  return { kind: 'VOID', next: { ...current, status: 'VOID', voidedAt: at, voidReason: reason, version: current.version + 1 } };
}

export type CreateOwnershipOutcome =
  | { readonly kind: 'CREATED'; readonly ownership: Ownership }
  | { readonly kind: 'REPLAYED'; readonly ownership: Ownership }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND' }
  | { readonly kind: 'PARTY_NOT_FOUND' }
  | { readonly kind: 'PARTY_INACTIVE' }
  | AcquisitionRefusal
  | PredecessorRefusal
  | InvariantViolation;

/** The `acquisitionId` of a create or change names no Acquisition of this PropertyReference, or no draft (§27.1). */
export type AcquisitionRefusal =
  | { readonly kind: 'ACQUISITION_NOT_FOUND'; readonly acquisitionId: string }
  | { readonly kind: 'ACQUISITION_NOT_DRAFT'; readonly acquisitionId: string; readonly status: string };

/**
 * The row ends the day before the owner's `VALID` Ownership `ownershipId`, which carries the `CONFIRMED` Acquisition
 * `acquisitionId`: voiding it, shortening it or recording it would move that purchase's confirmed increase
 * (§28.1A; → 409 ACQUISITION_CONFIRMED).
 */
export interface PredecessorRefusal {
  readonly kind: 'PREDECESSOR_OF_CONFIRMED';
  readonly acquisitionId: string;
  readonly ownershipId: string;
}

export type CloseOwnershipOutcome =
  | { readonly kind: 'CLOSED'; readonly ownership: Ownership; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'INVALID_OWNERSHIP'; readonly reason: InvalidOwnershipReason }
  | PredecessorRefusal
  | VersionConflict;

export type VoidOwnershipOutcome =
  | { readonly kind: 'VOIDED'; readonly ownership: Ownership; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  /** It carries a `CONFIRMED` Acquisition: close it instead (→ 409 ACQUISITION_CONFIRMED, §28.1). */
  | { readonly kind: 'ACQUISITION_CONFIRMED'; readonly acquisitionId: string }
  | PredecessorRefusal
  | VersionConflict;

export interface OwnershipPage {
  readonly items: readonly Ownership[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface OwnershipRepository {
  /**
   * In one READ COMMITTED transaction: claims the key, touches the PropertyReference (serialising writers of it),
   * locks the owner `FOR SHARE`, checks `checkInvariants` and inserts. A refusal rolls everything back.
   */
  create(ownership: NewOwnership, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateOwnershipOutcome>;
  findById(id: string, mreRealmId: string): Promise<Ownership | undefined>;
  /** Applies `planClose` under the row lock; the version is checked only when it changes. */
  close(id: string, mreRealmId: string, validUntil: BusinessDate, actor: AuditActor, expectedVersions?: readonly number[]): Promise<CloseOwnershipOutcome>;
  /** Applies `planVoid` under the row lock; a no-op answers whatever the version. */
  void(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidOwnershipOutcome>;
  /** The PropertyReference's `VALID` Ownerships covering a day; undefined for an unknown or foreign PropertyReference. */
  on(propertyReferenceId: string, mreRealmId: string, asOf: BusinessDate): Promise<OwnershipDay | undefined>;
  /** The full history, `VOID` included, by `validFrom`, `createdAt`, id; count and page in one snapshot. */
  history(propertyReferenceId: string, mreRealmId: string, page: { readonly page: number; readonly pageSize: number }): Promise<OwnershipPage | undefined>;
}

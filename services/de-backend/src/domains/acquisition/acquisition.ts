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

/** An exact fraction (reduced), as an Ownership share sum. */
export interface ExactFraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** An Ownership as the confirmation reads it (§28.1). */
export interface ConfirmationOwnership {
  readonly id: string;
  readonly ownerPartyId: string;
  readonly share: AcquiredShare;
  readonly validFrom: BusinessDate;
}

/** A failed requirement of §28.1, in the order they are reported. */
export type ConfirmationViolation =
  | { readonly code: 'BUYER_INACTIVE'; readonly partyId: string }
  | { readonly code: 'OWNERSHIP_NOT_FROM_TRANSFER_DATE'; readonly ownershipId: string; readonly validFrom: BusinessDate; readonly transferDate: BusinessDate }
  | { readonly code: 'OWNER_NOT_A_BUYER'; readonly ownershipId: string; readonly ownerPartyId: string }
  | { readonly code: 'BUYER_WITHOUT_OWNERSHIP'; readonly partyId: string }
  | { readonly code: 'SHARE_SUM_MISMATCH'; readonly expected: ExactFraction; readonly actual: ExactFraction }
  | { readonly code: 'OWNERSHIP_INCOMPLETE'; readonly date: BusinessDate; readonly shareSum: ExactFraction };

export interface ConfirmationInput {
  /** Status of each buyer, read under `FOR SHARE`. */
  readonly buyerStatuses: ReadonlyMap<string, string>;
  /** The `VALID` Ownerships carrying this Acquisition's id. */
  readonly own: readonly ConfirmationOwnership[];
  /** All `VALID` Ownerships of the PropertyReference covering the transfer date. */
  readonly onTransferDate: readonly ConfirmationOwnership[];
}

export type ConfirmPlan =
  | { readonly kind: 'CONFIRM'; readonly next: Acquisition }
  /** Already confirmed: a 200 no-op whatever the version. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'ACQUISITION_CANCELLED' }
  | { readonly kind: 'CONFIRMATION_BLOCKED'; readonly violations: readonly ConfirmationViolation[] };

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));

/** The exact, reduced sum of shares. */
export function sumOf(shares: readonly AcquiredShare[]): ExactFraction {
  let numerator = 0n;
  let denominator = 1n;
  for (const share of shares) {
    numerator = numerator * BigInt(share.denominator) + BigInt(share.numerator) * denominator;
    denominator *= BigInt(share.denominator);
    const g = gcd(numerator, denominator);
    numerator /= g;
    denominator /= g;
  }
  return { numerator, denominator };
}

/**
 * Status first (a no-op before a cancelled one), then requirements 1–6 of §28.1, all of them reported. The version is
 * checked by the caller between `ACQUISITION_CANCELLED` and the requirements.
 */
export function planConfirm(current: Acquisition, input: ConfirmationInput, at: Date): ConfirmPlan {
  if (current.status === 'CONFIRMED') return { kind: 'UNCHANGED' };
  if (current.status === 'CANCELLED') return { kind: 'ACQUISITION_CANCELLED' };
  const d = transferDate(current);
  const violations: ConfirmationViolation[] = [];
  for (const partyId of [...current.buyerPartyIds].sort()) {
    if (input.buyerStatuses.get(partyId) !== 'ACTIVE') violations.push({ code: 'BUYER_INACTIVE', partyId });
  }
  violations.push(...structureViolations(current, input.own));
  const total = sumOf(input.onTransferDate.map((o) => o.share));
  if (total.numerator !== total.denominator) violations.push({ code: 'OWNERSHIP_INCOMPLETE', date: d, shareSum: total });
  if (violations.length > 0) return { kind: 'CONFIRMATION_BLOCKED', violations };
  return { kind: 'CONFIRM', next: { ...current, status: 'CONFIRMED', confirmedAt: at, version: current.version + 1 } };
}

/**
 * Requirements 2–5 of §28.1, the structure of an Acquisition's own Ownerships: all from the transfer date, held only
 * by buyers, every buyer holds one, the shares sum to exactly `acquiredShare`. Confirmation adds 1 and 6; the
 * owner-level allocation (§27.4) needs exactly these four for a `PROVISIONAL` answer.
 */
export function structureViolations(current: Acquisition, own: readonly ConfirmationOwnership[]): ConfirmationViolation[] {
  const d = transferDate(current);
  const buyers = new Set(current.buyerPartyIds);
  const byId = [...own].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const violations: ConfirmationViolation[] = [];
  for (const o of byId) {
    if (o.validFrom !== d) violations.push({ code: 'OWNERSHIP_NOT_FROM_TRANSFER_DATE', ownershipId: o.id, validFrom: o.validFrom, transferDate: d });
  }
  for (const o of byId) {
    if (!buyers.has(o.ownerPartyId)) violations.push({ code: 'OWNER_NOT_A_BUYER', ownershipId: o.id, ownerPartyId: o.ownerPartyId });
  }
  const holders = new Set(own.map((o) => o.ownerPartyId));
  for (const partyId of [...current.buyerPartyIds].sort()) {
    if (!holders.has(partyId)) violations.push({ code: 'BUYER_WITHOUT_OWNERSHIP', partyId });
  }
  const actual = sumOf(own.map((o) => o.share));
  const expected = { numerator: BigInt(current.acquiredShare.numerator), denominator: BigInt(current.acquiredShare.denominator) };
  if (actual.numerator !== expected.numerator || actual.denominator !== expected.denominator) violations.push({ code: 'SHARE_SUM_MISMATCH', expected, actual });
  return violations;
}

export type ConfirmAcquisitionOutcome =
  | { readonly kind: 'CONFIRMED'; readonly acquisition: Acquisition; readonly changed: boolean; readonly ownershipIds: readonly string[] }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<ConfirmPlan, { kind: 'CONFIRM' | 'UNCHANGED' }>
  | VersionConflict;

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
  cancel(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<CancelAcquisitionOutcome>;
  /**
   * Locks PropertyReference (no-op write) → buyers `FOR SHARE` in id order → the Acquisition `FOR UPDATE`, then reads
   * its Ownerships and those of the PropertyReference on the transfer date, and applies `planConfirm` (§28.1).
   */
  confirm(id: string, mreRealmId: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ConfirmAcquisitionOutcome>;
}

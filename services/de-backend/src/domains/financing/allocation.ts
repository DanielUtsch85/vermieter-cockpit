import type { AuditActor, BusinessDate, Money, VersionConflict } from '../../shared/index.js';
import { compareToOne, gcd, sumShares, type Fraction } from '../ownership/index.js';
import { debtFrom, type Loan, type LoanStatus } from './loan.js';

/**
 * Loan allocation sets (data-model.md §23, api-design.md §41.3, backlog VC-3-03): one exact fraction per
 * PropertyReference, summing to exactly `1/1`, valid from a date (phase-3-plan P3-D3, ADR-038). Sets are appended after
 * the last one, never edited, only the last one voidable, as terms (§41.2). Before the first set the Loan is
 * unallocated (BR-FIN-009). The allocated amounts are derived by VC-3-06 and never stored.
 */

export type LoanAllocationSetId = string & { readonly __brand: 'LoanAllocationSetId' };

export const ALLOCATION_BASES = ['MANUAL', 'PURCHASE_PRICE'] as const;
export type AllocationBasis = (typeof ALLOCATION_BASES)[number];

export const ALLOCATION_STATUSES = ['VALID', 'VOID'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

/** At most 50 entries per set (§41.3). */
export const MAX_ALLOCATIONS = 50;

/** One entry of a request: a share for `MANUAL`, an Acquisition for `PURCHASE_PRICE` (the API checks which). */
export interface RequestedAllocation {
  readonly propertyReferenceId: string;
  readonly share: Fraction | null;
  readonly acquisitionId: string | null;
}

export interface AllocationRequest {
  readonly validFrom: BusinessDate;
  readonly basis: AllocationBasis;
  readonly allocations: readonly RequestedAllocation[];
  readonly notes: string | null;
}

/** A stored entry: the share reduced, exact (a `PURCHASE_PRICE` denominator may exceed 10 000). */
export interface Allocation {
  readonly propertyReferenceId: string;
  readonly share: Fraction;
  readonly acquisitionId: string | null;
}

export interface LoanAllocationSet {
  readonly id: LoanAllocationSetId;
  readonly loanId: string;
  readonly mreRealmId: string;
  readonly status: AllocationStatus;
  readonly validFrom: BusinessDate;
  readonly basis: AllocationBasis;
  /** In the order given. */
  readonly allocations: readonly Allocation[];
  readonly notes: string | null;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A set with its derived end: the day before the next `VALID` set's `validFrom`, `null` for the last. */
export interface LoanAllocationSetView extends LoanAllocationSet {
  readonly validUntil: BusinessDate | null;
}

/** `share_i = price_i / Σ price`, exact and reduced (ADR-038's default from the financed purchase amounts), prices in cents. */
export function sharesFromPrices(prices: readonly bigint[]): Fraction[] {
  const total = prices.reduce((sum, price) => sum + price, 0n);
  return prices.map((price) => {
    const divisor = gcd(price, total);
    return { numerator: price / divisor, denominator: total / divisor };
  });
}

/** Whether the shares sum to exactly `1/1`. */
export function sumsToOne(shares: readonly Fraction[]): boolean {
  return compareToOne(sumShares(shares)) === 0;
}

/** The `VALID` set covering `day`, or null while the Loan is unallocated on it. */
export function setOn(sets: readonly LoanAllocationSetView[], day: BusinessDate): LoanAllocationSetView | null {
  return sets.find((s) => s.status === 'VALID' && s.validFrom <= day && (s.validUntil === null || day <= s.validUntil)) ?? null;
}

/** Identity of a create request for `Idempotency-Key` replays: the Loan and the normalized payload (shares reduced). */
export function allocationFingerprint(loanId: string, request: AllocationRequest): string {
  return JSON.stringify([
    loanId,
    request.validFrom,
    request.basis,
    request.allocations.map((a) => [a.propertyReferenceId, a.share === null ? null : `${a.share.numerator}/${a.share.denominator}`, a.acquisitionId]),
    request.notes,
  ]);
}

export type AllocationAppendRefusal =
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  | { readonly kind: 'ALLOCATION_BEFORE_DEBT'; readonly debtFrom: BusinessDate }
  | { readonly kind: 'ALLOCATION_NOT_APPENDED'; readonly lastValidFrom: BusinessDate };

/** Checks 3–5 of §41.3 against the Loan and its `VALID` sets (in `validFrom` order); undefined when the set may be appended. */
export function checkAppendAllocation(loan: Loan, valid: readonly LoanAllocationSet[], validFrom: BusinessDate): AllocationAppendRefusal | undefined {
  if (loan.status !== 'ACTIVE') return { kind: 'LOAN_NOT_ACTIVE', status: loan.status };
  const from = debtFrom(loan);
  if (validFrom < from) return { kind: 'ALLOCATION_BEFORE_DEBT', debtFrom: from };
  const last = valid.at(-1);
  if (last !== undefined && validFrom <= last.validFrom) return { kind: 'ALLOCATION_NOT_APPENDED', lastValidFrom: last.validFrom };
  return undefined;
}

export type VoidAllocationPlan =
  | { readonly kind: 'VOID'; readonly next: LoanAllocationSet }
  /** Already void: a 200 no-op whatever the reason or version; the first reason and time stay. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  /** Only the last `VALID` set is voidable (→ 409 ALLOCATION_NOT_LAST). */
  | { readonly kind: 'ALLOCATION_NOT_LAST'; readonly laterAllocationSetId: string };

export function planVoidAllocation(loan: Loan, current: LoanAllocationSet, valid: readonly LoanAllocationSet[], reason: string, at: Date): VoidAllocationPlan {
  if (current.status === 'VOID') return { kind: 'UNCHANGED' };
  if (loan.status !== 'ACTIVE') return { kind: 'LOAN_NOT_ACTIVE', status: loan.status };
  const later = valid.find((s) => s.validFrom > current.validFrom);
  if (later !== undefined) return { kind: 'ALLOCATION_NOT_LAST', laterAllocationSetId: later.id };
  return { kind: 'VOID', next: { ...current, status: 'VOID', voidedAt: at, voidReason: reason, version: current.version + 1 } };
}

/** A Loan as `GET /property-references/{id}/loans` lists it: the property's entry in one `VALID` set. */
export interface PropertyLoan {
  readonly loanId: string;
  readonly status: LoanStatus;
  readonly lenderPartyId: string;
  readonly principalOriginal: Money;
  readonly allocationSetId: string;
  readonly validFrom: BusinessDate;
  readonly validUntil: BusinessDate | null;
  readonly basis: AllocationBasis;
  readonly share: Fraction;
}

/** The entries of `propertyReferenceId` in the Loan's `VALID` sets, as a history. */
export function propertyLoansOf(loan: Loan, sets: readonly LoanAllocationSetView[], propertyReferenceId: string): PropertyLoan[] {
  return sets.flatMap((s) => {
    const entry = s.status === 'VALID' ? s.allocations.find((a) => a.propertyReferenceId === propertyReferenceId) : undefined;
    if (entry === undefined) return [];
    return [
      {
        loanId: loan.id,
        status: loan.status,
        lenderPartyId: loan.lenderPartyId,
        principalOriginal: loan.principalOriginal,
        allocationSetId: s.id,
        validFrom: s.validFrom,
        validUntil: s.validUntil,
        basis: s.basis,
        share: entry.share,
      },
    ];
  });
}

/** Only the sets covering `asOf` when given; newest `validFrom` first, then `loanId`. */
export function selectPropertyLoans(items: readonly PropertyLoan[], asOf?: BusinessDate): PropertyLoan[] {
  const covering = asOf === undefined ? [...items] : items.filter((i) => i.validFrom <= asOf && (i.validUntil === null || asOf <= i.validUntil));
  return covering.sort((x, y) => (x.validFrom === y.validFrom ? (x.loanId < y.loanId ? -1 : x.loanId > y.loanId ? 1 : 0) : x.validFrom > y.validFrom ? -1 : 1));
}

export type CreateAllocationOutcome =
  | { readonly kind: 'CREATED'; readonly set: LoanAllocationSetView }
  | { readonly kind: 'REPLAYED'; readonly set: LoanAllocationSetView }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'LOAN_NOT_FOUND' }
  | AllocationAppendRefusal
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND'; readonly propertyReferenceId: string }
  | { readonly kind: 'ACQUISITION_NOT_FOUND'; readonly acquisitionId: string }
  | { readonly kind: 'ACQUISITION_CANCELLED'; readonly acquisitionId: string };

export type VoidAllocationOutcome =
  | { readonly kind: 'VOIDED'; readonly set: LoanAllocationSetView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<VoidAllocationPlan, { kind: 'VOID' | 'UNCHANGED' }>
  | VersionConflict;

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface LoanAllocationRepository {
  /**
   * The Loan `FOR UPDATE`, then its `VALID` sets and `checkAppendAllocation`, then the PropertyReferences and (for
   * `PURCHASE_PRICE`) the Acquisitions in the order given, whose prices give the shares; claims the key in the same
   * transaction.
   */
  create(
    loanId: string,
    mreRealmId: string,
    request: AllocationRequest,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateAllocationOutcome>;
  /** The Loan `FOR UPDATE`, then the set and the `VALID` sets, then `planVoidAllocation`. */
  void(
    loanId: string,
    setId: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidAllocationOutcome>;
  /** Every set of the Loan in `validFrom`, then `createdAt` order, with `validUntil`; undefined for an unknown or foreign Loan. */
  list(loanId: string, mreRealmId: string): Promise<readonly LoanAllocationSetView[] | undefined>;
  /** The property's entries in the `VALID` sets of its non-`VOID` Loans, as a history; undefined for an unknown or foreign PropertyReference. */
  loansOf(propertyReferenceId: string, mreRealmId: string): Promise<readonly PropertyLoan[] | undefined>;
}

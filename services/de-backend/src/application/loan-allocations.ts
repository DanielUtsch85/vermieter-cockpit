import {
  allocationFingerprint,
  selectPropertyLoans,
  setOn,
  type AllocationRequest,
  type AllocationStatus,
  type LoanAllocationRepository,
  type LoanAllocationSetView,
  type PropertyLoan,
} from '../domains/financing/index.js';
import type { BusinessDate } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { LoanNotActiveError, LoanNotFoundError } from './loans.js';
import { AcquisitionNotFoundError } from './ownerships.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

/**
 * Loan allocation commands and reads (api-design.md §41.3, backlog VC-3-03), in the caller's verified Realm. Input
 * arrives validated and normalized from the API boundary (shares reduced, summing to one for `MANUAL`, no duplicates).
 */

/** A rule of §41.3 refuses the set (→ 422 with the refusal's code and details). */
export class AllocationRefusedError extends Error {
  override readonly name = 'AllocationRefusedError';

  constructor(
    readonly refusal:
      | { readonly kind: 'ALLOCATION_BEFORE_DEBT'; readonly debtFrom: BusinessDate }
      | { readonly kind: 'ALLOCATION_NOT_APPENDED'; readonly lastValidFrom: BusinessDate }
      | { readonly kind: 'ACQUISITION_CANCELLED'; readonly acquisitionId: string },
  ) {
    super(refusal.kind);
  }
}

export class LoanAllocationSetNotFoundError extends Error {
  override readonly name = 'LoanAllocationSetNotFoundError';

  constructor(readonly allocationSetId: string) {
    super(`LoanAllocationSet ${allocationSetId} not found`);
  }
}

/** Only the last `VALID` set is voidable (→ 409 ALLOCATION_NOT_LAST). */
export class AllocationNotLastError extends Error {
  override readonly name = 'AllocationNotLastError';

  constructor(
    readonly allocationSetId: string,
    readonly laterAllocationSetId: string,
  ) {
    super(`LoanAllocationSet ${allocationSetId} is followed by ${laterAllocationSetId}`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export interface CreateLoanAllocationInput extends AllocationRequest {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly idempotencyKey?: string;
}

export type CreateLoanAllocation = (input: CreateLoanAllocationInput) => Promise<{ readonly set: LoanAllocationSetView; readonly replayed: boolean }>;

export function createLoanAllocation(deps: { readonly repository: LoanAllocationRepository }): CreateLoanAllocation {
  return async ({ principal, loanId, idempotencyKey, ...request }) => {
    const outcome = await deps.repository.create(
      loanId,
      principal.mreRealmId,
      request,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: allocationFingerprint(loanId, request) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { set: outcome.set, replayed: false };
      case 'REPLAYED':
        return { set: outcome.set, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'LOAN_NOT_FOUND':
        throw new LoanNotFoundError(loanId);
      case 'LOAN_NOT_ACTIVE':
        throw new LoanNotActiveError(loanId, outcome.status);
      case 'PROPERTY_REFERENCE_NOT_FOUND':
        throw new PropertyReferenceNotFoundError(outcome.propertyReferenceId);
      case 'ACQUISITION_NOT_FOUND':
        throw new AcquisitionNotFoundError(outcome.acquisitionId);
      default:
        throw new AllocationRefusedError(outcome);
    }
  };
}

export type VoidLoanAllocation = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly allocationSetId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly set: LoanAllocationSetView; readonly changed: boolean }>;

export function voidLoanAllocation(deps: { readonly repository: LoanAllocationRepository; readonly now?: () => Date }): VoidLoanAllocation {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, loanId, allocationSetId, reason, expectedVersions }) => {
    const outcome = await deps.repository.void(loanId, allocationSetId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { set: outcome.set, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new LoanAllocationSetNotFoundError(allocationSetId);
      case 'LOAN_NOT_ACTIVE':
        throw new LoanNotActiveError(loanId, outcome.status);
      case 'ALLOCATION_NOT_LAST':
        throw new AllocationNotLastError(allocationSetId, outcome.laterAllocationSetId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type ListLoanAllocations = (input: { readonly principal: RealmPrincipal; readonly loanId: string; readonly status?: AllocationStatus }) => Promise<readonly LoanAllocationSetView[]>;

export function listLoanAllocations(deps: { readonly repository: LoanAllocationRepository }): ListLoanAllocations {
  return async ({ principal, loanId, status }) => {
    const sets = await deps.repository.list(loanId, principal.mreRealmId);
    if (sets === undefined) throw new LoanNotFoundError(loanId);
    return status === undefined ? sets : sets.filter((s) => s.status === status);
  };
}

/** The set covering `asOf`, or null while the Loan is unallocated on that day (BR-FIN-009). */
export type GetLoanAllocationOn = (input: { readonly principal: RealmPrincipal; readonly loanId: string; readonly asOf: BusinessDate }) => Promise<LoanAllocationSetView | null>;

export function getLoanAllocationOn(deps: { readonly repository: LoanAllocationRepository }): GetLoanAllocationOn {
  return async ({ principal, loanId, asOf }) => {
    const sets = await deps.repository.list(loanId, principal.mreRealmId);
    if (sets === undefined) throw new LoanNotFoundError(loanId);
    return setOn(sets, asOf);
  };
}

export type ListPropertyLoans = (input: { readonly principal: RealmPrincipal; readonly propertyReferenceId: string; readonly asOf?: BusinessDate }) => Promise<readonly PropertyLoan[]>;

export function listPropertyLoans(deps: { readonly repository: LoanAllocationRepository }): ListPropertyLoans {
  return async ({ principal, propertyReferenceId, asOf }) => {
    const items = await deps.repository.loansOf(propertyReferenceId, principal.mreRealmId);
    if (items === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
    return selectPropertyLoans(items, asOf);
  };
}

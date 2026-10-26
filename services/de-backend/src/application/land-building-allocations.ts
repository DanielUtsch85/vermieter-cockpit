import {
  allocationFingerprint,
  type AllocationData,
  type LandBuildingAllocation,
  type LandBuildingAllocationRepository,
} from '../domains/acquisition/index.js';
import type { RealmPrincipal } from './access.js';
import { AcquisitionCancelledError } from './acquisition-costs.js';
import { IdempotencyKeyConflictError } from './errors.js';
import { AcquisitionNotFoundError } from './ownerships.js';
import { PartyNotFoundError } from './parties.js';

/**
 * Land/building allocation (api-design.md §27.3, backlog VC-2-08), in the caller's verified Realm. Input arrives
 * validated from the API boundary (total > 0, parts ≥ 0, land + building = total exactly).
 */

/** `supersedes` does not name the current allocation (→ 409 CURRENT_ALLOCATION_CHANGED). */
export class CurrentAllocationChangedError extends Error {
  override readonly name = 'CurrentAllocationChangedError';

  constructor(readonly currentAllocationId: string | null) {
    super(`The current allocation is ${currentAllocationId ?? 'none'}`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export type CreateLandBuildingAllocation = (
  input: AllocationData & { readonly principal: RealmPrincipal; readonly acquisitionId: string; readonly idempotencyKey?: string },
) => Promise<{ readonly allocation: LandBuildingAllocation; readonly replayed: boolean }>;

export function createLandBuildingAllocation(deps: { readonly repository: LandBuildingAllocationRepository }): CreateLandBuildingAllocation {
  return async ({ principal, acquisitionId, idempotencyKey, ...fields }) => {
    const allocation = { mreRealmId: principal.mreRealmId, acquisitionId, ...fields };
    const outcome = await deps.repository.create(
      allocation,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: allocationFingerprint(allocation) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { allocation: outcome.allocation, replayed: false };
      case 'REPLAYED':
        return { allocation: outcome.allocation, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'ACQUISITION_NOT_FOUND':
        throw new AcquisitionNotFoundError(acquisitionId);
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(outcome.partyId);
      case 'ACQUISITION_CANCELLED':
        throw new AcquisitionCancelledError(acquisitionId);
      case 'CURRENT_ALLOCATION_CHANGED':
        throw new CurrentAllocationChangedError(outcome.currentAllocationId);
    }
  };
}

export type ListLandBuildingAllocations = (input: {
  readonly principal: RealmPrincipal;
  readonly acquisitionId: string;
}) => Promise<{ readonly current: LandBuildingAllocation | null; readonly items: readonly LandBuildingAllocation[] }>;

export function listLandBuildingAllocations(deps: { readonly repository: LandBuildingAllocationRepository }): ListLandBuildingAllocations {
  return async ({ principal, acquisitionId }) => {
    const result = await deps.repository.list(acquisitionId, principal.mreRealmId);
    if (result === undefined) throw new AcquisitionNotFoundError(acquisitionId);
    return result;
  };
}

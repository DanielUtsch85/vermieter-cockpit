import { planOwnerAllocation, type ConfirmationViolation, type OwnerAllocationPlan, type OwnerAllocationSource } from '../domains/acquisition/index.js';
import type { RealmPrincipal } from './access.js';
import { AcquisitionCancelledError } from './acquisition-costs.js';
import { AcquisitionNotFoundError } from './ownerships.js';

/** Owner-level allocation read (api-design.md §27.4, backlog VC-2-09), in the caller's verified Realm. */

/**
 * Ownerships not meeting requirements 2–5 of §28.1 (5 as §28.1A): a `DRAFT` under way, or a legacy `CONFIRMED` one
 * (→ 409 OWNERSHIP_BASIS_INCOMPLETE).
 */
export class OwnershipBasisIncompleteError extends Error {
  override readonly name = 'OwnershipBasisIncompleteError';

  constructor(
    readonly acquisitionId: string,
    readonly violations: readonly ConfirmationViolation[],
  ) {
    super(`Acquisition ${acquisitionId}: the ownership basis is incomplete (${violations.map((v) => v.code).join(', ')})`);
  }
}

export type GetOwnerAllocation = (input: {
  readonly principal: RealmPrincipal;
  readonly acquisitionId: string;
}) => Promise<Extract<OwnerAllocationPlan, { kind: 'ALLOCATED' }>>;

export function getOwnerAllocation(deps: { readonly source: OwnerAllocationSource }): GetOwnerAllocation {
  return async ({ principal, acquisitionId }) => {
    const input = await deps.source.read(acquisitionId, principal.mreRealmId);
    if (input === undefined) throw new AcquisitionNotFoundError(acquisitionId);
    const plan = planOwnerAllocation(input);
    switch (plan.kind) {
      case 'ALLOCATED':
        return plan;
      case 'ACQUISITION_CANCELLED':
        throw new AcquisitionCancelledError(acquisitionId);
      case 'OWNERSHIP_BASIS_INCOMPLETE':
        throw new OwnershipBasisIncompleteError(acquisitionId, plan.violations);
    }
  };
}

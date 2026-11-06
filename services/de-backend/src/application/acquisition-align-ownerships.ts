import {
  alignOwnershipsFingerprint,
  type AcquisitionRepository,
  type AlignBlocker,
  type AlignOwnershipsInput,
  type AlignResult,
  type NotApplicableReason,
} from '../domains/acquisition/index.js';
import type { Ownership } from '../domains/ownership/index.js';
import type { BusinessDate } from '../shared/index.js';
import { AcquisitionCancelledError } from './acquisition-costs.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { AcquisitionNotFoundError } from './ownerships.js';

/**
 * `POST /acquisitions/{id}/align-ownerships-to-transfer` (api-design.md §58Q, VC-X-55; Entscheidung des
 * Projektinhabers, 2026-11-05, Fragen 1–11), in the caller's verified Realm and §58Q's order of checks.
 */

/** The act was applied already (→ 409 CONFLICT `OWNERSHIPS_ALREADY_ALIGNED`, with the time and the day). */
export class OwnershipsAlreadyAlignedError extends Error {
  override readonly name = 'OwnershipsAlreadyAlignedError';

  constructor(
    readonly acquisitionId: string,
    readonly ownershipAlignedAt: Date,
    readonly ownershipStart: BusinessDate,
  ) {
    super(`The Ownerships of Acquisition ${acquisitionId} are already aligned to the transfer`);
  }
}

/** The act does not apply (→ 422 OWNERSHIP_EXTENSION_NOT_APPLICABLE with `reason`). */
export class OwnershipExtensionNotApplicableError extends Error {
  override readonly name = 'OwnershipExtensionNotApplicableError';

  constructor(
    readonly acquisitionId: string,
    readonly reason: NotApplicableReason,
  ) {
    super(`The Ownerships of Acquisition ${acquisitionId} cannot be aligned: ${reason}`);
  }
}

/** A later fact rests on the old dates (→ 422 OWNERSHIP_EXTENSION_BLOCKED with `blockedBy`). */
export class OwnershipExtensionBlockedError extends Error {
  override readonly name = 'OwnershipExtensionBlockedError';

  constructor(
    readonly acquisitionId: string,
    readonly blockedBy: readonly AlignBlocker[],
  ) {
    super(`The Ownerships of Acquisition ${acquisitionId} cannot be aligned: ${blockedBy.map((b) => b.code).join(', ')}`);
  }
}

export type AlignOwnershipsToTransfer = (input: {
  readonly principal: RealmPrincipal;
  readonly acquisitionId: string;
  readonly align: AlignOwnershipsInput;
  readonly expectedVersions?: readonly number[];
  readonly idempotencyKey?: string;
}) => Promise<{ readonly result: AlignResult<Ownership>; readonly replayed: boolean }>;

export function alignOwnershipsToTransfer(deps: { readonly repository: AcquisitionRepository; readonly now?: () => Date }): AlignOwnershipsToTransfer {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, acquisitionId, align, expectedVersions, idempotencyKey }) => {
    const outcome = await deps.repository.alignOwnershipsToTransfer({
      id: acquisitionId,
      mreRealmId: principal.mreRealmId,
      align,
      at: now(),
      actor: { actorType: 'USER', actorId: principal.email },
      ...(expectedVersions === undefined ? {} : { expectedVersions }),
      ...(idempotencyKey === undefined ? {} : { idempotency: { key: idempotencyKey, fingerprint: alignOwnershipsFingerprint(acquisitionId, align) } }),
    });
    switch (outcome.kind) {
      case 'ALIGNED':
        return { result: outcome.result, replayed: outcome.replayed };
      case 'NOT_FOUND':
        throw new AcquisitionNotFoundError(acquisitionId);
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'ACQUISITION_CANCELLED':
        throw new AcquisitionCancelledError(acquisitionId);
      case 'OWNERSHIPS_ALREADY_ALIGNED':
        throw new OwnershipsAlreadyAlignedError(acquisitionId, outcome.ownershipAlignedAt, outcome.ownershipStart);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
      case 'OWNERSHIP_EXTENSION_NOT_APPLICABLE':
        throw new OwnershipExtensionNotApplicableError(acquisitionId, outcome.reason);
      case 'OWNERSHIP_EXTENSION_BLOCKED':
        throw new OwnershipExtensionBlockedError(acquisitionId, outcome.blockedBy);
    }
  };
}

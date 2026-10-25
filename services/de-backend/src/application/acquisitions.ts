import {
  createFingerprint,
  type Acquisition,
  type AcquisitionData,
  type AcquisitionFilter,
  type AcquisitionPage,
  type AcquisitionRepository,
} from '../domains/acquisition/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { AcquisitionNotFoundError, OwnerInactiveError } from './ownerships.js';
import { PartyNotFoundError } from './parties.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

/**
 * Acquisition commands and reads (api-design.md §27.1, backlog VC-2-05), in the caller's verified Realm. Input arrives
 * validated and normalized from the API boundary (price > 0, share reduced, texts trimmed).
 */

/** A confirmed Acquisition is final (→ 409 ACQUISITION_CONFIRMED). */
export class AcquisitionConfirmedError extends Error {
  override readonly name = 'AcquisitionConfirmedError';

  constructor(readonly acquisitionId: string) {
    super(`Acquisition ${acquisitionId} is confirmed`);
  }
}

/** `VALID` Ownerships still carry the id: void them first (→ 409 ACQUISITION_HAS_VALID_OWNERSHIPS, review on #46). */
export class AcquisitionHasValidOwnershipsError extends Error {
  override readonly name = 'AcquisitionHasValidOwnershipsError';

  constructor(
    readonly acquisitionId: string,
    readonly ownershipIds: readonly string[],
  ) {
    super(`Acquisition ${acquisitionId} is carried by VALID Ownerships ${ownershipIds.join(', ')}`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export interface CreateAcquisitionInput extends AcquisitionData {
  readonly principal: RealmPrincipal;
  readonly idempotencyKey?: string;
}

export type CreateAcquisition = (input: CreateAcquisitionInput) => Promise<{ readonly acquisition: Acquisition; readonly replayed: boolean }>;

export function createAcquisition(deps: { readonly repository: AcquisitionRepository }): CreateAcquisition {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const acquisition = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.create(
      acquisition,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: createFingerprint(acquisition) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { acquisition: outcome.acquisition, replayed: false };
      case 'REPLAYED':
        return { acquisition: outcome.acquisition, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'PROPERTY_REFERENCE_NOT_FOUND':
        throw new PropertyReferenceNotFoundError(fields.propertyReferenceId);
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(outcome.partyId);
      case 'PARTY_INACTIVE':
        throw new OwnerInactiveError(outcome.partyId);
    }
  };
}

export type GetAcquisition = (input: { readonly principal: RealmPrincipal; readonly acquisitionId: string }) => Promise<Acquisition>;

export function getAcquisition(deps: { readonly repository: AcquisitionRepository }): GetAcquisition {
  return async ({ principal, acquisitionId }) => {
    const acquisition = await deps.repository.findById(acquisitionId, principal.mreRealmId);
    if (acquisition === undefined) throw new AcquisitionNotFoundError(acquisitionId);
    return acquisition;
  };
}

export type ListAcquisitions = (input: {
  readonly principal: RealmPrincipal;
  readonly filter: AcquisitionFilter;
  readonly page: { readonly page: number; readonly pageSize: number };
}) => Promise<AcquisitionPage>;

export function listAcquisitions(deps: { readonly repository: AcquisitionRepository }): ListAcquisitions {
  return ({ principal, filter, page }) => deps.repository.list(principal.mreRealmId, filter, page);
}

export type ListPropertyAcquisitions = (input: {
  readonly principal: RealmPrincipal;
  readonly propertyReferenceId: string;
  readonly filter: Omit<AcquisitionFilter, 'propertyReferenceId'>;
  readonly page: { readonly page: number; readonly pageSize: number };
}) => Promise<AcquisitionPage>;

/** The PropertyReference's Acquisitions; an unknown or foreign PropertyReference is 404, not an empty page. */
export function listPropertyAcquisitions(deps: {
  readonly repository: AcquisitionRepository;
  readonly propertyReferences: { findById(id: string, mreRealmId: string): Promise<unknown> };
}): ListPropertyAcquisitions {
  return async ({ principal, propertyReferenceId, filter, page }) => {
    if ((await deps.propertyReferences.findById(propertyReferenceId, principal.mreRealmId)) === undefined) {
      throw new PropertyReferenceNotFoundError(propertyReferenceId);
    }
    return deps.repository.list(principal.mreRealmId, { ...filter, propertyReferenceId }, page);
  };
}

export type CancelAcquisition = (input: {
  readonly principal: RealmPrincipal;
  readonly acquisitionId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly acquisition: Acquisition; readonly changed: boolean }>;

export function cancelAcquisition(deps: { readonly repository: AcquisitionRepository; readonly now?: () => Date }): CancelAcquisition {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, acquisitionId, reason, expectedVersions }) => {
    const outcome = await deps.repository.cancel(acquisitionId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'CANCELLED':
        return { acquisition: outcome.acquisition, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new AcquisitionNotFoundError(acquisitionId);
      case 'ACQUISITION_CONFIRMED':
        throw new AcquisitionConfirmedError(acquisitionId);
      case 'ACQUISITION_HAS_VALID_OWNERSHIPS':
        throw new AcquisitionHasValidOwnershipsError(acquisitionId, outcome.ownershipIds);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

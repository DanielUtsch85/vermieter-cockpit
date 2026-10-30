import {
  referenceFingerprint,
  type NewRentalContractReference,
  type RentalContractReference,
  type RentalContractReferenceFields,
  type RentalContractReferenceRepository,
} from '../domains/rental-contract-reference/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import type { MreTenantLookup } from './party-external-references.js';

/**
 * The minimal RentalContractReference (api-design.md §58A, data-model §11, backlog VC-7-02), in the caller's verified
 * Realm. Input arrives validated from the API boundary (`mreTenantId` 24 hex characters, `rentDueDays` checked).
 * Nothing is written to MRE.
 */

export class RentalContractReferenceNotFoundError extends Error {
  override readonly name = 'RentalContractReferenceNotFoundError';

  constructor(readonly rentalContractReferenceId: string) {
    super(`Rental contract reference ${rentalContractReferenceId} not found`);
  }
}

/** The Tenant has a reference already (→ 409 RENTAL_CONTRACT_REFERENCE_EXISTS). */
export class RentalContractReferenceExistsError extends Error {
  override readonly name = 'RentalContractReferenceExistsError';

  constructor(readonly rentalContractReferenceId: string) {
    super(`The MRE Tenant already has rental contract reference ${rentalContractReferenceId}`);
  }
}

/** MRE has no such Tenant in the Realm (→ 422 MRE_TENANT_NOT_FOUND, §58A). */
export class RentalContractTenantNotFoundError extends Error {
  override readonly name = 'RentalContractTenantNotFoundError';

  constructor(readonly mreTenantId: string) {
    super(`MRE Tenant ${mreTenantId} not found in this Realm`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

type Deps = { readonly repository: RentalContractReferenceRepository };

export interface CreateRentalContractReferenceInput extends Omit<NewRentalContractReference, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  readonly authorizationHeader: string;
  readonly idempotencyKey?: string;
}

export type CreateRentalContractReference = (
  input: CreateRentalContractReferenceInput,
) => Promise<{ readonly reference: RentalContractReference; readonly replayed: boolean }>;

/**
 * §58A's order: the MRE Tenant read live with the caller's token, before the transaction (as §47.1); then the key and
 * the reference of the Tenant (`RENTAL_CONTRACT_REFERENCE_EXISTS`).
 */
export function createRentalContractReference(deps: Deps & { readonly lookupMreTenant: MreTenantLookup }): CreateRentalContractReference {
  return async ({ principal, authorizationHeader, idempotencyKey, ...fields }) => {
    const reference = { mreRealmId: principal.mreRealmId, ...fields };
    if (!(await deps.lookupMreTenant(authorizationHeader, principal.mreRealmId, fields.mreTenantId))) {
      throw new RentalContractTenantNotFoundError(fields.mreTenantId);
    }
    const outcome = await deps.repository.createReference(
      reference,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: referenceFingerprint(reference) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { reference: outcome.reference, replayed: false };
      case 'REPLAYED':
        return { reference: outcome.reference, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'REFERENCE_EXISTS':
        throw new RentalContractReferenceExistsError(outcome.rentalContractReferenceId);
    }
  };
}

export type AmendRentalContractReference = (
  input: Partial<RentalContractReferenceFields> & {
    readonly principal: RealmPrincipal;
    readonly rentalContractReferenceId: string;
    readonly expectedVersions?: readonly number[];
  },
) => Promise<{ readonly reference: RentalContractReference; readonly changed: boolean }>;

export function amendRentalContractReference(deps: Deps): AmendRentalContractReference {
  return async ({ principal, rentalContractReferenceId, expectedVersions, ...changes }) => {
    const outcome = await deps.repository.amendReference(rentalContractReferenceId, principal.mreRealmId, changes, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'AMENDED':
        return { reference: outcome.reference, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new RentalContractReferenceNotFoundError(rentalContractReferenceId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type GetRentalContractReference = (input: {
  readonly principal: RealmPrincipal;
  readonly rentalContractReferenceId: string;
}) => Promise<RentalContractReference>;

export function getRentalContractReference(deps: Deps): GetRentalContractReference {
  return async ({ principal, rentalContractReferenceId }) => {
    const found = await deps.repository.findReference(rentalContractReferenceId, principal.mreRealmId);
    if (found === undefined) throw new RentalContractReferenceNotFoundError(rentalContractReferenceId);
    return found;
  };
}

export type ListRentalContractReferences = (input: {
  readonly principal: RealmPrincipal;
  readonly mreTenantId: string;
}) => Promise<readonly RentalContractReference[]>;

/** The reference of one Tenant, or an empty list (§58A). */
export function listRentalContractReferences(deps: Deps): ListRentalContractReferences {
  return async ({ principal, mreTenantId }) => {
    const found = await deps.repository.findByTenant(mreTenantId, principal.mreRealmId);
    return found === undefined ? [] : [found];
  };
}

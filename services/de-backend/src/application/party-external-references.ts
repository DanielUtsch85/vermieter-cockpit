import type {
  ExternalReferencePage,
  ExternalReferenceStatus,
  PartyExternalReference,
  PartyExternalReferenceRepository,
} from '../domains/party/index.js';
import { AccessError, type RealmPrincipal } from './access.js';
import { ConcurrentUpdateError, VersionConflictError } from './errors.js';
import { PartyNotFoundError } from './parties.js';

/**
 * External references of a Party (api-design.md §20.1, backlog VC-2-02): an MRE Tenant linked to a Party of the
 * caller's Realm. Input arrives validated from the API boundary (`externalId` a 24-hex MRE `_id`).
 */

/**
 * Whether an MRE Tenant exists in a Realm, asked with the caller's own MRE credentials (so MRE enforces Realm
 * isolation). Throws AccessError when MRE refuses the caller and MreUnavailableError when MRE cannot be asked.
 */
export type MreTenantLookup = (authorizationHeader: string, mreRealmId: string, mreTenantId: string) => Promise<boolean>;

export class MreTenantNotFoundError extends Error {
  override readonly name = 'MreTenantNotFoundError';

  constructor(readonly externalId: string) {
    super(`MRE Tenant ${externalId} not found in the Realm`);
  }
}

/** Another Party holds the key in an active reference (→ 409 REFERENCE_IN_USE). */
export class ExternalReferenceInUseError extends Error {
  override readonly name = 'ExternalReferenceInUseError';

  constructor(readonly partyId: string) {
    super(`The external reference is held by Party ${partyId}`);
  }
}

/** No new reference for an INACTIVE Party (P2-D1 → 409 PARTY_INACTIVE). */
export class PartyInactiveError extends Error {
  override readonly name = 'PartyInactiveError';

  constructor(readonly partyId: string) {
    super(`Party ${partyId} is inactive`);
  }
}

export class ExternalReferenceNotFoundError extends Error {
  override readonly name = 'ExternalReferenceNotFoundError';

  constructor(readonly externalReferenceId: string) {
    super(`External reference ${externalReferenceId} not found`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export interface CreateExternalReferenceInput {
  readonly principal: RealmPrincipal;
  /** The caller's `Authorization` header, forwarded to MRE for the lookup. */
  readonly authorizationHeader: string;
  readonly partyId: string;
  readonly mreRealmId: string;
  readonly externalId: string;
}

export type CreateExternalReference = (
  input: CreateExternalReferenceInput,
) => Promise<{ readonly reference: PartyExternalReference; readonly created: boolean }>;

export function createExternalReference(deps: {
  readonly repository: PartyExternalReferenceRepository;
  readonly lookupMreTenant: MreTenantLookup;
}): CreateExternalReference {
  return async ({ principal, authorizationHeader, partyId, mreRealmId, externalId }) => {
    // As §23.1: the body names the verified Realm, never another one the caller guesses.
    if (mreRealmId !== principal.mreRealmId) throw new AccessError('FORBIDDEN', 'mreRealmId does not match the verified Realm');
    const key = { system: 'MRE', mreRealmId, entityType: 'tenant', externalId } as const;
    const settle = (outcome: Awaited<ReturnType<PartyExternalReferenceRepository['claim']>>) => {
      switch (outcome.kind) {
        case 'CREATED':
          return { reference: outcome.reference, created: true };
        case 'EXISTING':
          return { reference: outcome.reference, created: false };
        case 'NOT_FOUND':
          throw new PartyNotFoundError(partyId);
        case 'IN_USE':
          throw new ExternalReferenceInUseError(outcome.partyId);
        case 'PARTY_INACTIVE':
          throw new PartyInactiveError(partyId);
        case 'CONTENDED':
          throw new ConcurrentUpdateError(`external reference ${externalId}: claimed and ended concurrently on every attempt`);
      }
    };
    // Steps 1–4 from DE alone, so a repeat or a refusal never asks MRE (§20.1).
    const check = await deps.repository.checkClaim(partyId, key);
    if (check.kind !== 'CLAIM') return settle(check);
    if (!(await deps.lookupMreTenant(authorizationHeader, mreRealmId, externalId))) throw new MreTenantNotFoundError(externalId);
    // MRE was read outside any lock; the claim re-checks steps 1–4 under the Party's lock.
    return settle(await deps.repository.claim(partyId, key, actorOf(principal)));
  };
}

export type EndExternalReference = (input: {
  readonly principal: RealmPrincipal;
  readonly partyId: string;
  readonly externalReferenceId: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly reference: PartyExternalReference; readonly changed: boolean }>;

export function endExternalReference(deps: {
  readonly repository: PartyExternalReferenceRepository;
  readonly now?: () => Date;
}): EndExternalReference {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, partyId, externalReferenceId, expectedVersions }) => {
    const outcome = await deps.repository.end(partyId, externalReferenceId, principal.mreRealmId, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'ENDED':
        return { reference: outcome.reference, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new ExternalReferenceNotFoundError(externalReferenceId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type ListExternalReferences = (input: {
  readonly principal: RealmPrincipal;
  readonly partyId: string;
  readonly filter: { readonly status?: ExternalReferenceStatus };
  readonly page: { readonly page: number; readonly pageSize: number };
}) => Promise<ExternalReferencePage>;

export function listExternalReferences(deps: { readonly repository: PartyExternalReferenceRepository }): ListExternalReferences {
  return async ({ principal, partyId, filter, page }) => {
    const result = await deps.repository.list(partyId, principal.mreRealmId, filter, page);
    if (result === undefined) throw new PartyNotFoundError(partyId);
    return result;
  };
}

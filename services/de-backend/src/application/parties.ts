import {
  createFingerprint,
  fieldsNotAllowed,
  type Party,
  type PartyChanges,
  type PartyData,
  type PartyFilter,
  type PartyPage,
  type PartyRepository,
  type PartyType,
  type TypeSpecificField,
} from '../domains/party/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError } from './financial-accounts.js';
import { VersionConflictError } from './transactions.js';

/**
 * Party commands and reads (api-design.md §19.1, backlog VC-2-01), in the caller's verified Realm. Input arrives
 * validated and normalized from the API boundary (trimmed; empty optional strings are null).
 */

export class PartyNotFoundError extends Error {
  override readonly name = 'PartyNotFoundError';

  constructor(readonly partyId: string) {
    super(`Party ${partyId} not found`);
  }
}

/** A field of the other `partyType` (→ 400 `NOT_ALLOWED_FOR_TYPE`). */
export class PartyFieldNotAllowedError extends Error {
  override readonly name = 'PartyFieldNotAllowedError';

  constructor(
    readonly partyType: PartyType,
    readonly fields: readonly TypeSpecificField[],
  ) {
    super(`${fields.join(', ')} not allowed for a ${partyType}`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export interface CreatePartyInput extends PartyData {
  readonly principal: RealmPrincipal;
  readonly partyType: PartyType;
  readonly idempotencyKey?: string;
}

export type CreateParty = (input: CreatePartyInput) => Promise<{ readonly party: Party; readonly replayed: boolean }>;

export function createParty(deps: { readonly repository: PartyRepository }): CreateParty {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const notAllowed = fieldsNotAllowed(fields.partyType, fields);
    if (notAllowed.length > 0) throw new PartyFieldNotAllowedError(fields.partyType, notAllowed);
    const party = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.create(
      party,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: createFingerprint(party) },
    );
    if (outcome.kind === 'IDEMPOTENCY_CONFLICT') throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
    return { party: outcome.party, replayed: outcome.kind === 'REPLAYED' };
  };
}

export type GetParty = (input: { readonly principal: RealmPrincipal; readonly partyId: string }) => Promise<Party>;

export function getParty(deps: { readonly repository: PartyRepository }): GetParty {
  return async ({ principal, partyId }) => {
    const party = await deps.repository.findById(partyId, principal.mreRealmId);
    // Unknown and other-Realm Parties look the same, so existence does not leak.
    if (party === undefined) throw new PartyNotFoundError(partyId);
    return party;
  };
}

export type ListParties = (input: {
  readonly principal: RealmPrincipal;
  readonly filter: PartyFilter;
  readonly page: { readonly page: number; readonly pageSize: number };
}) => Promise<PartyPage>;

export function listParties(deps: { readonly repository: PartyRepository }): ListParties {
  return ({ principal, filter, page }) => deps.repository.list(principal.mreRealmId, filter, page);
}

export type AmendParty = (input: {
  readonly principal: RealmPrincipal;
  readonly partyId: string;
  readonly changes: PartyChanges;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly party: Party; readonly changed: boolean }>;

export function amendParty(deps: { readonly repository: PartyRepository }): AmendParty {
  return async ({ principal, partyId, changes, expectedVersions }) => {
    const outcome = await deps.repository.amend(partyId, principal.mreRealmId, changes, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'AMENDED':
        return { party: outcome.party, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new PartyNotFoundError(partyId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
      case 'NOT_ALLOWED_FOR_TYPE':
        throw new PartyFieldNotAllowedError(outcome.partyType, outcome.fields);
    }
  };
}

export type DeactivateParty = (input: {
  readonly principal: RealmPrincipal;
  readonly partyId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly party: Party; readonly changed: boolean }>;

export function deactivateParty(deps: { readonly repository: PartyRepository; readonly now?: () => Date }): DeactivateParty {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, partyId, reason, expectedVersions }) => {
    const outcome = await deps.repository.deactivate(partyId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'DEACTIVATED':
        return { party: outcome.party, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new PartyNotFoundError(partyId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

import {
  changeFingerprint,
  createFingerprint,
  type ChangeResult,
  type OwnershipChange,
  type OwnershipChangeRepository,
  type Fraction,
  type InvalidOwnershipReason,
  type NewOwnership,
  type Ownership,
  type OwnershipDay,
  type OwnershipPage,
  type OwnershipRepository,
} from '../domains/ownership/index.js';
import type { BusinessDate } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { PartyNotFoundError } from './parties.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

/**
 * Ownership commands and reads (api-design.md §26.1, backlog VC-2-03), in the caller's verified Realm. Input arrives
 * validated and normalized from the API boundary (share reduced, texts trimmed).
 */

export class OwnershipNotFoundError extends Error {
  override readonly name = 'OwnershipNotFoundError';

  constructor(readonly ownershipId: string) {
    super(`Ownership ${ownershipId} not found`);
  }
}

/** A new owner must be active (P2-D5 → 422 PARTY_INACTIVE). */
export class OwnerInactiveError extends Error {
  override readonly name = 'OwnerInactiveError';

  constructor(readonly partyId: string) {
    super(`Party ${partyId} is inactive`);
  }
}

/** The same owner already holds an overlapping Ownership (→ 422 OVERLAPPING_OWNERSHIP). */
export class OverlappingOwnershipError extends Error {
  override readonly name = 'OverlappingOwnershipError';

  constructor(readonly ownershipId: string) {
    super(`Overlaps Ownership ${ownershipId} of the same owner`);
  }
}

/** The shares on `date` would sum above 1 (→ 422 OWNERSHIP_TOTAL_EXCEEDS_ONE). */
export class OwnershipTotalExceedsOneError extends Error {
  override readonly name = 'OwnershipTotalExceedsOneError';

  constructor(
    readonly date: BusinessDate,
    readonly shareSum: Fraction,
  ) {
    super(`Shares on ${date} would sum to ${shareSum.numerator}/${shareSum.denominator}`);
  }
}

/** A close the Ownership's state does not allow (→ 422 INVALID_OWNERSHIP with the reason). */
export class InvalidOwnershipError extends Error {
  override readonly name = 'InvalidOwnershipError';

  constructor(
    readonly ownershipId: string,
    readonly reason: InvalidOwnershipReason | 'NOT_FOUND',
  ) {
    super(`Ownership ${ownershipId}: ${reason}`);
  }
}

/** The ownership was complete the day before and would not be on `date` (→ 422 OWNERSHIP_INCOMPLETE, §26.2). */
export class OwnershipIncompleteError extends Error {
  override readonly name = 'OwnershipIncompleteError';

  constructor(
    readonly date: BusinessDate,
    readonly shareSum: Fraction,
  ) {
    super(`Ownership on ${date} would sum to ${shareSum.numerator}/${shareSum.denominator}, not 1`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export interface CreateOwnershipInput extends Omit<NewOwnership, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  readonly idempotencyKey?: string;
}

export type CreateOwnership = (input: CreateOwnershipInput) => Promise<{ readonly ownership: Ownership; readonly replayed: boolean }>;

export function createOwnership(deps: { readonly repository: OwnershipRepository }): CreateOwnership {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const ownership = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.create(
      ownership,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: createFingerprint(ownership) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { ownership: outcome.ownership, replayed: false };
      case 'REPLAYED':
        return { ownership: outcome.ownership, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'PROPERTY_REFERENCE_NOT_FOUND':
        throw new PropertyReferenceNotFoundError(fields.propertyReferenceId);
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(fields.ownerPartyId);
      case 'PARTY_INACTIVE':
        throw new OwnerInactiveError(fields.ownerPartyId);
      case 'OVERLAPPING_OWNERSHIP':
        throw new OverlappingOwnershipError(outcome.ownershipId);
      case 'OWNERSHIP_TOTAL_EXCEEDS_ONE':
        throw new OwnershipTotalExceedsOneError(outcome.date, outcome.shareSum);
    }
  };
}

export type GetOwnership = (input: { readonly principal: RealmPrincipal; readonly ownershipId: string }) => Promise<Ownership>;

export function getOwnership(deps: { readonly repository: OwnershipRepository }): GetOwnership {
  return async ({ principal, ownershipId }) => {
    const ownership = await deps.repository.findById(ownershipId, principal.mreRealmId);
    if (ownership === undefined) throw new OwnershipNotFoundError(ownershipId);
    return ownership;
  };
}

export type CloseOwnership = (input: {
  readonly principal: RealmPrincipal;
  readonly ownershipId: string;
  readonly validUntil: BusinessDate;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly ownership: Ownership; readonly changed: boolean }>;

export function closeOwnership(deps: { readonly repository: OwnershipRepository }): CloseOwnership {
  return async ({ principal, ownershipId, validUntil, expectedVersions }) => {
    const outcome = await deps.repository.close(ownershipId, principal.mreRealmId, validUntil, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'CLOSED':
        return { ownership: outcome.ownership, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new OwnershipNotFoundError(ownershipId);
      case 'INVALID_OWNERSHIP':
        throw new InvalidOwnershipError(ownershipId, outcome.reason);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type VoidOwnership = (input: {
  readonly principal: RealmPrincipal;
  readonly ownershipId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly ownership: Ownership; readonly changed: boolean }>;

export function voidOwnership(deps: { readonly repository: OwnershipRepository; readonly now?: () => Date }): VoidOwnership {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, ownershipId, reason, expectedVersions }) => {
    const outcome = await deps.repository.void(ownershipId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { ownership: outcome.ownership, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new OwnershipNotFoundError(ownershipId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type ReadPropertyOwnerships = (
  input: { readonly principal: RealmPrincipal; readonly propertyReferenceId: string } & (
    | { readonly asOf: BusinessDate }
    | { readonly page: { readonly page: number; readonly pageSize: number } }
  ),
) => Promise<{ readonly day: OwnershipDay } | { readonly history: OwnershipPage }>;

/** `asOf` → the ownership of that day; otherwise the paged history (§26.1). */
export function readPropertyOwnerships(deps: { readonly repository: OwnershipRepository }): ReadPropertyOwnerships {
  return async (input) => {
    const { principal, propertyReferenceId } = input;
    if ('asOf' in input) {
      const day = await deps.repository.on(propertyReferenceId, principal.mreRealmId, input.asOf);
      if (day === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
      return { day };
    }
    const history = await deps.repository.history(propertyReferenceId, principal.mreRealmId, input.page);
    if (history === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
    return { history };
  };
}

export interface ChangeOwnershipInput extends Omit<OwnershipChange, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  readonly idempotencyKey?: string;
}

/** `status`: `CREATED` (201), `REPLAYED` (201, recorded body) or `UNCHANGED` (200 no-op, §26.2). */
export type ChangeOwnership = (input: ChangeOwnershipInput) => Promise<{ readonly result: ChangeResult; readonly status: 'CREATED' | 'REPLAYED' | 'UNCHANGED' }>;

export function changeOwnership(deps: { readonly repository: OwnershipChangeRepository }): ChangeOwnership {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const change = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.change(
      change,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: changeFingerprint(change) },
    );
    switch (outcome.kind) {
      case 'CHANGED':
        return { result: outcome.result, status: outcome.replayed ? 'REPLAYED' : 'CREATED' };
      case 'UNCHANGED':
        return { result: outcome.result, status: 'UNCHANGED' };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'PROPERTY_REFERENCE_NOT_FOUND':
        throw new PropertyReferenceNotFoundError(fields.propertyReferenceId);
      case 'INVALID_OWNERSHIP':
        throw new InvalidOwnershipError(outcome.ownershipId, outcome.reason);
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(outcome.partyId);
      case 'PARTY_INACTIVE':
        throw new OwnerInactiveError(outcome.partyId);
      case 'OVERLAPPING_OWNERSHIP':
        throw new OverlappingOwnershipError(outcome.ownershipId);
      case 'OWNERSHIP_TOTAL_EXCEEDS_ONE':
        throw new OwnershipTotalExceedsOneError(outcome.date, outcome.shareSum);
      case 'OWNERSHIP_INCOMPLETE':
        throw new OwnershipIncompleteError(outcome.date, outcome.shareSum);
    }
  };
}

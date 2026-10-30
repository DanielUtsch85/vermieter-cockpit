import {
  membershipFingerprint,
  wegFingerprint,
  type InvalidMembershipReason,
  type MembershipChanges,
  type MembershipFilter,
  type NewMembership,
  type NewWeg,
  type Page,
  type PageRequest,
  type Weg,
  type WegChanges,
  type WegFilter,
  type WegMembership,
  type WegRepository,
  type WegStatus,
} from '../domains/weg/index.js';
import type { BusinessDate } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { PartyNotFoundError } from './parties.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

/**
 * WEG and membership commands and reads (api-design.md §49.1–§49.2, backlog VC-6-01), in the caller's verified Realm.
 * Input arrives validated and normalized from the API boundary (MEA normalized, texts trimmed). No MRE call (P6-D9).
 */

export class WegNotFoundError extends Error {
  override readonly name = 'WegNotFoundError';

  constructor(readonly wegId: string) {
    super(`WEG ${wegId} not found`);
  }
}

export class WegMembershipNotFoundError extends Error {
  override readonly name = 'WegMembershipNotFoundError';

  constructor(readonly membershipId: string) {
    super(`WEG membership ${membershipId} not found`);
  }
}

/** An inactive Party does not become a WEG's administrator (P2-D1 → 409 PARTY_INACTIVE, §49.1). */
export class AdministratorInactiveError extends Error {
  override readonly name = 'AdministratorInactiveError';

  constructor(readonly partyId: string) {
    super(`Party ${partyId} is inactive`);
  }
}

/** The WEG is `VOID` (→ 409 WEG_NOT_ACTIVE). */
export class WegNotActiveError extends Error {
  override readonly name = 'WegNotActiveError';

  constructor(
    readonly wegId: string,
    readonly status: WegStatus,
  ) {
    super(`WEG ${wegId} is ${status}`);
  }
}

/** Memberships that are not `VOID` hang off the WEG (→ 409 WEG_HAS_MEMBERSHIPS, P6-D1). */
export class WegHasMembershipsError extends Error {
  override readonly name = 'WegHasMembershipsError';

  constructor(
    readonly wegId: string,
    readonly membershipIds: readonly string[],
  ) {
    super(`WEG ${wegId} has active memberships`);
  }
}

/** The unit already belongs to a WEG on an overlapping day (→ 409 OVERLAPPING_WEG_MEMBERSHIP, P6-D1). */
export class OverlappingWegMembershipError extends Error {
  override readonly name = 'OverlappingWegMembershipError';

  constructor(
    readonly membershipId: string,
    readonly wegId: string,
  ) {
    super(`Overlaps membership ${membershipId} of WEG ${wegId}`);
  }
}

/** The membership is `VOID` (→ 409 MEMBERSHIP_NOT_ACTIVE). */
export class MembershipNotActiveError extends Error {
  override readonly name = 'MembershipNotActiveError';

  constructor(readonly membershipId: string) {
    super(`WEG membership ${membershipId} is VOID`);
  }
}

/** Plans and statements are filed by financial year: the start month is fixed once one exists (→ 409 WEG_HAS_YEARS, §49.5, §50). */
export class WegHasYearsError extends Error {
  override readonly name = 'WegHasYearsError';

  constructor(readonly wegId: string) {
    super(`WEG ${wegId} has plans; its financial year is fixed`);
  }
}

/** WEG splits of the unit fall outside what would remain of the membership (→ 409 MEMBERSHIP_HAS_SPLITS, §49.3). */
export class MembershipHasSplitsError extends Error {
  override readonly name = 'MembershipHasSplitsError';

  constructor(
    readonly membershipId: string,
    readonly transactionIds: readonly string[],
  ) {
    super(`WEG membership ${membershipId} covers WEG splits`);
  }
}

/** `ACTIVE` plans fall outside what would remain of the membership (→ 409 MEMBERSHIP_HAS_PLANS, §49.5). */
export class MembershipHasPlansError extends Error {
  override readonly name = 'MembershipHasPlansError';

  constructor(
    readonly membershipId: string,
    readonly economicPlanIds: readonly string[],
  ) {
    super(`WEG membership ${membershipId} has plans`);
  }
}

/** Statements that are not `VOID` fall outside what would remain of the membership (→ 409 MEMBERSHIP_HAS_STATEMENTS, §50). */
export class MembershipHasStatementsError extends Error {
  override readonly name = 'MembershipHasStatementsError';

  constructor(
    readonly membershipId: string,
    readonly statementIds: readonly string[],
  ) {
    super(`WEG membership ${membershipId} has annual statements`);
  }
}

/** Sonderumlagen that are not `VOID` fall outside what would remain of the membership (→ 409 MEMBERSHIP_HAS_ASSESSMENTS, §51A). */
export class MembershipHasAssessmentsError extends Error {
  override readonly name = 'MembershipHasAssessmentsError';

  constructor(
    readonly membershipId: string,
    readonly assessmentIds: readonly string[],
  ) {
    super(`WEG membership ${membershipId} has special assessments`);
  }
}

/** An end the membership's period does not allow (→ 422 INVALID_MEMBERSHIP with the reason, §49.2). */
export class InvalidMembershipError extends Error {
  override readonly name = 'InvalidMembershipError';

  constructor(
    readonly membershipId: string,
    readonly reason: InvalidMembershipReason,
  ) {
    super(`WEG membership ${membershipId}: ${reason}`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

const idempotencyOf = (key: string | undefined, fingerprint: () => string) => (key === undefined ? undefined : { key, fingerprint: fingerprint() });

export interface CreateWegInput extends Omit<NewWeg, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  readonly idempotencyKey?: string;
}

export type CreateWeg = (input: CreateWegInput) => Promise<{ readonly weg: Weg; readonly replayed: boolean }>;

export function createWeg(deps: { readonly repository: WegRepository }): CreateWeg {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const weg = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.createWeg(
      weg,
      actorOf(principal),
      idempotencyOf(idempotencyKey, () => wegFingerprint(weg)),
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { weg: outcome.weg, replayed: false };
      case 'REPLAYED':
        return { weg: outcome.weg, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(outcome.partyId);
      case 'PARTY_INACTIVE':
        throw new AdministratorInactiveError(outcome.partyId);
    }
  };
}

export type GetWeg = (input: { readonly principal: RealmPrincipal; readonly wegId: string }) => Promise<Weg>;

export function getWeg(deps: { readonly repository: WegRepository }): GetWeg {
  return async ({ principal, wegId }) => {
    const weg = await deps.repository.findWeg(wegId, principal.mreRealmId);
    if (weg === undefined) throw new WegNotFoundError(wegId);
    return weg;
  };
}

export type ListWegs = (input: { readonly principal: RealmPrincipal; readonly filter: WegFilter; readonly page: PageRequest }) => Promise<Page<Weg>>;

export function listWegs(deps: { readonly repository: WegRepository }): ListWegs {
  return ({ principal, filter, page }) => deps.repository.listWegs(principal.mreRealmId, filter, page);
}

export type AmendWeg = (input: {
  readonly principal: RealmPrincipal;
  readonly wegId: string;
  readonly changes: WegChanges;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly weg: Weg; readonly changed: boolean }>;

export function amendWeg(deps: { readonly repository: WegRepository }): AmendWeg {
  return async ({ principal, wegId, changes, expectedVersions }) => {
    const outcome = await deps.repository.amendWeg(wegId, principal.mreRealmId, changes, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'AMENDED':
        return { weg: outcome.weg, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new WegNotFoundError(wegId);
      case 'WEG_NOT_ACTIVE':
        throw new WegNotActiveError(wegId, outcome.status);
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(outcome.partyId);
      case 'PARTY_INACTIVE':
        throw new AdministratorInactiveError(outcome.partyId);
      case 'WEG_HAS_YEARS':
        throw new WegHasYearsError(wegId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type VoidWeg = (input: {
  readonly principal: RealmPrincipal;
  readonly wegId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly weg: Weg; readonly changed: boolean }>;

export function voidWeg(deps: { readonly repository: WegRepository; readonly now?: () => Date }): VoidWeg {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, wegId, reason, expectedVersions }) => {
    const outcome = await deps.repository.voidWeg(wegId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { weg: outcome.weg, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new WegNotFoundError(wegId);
      case 'WEG_HAS_MEMBERSHIPS':
        throw new WegHasMembershipsError(wegId, outcome.membershipIds);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export interface CreateMembershipInput extends Omit<NewMembership, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  readonly idempotencyKey?: string;
}

export type CreateMembership = (input: CreateMembershipInput) => Promise<{ readonly membership: WegMembership; readonly replayed: boolean }>;

export function createMembership(deps: { readonly repository: WegRepository }): CreateMembership {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const membership = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.createMembership(
      membership,
      actorOf(principal),
      idempotencyOf(idempotencyKey, () => membershipFingerprint(membership)),
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { membership: outcome.membership, replayed: false };
      case 'REPLAYED':
        return { membership: outcome.membership, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'WEG_NOT_FOUND':
        throw new WegNotFoundError(fields.wegId);
      case 'WEG_NOT_ACTIVE':
        throw new WegNotActiveError(fields.wegId, outcome.status);
      case 'PROPERTY_REFERENCE_NOT_FOUND':
        throw new PropertyReferenceNotFoundError(fields.propertyReferenceId);
      case 'OVERLAPPING_WEG_MEMBERSHIP':
        throw new OverlappingWegMembershipError(outcome.membershipId, outcome.wegId);
    }
  };
}

export type GetMembership = (input: { readonly principal: RealmPrincipal; readonly membershipId: string }) => Promise<WegMembership>;

export function getMembership(deps: { readonly repository: WegRepository }): GetMembership {
  return async ({ principal, membershipId }) => {
    const membership = await deps.repository.findMembership(membershipId, principal.mreRealmId);
    if (membership === undefined) throw new WegMembershipNotFoundError(membershipId);
    return membership;
  };
}

export type ListMemberships = (input: {
  readonly principal: RealmPrincipal;
  readonly wegId: string;
  readonly filter: MembershipFilter;
  readonly page: PageRequest;
}) => Promise<Page<WegMembership>>;

export function listMemberships(deps: { readonly repository: WegRepository }): ListMemberships {
  return async ({ principal, wegId, filter, page }) => {
    const result = await deps.repository.listMemberships(wegId, principal.mreRealmId, filter, page);
    if (result === undefined) throw new WegNotFoundError(wegId);
    return result;
  };
}

export type ReadUnitMemberships = (
  input: { readonly principal: RealmPrincipal; readonly propertyReferenceId: string } & ({ readonly asOf: BusinessDate } | { readonly page: PageRequest }),
) => Promise<{ readonly membership: WegMembership | null } | { readonly history: Page<WegMembership> }>;

/** `asOf` → the unit's membership that day, or null; otherwise its paged history across WEGs (§49.2). */
export function readUnitMemberships(deps: { readonly repository: WegRepository }): ReadUnitMemberships {
  return async (input) => {
    const { principal, propertyReferenceId } = input;
    if ('asOf' in input) {
      const membership = await deps.repository.unitOn(propertyReferenceId, principal.mreRealmId, input.asOf);
      if (membership === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
      return { membership };
    }
    const history = await deps.repository.unitHistory(propertyReferenceId, principal.mreRealmId, input.page);
    if (history === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
    return { history };
  };
}

export type AmendMembership = (input: {
  readonly principal: RealmPrincipal;
  readonly membershipId: string;
  readonly changes: MembershipChanges;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly membership: WegMembership; readonly changed: boolean }>;

export function amendMembership(deps: { readonly repository: WegRepository }): AmendMembership {
  return async ({ principal, membershipId, changes, expectedVersions }) => {
    const outcome = await deps.repository.amendMembership(membershipId, principal.mreRealmId, changes, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'AMENDED':
        return { membership: outcome.membership, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new WegMembershipNotFoundError(membershipId);
      case 'MEMBERSHIP_NOT_ACTIVE':
        throw new MembershipNotActiveError(membershipId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type EndMembership = (input: {
  readonly principal: RealmPrincipal;
  readonly membershipId: string;
  readonly validUntil: BusinessDate;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly membership: WegMembership; readonly changed: boolean }>;

export function endMembership(deps: { readonly repository: WegRepository }): EndMembership {
  return async ({ principal, membershipId, validUntil, expectedVersions }) => {
    const outcome = await deps.repository.endMembership(membershipId, principal.mreRealmId, validUntil, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'ENDED':
        return { membership: outcome.membership, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new WegMembershipNotFoundError(membershipId);
      case 'MEMBERSHIP_NOT_ACTIVE':
        throw new MembershipNotActiveError(membershipId);
      case 'INVALID_MEMBERSHIP':
        throw new InvalidMembershipError(membershipId, outcome.reason);
      case 'MEMBERSHIP_HAS_SPLITS':
        throw new MembershipHasSplitsError(membershipId, outcome.transactionIds);
      case 'MEMBERSHIP_HAS_PLANS':
        throw new MembershipHasPlansError(membershipId, outcome.economicPlanIds);
      case 'MEMBERSHIP_HAS_STATEMENTS':
        throw new MembershipHasStatementsError(membershipId, outcome.statementIds);
      case 'MEMBERSHIP_HAS_ASSESSMENTS':
        throw new MembershipHasAssessmentsError(membershipId, outcome.assessmentIds);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type VoidMembership = (input: {
  readonly principal: RealmPrincipal;
  readonly membershipId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly membership: WegMembership; readonly changed: boolean }>;

export function voidMembership(deps: { readonly repository: WegRepository; readonly now?: () => Date }): VoidMembership {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, membershipId, reason, expectedVersions }) => {
    const outcome = await deps.repository.voidMembership(membershipId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { membership: outcome.membership, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new WegMembershipNotFoundError(membershipId);
      case 'MEMBERSHIP_HAS_SPLITS':
        throw new MembershipHasSplitsError(membershipId, outcome.transactionIds);
      case 'MEMBERSHIP_HAS_PLANS':
        throw new MembershipHasPlansError(membershipId, outcome.economicPlanIds);
      case 'MEMBERSHIP_HAS_STATEMENTS':
        throw new MembershipHasStatementsError(membershipId, outcome.statementIds);
      case 'MEMBERSHIP_HAS_ASSESSMENTS':
        throw new MembershipHasAssessmentsError(membershipId, outcome.assessmentIds);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

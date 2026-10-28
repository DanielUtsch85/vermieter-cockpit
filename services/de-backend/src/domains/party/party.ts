import type { AuditActor, VersionConflict } from '../../shared/index.js';

/**
 * Party (data-model.md §7, ADR-009; api-design.md §19.1, backlog VC-2-01): one canonical person or organization in
 * a Realm, holding any number of roles. DE stores it as minimal identity (phase-2-plan P2-D1): what the user enters,
 * never synchronised from MRE, never matched or merged automatically.
 */

export type PartyId = string & { readonly __brand: 'PartyId' };

export const PARTY_TYPES = ['PERSON', 'ORGANIZATION'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const PARTY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type PartyStatus = (typeof PARTY_STATUSES)[number];

/** Fields only a PERSON may carry, and only an ORGANIZATION (data-model.md §7.3–7.4). */
export const PERSON_FIELDS = ['firstName', 'lastName'] as const;
export const ORGANIZATION_FIELDS = ['legalName', 'registrationNumber'] as const;
/** Every field `amend` may change; `partyType` is fixed after creation (§19.1). */
export const PARTY_FIELDS = ['displayName', ...PERSON_FIELDS, ...ORGANIZATION_FIELDS, 'email', 'phone'] as const;
export type PartyField = (typeof PARTY_FIELDS)[number];
export type TypeSpecificField = (typeof PERSON_FIELDS)[number] | (typeof ORGANIZATION_FIELDS)[number];

export interface PartyData {
  readonly displayName: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly legalName: string | null;
  readonly registrationNumber: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

export interface Party extends PartyData {
  readonly id: PartyId;
  readonly mreRealmId: string;
  readonly partyType: PartyType;
  readonly status: PartyStatus;
  readonly deactivatedAt: Date | null;
  readonly deactivationReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A validated, normalized Party about to be created (trimmed; empty optional strings are null). */
export interface NewParty extends PartyData {
  readonly mreRealmId: string;
  readonly partyType: PartyType;
}

/** The fields to change; `undefined` = keep, `null` clears an optional one. */
export type PartyChanges = { readonly [F in Exclude<PartyField, 'displayName'>]?: string | null } & {
  readonly displayName?: string;
};

/** The type-specific fields set on a Party of the other type (→ 400 `NOT_ALLOWED_FOR_TYPE`). */
export function fieldsNotAllowed(partyType: PartyType, data: Partial<Record<TypeSpecificField, string | null | undefined>>): TypeSpecificField[] {
  const others: readonly TypeSpecificField[] = partyType === 'PERSON' ? ORGANIZATION_FIELDS : PERSON_FIELDS;
  return others.filter((field) => data[field] !== undefined && data[field] !== null);
}

/** Identity of a create request for `Idempotency-Key` replays: the normalized payload. */
export function createFingerprint(party: NewParty): string {
  return JSON.stringify([party.partyType, ...PARTY_FIELDS.map((field) => party[field])]);
}

export type AmendPlan =
  | { readonly kind: 'AMEND'; readonly values: PartyData; readonly changed: readonly PartyField[] }
  /** Every given value equals the current one: a 200 no-op, answered whatever the version (§16.1). */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'NOT_ALLOWED_FOR_TYPE'; readonly partyType: PartyType; readonly fields: readonly TypeSpecificField[] };

/**
 * `amend` changes the Party's data, for an INACTIVE Party too: correcting a name creates no role (P2-D1), and a
 * deceased owner's name must stay correctable. It never changes `status` or `partyType`.
 */
export function planAmend(current: Party, changes: PartyChanges): AmendPlan {
  const notAllowed = fieldsNotAllowed(current.partyType, changes);
  if (notAllowed.length > 0) return { kind: 'NOT_ALLOWED_FOR_TYPE', partyType: current.partyType, fields: notAllowed };
  const values = Object.fromEntries(
    PARTY_FIELDS.map((field) => [field, changes[field] === undefined ? current[field] : changes[field]]),
  ) as unknown as PartyData;
  const changed = PARTY_FIELDS.filter((field) => values[field] !== current[field]);
  return changed.length === 0 ? { kind: 'UNCHANGED' } : { kind: 'AMEND', values, changed };
}

export type DeactivatePlan =
  | { readonly kind: 'DEACTIVATE'; readonly next: Party }
  /** Already inactive: a 200 no-op whatever the reason or version; the first reason and time stay (§19.1). */
  | { readonly kind: 'UNCHANGED' };

export function planDeactivate(current: Party, reason: string, at: Date): DeactivatePlan {
  if (current.status === 'INACTIVE') return { kind: 'UNCHANGED' };
  return {
    kind: 'DEACTIVATE',
    next: { ...current, status: 'INACTIVE', deactivatedAt: at, deactivationReason: reason, version: current.version + 1 },
  };
}

export type CreatePartyOutcome =
  | { readonly kind: 'CREATED'; readonly party: Party }
  /** Same key, same payload: the Party as the first request created it. */
  | { readonly kind: 'REPLAYED'; readonly party: Party }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' };

export type AmendPartyOutcome =
  | { readonly kind: 'AMENDED'; readonly party: Party; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict
  | Exclude<AmendPlan, { kind: 'AMEND' | 'UNCHANGED' }>;

export type DeactivatePartyOutcome =
  | { readonly kind: 'DEACTIVATED'; readonly party: Party; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict;

export interface PartyFilter {
  readonly partyType?: PartyType;
  readonly status?: PartyStatus;
  /** Substring of displayName, legalName, firstName or lastName, matched literally and case-insensitively. */
  readonly name?: string;
  /** The Party holding this MRE Tenant `_id` in an active reference (api-design.md §20.1). */
  readonly externalReference?: { readonly system: 'MRE'; readonly externalId: string };
}

export interface PartyPage {
  readonly items: readonly Party[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface PartyRepository {
  /** Creates the Party and its AuditRecord in one transaction, claiming the idempotency key there too. */
  create(party: NewParty, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreatePartyOutcome>;
  findById(id: string, mreRealmId: string): Promise<Party | undefined>;
  /** Ordered by displayName (case-insensitive), then id; count and page in one snapshot. */
  list(mreRealmId: string, filter: PartyFilter, page: { readonly page: number; readonly pageSize: number }): Promise<PartyPage>;
  /** Applies `planAmend` under a row lock; the version is checked only when something changes. */
  amend(id: string, mreRealmId: string, changes: PartyChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendPartyOutcome>;
  /** Applies `planDeactivate` under a row lock; a no-op answers whatever the version. */
  deactivate(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<DeactivatePartyOutcome>;
}

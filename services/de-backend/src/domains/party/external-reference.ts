import type { AuditActor, VersionConflict } from '../../shared/index.js';
import type { Party, PartyId } from './party.js';

/**
 * PartyExternalReference (data-model.md §8, api-design.md §20.1, backlog VC-2-02): links a Party to a record of
 * another system. Phase 2 holds MRE Tenant references only (phase-2-plan P2-D2). "Active" is a status, not a period:
 * among active references a key resolves to at most one Party; an ended reference is kept and frees its key.
 */

export type ExternalReferenceId = string & { readonly __brand: 'ExternalReferenceId' };

export const EXTERNAL_SYSTEMS = ['MRE'] as const;
export type ExternalSystem = (typeof EXTERNAL_SYSTEMS)[number];

export const EXTERNAL_ENTITY_TYPES = ['tenant'] as const;
export type ExternalEntityType = (typeof EXTERNAL_ENTITY_TYPES)[number];

export const EXTERNAL_REFERENCE_STATUSES = ['ACTIVE', 'ENDED'] as const;
export type ExternalReferenceStatus = (typeof EXTERNAL_REFERENCE_STATUSES)[number];

/** An MRE `_id` (24-hex ObjectId), checked before MRE is asked (mre-integration.md §20.1). */
export const MRE_EXTERNAL_ID = /^[0-9a-f]{24}$/;

/** What resolves to one Party among active references. */
export interface ExternalReferenceKey {
  readonly system: ExternalSystem;
  readonly mreRealmId: string;
  readonly entityType: ExternalEntityType;
  readonly externalId: string;
}

export interface PartyExternalReference extends ExternalReferenceKey {
  readonly id: ExternalReferenceId;
  readonly partyId: PartyId;
  readonly status: ExternalReferenceStatus;
  readonly endedAt: Date | null;
  readonly createdAt: Date;
  readonly version: number;
}

export type ClaimPlan =
  /** The Party already holds the key actively: a 200 success repeat, also for an INACTIVE Party (§20.1 step 2). */
  | { readonly kind: 'EXISTING'; readonly reference: PartyExternalReference }
  /** Another Party holds it actively (→ 409 REFERENCE_IN_USE). */
  | { readonly kind: 'IN_USE'; readonly partyId: PartyId }
  /** No new reference for an inactive Party (P2-D1 → 409 PARTY_INACTIVE). */
  | { readonly kind: 'PARTY_INACTIVE' }
  /** Free to claim: MRE is asked (before the write) and the reference is created. */
  | { readonly kind: 'CLAIM' };

/** Steps 2–4 of §20.1, in that order: a success repeat before any refusal, `IN_USE` before `PARTY_INACTIVE`. */
export function planClaim(party: Party, active: PartyExternalReference | undefined): ClaimPlan {
  if (active !== undefined) {
    return active.partyId === party.id ? { kind: 'EXISTING', reference: active } : { kind: 'IN_USE', partyId: active.partyId };
  }
  return party.status === 'INACTIVE' ? { kind: 'PARTY_INACTIVE' } : { kind: 'CLAIM' };
}

export type EndPlan =
  | { readonly kind: 'END'; readonly next: PartyExternalReference }
  /** Already ended: a 200 no-op whatever the version; the first `endedAt` stays (§20.1). */
  | { readonly kind: 'UNCHANGED' };

export function planEnd(current: PartyExternalReference, at: Date): EndPlan {
  if (current.status === 'ENDED') return { kind: 'UNCHANGED' };
  return { kind: 'END', next: { ...current, status: 'ENDED', endedAt: at, version: current.version + 1 } };
}

export type ClaimOutcome =
  | { readonly kind: 'CREATED'; readonly reference: PartyExternalReference }
  | { readonly kind: 'NOT_FOUND' }
  /** Every attempt lost to a claim that was ended again before it could be read: nothing written, retry (→ 503). */
  | { readonly kind: 'CONTENDED' }
  | Exclude<ClaimPlan, { kind: 'CLAIM' }>;

/** Before MRE is asked: the plan, or `NOT_FOUND` for an unknown or foreign Party. */
export type ClaimCheck = { readonly kind: 'NOT_FOUND' } | ClaimPlan;

export type EndOutcome =
  | { readonly kind: 'ENDED'; readonly reference: PartyExternalReference; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict;

export interface ExternalReferencePage {
  readonly items: readonly PartyExternalReference[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface PartyExternalReferenceRepository {
  /** Read-only `planClaim` against the current state, to decide whether MRE needs to be asked. */
  checkClaim(partyId: string, key: ExternalReferenceKey): Promise<ClaimCheck>;
  /**
   * Under the Party's row lock: `planClaim` again, then the insert. A concurrent claim by another Party is settled
   * by the active-key index, never by an aborted transaction (§20.1).
   */
  claim(partyId: string, key: ExternalReferenceKey, actor: AuditActor): Promise<ClaimOutcome>;
  /** Applies `planEnd` under the reference's row lock; the version is checked only when it changes. */
  end(partyId: string, referenceId: string, mreRealmId: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<EndOutcome>;
  /** The Party's references, oldest first; undefined for an unknown or foreign Party. Count and page in one snapshot. */
  list(
    partyId: string,
    mreRealmId: string,
    filter: { readonly status?: ExternalReferenceStatus },
    page: { readonly page: number; readonly pageSize: number },
  ): Promise<ExternalReferencePage | undefined>;
}

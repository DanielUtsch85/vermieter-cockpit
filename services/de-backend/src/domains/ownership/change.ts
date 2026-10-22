import { addDays, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { checkInvariants, ownershipOn, type Completeness, type InvalidOwnershipReason, type InvariantViolation, type Ownership } from './ownership.js';
import type { Fraction, Share } from './share.js';

/**
 * Ownership change (api-design.md §26.2, phase-2-plan P2-D5, backlog VC-2-04): a sale, inheritance or transfer as one
 * atomic command. The listed Ownerships end on `effectiveDate − 1`, the new ones start on `effectiveDate`.
 */

export interface NewOwner {
  readonly ownerPartyId: string;
  readonly share: Share;
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

export interface OwnershipChange {
  readonly mreRealmId: string;
  readonly propertyReferenceId: string;
  readonly effectiveDate: BusinessDate;
  readonly reason: string;
  /** Ownership ids, no duplicates. */
  readonly close: readonly string[];
  /** One entry per owner at most. */
  readonly create: readonly NewOwner[];
}

/** Identity of a change request for `Idempotency-Key` replays: the normalized body, `close` sorted. */
export function changeFingerprint(change: OwnershipChange): string {
  return JSON.stringify([
    change.propertyReferenceId,
    change.effectiveDate,
    change.reason,
    [...change.close].sort(),
    change.create.map((c) => [c.ownerPartyId, c.share.numerator, c.share.denominator, c.sourceReferences, c.notes]),
  ]);
}

export type ChangePlan =
  | {
      readonly kind: 'CHANGE';
      /** The listed Ownerships that end now, with their new `validUntil`; one already ending on `effectiveDate − 1` is not here. */
      readonly closes: readonly { readonly ownership: Ownership; readonly validUntil: BusinessDate }[];
    }
  /** Nothing to create and every listed Ownership already ends on `effectiveDate − 1`: a 200 no-op (§26.2). */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'INVALID_OWNERSHIP'; readonly ownershipId: string; readonly reason: InvalidOwnershipReason | 'NOT_FOUND' }
  | (InvariantViolation & { readonly createIndex: number })
  | { readonly kind: 'OWNERSHIP_INCOMPLETE'; readonly date: BusinessDate; readonly shareSum: Fraction };

/**
 * The rules of §26.2 in their order, over the PropertyReference's Ownerships (`existing`, `VOID` ones included):
 * the listed Ownerships in the order given, then the invariants after the change, written as the repository writes
 * (closes first, then each create against the state so far), then completeness on `effectiveDate`.
 */
export function planChange(existing: readonly Ownership[], change: Pick<OwnershipChange, 'effectiveDate' | 'close' | 'create'>): ChangePlan {
  const lastDay = addDays(change.effectiveDate, -1);
  const byId = new Map(existing.map((o) => [o.id as string, o]));
  const closes: { ownership: Ownership; validUntil: BusinessDate }[] = [];
  for (const id of change.close) {
    const ownership = byId.get(id);
    if (ownership === undefined) return { kind: 'INVALID_OWNERSHIP', ownershipId: id, reason: 'NOT_FOUND' };
    if (ownership.status === 'VOID') return { kind: 'INVALID_OWNERSHIP', ownershipId: id, reason: 'VOID' };
    if (ownership.validFrom >= change.effectiveDate) return { kind: 'INVALID_OWNERSHIP', ownershipId: id, reason: 'STARTS_ON_OR_AFTER_EFFECTIVE_DATE' };
    if (ownership.validUntil !== null && ownership.validUntil < lastDay) return { kind: 'INVALID_OWNERSHIP', ownershipId: id, reason: 'ALREADY_ENDED' };
    if (ownership.validUntil !== lastDay) closes.push({ ownership, validUntil: lastDay });
  }
  if (change.create.length === 0 && closes.length === 0) return { kind: 'UNCHANGED' };

  const closedIds = new Set(closes.map((c) => c.ownership.id as string));
  let state: Ownership[] = existing.map((o) => (closedIds.has(o.id) ? { ...o, validUntil: lastDay } : o));
  for (const [index, create] of change.create.entries()) {
    const candidate = { ownerPartyId: create.ownerPartyId, share: create.share, validFrom: change.effectiveDate, validUntil: null };
    const violation = checkInvariants(state, candidate);
    if (violation !== undefined) return { ...violation, createIndex: index };
    // A placeholder row for the following creates' checks; its id never surfaces in a refusal for another owner.
    state = [...state, { ...state[0], ...candidate, id: `new:${index}`, status: 'VALID' } as Ownership];
  }

  const before = ownershipOn(existing, lastDay);
  const after = ownershipOn(state, change.effectiveDate);
  if (before.completeness === 'COMPLETE' && after.completeness !== 'COMPLETE') {
    return { kind: 'OWNERSHIP_INCOMPLETE', date: change.effectiveDate, shareSum: after.shareSum };
  }
  return { kind: 'CHANGE', closes: [...closes].sort((a, b) => (a.ownership.id < b.ownership.id ? -1 : 1)) };
}

export interface ChangeResult {
  readonly propertyReferenceId: string;
  readonly effectiveDate: BusinessDate;
  readonly reason: string;
  /** The listed Ownerships as they are after the change, in the order given. */
  readonly closed: readonly Ownership[];
  /** The new Ownerships, in the order given. */
  readonly created: readonly Ownership[];
  readonly completeness: Completeness;
  readonly shareSum: Fraction;
}

export type ChangeOwnershipOutcome =
  | { readonly kind: 'CHANGED'; readonly result: ChangeResult; readonly replayed: boolean }
  | { readonly kind: 'UNCHANGED'; readonly result: ChangeResult }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND' }
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | { readonly kind: 'PARTY_INACTIVE'; readonly partyId: string }
  | Exclude<ChangePlan, { kind: 'CHANGE' | 'UNCHANGED' }>;

/** Persistence port for the change, implemented in infrastructure/postgres. */
export interface OwnershipChangeRepository {
  /**
   * One READ COMMITTED transaction: claims the key, touches the PropertyReference, locks the new owners `FOR SHARE`
   * and the listed Ownerships `FOR UPDATE` (each in id order), applies `planChange`, then writes all closes before
   * all creates (§26.2). A refusal rolls everything back.
   */
  change(change: OwnershipChange, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<ChangeOwnershipOutcome>;
}

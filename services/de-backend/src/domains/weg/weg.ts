import { type AuditActor, type BusinessDate, type VersionConflict } from '../../shared/index.js';
import type { Mea } from './mea.js';

/**
 * WEG and WegMembership (data-model.md §27–§28, api-design.md §49.1–§49.2, phase-6-plan P6-D1): the landlord-side
 * record of a Wohnungseigentümergemeinschaft and of a unit's place in it for a period. No MRE counterpart (BR-WEG-001).
 * A WEG is `ACTIVE` → `VOID`; a membership is a period of inclusive business dates, `ACTIVE` → `VOID`, and a unit has
 * at most one `ACTIVE` membership on any day, across all WEGs of the Realm.
 */

export type WegId = string & { readonly __brand: 'WegId' };
export type WegMembershipId = string & { readonly __brand: 'WegMembershipId' };

export const WEG_STATUSES = ['ACTIVE', 'VOID'] as const;
export type WegStatus = (typeof WEG_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ['ACTIVE', 'VOID'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** The fields `amend` may change while the WEG is `ACTIVE`. */
export interface WegAmendable {
  readonly displayName: string;
  readonly administratorPartyId: string | null;
  /** 1–12; the first month of the WEG's Wirtschaftsjahr. */
  readonly financialYearStartMonth: number;
  readonly notes: string | null;
}

export interface Weg extends WegAmendable {
  readonly id: WegId;
  readonly mreRealmId: string;
  readonly status: WegStatus;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A validated WEG about to be created. */
export interface NewWeg extends WegAmendable {
  readonly mreRealmId: string;
}

/** The fields a membership's `amend` may change while `ACTIVE`; everything else is fixed (§49.2). */
export interface MembershipAmendable {
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

export interface WegMembership extends MembershipAmendable {
  readonly id: WegMembershipId;
  readonly mreRealmId: string;
  readonly wegId: string;
  readonly propertyReferenceId: string;
  readonly mea: Mea;
  readonly validFrom: BusinessDate;
  readonly validUntil: BusinessDate | null;
  readonly status: MembershipStatus;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A validated membership about to be created (texts trimmed, MEA normalized). */
export interface NewMembership extends MembershipAmendable {
  readonly mreRealmId: string;
  readonly wegId: string;
  readonly propertyReferenceId: string;
  readonly mea: Mea;
  readonly validFrom: BusinessDate;
  readonly validUntil: BusinessDate | null;
}

/** Identity of a WEG create for `Idempotency-Key` replays: the normalized body. */
export function wegFingerprint(weg: NewWeg): string {
  return JSON.stringify([weg.displayName, weg.administratorPartyId, weg.financialYearStartMonth, weg.notes]);
}

/** Identity of a membership create for `Idempotency-Key` replays: the normalized body, with the WEG. */
export function membershipFingerprint(membership: NewMembership): string {
  return JSON.stringify([
    membership.wegId,
    membership.propertyReferenceId,
    membership.mea.numerator,
    membership.mea.denominator,
    membership.validFrom,
    membership.validUntil,
    membership.sourceReferences,
    membership.notes,
  ]);
}

/** Inclusive business dates; `until` null is open-ended. ISO dates compare as strings. */
interface Period {
  readonly from: BusinessDate;
  readonly until: BusinessDate | null;
}

const covers = (period: Period, day: BusinessDate) => period.from <= day && (period.until === null || day <= period.until);
const overlaps = (a: Period, b: Period) => (a.until === null || b.from <= a.until) && (b.until === null || a.from <= b.until);
const periodOf = (m: Pick<WegMembership, 'validFrom' | 'validUntil'>): Period => ({ from: m.validFrom, until: m.validUntil });

/** One WEG per unit at a time (P6-D1): the `ACTIVE` membership of the unit the candidate period overlaps, if any. */
export function overlappingMembership(
  existing: readonly WegMembership[],
  candidate: Pick<WegMembership, 'validFrom' | 'validUntil'>,
): WegMembership | undefined {
  return existing.find((m) => m.status === 'ACTIVE' && overlaps(periodOf(m), periodOf(candidate)));
}

/** The unit's `ACTIVE` membership valid on a day, at most one by the rule above. */
export function membershipOn(memberships: readonly WegMembership[], asOf: BusinessDate): WegMembership | null {
  return memberships.find((m) => m.status === 'ACTIVE' && covers(periodOf(m), asOf)) ?? null;
}

export const WEG_AMENDABLE_FIELDS = ['displayName', 'administratorPartyId', 'financialYearStartMonth', 'notes'] as const;
export type WegAmendableField = (typeof WEG_AMENDABLE_FIELDS)[number];
export type WegChanges = { readonly [F in WegAmendableField]?: WegAmendable[F] };

export type WegAmendPlan =
  | {
      readonly kind: 'AMEND';
      readonly values: WegAmendable;
      readonly changed: readonly WegAmendableField[];
      /** The administrator this amend names anew, to check. */
      readonly newAdministratorId: string | null;
    }
  /** Every given value equals the current one: a 200 no-op, answered whatever the version (§16.1). */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'WEG_NOT_ACTIVE'; readonly status: WegStatus };

export function planWegAmend(current: Weg, changes: WegChanges): WegAmendPlan {
  if (current.status !== 'ACTIVE') return { kind: 'WEG_NOT_ACTIVE', status: current.status };
  const values: WegAmendable = {
    displayName: changes.displayName ?? current.displayName,
    administratorPartyId: changes.administratorPartyId === undefined ? current.administratorPartyId : changes.administratorPartyId,
    financialYearStartMonth: changes.financialYearStartMonth ?? current.financialYearStartMonth,
    notes: changes.notes === undefined ? current.notes : changes.notes,
  };
  const changed = WEG_AMENDABLE_FIELDS.filter((field) => values[field] !== current[field]);
  if (changed.length === 0) return { kind: 'UNCHANGED' };
  const newAdministratorId = changed.includes('administratorPartyId') ? values.administratorPartyId : null;
  return { kind: 'AMEND', values, changed, newAdministratorId };
}

export type WegVoidPlan =
  | { readonly kind: 'VOID'; readonly next: Weg }
  /** Already void: a 200 no-op whatever the reason or version; the first reason and time stay. */
  | { readonly kind: 'UNCHANGED' }
  /** A membership that is not `VOID` hangs off the WEG (→ 409 WEG_HAS_MEMBERSHIPS, P6-D1). */
  | { readonly kind: 'WEG_HAS_MEMBERSHIPS'; readonly membershipIds: readonly string[] };

export function planWegVoid(current: Weg, reason: string, at: Date, activeMembershipIds: readonly string[]): WegVoidPlan {
  if (current.status === 'VOID') return { kind: 'UNCHANGED' };
  if (activeMembershipIds.length > 0) return { kind: 'WEG_HAS_MEMBERSHIPS', membershipIds: [...activeMembershipIds].sort() };
  return { kind: 'VOID', next: { ...current, status: 'VOID', voidedAt: at, voidReason: reason, version: current.version + 1 } };
}

export type MembershipChanges = { readonly [F in keyof MembershipAmendable]?: MembershipAmendable[F] };

export type MembershipAmendPlan =
  | { readonly kind: 'AMEND'; readonly values: MembershipAmendable; readonly changed: readonly (keyof MembershipAmendable)[] }
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'MEMBERSHIP_NOT_ACTIVE' };

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function planMembershipAmend(current: WegMembership, changes: MembershipChanges): MembershipAmendPlan {
  if (current.status !== 'ACTIVE') return { kind: 'MEMBERSHIP_NOT_ACTIVE' };
  const values: MembershipAmendable = {
    sourceReferences: changes.sourceReferences ?? current.sourceReferences,
    notes: changes.notes === undefined ? current.notes : changes.notes,
  };
  const changed = (['sourceReferences', 'notes'] as const).filter((field) =>
    field === 'sourceReferences' ? !sameList(values.sourceReferences, current.sourceReferences) : values.notes !== current.notes,
  );
  if (changed.length === 0) return { kind: 'UNCHANGED' };
  return { kind: 'AMEND', values, changed };
}

/** Why an end is refused (`422 INVALID_MEMBERSHIP`, §49.2). */
export type InvalidMembershipReason = 'STARTS_AFTER_END' | 'ALREADY_ENDED';

export type MembershipEndPlan =
  | { readonly kind: 'END'; readonly next: WegMembership }
  /** Already ends on that day: a 200 no-op whatever the version. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'MEMBERSHIP_NOT_ACTIVE' }
  | { readonly kind: 'INVALID_MEMBERSHIP'; readonly reason: InvalidMembershipReason };

/** Sets or shortens `validUntil`; an end never extends a period (§49.2, as §26.1's close). */
export function planMembershipEnd(current: WegMembership, validUntil: BusinessDate): MembershipEndPlan {
  if (current.status !== 'ACTIVE') return { kind: 'MEMBERSHIP_NOT_ACTIVE' };
  if (validUntil < current.validFrom) return { kind: 'INVALID_MEMBERSHIP', reason: 'STARTS_AFTER_END' };
  if (current.validUntil === validUntil) return { kind: 'UNCHANGED' };
  if (current.validUntil !== null && current.validUntil < validUntil) return { kind: 'INVALID_MEMBERSHIP', reason: 'ALREADY_ENDED' };
  return { kind: 'END', next: { ...current, validUntil, version: current.version + 1 } };
}

export type MembershipVoidPlan = { readonly kind: 'VOID'; readonly next: WegMembership } | { readonly kind: 'UNCHANGED' };

export function planMembershipVoid(current: WegMembership, reason: string, at: Date): MembershipVoidPlan {
  if (current.status === 'VOID') return { kind: 'UNCHANGED' };
  return { kind: 'VOID', next: { ...current, status: 'VOID', voidedAt: at, voidReason: reason, version: current.version + 1 } };
}

/**
 * What hangs off a membership's period (§49.3, §49.5, §50): its unit's WEG splits, its `ACTIVE` plans and its
 * statements that are not `VOID`.
 */
export interface MembershipHolds {
  readonly splits: readonly { readonly transactionId: string; readonly bookingDate: BusinessDate }[];
  readonly plans: readonly { readonly id: string; readonly effectiveFrom: BusinessDate }[];
  readonly statements: readonly { readonly id: string; readonly periodFrom: BusinessDate; readonly periodUntil: BusinessDate }[];
}

export type MembershipHoldRefusal =
  | { readonly kind: 'MEMBERSHIP_HAS_SPLITS'; readonly transactionIds: readonly string[] }
  | { readonly kind: 'MEMBERSHIP_HAS_PLANS'; readonly economicPlanIds: readonly string[] }
  | { readonly kind: 'MEMBERSHIP_HAS_STATEMENTS'; readonly statementIds: readonly string[] };

/**
 * An end (`remaining` the shortened period) or a void (`remaining` null) refused because a WEG split of the unit, an
 * `ACTIVE` plan or a statement would fall outside what remains of the membership's period: splits, plans, statements.
 */
export function holdsOutside(
  current: WegMembership,
  remaining: Pick<WegMembership, 'validFrom' | 'validUntil'> | null,
  holds: MembershipHolds,
): MembershipHoldRefusal | undefined {
  const old = periodOf(current);
  const kept = (day: BusinessDate) => remaining !== null && covers(periodOf(remaining), day);
  const splits = [...new Set(holds.splits.filter((s) => covers(old, s.bookingDate) && !kept(s.bookingDate)).map((s) => s.transactionId))].sort();
  if (splits.length > 0) return { kind: 'MEMBERSHIP_HAS_SPLITS', transactionIds: splits };
  const plans = holds.plans
    .filter((p) => !kept(p.effectiveFrom))
    .map((p) => p.id)
    .sort();
  if (plans.length > 0) return { kind: 'MEMBERSHIP_HAS_PLANS', economicPlanIds: plans };
  const statements = holds.statements
    .filter((st) => !kept(st.periodFrom) || !kept(st.periodUntil))
    .map((st) => st.id)
    .sort();
  if (statements.length > 0) return { kind: 'MEMBERSHIP_HAS_STATEMENTS', statementIds: statements };
  return undefined;
}

/** The administrator named on create or amend (§49.1 check 2). */
export type AdministratorRefusal =
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | { readonly kind: 'PARTY_INACTIVE'; readonly partyId: string };

export type CreateWegOutcome =
  | { readonly kind: 'CREATED'; readonly weg: Weg }
  | { readonly kind: 'REPLAYED'; readonly weg: Weg }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | AdministratorRefusal;

export type AmendWegOutcome =
  | { readonly kind: 'AMENDED'; readonly weg: Weg; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'WEG_NOT_ACTIVE'; readonly status: WegStatus }
  /** `financialYearStartMonth` while a membership has an `ACTIVE` plan or a statement that is not `VOID` (§49.5, §50). */
  | { readonly kind: 'WEG_HAS_YEARS' }
  | AdministratorRefusal
  | VersionConflict;

export type VoidWegOutcome =
  | { readonly kind: 'VOIDED'; readonly weg: Weg; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'WEG_HAS_MEMBERSHIPS'; readonly membershipIds: readonly string[] }
  | VersionConflict;

export type CreateMembershipOutcome =
  | { readonly kind: 'CREATED'; readonly membership: WegMembership }
  | { readonly kind: 'REPLAYED'; readonly membership: WegMembership }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'WEG_NOT_FOUND' }
  | { readonly kind: 'WEG_NOT_ACTIVE'; readonly status: WegStatus }
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND' }
  | { readonly kind: 'OVERLAPPING_WEG_MEMBERSHIP'; readonly membershipId: string; readonly wegId: string };

export type AmendMembershipOutcome =
  | { readonly kind: 'AMENDED'; readonly membership: WegMembership; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'MEMBERSHIP_NOT_ACTIVE' }
  | VersionConflict;

export type EndMembershipOutcome =
  | { readonly kind: 'ENDED'; readonly membership: WegMembership; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'MEMBERSHIP_NOT_ACTIVE' }
  | { readonly kind: 'INVALID_MEMBERSHIP'; readonly reason: InvalidMembershipReason }
  | MembershipHoldRefusal
  | VersionConflict;

export type VoidMembershipOutcome =
  | { readonly kind: 'VOIDED'; readonly membership: WegMembership; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | MembershipHoldRefusal
  | VersionConflict;

export interface WegFilter {
  readonly statuses?: readonly WegStatus[];
  readonly administratorPartyId?: string;
  /** WEGs with a membership of that unit, any status and period. */
  readonly propertyReferenceId?: string;
}

export interface MembershipFilter {
  readonly statuses?: readonly MembershipStatus[];
  readonly propertyReferenceId?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface PageRequest {
  readonly page: number;
  readonly pageSize: number;
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface WegRepository {
  /** Claims the key, reads the administrator `FOR SHARE`, inserts, and writes an AuditRecord. */
  createWeg(weg: NewWeg, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateWegOutcome>;
  findWeg(id: string, mreRealmId: string): Promise<Weg | undefined>;
  /** By `displayName`, then id; count and page in one snapshot. */
  listWegs(mreRealmId: string, filter: WegFilter, page: PageRequest): Promise<Page<Weg>>;
  /** A newly named administrator `FOR SHARE`, then the WEG `FOR UPDATE`, then `planWegAmend`. */
  amendWeg(id: string, mreRealmId: string, changes: WegChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendWegOutcome>;
  /** The WEG `FOR UPDATE`, then its memberships are read, then `planWegVoid`. */
  voidWeg(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidWegOutcome>;
  /**
   * Claims the key, writes the PropertyReference (a no-op, serialising writers of the unit), then the WEG (a no-op,
   * serialising with its void), checks the overlap, inserts, and writes the AuditRecords (§49.2).
   */
  createMembership(
    membership: NewMembership,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateMembershipOutcome>;
  findMembership(id: string, mreRealmId: string): Promise<WegMembership | undefined>;
  /** The WEG's memberships, `VOID` included; undefined for an unknown or foreign WEG. */
  listMemberships(wegId: string, mreRealmId: string, filter: MembershipFilter, page: PageRequest): Promise<Page<WegMembership> | undefined>;
  /** The unit's history across WEGs; undefined for an unknown or foreign PropertyReference. */
  unitHistory(propertyReferenceId: string, mreRealmId: string, page: PageRequest): Promise<Page<WegMembership> | undefined>;
  /** The unit's `ACTIVE` membership on a day, or null; undefined for an unknown or foreign PropertyReference. */
  unitOn(propertyReferenceId: string, mreRealmId: string, asOf: BusinessDate): Promise<WegMembership | null | undefined>;
  amendMembership(
    id: string,
    mreRealmId: string,
    changes: MembershipChanges,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<AmendMembershipOutcome>;
  /** The PropertyReference (a no-op write), then the membership `FOR UPDATE`, then `planMembershipEnd`. */
  endMembership(
    id: string,
    mreRealmId: string,
    validUntil: BusinessDate,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<EndMembershipOutcome>;
  /** The PropertyReference (a no-op write), then the membership `FOR UPDATE`, then `planMembershipVoid`. */
  voidMembership(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidMembershipOutcome>;
}

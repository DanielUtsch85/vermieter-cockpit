import type { AuditActor, BusinessDate, VersionConflict } from '../../shared/index.js';

/**
 * The minimal RentalContractReference (data-model.md §11, api-design.md §58A, VC-7-02): the DE-side reference to the
 * concrete rental relationship of one MRE Tenant, carrying the one fact DE needs and MRE's lease does not hold, the
 * rent's due day over time. MRE stays authoritative for the rental relationship; nothing here is written to MRE.
 */

export type RentalContractReferenceId = string & { readonly __brand: 'RentalContractReferenceId' };

/** From `validFrom` on, the rent falls due on `day` (1–31; in a shorter month the month's last day). */
export interface RentDueDay {
  readonly validFrom: BusinessDate;
  readonly day: number;
}

export const MAX_RENT_DUE_DAYS = 20;

export interface RentalContractReferenceFields {
  readonly rentDueDays: readonly RentDueDay[];
  readonly notes: string | null;
  readonly sourceReferences: readonly string[];
}

export interface NewRentalContractReference extends RentalContractReferenceFields {
  readonly mreRealmId: string;
  readonly mreTenantId: string;
}

export interface RentalContractReference extends NewRentalContractReference {
  readonly id: RentalContractReferenceId;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly version: number;
}

/**
 * Why a list of due days is not valid, or undefined: `validFrom` unique and strictly ascending, each day 1–31, at
 * most 20 entries (the database checks the same, `rental_contract_reference_due_days_valid`).
 */
export function rentDueDaysError(days: readonly RentDueDay[]): { readonly index: number; readonly code: 'NOT_ASCENDING' | 'OUT_OF_RANGE' } | undefined {
  if (days.length > MAX_RENT_DUE_DAYS) return { index: MAX_RENT_DUE_DAYS, code: 'OUT_OF_RANGE' };
  for (const [index, entry] of days.entries()) {
    if (!Number.isInteger(entry.day) || entry.day < 1 || entry.day > 31) return { index, code: 'OUT_OF_RANGE' };
    const previous = days[index - 1];
    if (previous !== undefined && entry.validFrom <= previous.validFrom) return { index, code: 'NOT_ASCENDING' };
  }
  return undefined;
}

/**
 * The due day of a rent term starting on `termStart`: the entry with the latest `validFrom` on or before it; undefined
 * before the first entry or for an empty list (`DUE_DATE_ASSUMED`, §58A).
 */
export function dueDayOn(days: readonly RentDueDay[], termStart: BusinessDate): number | undefined {
  let found: number | undefined;
  for (const entry of days) if (entry.validFrom <= termStart) found = entry.day;
  return found;
}

/** One entry whose day differs between two lists, by `validFrom`: added (`from` null), removed (`to` null) or changed. */
export interface ChangedEntry {
  readonly validFrom: BusinessDate;
  readonly from: number | null;
  readonly to: number | null;
}

/** The entries an amend changes, in `validFrom` order (the AuditRecord's `details.changedEntries`, §58A). */
export function changedEntries(before: readonly RentDueDay[], after: readonly RentDueDay[]): ChangedEntry[] {
  const old = new Map(before.map((e) => [e.validFrom, e.day]));
  const next = new Map(after.map((e) => [e.validFrom, e.day]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .sort()
    .map((validFrom) => ({ validFrom, from: old.get(validFrom) ?? null, to: next.get(validFrom) ?? null }))
    .filter((e) => e.from !== e.to);
}

export type AmendableReferenceField = keyof RentalContractReferenceFields;

/** What an amend changes; nothing is a `200` no-op. */
export interface ReferenceAmendPlan {
  readonly changedFields: readonly AmendableReferenceField[];
  readonly changedEntries: readonly ChangedEntry[];
}

export function planReferenceAmend(current: RentalContractReference, changes: RentalContractReferenceFields): ReferenceAmendPlan {
  const entries = changedEntries(current.rentDueDays, changes.rentDueDays);
  const changedFields: AmendableReferenceField[] = [];
  if (entries.length > 0) changedFields.push('rentDueDays');
  if (changes.notes !== current.notes) changedFields.push('notes');
  if (JSON.stringify(changes.sourceReferences) !== JSON.stringify(current.sourceReferences)) changedFields.push('sourceReferences');
  return { changedFields, changedEntries: entries };
}

/** Identity of a create for `Idempotency-Key` replays. */
export function referenceFingerprint(reference: NewRentalContractReference): string {
  return JSON.stringify([reference.mreTenantId, reference.rentDueDays.map((e) => [e.validFrom, e.day]), reference.notes, reference.sourceReferences]);
}

export type CreateReferenceOutcome =
  | { readonly kind: 'CREATED'; readonly reference: RentalContractReference }
  | { readonly kind: 'REPLAYED'; readonly reference: RentalContractReference }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'REFERENCE_EXISTS'; readonly rentalContractReferenceId: string };

export type AmendReferenceOutcome =
  | { readonly kind: 'AMENDED'; readonly reference: RentalContractReference; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict;

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface RentalContractReferenceRepository {
  /** Claims the key, then inserts; a second reference of the Tenant is REFERENCE_EXISTS. */
  createReference(
    reference: NewRentalContractReference,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateReferenceOutcome>;
  /** The row `FOR UPDATE`; an omitted field keeps its value; the same values are a no-op regardless of `If-Match`. */
  amendReference(
    id: string,
    mreRealmId: string,
    changes: Partial<RentalContractReferenceFields>,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<AmendReferenceOutcome>;
  findReference(id: string, mreRealmId: string): Promise<RentalContractReference | undefined>;
  findByTenant(mreTenantId: string, mreRealmId: string): Promise<RentalContractReference | undefined>;
}

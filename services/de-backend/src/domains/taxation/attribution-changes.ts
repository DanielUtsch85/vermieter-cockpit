import type { BusinessDate, RuleRegistry } from '../../shared/index.js';
import { businessDayOf } from '../ledger/index.js';
import type { ChangedEntry, RentDueDay } from '../rental-contract-reference/index.js';
import { attributeTaxYear, rentTiming } from './cash-timing.js';

/**
 * `ATTRIBUTION_INPUT_CHANGED` (api-design.md §58C, §58A): a correction of a RentalContractReference's `rentDueDays`
 * moves the tax year of rent derived on read, and nothing per split records it. The lists before and after each
 * amendment are rebuilt from the reference's AuditRecords; a candidate rent split's year is computed under both, with
 * everything else as read now. Derived, never stored; no acknowledgement (VC-X-28).
 */

/** One `AMENDED` AuditRecord of a reference with `changedEntries`. */
export interface ReferenceAmendment {
  readonly auditRecordId: string;
  readonly newVersion: number;
  /** The AuditRecord's `occurred_at`. */
  readonly amendedAt: Date;
  readonly changedEntries: readonly ChangedEntry[];
}

/** A RentalContractReference of the Realm with its history. */
export interface ReferenceHistory {
  readonly rentalContractReferenceId: string;
  readonly mreTenantId: string;
  /** The current list. */
  readonly rentDueDays: readonly RentDueDay[];
  /** The `CREATED` record's list; `null` without one. */
  readonly created: readonly RentDueDay[] | null;
  readonly amendments: readonly ReferenceAmendment[];
}

/**
 * A counting rent split (`RENT_BASE`, `RENT_OPERATING_COST_ADVANCE`) of the PropertyReference booked in a window at an
 * edge of the year, with its one `CONFIRMED` reconciliation term, and its classification's `taxYear` override.
 */
export interface AttributionCandidate {
  readonly sourceId: string;
  readonly bookingDate: BusinessDate;
  readonly financialCategoryCode: string;
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
  readonly taxYearOverride: number | null;
}

export interface AttributionInput {
  readonly references: readonly ReferenceHistory[];
  readonly candidates: readonly AttributionCandidate[];
}

export interface AttributionChange {
  readonly rentalContractReferenceId: string;
  readonly auditRecordId: string;
  readonly amendedAt: Date;
  readonly changedEntries: readonly ChangedEntry[];
  readonly items: readonly { readonly sourceId: string; readonly yearBefore: number; readonly yearAfter: number }[];
}

export interface AttributionChanges {
  /** `ATTRIBUTION_INPUT_CHANGED`'s details, by reference id, then the amendment's version. */
  readonly changes: readonly AttributionChange[];
  /** The references whose history does not reach their `CREATED` list (`ATTRIBUTION_HISTORY_INCONSISTENT`). */
  readonly inconsistent: readonly string[];
}

const normalized = (days: readonly RentDueDay[]) =>
  JSON.stringify([...days].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0)).map((d) => [d.validFrom, d.day]));

/**
 * The list before an amendment: the list after it with each changed entry undone (`to` removed, `from` restored);
 * `undefined` when the list after does not hold the entry's `to` (the history does not fit).
 */
export function listBefore(after: readonly RentDueDay[], changed: readonly ChangedEntry[]): RentDueDay[] | undefined {
  const days = new Map(after.map((e) => [e.validFrom as string, e.day]));
  for (const entry of changed) {
    if ((days.get(entry.validFrom) ?? null) !== entry.to) return undefined;
    if (entry.from === null) days.delete(entry.validFrom);
    else days.set(entry.validFrom, entry.from);
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([validFrom, day]) => ({ validFrom: validFrom as BusinessDate, day }));
}

/**
 * The amendments of each reference with their lists before (B) and after (A), newest first, going back from the
 * current list; `undefined` when the oldest list reached is not the `CREATED` record's.
 */
export function amendmentLists(
  reference: ReferenceHistory,
): { readonly amendment: ReferenceAmendment; readonly before: readonly RentDueDay[]; readonly after: readonly RentDueDay[] }[] | undefined {
  const found: { amendment: ReferenceAmendment; before: readonly RentDueDay[]; after: readonly RentDueDay[] }[] = [];
  let after: readonly RentDueDay[] = reference.rentDueDays;
  for (const amendment of [...reference.amendments].sort((a, b) => b.newVersion - a.newVersion)) {
    const before = listBefore(after, amendment.changedEntries);
    if (before === undefined) return undefined;
    found.push({ amendment, before, after });
    after = before;
  }
  if (reference.created === null || normalized(reference.created) !== normalized(after)) return undefined;
  return found;
}

/**
 * The amendments that moved a candidate into or out of `year` (§58C): its tax year by `DE_CASH_TIMING` with B and with
 * A differs, one of them is `year`, and the amendment was recorded after 31 December of `year` (Europe/Berlin).
 */
export function attributionChanges(input: AttributionInput, year: number, registry: RuleRegistry): AttributionChanges {
  const changes: AttributionChange[] = [];
  const inconsistent: string[] = [];
  const yearEnd = `${String(year).padStart(4, '0')}-12-31`;
  for (const reference of [...input.references].sort((a, b) => (a.rentalContractReferenceId < b.rentalContractReferenceId ? -1 : 1))) {
    const lists = amendmentLists(reference);
    if (lists === undefined) {
      inconsistent.push(reference.rentalContractReferenceId);
      continue;
    }
    const candidates = input.candidates.filter((c) => c.mreTenantId === reference.mreTenantId);
    for (const { amendment, before, after } of [...lists].reverse()) {
      // An amendment recorded while `year` was still running cannot have changed a filed return of it (review on #168).
      if (businessDayOf(amendment.amendedAt) <= yearEnd) continue;
      const items = candidates.flatMap((c) => {
        const yearUnder = (days: readonly RentDueDay[]) => attributeTaxYear(c, rentTiming(c.mreRentTerm, days), c.taxYearOverride, registry).taxYear;
        const [yearBefore, yearAfter] = [yearUnder(before), yearUnder(after)];
        return yearBefore !== yearAfter && (yearBefore === year || yearAfter === year) ? [{ sourceId: c.sourceId, yearBefore, yearAfter }] : [];
      });
      if (items.length > 0) {
        changes.push({
          rentalContractReferenceId: reference.rentalContractReferenceId,
          auditRecordId: amendment.auditRecordId,
          amendedAt: amendment.amendedAt,
          changedEntries: amendment.changedEntries,
          items,
        });
      }
    }
  }
  return { changes, inconsistent };
}

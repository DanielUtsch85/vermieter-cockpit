import { addDays, type BusinessDate } from '../../shared/index.js';

/**
 * The continuous tenure of a Party on a PropertyReference (api-design.md §58B, §59A; moved from Taxation's
 * `distribution-82b.ts` by VC-8-02, unchanged): Taxation's § 82b fold and Depreciation's schedule both read it, and
 * neither imports the other, so it lives with the Ownerships.
 */

/** An Ownership of the source's PropertyReference, `VALID` and valid on the source's date (§26.1). */
export interface ContinuousOwnership {
  readonly id: string;
  readonly validUntil: BusinessDate | null;
}

/** A `VALID` Ownership of the PropertyReference with its Party (§26). */
export interface OwnershipPeriod {
  readonly id: string;
  readonly partyId: string;
  readonly validFrom: BusinessDate;
  readonly validUntil: BusinessDate | null;
}

/**
 * The owners concerned by a source (§58B; clarified in the review of the VC-7-04 spec): each Party owning on the
 * source's date, with the end of its **continuous** ownership of the PropertyReference: consecutive or overlapping
 * `VALID` Ownerships of the same Party with no gap of a day, whatever the share. An ownership change (§26.2) that
 * closes 1/2 and continues the Party at 1/1 the next day is no end: nobody sold, so nothing folds.
 */
export function continuousOwners(ownerships: readonly OwnershipPeriod[], date: BusinessDate): ContinuousOwnership[] {
  const onDate = ownerships.filter((o) => o.validFrom <= date && (o.validUntil === null || o.validUntil >= date));
  const found = new Map<string, ContinuousOwnership>();
  for (const o of [...onDate].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (found.has(o.partyId)) continue;
    const ofParty = ownerships.filter((x) => x.partyId === o.partyId);
    let end: BusinessDate | null = o.validUntil;
    for (let extended = true; end !== null && extended; ) {
      extended = false;
      const reach: BusinessDate = addDays(end, 1);
      for (const x of ofParty) {
        if (x.validFrom <= reach && (x.validUntil === null || x.validUntil > end)) {
          end = x.validUntil;
          extended = true;
          if (end === null) break;
        }
      }
    }
    found.set(o.partyId, { id: o.id, validUntil: end });
  }
  return [...found.values()];
}

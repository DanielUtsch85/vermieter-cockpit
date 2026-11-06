import { addDays, checkVersion, type BusinessDate, type VersionConflict } from '../../shared/index.js';
import {
  ownershipStart,
  structureViolations,
  sumOf,
  type Acquisition,
  type ConfirmationOwnership,
  type ConfirmationViolation,
  type ExactFraction,
} from './acquisition.js';

/**
 * Extending a seller's Ownership up to the economic transfer (api-design.md §58Q, VC-X-55; Entscheidung des
 * Projektinhabers, 2026-11-05, §58Q Fragen 1–11: option (A), the route at the Acquisition, `If-Match` on its version,
 * `DRAFT` too). For an Acquisition X whose `economicTransferDate` `t` was recorded later (§58N) and lies after its
 * contract date `c`, one act, all or nothing: every seller row of X ending on `c − 1` and every buyer predecessor ending
 * on `c − 1` end on `t − 1`, every buyer row carrying X starts on `t`, X is marked aligned (`ownershipAlignedAt`, with new
 * evidence) and from then on `ownershipStart(X) = t`. Pure: the repository reads the rows under its locks and writes the
 * plan in rule 3's order.
 */

/** The normalized body (texts trimmed; §58Q "Body"); no date, every new date follows from X. */
export interface AlignOwnershipsInput {
  /** 1–10 entries, as given. */
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

/** A `VALID` Ownership of X's PropertyReference as the plan reads it. */
export interface AlignOwnership extends ConfirmationOwnership {
  readonly acquisitionId: string | null;
}

/** Why the act does not apply (`422 OWNERSHIP_EXTENSION_NOT_APPLICABLE`, step 6), the first of them. */
export type NotApplicableReason = 'TRANSFER_DATE_NOT_RECORDED' | 'TRANSFER_ON_CONTRACT_DATE' | 'NO_SELLER_ROW';

/** A fact resting on the old dates (`422 OWNERSHIP_EXTENSION_BLOCKED`, step 7, rule 4). */
export type AlignBlocker =
  | { readonly code: 'SELLER_KEEPS_PART'; readonly ownershipId: string }
  | { readonly code: 'SELLER_ROW_IN_GAP'; readonly ownershipId: string; readonly validFrom: BusinessDate }
  | { readonly code: 'BUYER_ROW_ENDS_BEFORE_TRANSFER'; readonly ownershipId: string; readonly validUntil: BusinessDate }
  | { readonly code: 'BUYER_PREDECESSOR_NOT_ADJACENT'; readonly partyId: string }
  | { readonly code: 'OVERLAPPING_OWNERSHIP'; readonly ownershipId: string }
  | { readonly code: 'OWNERSHIP_TOTAL_EXCEEDS_ONE'; readonly date: BusinessDate; readonly shareSum: ExactFraction }
  | { readonly code: 'CONFIRMATION_REQUIREMENTS'; readonly violations: readonly ConfirmationViolation[] };

/** One row of the act with its new date (rule 2). */
export interface AlignStep {
  readonly ownershipId: string;
  readonly from: BusinessDate | null;
  readonly to: BusinessDate;
}

export type AlignPlan =
  | {
      readonly kind: 'ALIGN';
      readonly next: Acquisition;
      /** (i) the seller rows, `validUntil` `c − 1` → `t − 1`, in id order. */
      readonly sellers: readonly AlignStep[];
      /** (iii) the buyers' predecessors, `validUntil` `c − 1` → `t − 1`, in id order. */
      readonly predecessors: readonly AlignStep[];
      /** (ii) the buyer rows carrying X, `validFrom` `c` → `t`, in id order. */
      readonly moved: readonly AlignStep[];
    }
  | { readonly kind: 'ACQUISITION_CANCELLED' }
  | { readonly kind: 'OWNERSHIPS_ALREADY_ALIGNED'; readonly ownershipAlignedAt: Date; readonly ownershipStart: BusinessDate }
  | VersionConflict
  | { readonly kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE'; readonly reason: NotApplicableReason }
  | { readonly kind: 'OWNERSHIP_EXTENSION_BLOCKED'; readonly blockedBy: readonly AlignBlocker[] };

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a: { readonly id: string }, b: { readonly id: string }) => byText(a.id, b.id);
const covers = (o: ConfirmationOwnership, day: BusinessDate) => o.validFrom <= day && (o.validUntil === null || day <= o.validUntil);
const overlaps = (a: ConfirmationOwnership, b: ConfirmationOwnership) =>
  (a.validUntil === null || b.validFrom <= a.validUntil) && (b.validUntil === null || a.validFrom <= b.validUntil);
const blockerKey = (b: AlignBlocker) => ('ownershipId' in b ? b.ownershipId : 'partyId' in b ? b.partyId : '');

/**
 * §58Q's order of checks after `400` and `404`: `CANCELLED` (also with a stale `If-Match`), already aligned (also for a
 * retry with the same body), `If-Match` on X's version, not applicable, then the blockers of rule 4: the facts resting on
 * the old dates (all of them, by code then id), else the invariants over the state after the act (§26.1), else for a
 * `CONFIRMED` X requirements 2–6 of §28.1 on `t` (with §28.1A's 5a/5b). `rows` are the `VALID` Ownerships of X's
 * PropertyReference read under the locks.
 */
export function planAlignOwnerships(
  current: Acquisition,
  rows: readonly AlignOwnership[],
  input: AlignOwnershipsInput,
  at: Date,
  expectedVersions?: readonly number[],
): AlignPlan {
  if (current.status === 'CANCELLED') return { kind: 'ACQUISITION_CANCELLED' };
  if (current.ownershipAlignedAt !== null) {
    return { kind: 'OWNERSHIPS_ALREADY_ALIGNED', ownershipAlignedAt: current.ownershipAlignedAt, ownershipStart: ownershipStart(current) };
  }
  const conflict = checkVersion(current.version, expectedVersions);
  if (conflict !== undefined) return conflict;
  const t = current.economicTransferDate;
  const c = current.contractDate;
  if (current.economicTransferRecordedAt === null || t === null) return { kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE', reason: 'TRANSFER_DATE_NOT_RECORDED' };
  if (t <= c) return { kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE', reason: 'TRANSFER_ON_CONTRACT_DATE' };
  const dayBefore = addDays(c, -1);
  const newEnd = addDays(t, -1);
  const sellers = new Set(current.sellerPartyIds);
  const buyers = new Set(current.buyerPartyIds);
  const sorted = [...rows].sort(byId);
  const sellerRows = sorted.filter((o) => sellers.has(o.ownerPartyId) && o.validUntil === dayBefore);
  if (sellerRows.length === 0) return { kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE', reason: 'NO_SELLER_ROW' };
  const buyerRows = sorted.filter((o) => o.acquisitionId === current.id);
  const predecessors = sorted.filter((o) => buyers.has(o.ownerPartyId) && o.acquisitionId !== current.id && o.validUntil === dayBefore);

  const blockers: AlignBlocker[] = [];
  for (const o of sorted.filter((r) => sellers.has(r.ownerPartyId))) {
    if (o.validFrom === c) blockers.push({ code: 'SELLER_KEEPS_PART', ownershipId: o.id });
    else if (o.validFrom > c && o.validFrom <= newEnd) blockers.push({ code: 'SELLER_ROW_IN_GAP', ownershipId: o.id, validFrom: o.validFrom });
  }
  for (const o of buyerRows) {
    if (o.validUntil !== null && o.validUntil < t) blockers.push({ code: 'BUYER_ROW_ENDS_BEFORE_TRANSFER', ownershipId: o.id, validUntil: o.validUntil });
  }
  for (const partyId of [...buyers].sort()) {
    const notAdjacent = sorted.some((o) => o.ownerPartyId === partyId && o.acquisitionId !== current.id && covers(o, dayBefore) && o.validUntil !== dayBefore);
    if (notAdjacent) blockers.push({ code: 'BUYER_PREDECESSOR_NOT_ADJACENT', partyId });
  }
  if (blockers.length > 0) {
    blockers.sort((a, b) => byText(a.code, b.code) || byText(blockerKey(a), blockerKey(b)));
    return { kind: 'OWNERSHIP_EXTENSION_BLOCKED', blockedBy: blockers };
  }

  const extendedIds = new Set([...sellerRows, ...predecessors].map((o) => o.id));
  const movedIds = new Set(buyerRows.map((o) => o.id));
  const after = sorted.map((o) => (extendedIds.has(o.id) ? { ...o, validUntil: newEnd } : movedIds.has(o.id) ? { ...o, validFrom: t } : o));
  const invariant = invariantViolation(
    after,
    after.filter((o) => extendedIds.has(o.id) || movedIds.has(o.id)),
  );
  if (invariant !== undefined) return { kind: 'OWNERSHIP_EXTENSION_BLOCKED', blockedBy: [invariant] };

  const next: Acquisition = {
    ...current,
    ownershipAlignedAt: at,
    ownershipAlignmentSourceReferences: [...input.sourceReferences],
    version: current.version + 1,
    flags: [],
  };
  if (current.status === 'CONFIRMED') {
    // Requirement 1 (buyers active) is not re-checked: a buyer inactive since stays a buyer (P2-D1).
    const own = after.filter((o) => o.acquisitionId === current.id);
    const violations = structureViolations(
      next,
      own,
      after.filter((o) => covers(o, t)),
      after.filter((o) => covers(o, newEnd)),
    );
    const total = sumOf(after.filter((o) => covers(o, t)).map((o) => o.share));
    if (total.numerator !== total.denominator) violations.push({ code: 'OWNERSHIP_INCOMPLETE', date: t, shareSum: total });
    if (violations.length > 0) return { kind: 'OWNERSHIP_EXTENSION_BLOCKED', blockedBy: [{ code: 'CONFIRMATION_REQUIREMENTS', violations }] };
  }
  const step = (o: AlignOwnership, from: BusinessDate | null, to: BusinessDate): AlignStep => ({ ownershipId: o.id, from, to });
  return {
    kind: 'ALIGN',
    next,
    sellers: sellerRows.map((o) => step(o, o.validUntil, newEnd)),
    predecessors: predecessors.map((o) => step(o, o.validUntil, newEnd)),
    moved: buyerRows.map((o) => step(o, o.validFrom, t)),
  };
}

/**
 * §26.1's rules over the state after the act, for the rows it changes (in id order): no overlap with a row of the same
 * owner, then no day above 1 on the row's start or on any other start inside its period (a sum only rises where a period
 * starts), as 0019's `ownership_invariants` checks each written row.
 */
function invariantViolation(after: readonly ConfirmationOwnership[], changed: readonly ConfirmationOwnership[]): AlignBlocker | undefined {
  for (const row of changed) {
    const other = after.find((o) => o.id !== row.id && o.ownerPartyId === row.ownerPartyId && overlaps(o, row));
    if (other !== undefined) return { code: 'OVERLAPPING_OWNERSHIP', ownershipId: other.id };
  }
  for (const row of changed) {
    const days = [...new Set(after.filter((o) => covers(row, o.validFrom)).map((o) => o.validFrom))].sort();
    for (const day of days) {
      const shareSum = sumOf(after.filter((o) => covers(o, day)).map((o) => o.share));
      if (shareSum.numerator > shareSum.denominator) return { code: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', date: day, shareSum };
    }
  }
  return undefined;
}

/** §15: the identity of a request for `Idempotency-Key` replays (scope `acquisition.align-ownerships-to-transfer`). */
export function alignOwnershipsFingerprint(acquisitionId: string, input: AlignOwnershipsInput): string {
  return JSON.stringify([acquisitionId.toLowerCase(), input.sourceReferences, input.notes]);
}

/** The act's answer (§58Q "Success"): the Ownerships as they are after it, in id order, and the ownership on `t − 1`. */
export interface AlignResult<O> {
  readonly acquisition: Acquisition;
  readonly extended: readonly O[];
  readonly moved: readonly O[];
  readonly completeness: 'COMPLETE' | 'INCOMPLETE' | 'NONE';
  readonly shareSum: ExactFraction;
}

export type AlignOwnershipsOutcome<O> =
  | { readonly kind: 'ALIGNED'; readonly result: AlignResult<O>; readonly replayed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | Exclude<AlignPlan, { kind: 'ALIGN' }>;

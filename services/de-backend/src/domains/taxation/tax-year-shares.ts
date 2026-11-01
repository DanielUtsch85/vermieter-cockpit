import { centsOf, type BusinessDate, type Money, type RuleRef } from '../../shared/index.js';
import { largestRemainder } from '../acquisition/index.js';
import { continuousOwners, type OwnershipPeriod } from '../ownership/index.js';
import { yearOf } from './cash-timing.js';
import { distribute } from './distribution-82b.js';

/**
 * The owners' parts in the tax-year view (api-design.md §58C, P7-D7): the participants of a share date, the per-item
 * rounding to the cent, and the per-owner fold of a § 82b distribution.
 */

/** The participant for the part of a share date's shares that sum to less than 1 (§26.1 `INCOMPLETE`/`NONE`). */
export const NOT_OWNED = 'NOT_OWNED';

// ——— Participants and the per-item rounding (P7-D7) ———

/** A `VALID` Ownership of the PropertyReference with its exact share (§26.1). */
export interface ViewOwnership extends OwnershipPeriod {
  readonly share: { readonly numerator: number; readonly denominator: number };
}

export interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
const reduce = (numerator: bigint, denominator: bigint): Fraction => {
  const g = gcd(numerator, denominator);
  return g === 0n ? { numerator: 0n, denominator: 1n } : { numerator: numerator / g, denominator: denominator / g };
};
const addFraction = (a: Fraction, b: Fraction) => reduce(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);

/** One participant of a share date: a Party (its Ownerships on that day, shares summed) or `NOT_OWNED`. */
export interface Participant {
  /** The Party, or `NOT_OWNED`. */
  readonly key: string;
  readonly ownershipIds: readonly string[];
  readonly share: Fraction;
}

export const covers = (o: OwnershipPeriod, day: BusinessDate) => o.validFrom <= day && (o.validUntil === null || o.validUntil >= day);

/**
 * The participants on a share date (§58C): the Parties of the `VALID` Ownerships covering the day, each with its exact
 * share, and `NOT_OWNED` for the rest when the shares sum to less than 1. In the order the rounding gives the rest:
 * the larger share first, then `ownerPartyId` ascending, `NOT_OWNED` last.
 */
export function participantsOn(ownerships: readonly ViewOwnership[], day: BusinessDate): Participant[] {
  const byParty = new Map<string, { ownershipIds: string[]; share: Fraction }>();
  for (const o of ownerships.filter((x) => covers(x, day)).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const share = reduce(BigInt(o.share.numerator), BigInt(o.share.denominator));
    const seen = byParty.get(o.partyId);
    byParty.set(
      o.partyId,
      seen === undefined ? { ownershipIds: [o.id], share } : { ownershipIds: [...seen.ownershipIds, o.id], share: addFraction(seen.share, share) },
    );
  }
  const owners: Participant[] = [...byParty.entries()].map(([key, v]) => ({ key, ownershipIds: v.ownershipIds, share: v.share }));
  owners.sort((a, b) => {
    const left = a.share.numerator * b.share.denominator;
    const right = b.share.numerator * a.share.denominator;
    if (left !== right) return left > right ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const sum = owners.reduce<Fraction>((s, p) => addFraction(s, p.share), { numerator: 0n, denominator: 1n });
  if (sum.numerator < sum.denominator) {
    owners.push({ key: NOT_OWNED, ownershipIds: [], share: reduce(sum.denominator - sum.numerator, sum.denominator) });
  }
  return owners;
}

/**
 * `cents` over the participants by their exact shares (§58C, §27.4's method): `floor(|A| × w)` each, the rest one cent
 * each to the largest fractional remainders, ties in the participants' order (the larger share, then `ownerPartyId`,
 * `NOT_OWNED` last); a negative amount by its absolute value with the sign restored. The parts sum to `cents`.
 */
export function shareOut(cents: bigint, participants: readonly Participant[]): Map<string, bigint> {
  // largestRemainder breaks ties by key ascending: the keys carry the participants' order.
  const keyOf = (i: number) => String(i).padStart(6, '0');
  const parts = largestRemainder(
    cents < 0n ? -cents : cents,
    participants.map((p, i) => ({ key: keyOf(i), weight: p.share })),
  );
  return new Map(participants.map((p, i) => [p.key, (cents < 0n ? -1n : 1n) * (parts.get(keyOf(i)) ?? 0n)]));
}

// ——— § 82b per owner ———

/** A participant's § 82b parts after the per-owner fold, by year; a year without an entry has no part. */
export type FoldedParts = ReadonlyMap<string, ReadonlyMap<number, bigint>>;

/**
 * The per-owner fold of a § 82b distribution (§58C, §58B open question 10, P7-D6): each base part (before any fold) is
 * shared out over the participants on the source's date; an owner whose tenure (its continuous run of Ownerships)
 * ends in a year E before the last year deducts, in E, their parts of E and every later year; the others, and
 * `NOT_OWNED`, keep their parts in their years. A part never moves before the first year.
 */
export function foldPerOwner(
  source: { readonly amount: Money; readonly firstYear: number; readonly years: number; readonly rule: RuleRef; readonly date: BusinessDate },
  ownerships: readonly ViewOwnership[],
): { readonly participants: readonly Participant[]; readonly parts: FoldedParts; readonly endYears: ReadonlyMap<string, number> } {
  const base = distribute({ amount: source.amount, firstYear: source.firstYear, years: source.years, rule: source.rule, ownerships: [] }).distribution.parts;
  const participants = participantsOn(ownerships, source.date);
  const lastYear = source.firstYear + source.years - 1;
  // The end of each owner's tenure (VC-7-03's continuous ownership).
  const partyOf = new Map(ownerships.map((o) => [o.id, o.partyId]));
  const endYears = new Map<string, number>();
  for (const owner of continuousOwners(ownerships, source.date)) {
    const party = partyOf.get(owner.id);
    if (party !== undefined && owner.validUntil !== null && yearOf(owner.validUntil) < lastYear) {
      endYears.set(party, Math.max(source.firstYear, yearOf(owner.validUntil)));
    }
  }
  const parts = new Map<string, Map<number, bigint>>(participants.map((p) => [p.key, new Map()]));
  for (const part of base) {
    for (const [key, cents] of shareOut(centsOf(part.amount), participants)) {
      const end = endYears.get(key);
      const year = end !== undefined && part.year > end ? end : part.year;
      const own = parts.get(key) as Map<number, bigint>;
      own.set(year, (own.get(year) ?? 0n) + cents);
    }
  }
  return { participants, parts, endYears };
}

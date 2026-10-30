import type { BusinessDate, Money, RuleRef, RuleRegistry, RuleStatus } from '../../shared/index.js';
import { largestRemainder } from '../acquisition/index.js';
import type { Direction } from '../ledger/index.js';
import type { AnschaffungsnaheCheck, CheckStatus, NotFinalReason } from './anschaffungsnahe.js';
import { attributionChanges, type AttributionChange, type AttributionInput } from './attribution-changes.js';
import { yearOf, type RefundInfo } from './cash-timing.js';
import { centsOf, moneyOfCents } from './cents.js';
import type { TaxListItem, TreatmentSuggestion } from './classification.js';
import type { DepositTaxMeaning } from './deposit-closing.js';
import { continuousOwners, distribute, partOf, type Distribution, type OwnershipPeriod } from './distribution-82b.js';
import type { Origin, ReviewState, SourceType, TaxCategory, Treatment } from './vocabulary.js';
import { REVIEW_STATES } from './vocabulary.js';

/**
 * The tax-year view (api-design.md §58C, phase-7-plan P7-D7, P7-D8): §55's per-year list, grouped and summed into
 * Einnahmen, Werbungskosten and the result before AfA, per PropertyReference and per owner. Derived on every read from
 * one snapshot (the repository's), never stored; it applies no tax rule of its own and writes nothing. Every figure is
 * exact in cents (`bigint`), and the owners' figures with `NOT_OWNED` sum to the property's to the cent.
 */

/** At most this many items over all places, `notInView` and the deposits not attributed included (§58C). */
export const TAX_YEAR_ITEM_LIMIT = 5000;

/** The participant for the part of a share date's shares that sum to less than 1 (§26.1 `INCOMPLETE`/`NONE`). */
export const NOT_OWNED = 'NOT_OWNED';

/** The Einnahmen lines, in the order of §58C's table. */
export const EINNAHMEN_LINES = [
  'RENT',
  'OPERATING_COST_ADVANCES',
  'OPERATING_COST_SETTLEMENT',
  'OTHER_INCOME',
  'RETAINED_DEPOSIT_RENT',
  'RETAINED_DEPOSIT_DAMAGES',
  'REFUNDS_OF_EARLIER_YEARS',
] as const satisfies readonly TaxCategory[];

/** The Werbungskosten lines, in the order of §58C's table. */
export const WERBUNGSKOSTEN_LINES = [
  'LOAN_INTEREST',
  'FINANCING_COSTS',
  'WEG_HAUSGELD',
  'WEG_SPENDING',
  'MAINTENANCE',
  'ADMINISTRATION',
  'INSURANCE',
  'PROPERTY_TAX',
  'BANK_FEES',
  'TAX_ADVICE',
  'TRAVEL',
  'OTHER_EXPENSE',
] as const satisfies readonly TaxCategory[];

/** The lines with `subtotals` (taxation.md §5: deducted at once, or a part of a § 82b distribution). */
const SUBTOTAL_LINES: readonly TaxCategory[] = ['WEG_SPENDING', 'MAINTENANCE'];

export type Section = 'EINNAHMEN' | 'WERBUNGSKOSTEN' | 'NOT_IN_VIEW' | 'UNCLASSIFIED';

/** Where each `taxCategory` goes (§58C's placement table); a `Record`, so no category can be left unplaced. */
export const TAX_YEAR_PLACES: Readonly<Record<TaxCategory, Section>> = {
  ...(Object.fromEntries(EINNAHMEN_LINES.map((c) => [c, 'EINNAHMEN'])) as Record<(typeof EINNAHMEN_LINES)[number], Section>),
  ...(Object.fromEntries(WERBUNGSKOSTEN_LINES.map((c) => [c, 'WERBUNGSKOSTEN'])) as Record<(typeof WERBUNGSKOSTEN_LINES)[number], Section>),
  NOT_RELEVANT: 'NOT_IN_VIEW',
  UNCLASSIFIED: 'UNCLASSIFIED',
};

export type Placement =
  | { readonly place: 'LINE'; readonly section: 'EINNAHMEN' | 'WERBUNGSKOSTEN'; readonly line: TaxCategory }
  | { readonly place: 'CAPITALIZED'; readonly line: TaxCategory }
  | { readonly place: 'NOT_IN_VIEW' }
  | { readonly place: 'UNCLASSIFIED' };

/**
 * The one place of an item (§58C): its line when its treatment is summed there (`INCOME` on an income line,
 * `DEDUCTIBLE` or `DISTRIBUTED_82B` on an expense line; a refund of an earlier year on `refund.line`), `capitalized`
 * for `CAPITALIZED`, `notInView` for `NOT_RELEVANT`, `unclassified` without a treatment.
 */
export function placementOf(meaning: {
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly refund?: Pick<RefundInfo, 'presentation' | 'line'> | null;
}): Placement {
  const section = TAX_YEAR_PLACES[meaning.taxCategory];
  if (section === 'UNCLASSIFIED' || meaning.treatment === null) return { place: 'UNCLASSIFIED' };
  if (section === 'NOT_IN_VIEW' || meaning.treatment === 'NOT_RELEVANT') return { place: 'NOT_IN_VIEW' };
  if (meaning.treatment === 'CAPITALIZED') return { place: 'CAPITALIZED', line: meaning.taxCategory };
  if (section === 'EINNAHMEN' && meaning.treatment === 'INCOME') return { place: 'LINE', section, line: meaning.taxCategory };
  if (section === 'WERBUNGSKOSTEN' && (meaning.treatment === 'DEDUCTIBLE' || meaning.treatment === 'DISTRIBUTED_82B')) {
    const line = meaning.refund?.presentation === 'INCOME' ? meaning.refund.line : meaning.taxCategory;
    return { place: 'LINE', section: TAX_YEAR_PLACES[line] === 'EINNAHMEN' ? 'EINNAHMEN' : 'WERBUNGSKOSTEN', line };
  }
  // A meaning §56's fit does not allow is never stored; should one appear, it needs a person.
  return { place: 'UNCLASSIFIED' };
}

/**
 * The signed amount an item contributes to its place, in cents (§58C "Signs"): on an income line an `INFLOW` counts
 * positive and a repayment negative; a refund of an earlier year counts positive on `REFUNDS_OF_EARLIER_YEARS`; on an
 * expense line and in `capitalized` an `OUTFLOW` counts positive and a refund negative. A deposit closing, a withdrawal
 * and a use have no direction: positive.
 */
export function signedCents(
  item: { readonly amount: Money; readonly direction: Direction | null; readonly taxCategory: TaxCategory },
  placement: Placement,
): bigint {
  const cents = centsOf(item.amount);
  if (item.direction === null) return cents;
  if (placement.place === 'LINE' && placement.section === 'EINNAHMEN') {
    // Its own income line, or a refund (an INFLOW) placed on REFUNDS_OF_EARLIER_YEARS.
    return item.direction === 'INFLOW' ? cents : -cents;
  }
  return item.direction === 'OUTFLOW' ? cents : -cents;
}

// ——— Participants and the per-item rounding (P7-D7) ———

/** A `VALID` Ownership of the PropertyReference with its exact share (§26.1). */
export interface ViewOwnership extends OwnershipPeriod {
  readonly share: { readonly numerator: number; readonly denominator: number };
}

interface Fraction {
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

const covers = (o: OwnershipPeriod, day: BusinessDate) => o.validFrom <= day && (o.validUntil === null || o.validUntil >= day);

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

// ——— The view ———

export type Level = 'PROPERTY' | 'OWNER';

export interface ViewFlag {
  readonly code: string;
  readonly details: unknown;
}

/** An item of the view (§58C "Response"). */
export interface TaxYearItem {
  readonly sourceType: SourceType;
  readonly sourceId: string;
  readonly sourcePosition: number | null;
  readonly transactionId: string | null;
  readonly date: BusinessDate;
  readonly dateSource: string;
  readonly taxYear: number | null;
  readonly direction: Direction | null;
  readonly amount: Money;
  readonly lineAmount: Money | null;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: ReviewState;
  readonly origin: Origin;
  readonly classificationId: string | null;
  readonly rule: RuleRef | null;
  readonly treatmentRule: RuleRef | null;
  readonly attribution: unknown;
  readonly refund: RefundInfo | null;
  readonly distribution:
    | (Distribution & { readonly yearAmount: Money; readonly ownerParts: readonly { readonly year: number; readonly amount: Money }[] | null })
    | null;
  readonly suggestion: TreatmentSuggestion | null;
  readonly share: { readonly ownershipId: string; readonly share: string; readonly amount: Money | null } | null;
  readonly flags: readonly ViewFlag[];
  /** "nicht zugeordnet" only: why, the candidates, and the deposit's tax meaning. */
  readonly notAttributed: { readonly reason: string; readonly candidates: readonly string[]; readonly href: string } | null;
}

export interface TaxYearLine {
  readonly taxCategory: TaxCategory;
  readonly total: Money;
  readonly itemCount: number;
  readonly subtotals: { readonly immediate: Money; readonly distributed82b: Money } | null;
  readonly items: readonly TaxYearItem[];
}

export interface TaxYearSection {
  readonly total: Money;
  readonly lines: readonly TaxYearLine[];
}

export interface TaxYearResult {
  readonly amount: Money;
  readonly kind: 'SURPLUS' | 'LOSS' | 'ZERO';
  readonly basis: 'BEFORE_DEPRECIATION';
}

/** An owner's (or `NOT_OWNED`'s) totals at the property level: summed from their item parts, never distributed. */
export interface TaxYearTotals {
  readonly einnahmen: { readonly total: Money; readonly lines: readonly Omit<TaxYearLine, 'items'>[] };
  readonly werbungskosten: { readonly total: Money; readonly lines: readonly Omit<TaxYearLine, 'items'>[] };
  readonly result: TaxYearResult;
  readonly capitalized: { readonly total: Money };
}

export interface TaxYearAcquisition {
  readonly acquisitionId: string;
  readonly transferDate: BusinessDate;
  readonly window: { readonly from: BusinessDate; readonly until: BusinessDate };
  readonly status: CheckStatus;
  readonly final: boolean;
  readonly notFinalReasons: readonly NotFinalReason[];
  readonly href: string;
}

export interface TaxYearRuleVersion {
  readonly ruleCode: string;
  readonly version: number;
  readonly title: string | null;
  readonly legalBasis: string | null;
  readonly status: RuleStatus | null;
  readonly itemCount: number;
}

export interface TaxYearReview {
  readonly final: boolean;
  readonly open: readonly { readonly code: string; readonly count: number }[];
  readonly info: readonly { readonly code: string; readonly count: number }[];
  readonly reviewStates: Readonly<Record<ReviewState, number>>;
}

export interface TaxYearView {
  readonly propertyReferenceId: string;
  readonly year: number;
  readonly ownerPartyId: string | null;
  readonly level: Level;
  readonly computedOn: BusinessDate;
  readonly einnahmen: TaxYearSection;
  readonly werbungskosten: TaxYearSection;
  readonly depreciation: { readonly status: 'DEPRECIATION_NOT_AVAILABLE'; readonly amount: null; readonly note: string };
  readonly result: TaxYearResult;
  readonly capitalized: { readonly total: Money; readonly items: readonly TaxYearItem[] };
  readonly notInView: { readonly items: readonly TaxYearItem[] };
  readonly unclassified: { readonly items: readonly TaxYearItem[] };
  readonly notAttributed: { readonly items: readonly TaxYearItem[] };
  readonly acquisitions: readonly TaxYearAcquisition[];
  readonly owners: readonly (TaxYearTotals & { readonly ownerPartyId: string; readonly ownershipIds: readonly string[] })[] | null;
  readonly notOwned: TaxYearTotals | null;
  readonly flags: readonly ViewFlag[];
  readonly review: TaxYearReview;
  readonly ruleVersions: readonly TaxYearRuleVersion[];
}

/** What the view reads, in one snapshot (§58C "One snapshot"). */
export interface TaxYearRead {
  readonly propertyReferenceId: string;
  /** `null` without `ownerPartyId`; else whether it names a Party of the Realm. */
  readonly ownerPartyFound: boolean | null;
  /**
   * §55's per-year list (in its order), with the earlier § 82b sources whose §58B parts have none in `year` beside it
   * (`listed: false`): the per-owner fold may still give them one.
   */
  readonly sources: readonly { readonly item: TaxListItem; readonly listed: boolean }[];
  /** The counting deposit closings of the Realm closed in `year` without a PropertyReference (§58A). */
  readonly unattributedDeposits: readonly DepositTaxMeaning[];
  readonly ownerships: readonly ViewOwnership[];
  /** The anschaffungsnahe checks of the PropertyReference's Acquisitions, from the same derivation as the list's. */
  readonly checks: readonly AnschaffungsnaheCheck[];
  readonly attribution: AttributionInput;
  /**
   * The counting `LOAN_INTEREST` splits of `year` (§58A's tax year, as the list derives it) of the Loans with a `VALID`
   * LoanAllocation set naming this PropertyReference. A split with a `loanId` carries no PropertyReference (0027), so
   * the view places none of them: they only raise `LOAN_INTEREST_NOT_ATTRIBUTED` (VC-X-29 decides the attribution).
   */
  readonly allocatedLoanInterest: readonly { readonly splitId: string; readonly loanId: string; readonly direction: Direction; readonly amount: Money }[];
}

export type TaxYearOutcome =
  | { readonly kind: 'VIEW'; readonly view: TaxYearView }
  | { readonly kind: 'NOT_AN_OWNER_IN_YEAR' }
  | { readonly kind: 'TAX_YEAR_TOO_LARGE'; readonly itemCount: number; readonly limit: number };

const DEPRECIATION_NOTE = 'Die AfA wird in Phase 8 abgeleitet; das Ergebnis ist vor AfA (P7-D8).';

/** An item with what the view derived for it, before a level is chosen. */
interface Derived {
  readonly source: TaxListItem;
  readonly placement: Placement;
  readonly date: BusinessDate;
  readonly participants: readonly Participant[];
  /** The property's signed contribution in `year`; `null` where nothing counts (notInView, unclassified). */
  readonly lineCents: bigint | null;
  /** Each participant's part of `lineCents` (absent: no part in `year`, for a § 82b source). */
  readonly parts: ReadonlyMap<string, bigint>;
  readonly folded: { readonly parts: FoldedParts; readonly endYears: ReadonlyMap<string, number> } | null;
  readonly flags: readonly ViewFlag[];
}

const dateOf = (m: TaxListItem): BusinessDate =>
  m.sourceType === 'TRANSACTION_SPLIT' ? m.bookingDate : m.sourceType === 'DEPOSIT_CLOSING' ? (m.closingDate as BusinessDate) : m.date;
const dateSourceOf = (m: TaxListItem): string =>
  m.sourceType === 'TRANSACTION_SPLIT' ? 'BOOKING' : m.sourceType === 'DEPOSIT_CLOSING' ? 'CLOSING' : m.dateSource;
const directionOf = (m: TaxListItem): Direction | null => (m.sourceType === 'TRANSACTION_SPLIT' ? m.direction : null);
const refundOfItem = (m: TaxListItem): RefundInfo | null => (m.sourceType === 'TRANSACTION_SPLIT' ? m.refund : null);
const distributionOfItem = (m: TaxListItem): Distribution | null => (m.sourceType === 'DEPOSIT_CLOSING' ? null : m.distribution);
const positionOf = (m: TaxListItem): number | null =>
  m.sourceType === 'WEG_RESERVE_WITHDRAWAL' || m.sourceType === 'WEG_ASSESSMENT_USE' ? m.sourcePosition : null;
const keyOfSource = (m: { readonly sourceType: string; readonly sourceId: string; readonly sourcePosition?: number | null }) =>
  `${m.sourceType}/${m.sourceId}/${m.sourcePosition ?? ''}`;

const sameOwnerships = (ownerships: readonly ViewOwnership[], a: BusinessDate, b: BusinessDate) => {
  const on = (day: BusinessDate) =>
    ownerships
      .filter((o) => covers(o, day))
      .map((o) => o.id)
      .sort()
      .join(',');
  return on(a) === on(b);
};

function deriveItem(source: TaxListItem, year: number, ownerships: readonly ViewOwnership[], changed: readonly AttributionChange[]): Derived | undefined {
  const date = dateOf(source);
  const placement: Placement = source.counts ? placementOf({ ...source, refund: refundOfItem(source) }) : { place: 'UNCLASSIFIED' };
  const flags: ViewFlag[] = [];
  const distribution = distributionOfItem(source);
  let participants: readonly Participant[];
  let lineCents: bigint | null = null;
  let parts = new Map<string, bigint>();
  let folded: Derived['folded'] = null;
  if (distribution !== null && source.counts && placement.place === 'LINE') {
    // § 82b: the per-owner fold decides the parts of `year`; the property's part is their sum.
    const fold = foldPerOwner(
      { amount: source.amount, firstYear: distribution.firstYear, years: distribution.years, rule: distribution.rule, date },
      ownerships,
    );
    participants = fold.participants;
    for (const [key, byYear] of fold.parts) {
      const cents = byYear.get(year);
      if (cents !== undefined) parts.set(key, cents);
    }
    if (parts.size === 0) return undefined;
    lineCents = [...parts.values()].reduce((s, c) => s + c, 0n);
    folded = { parts: fold.parts, endYears: fold.endYears };
    const yearAmount = partOf(distribution, year);
    if (yearAmount === undefined || centsOf(yearAmount) !== lineCents) {
      flags.push({
        code: 'DISTRIBUTION_FOLDED_PER_OWNER',
        details: {
          yearAmount: (yearAmount ?? moneyOfCents(0n, source.amount.currency)).toJSON(),
          lineAmount: moneyOfCents(lineCents, source.amount.currency).toJSON(),
          owners: [...fold.endYears.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ownerPartyId, endYear]) => ({ ownerPartyId, endYear })),
        },
      });
    }
  } else {
    // An earlier § 82b source that counts nowhere in `year` (outside a line) or does not count is not in the view.
    if (source.taxYear !== year && source.sourceType !== 'DEPOSIT_CLOSING') return undefined;
    participants = participantsOn(ownerships, date);
    if (placement.place === 'LINE' || placement.place === 'CAPITALIZED') {
      lineCents = signedCents({ amount: source.amount, direction: directionOf(source), taxCategory: source.taxCategory }, placement);
      parts = shareOut(lineCents, participants);
    } else {
      for (const p of participants) parts.set(p.key, 0n);
    }
  }
  if (date < `${year}-01-01` || date > `${year}-12-31`) {
    const nearest = (date < `${year}-01-01` ? `${year}-01-01` : `${year}-12-31`) as BusinessDate;
    if (!sameOwnerships(ownerships, date, nearest))
      flags.push({ code: 'SHARE_DATE_OUTSIDE_TAX_YEAR', details: { shareDate: date, nearestDayOfYear: nearest } });
  }
  const moved = changed.flatMap((c) =>
    c.items
      .filter((i) => i.sourceId === source.sourceId && source.sourceType === 'TRANSACTION_SPLIT')
      .map((i) => ({
        rentalContractReferenceId: c.rentalContractReferenceId,
        auditRecordId: c.auditRecordId,
        amendedAt: c.amendedAt.toISOString(),
        yearBefore: i.yearBefore,
        yearAfter: i.yearAfter,
      })),
  );
  if (moved.length > 0 && source.taxYear === year) flags.push({ code: 'ATTRIBUTION_INPUT_CHANGED', details: moved });
  if (source.reviewState === 'NEEDS_REVIEW') flags.push({ code: 'NEEDS_REVIEW', details: {} });
  if (source.treatment === null) flags.push({ code: 'UNCLASSIFIED', details: {} });
  return { source, placement, date, participants, lineCents, parts, folded, flags };
}

const kindOf = (cents: bigint): TaxYearResult['kind'] => (cents > 0n ? 'SURPLUS' : cents < 0n ? 'LOSS' : 'ZERO');
const formatFraction = (f: Fraction) => `${f.numerator}/${f.denominator}`;

/** The item at a level: the property's (`participant` undefined) or one participant's part. */
function itemAt(d: Derived, year: number, currency: string, participant: string | undefined): TaxYearItem {
  const m = d.source;
  const money = (cents: bigint) => moneyOfCents(cents, currency);
  const distribution = distributionOfItem(m);
  const p = participant === undefined ? undefined : d.participants.find((x) => x.key === participant);
  const partCents = participant === undefined ? undefined : d.parts.get(participant);
  const lineCents = participant === undefined ? d.lineCents : d.lineCents === null ? null : (partCents ?? 0n);
  const ownerParts =
    participant === undefined || d.folded === null
      ? null
      : [...(d.folded.parts.get(participant) ?? new Map<number, bigint>()).entries()]
          .sort(([a], [b]) => a - b)
          .map(([y, cents]) => ({ year: y, amount: money(cents) }));
  return {
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    sourcePosition: positionOf(m),
    transactionId: m.sourceType === 'TRANSACTION_SPLIT' ? m.transactionId : null,
    date: d.date,
    dateSource: dateSourceOf(m),
    taxYear: m.taxYear,
    direction: directionOf(m),
    amount: m.amount,
    lineAmount: lineCents === null ? null : money(lineCents),
    taxCategory: m.taxCategory,
    treatment: m.treatment,
    reviewState: m.reviewState,
    origin: m.origin,
    classificationId: m.classificationId,
    rule: m.rule,
    treatmentRule: m.sourceType === 'DEPOSIT_CLOSING' ? null : m.treatmentRule,
    attribution: m.sourceType === 'DEPOSIT_CLOSING' ? null : m.attribution,
    refund: refundOfItem(m),
    distribution: distribution === null ? null : { ...distribution, yearAmount: partOf(distribution, year) ?? money(0n), ownerParts },
    suggestion: m.sourceType === 'DEPOSIT_CLOSING' ? null : m.suggestion,
    share:
      p === undefined
        ? null
        : {
            ownershipId: [...p.ownershipIds].sort()[0] ?? NOT_OWNED,
            share: formatFraction(p.share),
            amount: lineCents === null ? null : money(lineCents),
          },
    flags: [...(m.flags as readonly ViewFlag[]), ...d.flags],
    notAttributed: null,
  };
}

function notAttributedItem(m: DepositTaxMeaning): TaxYearItem {
  const flag = m.flags.find((f) => f.code === 'NO_PROPERTY_REFERENCE');
  const details = (flag?.details ?? { reason: 'NO_RECONCILED_RENT' }) as { reason: string; candidates?: readonly string[] };
  return {
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    sourcePosition: null,
    transactionId: null,
    date: m.closingDate as BusinessDate,
    dateSource: 'CLOSING',
    taxYear: m.taxYear,
    direction: null,
    amount: m.amount,
    lineAmount: null,
    taxCategory: m.taxCategory,
    treatment: m.treatment,
    reviewState: m.reviewState,
    origin: m.origin,
    classificationId: m.classificationId,
    rule: m.rule,
    treatmentRule: null,
    attribution: null,
    refund: null,
    distribution: null,
    suggestion: null,
    share: null,
    flags: [
      ...(m.flags as readonly ViewFlag[]),
      ...(m.reviewState === 'NEEDS_REVIEW' ? [{ code: 'NEEDS_REVIEW', details: {} }] : []),
      ...(m.treatment === null ? [{ code: 'UNCLASSIFIED', details: {} }] : []),
    ],
    notAttributed: { reason: details.reason, candidates: details.candidates ?? [], href: `/api/v1/security-deposits/${m.sourceId}/tax-meaning` },
  };
}

/** Lines and totals from the derived items at a level (the property's, or one participant's). */
function sectionsOf(derived: readonly Derived[], year: number, currency: string, participant: string | undefined) {
  const money = (cents: bigint) => moneyOfCents(cents, currency);
  const takesPart = (d: Derived) => participant === undefined || d.parts.has(participant);
  const cents = (d: Derived) => (participant === undefined ? (d.lineCents ?? 0n) : (d.parts.get(participant) ?? 0n));
  const line = (taxCategory: TaxCategory): TaxYearLine => {
    const on = derived.filter((d) => d.placement.place === 'LINE' && d.placement.line === taxCategory && takesPart(d));
    const sum = (ds: readonly Derived[]) => ds.reduce((s, d) => s + cents(d), 0n);
    const distributed = on.filter((d) => d.source.treatment === 'DISTRIBUTED_82B');
    return {
      taxCategory,
      total: money(sum(on)),
      itemCount: on.length,
      subtotals: SUBTOTAL_LINES.includes(taxCategory)
        ? { immediate: money(sum(on.filter((d) => d.source.treatment !== 'DISTRIBUTED_82B'))), distributed82b: money(sum(distributed)) }
        : null,
      items: on.map((d) => itemAt(d, year, currency, participant)),
    };
  };
  const section = (lines: readonly TaxCategory[]): TaxYearSection => {
    const built = lines.map(line);
    return { total: money(built.reduce((s, l) => s + centsOf(l.total), 0n)), lines: built };
  };
  const einnahmen = section(EINNAHMEN_LINES);
  const werbungskosten = section(WERBUNGSKOSTEN_LINES);
  const resultCents = centsOf(einnahmen.total) - centsOf(werbungskosten.total);
  const capitalizedItems = derived.filter((d) => d.placement.place === 'CAPITALIZED' && takesPart(d));
  const listed = (place: Placement['place']) =>
    derived.filter((d) => d.placement.place === place && takesPart(d)).map((d) => itemAt(d, year, currency, participant));
  return {
    einnahmen,
    werbungskosten,
    result: { amount: money(resultCents), kind: kindOf(resultCents), basis: 'BEFORE_DEPRECIATION' } as TaxYearResult,
    capitalized: {
      total: money(capitalizedItems.reduce((s, d) => s + cents(d), 0n)),
      items: capitalizedItems.map((d) => itemAt(d, year, currency, participant)),
    },
    notInView: { items: listed('NOT_IN_VIEW') },
    unclassified: { items: listed('UNCLASSIFIED') },
  };
}

const withoutItems = (s: TaxYearSection): TaxYearTotals['einnahmen'] => ({
  total: s.total,
  lines: s.lines.map(({ items: _items, ...line }) => line),
});

const CONFIRMABLE = new Set([
  'ATTRIBUTED_BY_10_DAY_RULE',
  'DUE_DATE_ASSUMED',
  'ECONOMIC_PERIOD_ASSUMED',
  'NO_ECONOMIC_PERIOD',
  'WITHDRAWAL_DATE_ASSUMED',
  'WEG_FINANCIAL_YEAR_NOT_CALENDAR',
]);
const OPEN_ITEM_FLAGS = new Set([
  'NEEDS_REVIEW',
  'UNCLASSIFIED',
  'CLASSIFICATION_ON_CORRECTED_SPLIT',
  'PREDECESSOR_CLASSIFIED',
  'REFUND_YEAR_UNKNOWN',
  'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE',
  'ATTRIBUTION_INPUT_CHANGED',
]);
/** Every flag of the year is open (§58C's review table). */
const OPEN_YEAR_FLAGS = new Set([
  'DEPRECIATION_NOT_AVAILABLE',
  'ATTRIBUTION_INPUT_CHANGED',
  'ATTRIBUTION_HISTORY_INCONSISTENT',
  'OWNERSHIP_INCOMPLETE',
  'UNATTRIBUTED_ITEMS',
  'LOAN_INTEREST_NOT_ATTRIBUTED',
  'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL',
]);

/**
 * Whether an item's flag needs a person (§58C's review table): `ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN` while the item is
 * not `CAPITALIZED`; an attribution flag while no confirmed classification stands for the item; every flag the table
 * does not name as open is informative.
 */
export function flagIsOpen(code: string, item: { readonly treatment: Treatment | null; readonly origin: Origin; readonly reviewState: ReviewState }): boolean {
  if (OPEN_YEAR_FLAGS.has(code) || OPEN_ITEM_FLAGS.has(code)) return true;
  if (code === 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN') return item.treatment !== 'CAPITALIZED';
  if (CONFIRMABLE.has(code)) return !(item.origin === 'CLASSIFICATION' && (item.reviewState === 'USER_CONFIRMED' || item.reviewState === 'ADVISOR_CONFIRMED'));
  return false;
}

export function reviewOf(yearFlags: readonly ViewFlag[], items: readonly TaxYearItem[]): TaxYearReview {
  const open = new Map<string, number>();
  const info = new Map<string, number>();
  const bump = (map: Map<string, number>, code: string) => map.set(code, (map.get(code) ?? 0) + 1);
  for (const f of yearFlags) bump(OPEN_YEAR_FLAGS.has(f.code) ? open : info, f.code);
  const itemCodes = new Map<string, { open: number; info: number }>();
  for (const item of items) {
    for (const code of new Set(item.flags.map((f) => f.code))) {
      const seen = itemCodes.get(code) ?? { open: 0, info: 0 };
      if (flagIsOpen(code, item)) seen.open += 1;
      else seen.info += 1;
      itemCodes.set(code, seen);
    }
  }
  for (const [code, counts] of [...itemCodes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (counts.open > 0) open.set(code, (open.get(code) ?? 0) + counts.open);
    if (counts.info > 0) info.set(code, (info.get(code) ?? 0) + counts.info);
  }
  const reviewStates = Object.fromEntries(REVIEW_STATES.map((s) => [s, items.filter((i) => i.reviewState === s).length])) as Record<ReviewState, number>;
  const list = (map: Map<string, number>) => [...map.entries()].map(([code, count]) => ({ code, count }));
  return { final: open.size === 0, open: list(open), info: list(info), reviewStates };
}

export function ruleVersionsOf(
  items: readonly TaxYearItem[],
  checks: readonly AnschaffungsnaheCheck[],
  registry: RuleRegistry,
  today: BusinessDate,
): TaxYearRuleVersion[] {
  const counted = new Map<string, { ref: RuleRef; count: number }>();
  const count = (refs: readonly (RuleRef | null | undefined)[]) => {
    const keys = new Map<string, RuleRef>();
    for (const ref of refs) if (ref !== null && ref !== undefined) keys.set(`${ref.ruleCode}@${ref.version}`, ref);
    for (const [key, ref] of keys) counted.set(key, { ref, count: (counted.get(key)?.count ?? 0) + 1 });
  };
  for (const item of items) {
    const attribution = item.attribution as { readonly rule?: RuleRef | null } | null;
    count([item.rule, item.treatmentRule, attribution?.rule, item.distribution?.rule]);
  }
  for (const check of checks) count([check.rule]);
  return [...counted.values()]
    .map(({ ref, count: itemCount }) => {
      const version = registry.find(ref);
      return {
        ruleCode: ref.ruleCode,
        version: ref.version,
        title: version?.title ?? null,
        legalBasis: version?.legalBasis ?? null,
        status: version === undefined ? null : registry.status(version, today),
        itemCount,
      };
    })
    .sort((a, b) => (a.ruleCode !== b.ruleCode ? (a.ruleCode < b.ruleCode ? -1 : 1) : a.version - b.version));
}

/**
 * The view of `year` at the property level (`ownerPartyId` null) or of one owner, in §58C's order of checks after the
 * reads: `NOT_AN_OWNER_IN_YEAR` (no `VALID` Ownership overlapping the year and no part in an item of it), then the cap.
 */
export function buildTaxYearView(
  read: TaxYearRead,
  options: { readonly year: number; readonly ownerPartyId: string | null; readonly today: BusinessDate; readonly registry: RuleRegistry },
): TaxYearOutcome {
  const { year, ownerPartyId, today, registry } = options;
  const currency = 'EUR';
  const attribution = attributionChanges(read.attribution, year, registry);
  const derived = read.sources.map((s) => deriveItem(s.item, year, read.ownerships, attribution.changes)).filter((d): d is Derived => d !== undefined);

  // The deposits not attributed (§58C): NO_RECONCILED_RENT in every view, SEVERAL_PROPERTY_REFERENCES in each candidate's.
  const unattributed = read.unattributedDeposits.filter(
    (d) => d.counts && (d.propertyCandidates.length === 0 || d.propertyCandidates.includes(read.propertyReferenceId)),
  );

  if (ownerPartyId !== null) {
    const owns = read.ownerships.some(
      (o) => o.partyId === ownerPartyId && o.validFrom <= `${year}-12-31` && (o.validUntil === null || o.validUntil >= `${year}-01-01`),
    );
    if (!owns && !derived.some((d) => d.parts.has(ownerPartyId))) return { kind: 'NOT_AN_OWNER_IN_YEAR' };
  }
  const itemCount = derived.length + unattributed.length;
  if (itemCount > TAX_YEAR_ITEM_LIMIT) return { kind: 'TAX_YEAR_TOO_LARGE', itemCount, limit: TAX_YEAR_ITEM_LIMIT };

  const participant = ownerPartyId ?? undefined;
  const sections = sectionsOf(derived, year, currency, participant);
  const notAttributed = unattributed.map(notAttributedItem);

  // The flags of the year.
  const flags: ViewFlag[] = [{ code: 'DEPRECIATION_NOT_AVAILABLE', details: {} }];
  if (attribution.changes.length > 0) {
    flags.push({
      code: 'ATTRIBUTION_INPUT_CHANGED',
      details: attribution.changes.map((c) => ({
        rentalContractReferenceId: c.rentalContractReferenceId,
        auditRecordId: c.auditRecordId,
        amendedAt: c.amendedAt.toISOString(),
        changedEntries: c.changedEntries,
        items: c.items,
      })),
    });
  }
  for (const id of attribution.inconsistent) flags.push({ code: 'ATTRIBUTION_HISTORY_INCONSISTENT', details: { rentalContractReferenceId: id } });
  const incomplete = derived.filter((d) => d.parts.has(NOT_OWNED));
  if (incomplete.length > 0) {
    const notOwnedResult = incomplete.reduce((s, d) => {
      if (d.placement.place !== 'LINE') return s;
      const part = d.parts.get(NOT_OWNED) ?? 0n;
      return d.placement.section === 'EINNAHMEN' ? s + part : s - part;
    }, 0n);
    flags.push({
      code: 'OWNERSHIP_INCOMPLETE',
      details: {
        itemCount: incomplete.length,
        notOwnedTotal: moneyOfCents(notOwnedResult, currency).toJSON(),
        firstDate: incomplete.map((d) => d.date).sort()[0],
      },
    });
  }
  if (notAttributed.length > 0) flags.push({ code: 'UNATTRIBUTED_ITEMS', details: { count: notAttributed.length } });
  // Interest of an allocated Loan reaches no line (VC-X-29): flagged at both levels with the property's total, never summed.
  const interest = read.allocatedLoanInterest;
  if (interest.length > 0) {
    const total = interest.reduce((s, i) => s + (i.direction === 'OUTFLOW' ? centsOf(i.amount) : -centsOf(i.amount)), 0n);
    flags.push({
      code: 'LOAN_INTEREST_NOT_ATTRIBUTED',
      details: {
        loanIds: [...new Set(interest.map((i) => i.loanId))].sort(),
        interestTotal: moneyOfCents(total, currency).toJSON(),
        splitIds: interest.map((i) => i.splitId).sort(),
      },
    });
  }
  const acquisitions: TaxYearAcquisition[] = read.checks
    .filter((c) => c.acquisitionStatus !== 'CANCELLED' && c.window !== null && c.window.from <= `${year}-12-31` && c.window.until >= `${year}-01-01`)
    .map((c) => {
      const notFinal = c.flags.find((f) => f.code === 'NOT_FINAL');
      return {
        acquisitionId: c.acquisitionId,
        transferDate: c.transferDate,
        window: c.window as { from: BusinessDate; until: BusinessDate },
        status: c.status,
        final: c.final,
        notFinalReasons: notFinal === undefined ? [] : (notFinal.details as { reasons: readonly NotFinalReason[] }).reasons,
        href: `/api/v1/acquisitions/${c.acquisitionId}/anschaffungsnahe-herstellungskosten`,
      };
    });
  const notFinal = acquisitions.filter((a) => !a.final || a.status === 'NOT_COMPUTABLE');
  if (notFinal.length > 0) flags.push({ code: 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL', details: { acquisitionIds: notFinal.map((a) => a.acquisitionId) } });

  // The owners and NOT_OWNED at the property level: summed from their parts, never distributed (§27.4's F4b).
  let owners: TaxYearView['owners'] = null;
  let notOwned: TaxYearTotals | null = null;
  if (ownerPartyId === null) {
    const keys = new Set(derived.flatMap((d) => [...d.parts.keys()]));
    const totalsOf = (key: string): TaxYearTotals => {
      const s = sectionsOf(derived, year, currency, key);
      return {
        einnahmen: withoutItems(s.einnahmen),
        werbungskosten: withoutItems(s.werbungskosten),
        result: s.result,
        capitalized: { total: s.capitalized.total },
      };
    };
    owners = [...keys]
      .filter((k) => k !== NOT_OWNED)
      .sort()
      .map((key) => ({
        ownerPartyId: key,
        ownershipIds: [
          ...new Set(derived.filter((d) => d.parts.has(key)).flatMap((d) => d.participants.find((p) => p.key === key)?.ownershipIds ?? [])),
        ].sort(),
        ...totalsOf(key),
      }));
    notOwned = keys.has(NOT_OWNED) ? totalsOf(NOT_OWNED) : null;
  }

  const placed = [
    ...sections.einnahmen.lines.flatMap((l) => l.items),
    ...sections.werbungskosten.lines.flatMap((l) => l.items),
    ...sections.capitalized.items,
    ...sections.notInView.items,
    ...sections.unclassified.items,
    ...notAttributed,
  ];
  return {
    kind: 'VIEW',
    view: {
      propertyReferenceId: read.propertyReferenceId,
      year,
      ownerPartyId,
      level: ownerPartyId === null ? 'PROPERTY' : 'OWNER',
      computedOn: today,
      einnahmen: sections.einnahmen,
      werbungskosten: sections.werbungskosten,
      depreciation: { status: 'DEPRECIATION_NOT_AVAILABLE', amount: null, note: DEPRECIATION_NOTE },
      result: sections.result,
      capitalized: sections.capitalized,
      notInView: sections.notInView,
      unclassified: sections.unclassified,
      notAttributed: { items: notAttributed },
      acquisitions,
      owners,
      notOwned,
      flags,
      review: reviewOf(flags, placed),
      ruleVersions: ruleVersionsOf(
        placed,
        read.checks.filter((c) => acquisitions.some((a) => a.acquisitionId === c.acquisitionId)),
        registry,
        today,
      ),
    },
  };
}

/** For tests and callers comparing a view with §55's list: the source key of an item. */
export const sourceKeyOf = (item: { readonly sourceType: string; readonly sourceId: string; readonly sourcePosition?: number | null }) => keyOfSource(item);

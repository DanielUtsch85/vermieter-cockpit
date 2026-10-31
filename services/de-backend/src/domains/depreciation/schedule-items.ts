import { addDays, centsOf, divideHalfUp, moneyOfCents, type BusinessDate, type Money, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import { isConfirmed, type DepreciationAsset } from './asset.js';
import { NOT_OWNED_PART, componentIdOf, type CapitalizedItem, type ItemRef } from './capitalized-item.js';
import {
  ONE,
  ZERO,
  add,
  byText,
  cmp,
  div,
  firstDay,
  frac,
  lastDayOf,
  maxDate,
  minF,
  monthLabel,
  monthOf,
  mul,
  ofShare,
  rateOfYear,
  show,
  sub,
  yearOfDate,
  yearOfMonth,
  type Frac,
} from './exact.js';
import { buildingRuleOn, movableRuleOn, reciprocalPercent } from './rate.js';
import { AFA_BUILDING_LINEAR, type BuildingBand, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import { AFA_MOVABLE_LINEAR, type MovableLinearParameters } from './rules/de-afa-movable-linear.js';
import type { ComponentYear, Flag, OwnerYear, Part, ScheduleAcquisition, ScheduleOwnership, Work } from './schedule.js';

/**
 * The capitalised items of the schedule (api-design.md §59B, backlog VC-8-03; P8-D2 (2), P8-D6, P8-D7, P8-D8, B11):
 * one component per item, its parts §58C's per-item parts (the owners on the item's date, `NOT_OWNED` for the rest),
 * each part depreciated month by month in exact fractions and rounded once per year, cumulatively, half-up. On the
 * building an item starts by `subsequentCostStart`, runs at its owner's purchase rate and ends with the owner's
 * **pool** (one basis per ownership tenure, `POOLED_BASIS`) or its own series (`PER_ITEM_SERIES`); both are computed,
 * and the years in which they differ are open. A separate asset's items start in the month of `acquiredOn` and run at
 * `1/usefulLifeYears`. Nothing is stored; a figure that cannot be derived is `null` with a reason, never 0.00.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Output types

export interface ItemSourceView extends ItemRef {
  readonly classificationId: string | null;
  readonly reviewState: string | null;
  readonly taxCategory: string | null;
  readonly date: BusinessDate | null;
  readonly dateSource: string | null;
  readonly taxYear: number | null;
  readonly anschaffungsnaheAcquisitionId: string | null;
}

export interface ItemComponentRate {
  readonly kind: 'BAND' | 'USEFUL_LIFE';
  readonly band: BuildingBand | null;
  readonly ratePercent: string;
  readonly rate: string;
  readonly usefulLifeYears: number | null;
  readonly legalBasis: string;
}

export interface ItemOwner {
  readonly ownerPartyId: string;
  readonly ownershipIds: readonly string[];
  readonly share: string;
  readonly basis: Money;
  readonly firstMonth: string;
  /** The part's annual rate (`"1/50"`, `"1/30"` with a shorter life), `null` when it is not known. */
  readonly rate: string | null;
  readonly tenure: {
    readonly from: BusinessDate | null;
    readonly lastDay: BusinessDate | null;
    readonly lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' | 'VALID_UNTIL' | null;
  };
}

/** A component of `kind` `CAPITALIZED_ITEM` (§59B "The component"). */
export interface ItemComponent {
  readonly componentId: string;
  readonly kind: 'CAPITALIZED_ITEM';
  readonly source: ItemSourceView;
  readonly status: 'COMPUTABLE' | 'NOT_COMPUTABLE';
  readonly reasons: readonly Flag[];
  readonly basis: { readonly amount: Money | null; readonly netAmount: Money | null; readonly amountUsed: 'GROSS_LINE_AMOUNT' };
  readonly start: {
    readonly date: BusinessDate | null;
    readonly dateSource: 'ITEM_DATE' | 'ACQUIRED_ON';
    readonly method: 'START_OF_YEAR' | 'MONTH_OF_DATE' | 'MONTH_OF_ACQUISITION';
    readonly month: string | null;
    readonly firstYearMonths: number | null;
  };
  readonly rate: ItemComponentRate | null;
  readonly end: { readonly lastYear: number; readonly lastMonth: string } | null;
  readonly owners: readonly ItemOwner[];
  readonly notOwned: { readonly share: string; readonly basis: Money } | null;
  readonly years: readonly ComponentYear[];
  readonly flags: readonly Flag[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs and internal state

export interface ItemContext {
  readonly registry: RuleRegistry;
  readonly asset: DepreciationAsset;
  readonly assetReasons: readonly Flag[];
  /** The purchase components (building only), with their parts' months walked. */
  readonly works: readonly Work[];
  readonly ownerships: readonly ScheduleOwnership[];
  readonly acquisitions: readonly ScheduleAcquisition[];
}

/** The rate of an item part: the band of each year, a shorter life `1/n`, or a separate asset's `1/n`. */
interface PartRate {
  readonly kind: 'BAND' | 'SHORTER_USEFUL_LIFE' | 'USEFUL_LIFE';
  readonly usefulLifeYears: number | null;
  /** The annual rate of `year`, undefined without a rule version for it. */
  readonly annualOf: (year: number) => Frac | undefined;
}

interface Reading {
  /** month → the part's exact amount of the month in cents (signed). */
  readonly monthly: Map<number, Frac>;
  /** year → counted months and the last counted month's fraction. */
  readonly counted: Map<number, { months: number; fraction: Frac }>;
  lastMonth: number | null;
  /** The month in which the part's consumed fraction reached 1. */
  exhaustedMonth: number | null;
}

interface ItemPart {
  readonly participant: string;
  readonly ownershipIds: readonly string[];
  readonly share: Frac;
  readonly basisCents: bigint;
  readonly firstMonth: number;
  readonly tenureFrom: BusinessDate | null;
  readonly lastDay: BusinessDate | null;
  readonly lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' | 'VALID_UNTIL' | null;
  readonly missingFrom: { readonly year: number; readonly details: Record<string, unknown> } | null;
  readonly disposals: Map<number, Record<string, unknown>>;
  readonly changes: readonly { readonly date: BusinessDate; readonly from: Frac; readonly to: Frac }[];
  readonly fractionAt: (m: number) => Frac;
  readonly rate: PartRate | null;
  /** Part-level reasons: the part is not computed in any year (`USEFUL_LIFE_NOT_CONFIRMED`). */
  readonly partReasons: Flag[];
  /** The part is not computed from this year on (a year without a rule; the pool's purchase not computable). */
  stopFrom: { readonly year: number; readonly reason: Flag } | null;
  /** The pool: the owner's tenure (with its purchase parts), an heir's tenure, or `NOT_OWNED`. */
  readonly poolKey: string;
  readonly purchases: readonly { readonly w: Work; readonly p: Part }[];
  pooled: Reading;
  perItem: Reading;
  /** `SUBSEQUENT_COST_END_TO_VERIFY`: the years in which the readings differ, with the flag's details. */
  endToVerify: { readonly from: number; readonly to: number; readonly details: Record<string, unknown> } | null;
}

interface ItemWork {
  readonly item: CapitalizedItem | null;
  readonly ref: ItemRef;
  readonly componentId: string;
  readonly separate: boolean;
  readonly startDate: BusinessDate | null;
  readonly startMonth: number | null;
  readonly method: ItemComponent['start']['method'];
  readonly reasons: Flag[];
  readonly flags: Flag[];
  readonly parts: ItemPart[];
  readonly selected: 'POOLED_BASIS' | 'PER_ITEM_SERIES';
  readonly parameters: { readonly disposalVerified: boolean; readonly rateVerified: (year: number) => boolean };
  computable: boolean;
}

const twelfth = (annual: Frac) => div(annual, frac(12n, 1n));
const cents = (b: bigint) => frac(b, 1n);
const roundCents = (c: Frac) => divideHalfUp(c.n, c.d);

/** The continuous run of a Party's `VALID` Ownerships holding `date` (§58C, §59A): its first day and its last. */
export function tenureOf(rows: readonly ScheduleOwnership[], date: BusinessDate): { from: BusinessDate; until: BusinessDate | null } | undefined {
  const covering = rows.filter((r) => r.validFrom <= date && (r.validUntil === null || r.validUntil >= date));
  if (covering.length === 0) return undefined;
  let from = covering.map((r) => r.validFrom).sort(byText)[0] as BusinessDate;
  for (let extended = true; extended; ) {
    extended = false;
    for (const r of rows) {
      if (r.validFrom < from && (r.validUntil === null || r.validUntil >= addDays(from, -1))) {
        from = r.validFrom;
        extended = true;
      }
    }
  }
  let until: BusinessDate | null = covering.some((r) => r.validUntil === null)
    ? null
    : (covering
        .map((r) => r.validUntil as BusinessDate)
        .sort(byText)
        .pop() as BusinessDate);
  for (let extended = until !== null; extended && until !== null; ) {
    extended = false;
    const reach: BusinessDate = addDays(until, 1);
    for (const r of rows) {
      if (r.validFrom <= reach && (r.validUntil === null || r.validUntil > until)) {
        until = r.validUntil;
        extended = true;
        if (until === null) break;
      }
    }
  }
  return { from, until };
}

const heldOn = (rows: readonly ScheduleOwnership[], day: BusinessDate) =>
  rows.filter((r) => r.validFrom <= day && (r.validUntil === null || r.validUntil >= day)).reduce((sum, r) => add(sum, ofShare(r.share)), ZERO);

function buyerOn(acquisitions: readonly ScheduleAcquisition[], seller: string, day: BusinessDate): ScheduleAcquisition | undefined {
  return acquisitions.find((a) => a.status === 'CONFIRMED' && a.sellerPartyIds.includes(seller) && (a.economicTransferDate ?? a.contractDate) === day);
}

// ---------------------------------------------------------------------------------------------------------------------
// The derivation

/**
 * The item components of a schedule (§59B): for the building, `items` are the capitalised items not linked to an
 * `ACTIVE` separate asset; for a separate asset, its linked items (`null` for a link whose source the read did not
 * find). The order is the start month, then `componentId`.
 */
export function deriveItemWorks(ctx: ItemContext, items: readonly { readonly ref: ItemRef; readonly item: CapitalizedItem | null }[]): ItemWork[] {
  const { asset, registry } = ctx;
  const separate = asset.assetType === 'SEPARATE_ASSET';
  const buildingVersions = registry.versions(AFA_BUILDING_LINEAR) as readonly RuleVersion<BuildingLinearParameters>[];
  const movableVersions = registry.versions(AFA_MOVABLE_LINEAR) as readonly RuleVersion<MovableLinearParameters>[];
  const works: ItemWork[] = [];
  for (const { ref, item } of items) {
    const componentId = componentIdOf(ref);
    const reasons: Flag[] = [];
    const flags: Flag[] = [];
    if (item === null) {
      reasons.push({ code: 'LINKED_ITEM_NOT_CAPITALIZED', details: { counts: false, treatment: null, anschaffungsnaheAcquisitionId: null } });
      works.push(emptyWork(ref, componentId, separate, reasons));
      continue;
    }
    const date = item.date;
    const year = yearOfDate(date);
    // The parameters: of the version of the item's (resp. the acquisition's) first year, else the latest (§59A item 5).
    let startMonth: number;
    let method: ItemComponent['start']['method'];
    let reviewStates: readonly string[];
    let disposal: BuildingLinearParameters['end']['disposal'] | undefined;
    let selected: ItemWork['selected'] = 'PER_ITEM_SERIES';
    let notBeforeOwnerStart = true;
    let startDate: BusinessDate = date;
    if (separate) {
      const acquiredOn = asset.acquiredOn as BusinessDate;
      startDate = acquiredOn;
      const rule = movableRuleOn(registry, yearOfDate(acquiredOn)) ?? movableVersions[movableVersions.length - 1];
      startMonth = monthOf(acquiredOn) + ((rule?.parameters.firstYear.startMonthCounts ?? true) ? 0 : 1);
      method = 'MONTH_OF_ACQUISITION';
      reviewStates = rule?.parameters.basis.itemReviewStates ?? [];
      disposal = rule?.parameters.end.disposal;
      const supportedFrom = movableVersions[0]?.effectiveFrom ?? null;
      if (supportedFrom === null || acquiredOn < supportedFrom) reasons.push({ code: 'NO_APPLICABLE_RULE', details: { acquiredOn, supportedFrom } });
      if (yearOfDate(date) > yearOfDate(acquiredOn)) flags.push({ code: 'LATER_ITEM_TO_VERIFY', details: { date, acquiredOn } });
    } else {
      const rule = buildingRuleOn(registry, year) ?? buildingVersions[buildingVersions.length - 1];
      const start = rule?.parameters.subsequentCostStart;
      method = start?.method ?? 'START_OF_YEAR';
      notBeforeOwnerStart = start?.notBeforeOwnerStart ?? true;
      startMonth = method === 'START_OF_YEAR' ? year * 12 : monthOf(date);
      reviewStates = rule?.parameters.basis.capitalizedItemReviewStates ?? [];
      disposal = rule?.parameters.end.disposal;
      selected = rule?.parameters.subsequentCostEnd.method ?? 'POOLED_BASIS';
      // §59A as decided 2026-10-31: no version before 2006, so an item starting before it is not computed in any year.
      const supportedFrom = buildingVersions[0]?.effectiveFrom ?? null;
      if (supportedFrom === null || startMonth < monthOf(supportedFrom)) {
        reasons.push({ code: 'NO_APPLICABLE_RULE', details: { firstMonth: monthLabel(startMonth), supportedFrom } });
      }
      if (item.anschaffungsnaheAcquisitionId !== null)
        flags.push({ code: 'ANSCHAFFUNGSNAHE_CAPITALIZED', details: { acquisitionId: item.anschaffungsnaheAcquisitionId } });
    }
    const capitalized = item.counts && item.treatment === 'CAPITALIZED' && (!separate || item.anschaffungsnaheAcquisitionId === null);
    // Only a confirmed classification feeds a figure; the states are the rule's parameter, never a constant (§59B).
    if (capitalized && !reviewStates.includes(item.reviewState)) {
      reasons.push({ code: 'ITEM_CLASSIFICATION_NEEDS_REVIEW', details: { reviewState: item.reviewState, classificationId: item.classificationId } });
    }
    if (!capitalized) {
      reasons.push({
        code: 'LINKED_ITEM_NOT_CAPITALIZED',
        details: { counts: item.counts, treatment: item.treatment, anschaffungsnaheAcquisitionId: item.anschaffungsnaheAcquisitionId },
      });
    }
    // The order of §59B's table: ITEM_CLASSIFICATION_NEEDS_REVIEW, LINKED_ITEM_NOT_CAPITALIZED, then NO_APPLICABLE_RULE.
    reasons.sort((a, b) => order(a.code) - order(b.code));
    if (item.taxYear !== year) flags.push({ code: 'CAPITALIZED_YEAR_DIFFERS', details: { date, taxYear: item.taxYear } });
    for (const f of item.flags) if (CARRIED_FLAGS.includes(f.code)) flags.push({ code: f.code, details: f.details });
    if (item.lineAmount.isNegative()) flags.push({ code: 'CAPITALIZED_REFUND', details: {} });

    const parts: ItemPart[] = item.parts.map((part) => {
      const basisCents = centsOf(part.amount);
      return partOf(ctx, { date, separate, startMonth, notBeforeOwnerStart, disposal, part: { ...part, basisCents } });
    });
    const notOwned = parts.find((p) => p.participant === NOT_OWNED_PART);
    if (notOwned !== undefined && notOwned.basisCents !== 0n) {
      flags.push({
        code: 'CAPITALIZED_ITEM_NOT_OWNED',
        details: { notOwnedBasis: moneyOfCents(notOwned.basisCents, item.lineAmount.currency).toJSON(), date },
      });
    }
    const shorter = parts.filter((p) => p.rate?.kind === 'SHORTER_USEFUL_LIFE');
    if (!separate && shorter.length > 0) {
      const rule = buildingRuleOn(registry, year) ?? buildingVersions[buildingVersions.length - 1];
      if (rule !== undefined && !rule.parameters.subsequentCostRate.shorterLifeVerified) {
        flags.push({
          code: 'SUBSEQUENT_COST_SHORTER_LIFE_TO_VERIFY',
          details: { ownerPartyIds: shorter.map((p) => p.participant), usefulLifeYears: shorter[0]?.rate?.usefulLifeYears ?? null },
        });
      }
    }
    const work: ItemWork = {
      item,
      ref,
      componentId,
      separate,
      startDate,
      startMonth,
      method,
      reasons,
      flags,
      parts,
      selected,
      parameters: {
        disposalVerified: disposal?.verified ?? false,
        rateVerified: (y: number) => (separate ? true : (buildingRuleOn(registry, y)?.parameters.verified ?? true)),
      },
      computable: ctx.assetReasons.length === 0 && reasons.length === 0,
    };
    works.push(work);
  }

  // The months: every pool of the building (one per tenure, heirs' and NOT_OWNED's of their own), both readings.
  walkPools(ctx, works);

  // SUBSEQUENT_COST_START_TO_VERIFY on a building's item while the start rule is unverified (§59B "The start").
  for (const w of works) {
    if (w.separate || w.item === null || w.startMonth === null || !w.computable) continue;
    const rule = buildingRuleOn(registry, yearOfDate(w.item.date)) ?? buildingVersions[buildingVersions.length - 1];
    const start = rule?.parameters.subsequentCostStart;
    if (start === undefined || start.verified) continue;
    const firstMonths = w.parts.map((p) => p.firstMonth);
    const details = { date: w.item.date, method: start.method, firstMonth: monthLabel(Math.min(w.startMonth, ...firstMonths)), legalBasis: start.legalBasis };
    // A component flag (review on #186): the start moves the residual value of every later year, so every year of the
    // component is PROVISIONAL, as §59A's open component flags (as implemented, item 10).
    w.flags.push({ code: 'SUBSEQUENT_COST_START_TO_VERIFY', details });
  }

  // REFUND_EXCEEDS_CAPITALIZED: an owner's item bases up to a refund's date sum to less than zero (§59B "A refund").
  for (const w of works) {
    if (w.item === null || !w.item.lineAmount.isNegative()) continue;
    for (const part of w.parts) {
      const sum = works
        .filter((o) => o.item !== null && o.item.date <= (w.item as CapitalizedItem).date)
        .flatMap((o) => o.parts.filter((p) => p.participant === part.participant))
        .reduce((s, p) => s + p.basisCents, 0n);
      if (sum < 0n) {
        w.flags.push({
          code: 'REFUND_EXCEEDS_CAPITALIZED',
          details: { ownerPartyId: part.participant, basisSum: moneyOfCents(sum, w.item.lineAmount.currency).toJSON(), refundComponentId: w.componentId },
        });
      }
    }
  }
  return works.sort((a, b) => (a.startMonth ?? 0) - (b.startMonth ?? 0) || byText(a.componentId, b.componentId));
}

/** The order of the item reasons in §59B's table. */
const REASON_ORDER = ['ITEM_CLASSIFICATION_NEEDS_REVIEW', 'LINKED_ITEM_NOT_CAPITALIZED', 'USEFUL_LIFE_NOT_CONFIRMED', 'NO_APPLICABLE_RULE'];
const order = (code: string) => (REASON_ORDER.includes(code) ? REASON_ORDER.indexOf(code) : REASON_ORDER.length);

/** The item's own flags carried onto its component (§59B "The date", §58C). */
const CARRIED_FLAGS = ['DATE_IS_BOOKING_DATE', 'WITHDRAWAL_DATE_ASSUMED', 'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE'];

function emptyWork(ref: ItemRef, componentId: string, separate: boolean, reasons: Flag[]): ItemWork {
  return {
    item: null,
    ref,
    componentId,
    separate,
    startDate: null,
    startMonth: null,
    method: separate ? 'MONTH_OF_ACQUISITION' : 'START_OF_YEAR',
    reasons,
    flags: [],
    parts: [],
    selected: 'PER_ITEM_SERIES',
    parameters: { disposalVerified: false, rateVerified: () => true },
    computable: false,
  };
}

/** One part of an item: its owner's tenure on the item's date, the cut-off, the still-held fraction and the rate. */
function partOf(
  ctx: ItemContext,
  input: {
    readonly date: BusinessDate;
    readonly separate: boolean;
    readonly startMonth: number;
    readonly notBeforeOwnerStart: boolean;
    readonly disposal: BuildingLinearParameters['end']['disposal'] | undefined;
    readonly part: CapitalizedItem['parts'][number] & { readonly basisCents: bigint };
  },
): ItemPart {
  const { date, part, separate } = input;
  const { asset, registry } = ctx;
  const endMonthCounts = input.disposal?.endMonthCounts ?? true;
  const empty = (): Reading => ({ monthly: new Map(), counted: new Map(), lastMonth: null, exhaustedMonth: null });
  if (part.participant === NOT_OWNED_PART) {
    // No tenure: from the item's start to exhaustion, at the band's rate (resp. 1/n), never ended (§59B "Per owner").
    return {
      participant: part.participant,
      ownershipIds: [],
      share: ofShare(part.share),
      basisCents: part.basisCents,
      firstMonth: input.startMonth,
      tenureFrom: null,
      lastDay: null,
      lastDaySource: null,
      missingFrom: null,
      disposals: new Map(),
      changes: [],
      fractionAt: () => ONE,
      rate: separate ? usefulLifeRate(registry, asset) : bandRate(registry, asset),
      partReasons: [],
      stopFrom: null,
      poolKey: NOT_OWNED_PART,
      purchases: [],
      pooled: empty(),
      perItem: empty(),
      endToVerify: null,
    };
  }
  const rows = ctx.ownerships.filter((o) => o.partyId === part.participant);
  const tenure = tenureOf(rows, date);
  const tenureFrom = tenure?.from ?? date;
  const firstMonth = input.notBeforeOwnerStart ? Math.max(input.startMonth, monthOf(tenureFrom)) : input.startMonth;
  const shareOnDate = heldOn(rows, date);
  // The cut-off of the tenure's end and of each reduction after the item's date: the buyer's transfer date (§59A).
  let missingFrom: ItemPart['missingFrom'] = null;
  const disposals = new Map<number, Record<string, unknown>>();
  const missing = (day: BusinessDate, buyer: ScheduleAcquisition | undefined) => {
    const year = yearOfDate(addDays(day, -1));
    if (missingFrom === null || year < missingFrom.year)
      missingFrom = { year, details: { validUntil: addDays(day, -1), buyerAcquisitionId: buyer?.id ?? null } };
  };
  const cutOff = (day: BusinessDate) => {
    const buyer = buyerOn(ctx.acquisitions, part.participant, day);
    if (buyer === undefined || buyer.economicTransferDate === null) {
      missing(day, buyer);
      return false;
    }
    return true;
  };
  let lastDay: BusinessDate | null = null;
  let lastDaySource: ItemPart['lastDaySource'] = null;
  if (tenure?.until !== null && tenure?.until !== undefined) {
    lastDay = tenure.until;
    lastDaySource = cutOff(addDays(tenure.until, 1)) ? 'BUYER_ECONOMIC_TRANSFER_DATE' : 'VALID_UNTIL';
  }
  // The share falls within the tenure after the item's date: the running minimum against the share on that date.
  const changes: { date: BusinessDate; from: Frac; to: Frac }[] = [];
  const steps: { date: BusinessDate; f: Frac }[] = [];
  const days = [...new Set(rows.flatMap((r) => [r.validFrom, ...(r.validUntil === null ? [] : [addDays(r.validUntil, 1)])]))]
    .filter((d) => d > date && (lastDay === null || d <= lastDay))
    .sort(byText);
  let running = ONE;
  let before = shareOnDate;
  for (const d of days) {
    const held = heldOn(rows, d);
    const ratio = cmp(shareOnDate, ZERO) === 0 ? ZERO : minF(ONE, div(held, shareOnDate));
    if (cmp(ratio, running) < 0) {
      running = ratio;
      steps.push({ date: d, f: ratio });
      changes.push({ date: d, from: before, to: held });
      if (cutOff(d)) disposals.set(yearOfDate(addDays(d, -1)), { lastDay: addDays(d, -1), endMonthCounts, legalBasis: input.disposal?.legalBasis ?? null });
    }
    before = held;
  }
  if (lastDaySource === 'BUYER_ECONOMIC_TRANSFER_DATE' && lastDay !== null) {
    disposals.set(yearOfDate(lastDay), { lastDay, endMonthCounts, legalBasis: input.disposal?.legalBasis ?? null });
  }
  const fractionOn = (day: BusinessDate): Frac => {
    if (lastDay !== null && day > lastDay) return ZERO;
    if (day < date) return ONE;
    let value = ONE;
    for (const s of steps) if (s.date <= day) value = s.f;
    return value;
  };
  const fractionAt = (m: number) => (endMonthCounts ? fractionOn(maxDate(firstDay(m), tenureFrom)) : fractionOn(lastDayOf(m)));

  // The rate and the pool (B11, §59B "The rate in a pool"): the owner's purchase component whose tenure holds the date.
  const partReasons: Flag[] = [];
  let rate: PartRate | null;
  let poolKey: string;
  let purchases: { w: Work; p: Part }[] = [];
  if (separate) {
    rate = usefulLifeRate(registry, asset);
    poolKey = `${part.participant}|${tenureFrom}`;
  } else {
    purchases = ctx.works
      .flatMap((w) => w.parts.filter((p) => p.ownerPartyId === part.participant && p.hasTenure).map((p) => ({ w, p })))
      .filter(({ w }) => tenureOf(rows, w.start)?.from === tenureFrom)
      .sort((x, y) => byText(x.w.start, y.w.start) || byText(x.w.componentId, y.w.componentId));
    const governing = purchases.find(({ w, p }) => w.start <= date && (p.tenureEnd === null || date <= p.tenureEnd));
    poolKey = governing === undefined ? `${part.participant}|${tenureFrom}|HEIR` : `${part.participant}|${tenureFrom}`;
    if (governing === undefined) {
      rate = bandRate(registry, asset);
      purchases = [];
    } else {
      const entry = governing.w.entry;
      if (entry !== undefined && !isConfirmed(entry.reviewState)) {
        partReasons.push({
          code: 'USEFUL_LIFE_NOT_CONFIRMED',
          details: { acquisitionId: entry.acquisitionId, usefulLifeYears: entry.usefulLifeYears, reviewState: entry.reviewState },
        });
        rate = null;
      } else {
        const atDate = rateOfYear(registry, yearOfDate(date), asset.buildingCompletionYear, entry);
        rate =
          entry !== undefined && atDate?.kind === 'SHORTER_USEFUL_LIFE'
            ? {
                kind: 'SHORTER_USEFUL_LIFE',
                usefulLifeYears: entry.usefulLifeYears,
                annualOf: (y) => (buildingRuleOn(registry, y) === undefined ? undefined : frac(1n, BigInt(entry.usefulLifeYears))),
              }
            : bandRate(registry, asset);
      }
    }
  }
  return {
    participant: part.participant,
    ownershipIds: part.ownershipIds,
    share: ofShare(part.share),
    basisCents: part.basisCents,
    firstMonth,
    tenureFrom: tenure?.from ?? null,
    lastDay,
    lastDaySource,
    missingFrom,
    disposals,
    changes,
    fractionAt,
    rate,
    partReasons,
    stopFrom: null,
    poolKey,
    purchases,
    pooled: empty(),
    perItem: empty(),
    endToVerify: null,
  };
}

function bandRate(registry: RuleRegistry, asset: DepreciationAsset): PartRate {
  return { kind: 'BAND', usefulLifeYears: null, annualOf: (y) => rateOfYear(registry, y, asset.buildingCompletionYear, undefined)?.annual };
}

function usefulLifeRate(registry: RuleRegistry, asset: DepreciationAsset): PartRate {
  const years = asset.usefulLifeYears ?? 0;
  return {
    kind: 'USEFUL_LIFE',
    usefulLifeYears: years,
    annualOf: (y) => (years < 1 || movableRuleOn(registry, y) === undefined ? undefined : frac(1n, BigInt(years))),
  };
}

/** The last month of a purchase if every year ran at the rate of its band (or `1/n`): `nominalLastMonth` of §59B. */
function nominalLastMonth(ctx: ItemContext, w: Work): number | null {
  const versions = ctx.registry.versions(AFA_BUILDING_LINEAR) as readonly RuleVersion<BuildingLinearParameters>[];
  const earliest = versions[0];
  const fallback =
    earliest === undefined ? undefined : rateOfYear(ctx.registry, yearOfDate(earliest.effectiveFrom), ctx.asset.buildingCompletionYear, w.entry)?.annual;
  let done = ZERO;
  for (let m = w.firstMonth; m <= w.firstMonth + 1200; m++) {
    const annual = rateOfYear(ctx.registry, yearOfMonth(m), ctx.asset.buildingCompletionYear, w.entry)?.annual ?? fallback;
    if (annual === undefined) return null;
    done = add(done, minF(twelfth(annual), sub(ONE, done)));
    if (cmp(done, ONE) >= 0) return m;
  }
  return null;
}

/** Bound of the walk: a century after the latest start (1/99 is the smallest rate), as §59A. */
const HORIZON = 1200;

/**
 * Both readings of every pool (§59B "The end"). `POOLED_BASIS`: each month the pool's allowance is the rate × the
 * whole basis started so far (each part weighted by its still-held fraction, exhausted parts included); what the
 * running parts' own steps leave goes to the running item parts oldest first, each capped at its basis; refunds run
 * as series of their own. `PER_ITEM_SERIES`: each item part its own capped series. The purchase parts keep §59A's
 * figures: they take no overflow (see "As implemented (VC-8-03)").
 */
function walkPools(ctx: ItemContext, works: readonly ItemWork[]): void {
  const pools = new Map<string, { w: ItemWork; p: ItemPart }[]>();
  for (const w of works) {
    if (!w.computable) continue;
    for (const p of w.parts) {
      if (p.rate === null || p.partReasons.length > 0) continue;
      pools.set(p.poolKey, [...(pools.get(p.poolKey) ?? []), { w, p }]);
    }
  }
  for (const members of pools.values()) {
    // Each part's own series (PER_ITEM_SERIES), and the pooled reading.
    for (const { w, p } of members) p.perItem = walk([{ p, refund: p.basisCents < 0n, componentId: w.componentId }], [], false).get(p) as Reading;
    // A separate asset is never pooled (§59B): its items share one start and one rate, so each is its own series.
    if (members.every(({ w }) => w.separate)) {
      for (const { p } of members) p.pooled = p.perItem;
      continue;
    }
    const purchases = members[0]?.p.purchases ?? [];
    const purchaseKnown = purchases.every(({ w, p }) => w.computable && p.basisCents !== null && p.fractionAt !== null);
    const pooled = walk(
      members.map(({ w, p }) => ({ p, refund: p.basisCents < 0n, componentId: w.componentId })),
      purchaseKnown ? purchases : [],
      true,
      ctx,
    );
    for (const { p } of members) p.pooled = pooled.get(p) as Reading;
    const exhausted = pooled.firstExhausted;

    // A purchase not computable: the pool's figures are known only while it runs, up to its nominal last month.
    let stop: { year: number; month: number; poolComponentId: string; reason: Flag } | null = null;
    if (!purchaseKnown) {
      for (const { w } of purchases.filter(({ w, p }) => !(w.computable && p.basisCents !== null))) {
        const nominal = nominalLastMonth(ctx, w);
        const historical = w.reasons.some((r) => r.code === 'HISTORICAL_RULE_NOT_SUPPORTED' || r.code === 'NO_APPLICABLE_RULE') || nominal === null;
        const month = nominal ?? Number.MIN_SAFE_INTEGER;
        if (stop === null || month < stop.month) {
          const details = { poolComponentId: w.componentId, nominalLastMonth: nominal === null ? null : monthLabel(nominal) };
          stop = {
            year: nominal === null ? Number.MIN_SAFE_INTEGER : yearOfMonth(nominal),
            month,
            poolComponentId: w.componentId,
            reason: historical
              ? { code: 'NO_APPLICABLE_RULE', details }
              : {
                  code: 'POOL_PURCHASE_NOT_COMPUTABLE',
                  details: { ...details, reasons: [...w.reasons.map((r) => r.code), ...(w.computable ? [] : ['NOT_COMPUTABLE'])] },
                },
          };
        }
      }
    }

    for (const { w, p } of members) {
      const selectedReading = w.selected === 'POOLED_BASIS' ? p.pooled : p.perItem;
      const alternativeReading = w.selected === 'POOLED_BASIS' ? p.perItem : p.pooled;
      const alternativeMethod = w.selected === 'POOLED_BASIS' ? 'PER_ITEM_SERIES' : 'POOLED_BASIS';
      if (stop !== null) {
        // Under POOLED_BASIS the part is not computed from the nominal last month's year on; under PER_ITEM_SERIES it is
        // computed and flagged from then on (§59B "NO_APPLICABLE_RULE").
        if (w.selected === 'POOLED_BASIS') {
          p.pooled = p.perItem;
          p.stopFrom = { year: stop.year, reason: stop.reason };
        } else if (p.perItem.lastMonth !== null && p.perItem.lastMonth >= stop.month) {
          p.endToVerify = {
            from: Math.max(stop.year, yearOfMonth(p.firstMonth)),
            to: yearOfMonth(p.perItem.lastMonth),
            details: {
              exhaustedComponentId: stop.poolComponentId,
              exhaustedLastMonth: monthLabel(stop.month),
              method: w.selected,
              alternativeMethod,
              alternativeLastMonth: null,
              alternativeAmount: null,
            },
          };
        }
        continue;
      }
      // The first month in which the readings differ, through the later of the two last months (review on #180).
      const months = [...new Set([...selectedReading.monthly.keys(), ...alternativeReading.monthly.keys()])].sort((a, b) => a - b);
      const differs = months.find((m) => cmp(selectedReading.monthly.get(m) ?? ZERO, alternativeReading.monthly.get(m) ?? ZERO) !== 0);
      if (differs === undefined) continue;
      const lastMonths = [selectedReading.lastMonth, alternativeReading.lastMonth].filter((m): m is number => m !== null);
      p.endToVerify = {
        from: yearOfMonth(differs),
        to: yearOfMonth(Math.max(...lastMonths)),
        details: {
          exhaustedComponentId: exhausted?.componentId ?? null,
          exhaustedLastMonth: exhausted === null || exhausted === undefined ? null : monthLabel(exhausted.month),
          method: w.selected,
          alternativeMethod,
          alternativeLastMonth: alternativeReading.lastMonth === null ? null : monthLabel(alternativeReading.lastMonth),
        },
      };
    }
  }
  // A year without a rule version before the part is exhausted stops it from that year (a test registry ending).
  for (const w of works) {
    if (!w.computable) continue;
    for (const p of w.parts) {
      if (p.rate === null || p.stopFrom !== null) continue;
      const exhausted = p.perItem.exhaustedMonth;
      for (let y = yearOfMonth(p.firstMonth); y <= yearOfMonth(p.firstMonth) + 100 && (exhausted === null || y <= yearOfMonth(exhausted)); y++) {
        if (p.rate.annualOf(y) === undefined) {
          p.stopFrom = { year: y, reason: { code: 'NO_APPLICABLE_RULE', details: { yearsWithoutRule: [y] } } };
          break;
        }
      }
    }
  }
}

type WalkResult = Map<ItemPart, Reading> & { firstExhausted?: { componentId: string; month: number } | null };

/** The month-by-month walk of one pool (or of one part alone). */
function walk(
  members: readonly { readonly p: ItemPart; readonly refund: boolean; readonly componentId: string }[],
  purchases: readonly { readonly w: Work; readonly p: Part }[],
  pooled: boolean,
  ctx?: ItemContext,
): WalkResult {
  const result: WalkResult = new Map();
  result.firstExhausted = null;
  const used = new Map<ItemPart, Frac>();
  for (const { p } of members) {
    used.set(p, ZERO);
    result.set(p, { monthly: new Map(), counted: new Map(), lastMonth: null, exhaustedMonth: null });
  }
  if (members.length === 0) return result;
  const startMonth = Math.min(...members.map(({ p }) => p.firstMonth));
  const endMonth = Math.max(...members.map(({ p }) => p.firstMonth)) + HORIZON;
  const order = [...members].filter(({ refund }) => !refund).sort((a, b) => a.p.firstMonth - b.p.firstMonth);
  // A purchase's consumed fraction from its own first month (it starts before the pool's items, §59A's nominal months).
  const purchaseUsed = new Map<Part, Frac>(
    purchases.map(({ w, p }) => [p, [...w.monthly.entries()].filter(([m]) => m < startMonth).reduce((sum, [, q]) => add(sum, q), ZERO)]),
  );
  const lastMonthOf = (p: ItemPart) => (p.lastDay === null ? Number.MAX_SAFE_INTEGER : monthOf(p.lastDay));
  for (let m = startMonth; m <= endMonth; m++) {
    const year = yearOfMonth(m);
    const running = members.filter(({ p }) => m >= p.firstMonth && m <= lastMonthOf(p) && cmp(used.get(p) as Frac, ONE) < 0);
    if (running.length === 0 && members.every(({ p }) => m > p.firstMonth)) break;
    let allowance = ZERO;
    let ownSum = ZERO;
    if (pooled && ctx !== undefined) {
      for (const { w, p } of purchases) {
        if (m < w.firstMonth || p.fractionAt === null || p.basisCents === null) continue;
        const f = p.fractionAt(m);
        const q = w.monthly.get(m) ?? ZERO;
        const annual = rateOfYear(ctx.registry, year, ctx.asset.buildingCompletionYear, w.entry)?.annual ?? ZERO;
        const weight = mul(f, cents(p.basisCents));
        allowance = add(allowance, mul(weight, twelfth(annual)));
        ownSum = add(ownSum, mul(weight, q));
        const before = purchaseUsed.get(p) as Frac;
        const after = add(before, q);
        purchaseUsed.set(p, after);
        if (cmp(before, ONE) < 0 && cmp(after, ONE) >= 0 && result.firstExhausted === null) result.firstExhausted = { componentId: w.componentId, month: m };
      }
    }
    const own = new Map<ItemPart, Frac>();
    for (const { p, refund } of members) {
      if (m < p.firstMonth || m > lastMonthOf(p)) continue;
      const annual = p.rate?.annualOf(year);
      if (annual === undefined) continue;
      const step = minF(twelfth(annual), sub(ONE, used.get(p) as Frac));
      own.set(p, cmp(step, ZERO) > 0 ? step : ZERO);
      if (!pooled || refund) continue;
      const weight = mul(p.fractionAt(m), cents(p.basisCents));
      allowance = add(allowance, mul(weight, twelfth(annual)));
      ownSum = add(ownSum, mul(weight, own.get(p) as Frac));
    }
    const extra = new Map<ItemPart, Frac>();
    if (pooled) {
      let left = sub(allowance, ownSum);
      for (const { p } of order) {
        if (cmp(left, ZERO) <= 0) break;
        const step = own.get(p);
        if (step === undefined) continue;
        const weight = mul(p.fractionAt(m), cents(p.basisCents));
        if (cmp(weight, ZERO) <= 0) continue;
        const room = sub(sub(ONE, used.get(p) as Frac), step);
        if (cmp(room, ZERO) <= 0) continue;
        const take = minF(div(left, weight), room);
        extra.set(p, take);
        left = sub(left, mul(weight, take));
      }
    }
    for (const { p, componentId } of members) {
      const step = own.get(p);
      if (step === undefined) continue;
      const total = add(step, extra.get(p) ?? ZERO);
      const before = used.get(p) as Frac;
      used.set(p, add(before, total));
      const reading = result.get(p) as Reading;
      if (cmp(before, ONE) < 0 && cmp(add(before, total), ONE) >= 0) {
        reading.exhaustedMonth = m;
        if (result.firstExhausted === null && pooled) result.firstExhausted = { componentId, month: m };
      }
      const f = p.fractionAt(m);
      const amount = mul(mul(f, cents(p.basisCents)), total);
      if (cmp(total, ZERO) > 0 && cmp(f, ZERO) > 0) {
        reading.monthly.set(m, amount);
        const seen = reading.counted.get(year) ?? { months: 0, fraction: ZERO };
        reading.counted.set(year, { months: seen.months + 1, fraction: f });
        reading.lastMonth = m;
      }
    }
  }
  return result;
}

/** The last year in which a part of the item depreciates (the selected reading), or a flagged later year. */
function lastYearOf(w: ItemWork): number | null {
  const years = w.parts.flatMap((p) => {
    const reading = w.selected === 'POOLED_BASIS' ? p.pooled : p.perItem;
    return [...(reading.lastMonth === null ? [] : [yearOfMonth(reading.lastMonth)]), ...(p.endToVerify === null ? [] : [p.endToVerify.to])];
  });
  return years.length === 0 ? null : Math.max(...years);
}

// ---------------------------------------------------------------------------------------------------------------------
// The component of the response

const isOpenCode = (informative: readonly string[]) => (code: string) => !informative.includes(code);

/** The exact cumulative AfA of a part in cents to the end of `year`. */
function cumulativeCents(reading: Reading, year: number): Frac {
  let total = ZERO;
  for (const [m, amount] of reading.monthly) if (yearOfMonth(m) <= year) total = add(total, amount);
  return total;
}

export function itemComponentOf(
  w: ItemWork,
  ctx: ItemContext,
  range: { readonly from: number; readonly to: number },
  ownerPartyId: string | null,
  informative: readonly string[],
): ItemComponent {
  const isOpen = isOpenCode(informative);
  const currency = w.item?.lineAmount.currency ?? 'EUR';
  const reasonsOfComponent = [...ctx.assetReasons, ...w.reasons];
  const componentOpen = w.flags.some((f) => isOpen(f.code));
  const readingOf = (p: ItemPart) => (p.stopFrom !== null ? p.perItem : w.selected === 'POOLED_BASIS' ? p.pooled : p.perItem);
  const alternativeOf = (p: ItemPart) => (w.selected === 'POOLED_BASIS' ? p.perItem : p.pooled);
  const lastYear = w.computable ? lastYearOf(w) : null;
  const partLastYear = (p: ItemPart): number => {
    const reading = readingOf(p);
    const ends = [
      yearOfMonth(p.firstMonth),
      ...(reading.lastMonth === null ? [] : [yearOfMonth(reading.lastMonth)]),
      ...(p.endToVerify === null ? [] : [p.endToVerify.to]),
    ];
    const end = Math.max(...ends);
    return p.lastDay === null ? end : Math.min(end, yearOfDate(p.lastDay));
  };
  const ownerYearOf = (p: ItemPart, year: number): OwnerYear => {
    const notCalculable = (reasons: readonly Flag[]): OwnerYear => ({
      ownerPartyId: p.participant,
      months: null,
      fraction: null,
      amount: null,
      residualValue: null,
      calculationStatus: 'NOT_CALCULABLE',
      reasons,
      flags: [],
    });
    if (!w.computable) return notCalculable(reasonsOfComponent);
    if (p.partReasons.length > 0) return notCalculable(p.partReasons);
    if (p.missingFrom !== null && year >= p.missingFrom.year) return notCalculable([{ code: 'DISPOSAL_DATE_MISSING', details: p.missingFrom.details }]);
    if (p.stopFrom !== null && year >= p.stopFrom.year) return notCalculable([p.stopFrom.reason]);
    const reading = readingOf(p);
    const now = roundCents(cumulativeCents(reading, year));
    const before = roundCents(cumulativeCents(reading, year - 1));
    const counted = reading.counted.get(year);
    const flags: Flag[] = [];
    if (!w.parameters.rateVerified(year)) {
      const rule = buildingRuleOn(ctx.registry, year);
      flags.push({ code: 'HISTORICAL_RULE_TO_VERIFY', details: { ruleCode: rule?.ruleCode ?? AFA_BUILDING_LINEAR, version: rule?.version ?? null } });
    }
    const disposal = p.disposals.get(year);
    if (disposal !== undefined && !w.parameters.disposalVerified)
      flags.push({ code: 'DISPOSAL_YEAR_TO_VERIFY', details: { ...disposal, months: counted?.months ?? 0 } });
    for (const c of p.changes.filter((c) => yearOfDate(c.date) === year)) {
      flags.push({ code: 'OWNER_SHARE_CHANGED', details: { date: c.date, from: show(c.from), to: show(c.to) } });
    }
    if (p.endToVerify !== null && year >= p.endToVerify.from && year <= p.endToVerify.to) {
      const alternative = alternativeOf(p);
      const alternativeAmount =
        p.endToVerify.details['alternativeAmount'] === null
          ? null
          : moneyOfCents(roundCents(cumulativeCents(alternative, year)) - roundCents(cumulativeCents(alternative, year - 1)), currency).toJSON();
      flags.push({ code: 'SUBSEQUENT_COST_END_TO_VERIFY', details: { ...p.endToVerify.details, alternativeAmount } });
    }
    const open = componentOpen || flags.some((f) => isOpen(f.code));
    return {
      ownerPartyId: p.participant,
      months: counted?.months ?? 0,
      fraction: counted === undefined ? null : show(counted.fraction),
      amount: moneyOfCents(now - before, currency),
      residualValue: moneyOfCents(p.basisCents - now, currency),
      calculationStatus: open ? 'PROVISIONAL' : 'CALCULATED',
      reasons: [],
      flags: sortFlags(flags),
    };
  };
  const shownParts = ownerPartyId === null ? w.parts : w.parts.filter((p) => p.participant === ownerPartyId);
  const listedIn = (p: ItemPart, year: number) => {
    if (!w.computable || p.partReasons.length > 0) return true;
    return year >= yearOfMonth(p.firstMonth) && year <= partLastYear(p);
  };
  const firstYear = w.startMonth === null ? range.from : yearOfMonth(w.startMonth);
  const yearsTo = w.computable && lastYear !== null ? Math.min(range.to, Math.max(lastYear, ...w.parts.map(partLastYear))) : range.to;
  const years: ComponentYear[] = [];
  for (let year = Math.max(range.from, firstYear); year <= yearsTo; year++) {
    const listed = shownParts.filter((p) => listedIn(p, year)).map((p) => ({ p, y: ownerYearOf(p, year) }));
    const owners = listed.filter(({ p }) => p.participant !== NOT_OWNED_PART).map(({ y }) => y);
    const notOwnedYear = listed.find(({ p }) => p.participant === NOT_OWNED_PART)?.y;
    const all = listed.map(({ y }) => y);
    const notCalculable = all.some((o) => o.calculationStatus === 'NOT_CALCULABLE') || !w.computable;
    const known =
      w.computable &&
      w.parts.every(
        (p) => p.partReasons.length === 0 && (p.missingFrom === null || p.missingFrom.year > year) && (p.stopFrom === null || p.stopFrom.year > year),
      );
    const cumulative = known ? w.parts.map((p) => roundCents(cumulativeCents(readingOf(p), year))) : null;
    const sum = (values: readonly bigint[]) =>
      moneyOfCents(
        values.reduce((s, v) => s + v, 0n),
        currency,
      );
    const rule = w.separate ? movableRuleOn(ctx.registry, year) : buildingRuleOn(ctx.registry, year);
    const band = w.separate || rule === undefined ? null : rateOfYear(ctx.registry, year, ctx.asset.buildingCompletionYear, undefined)?.band;
    years.push({
      year,
      rule: rule === undefined ? null : { ruleCode: rule.ruleCode, version: rule.version, band: band?.band ?? null, legalBasis: band?.legalBasis ?? null },
      months: w.computable ? Math.max(0, ...w.parts.map((p) => readingOf(p).counted.get(year)?.months ?? 0)) : null,
      amount: notCalculable ? null : sum(all.map((o) => centsOf(o.amount as Money))),
      cumulative: notCalculable || cumulative === null ? null : sum(cumulative),
      residualValue: notCalculable || cumulative === null ? null : sum(w.parts.map((p, i) => p.basisCents - (cumulative[i] as bigint))),
      notOwned: notOwnedYear === undefined || ownerPartyId !== null ? null : notOwnedYear.amount,
      calculationStatus: notCalculable
        ? 'NOT_CALCULABLE'
        : all.some((o) => o.calculationStatus === 'PROVISIONAL') || componentOpen
          ? 'PROVISIONAL'
          : 'CALCULATED',
      reasons: notCalculable ? mergeOwnerFlags(listed.map(({ y }) => ({ ownerPartyId: y.ownerPartyId, flags: y.reasons }))) : [],
      owners,
      flags: mergeOwnerFlags(listed.map(({ y }) => ({ ownerPartyId: y.ownerPartyId, flags: y.flags }))),
    });
  }
  const lastMonth = w.computable
    ? Math.max(
        ...w.parts.flatMap((p) => {
          const m = readingOf(p).lastMonth;
          return m === null ? [] : [p.lastDay === null ? m : Math.min(m, monthOf(p.lastDay))];
        }),
      )
    : null;
  const notOwned = w.parts.find((p) => p.participant === NOT_OWNED_PART);
  const item = w.item;
  const rateYear = Math.max(firstYear, Math.min(range.to, lastYear ?? range.to));
  const componentRate: ItemComponentRate | null = w.separate
    ? ctx.asset.usefulLifeYears === null
      ? null
      : {
          kind: 'USEFUL_LIFE',
          band: null,
          ratePercent: reciprocalPercent(ctx.asset.usefulLifeYears),
          rate: `1/${ctx.asset.usefulLifeYears}`,
          usefulLifeYears: ctx.asset.usefulLifeYears,
          legalBasis: '§ 7 Abs. 1 EStG',
        }
    : (() => {
        const r = rateOfYear(ctx.registry, rateYear, ctx.asset.buildingCompletionYear, undefined);
        return r === undefined
          ? null
          : { kind: 'BAND', band: r.band.band, ratePercent: r.band.ratePercent, rate: show(r.annual), usefulLifeYears: null, legalBasis: r.band.legalBasis };
      })();
  return {
    componentId: w.componentId,
    kind: 'CAPITALIZED_ITEM',
    source: {
      sourceType: w.ref.sourceType,
      sourceId: w.ref.sourceId,
      sourcePosition: w.ref.sourcePosition,
      classificationId: item?.classificationId ?? null,
      reviewState: item?.reviewState ?? null,
      taxCategory: item?.taxCategory ?? null,
      date: item?.date ?? null,
      dateSource: item?.dateSource ?? null,
      taxYear: item?.taxYear ?? null,
      anschaffungsnaheAcquisitionId: item?.anschaffungsnaheAcquisitionId ?? null,
    },
    status: w.computable ? 'COMPUTABLE' : 'NOT_COMPUTABLE',
    reasons: w.reasons,
    basis: { amount: item?.lineAmount ?? null, netAmount: item?.netAmount ?? null, amountUsed: 'GROSS_LINE_AMOUNT' },
    start: {
      date: w.startDate,
      dateSource: w.separate ? 'ACQUIRED_ON' : 'ITEM_DATE',
      method: w.method,
      month: w.startMonth === null ? null : monthLabel(w.startMonth),
      firstYearMonths: w.startMonth === null ? null : 12 - (w.startMonth % 12),
    },
    rate: componentRate,
    end: lastYear === null || lastMonth === null || !Number.isFinite(lastMonth) ? null : { lastYear: yearOfMonth(lastMonth), lastMonth: monthLabel(lastMonth) },
    owners: shownParts
      .filter((p) => p.participant !== NOT_OWNED_PART)
      .sort((a, b) => byText(a.participant, b.participant))
      .map((p) => ({
        ownerPartyId: p.participant,
        ownershipIds: p.ownershipIds,
        share: show(p.share),
        basis: moneyOfCents(p.basisCents, currency),
        firstMonth: monthLabel(p.firstMonth),
        rate: p.rate === null ? null : rateLabel(p.rate, firstYear),
        tenure: { from: p.tenureFrom, lastDay: p.lastDay, lastDaySource: p.lastDaySource },
      })),
    notOwned: notOwned === undefined || ownerPartyId !== null ? null : { share: show(notOwned.share), basis: moneyOfCents(notOwned.basisCents, currency) },
    years: years.map((y) => ({ ...y, owners: [...y.owners].sort((a, b) => byText(a.ownerPartyId, b.ownerPartyId)) })),
    flags: sortFlags(w.flags),
  };
}

const rateLabel = (rate: PartRate, year: number) => {
  const annual = rate.annualOf(year);
  return annual === undefined ? null : show(annual);
};

/** The first and the last year of an item component (the default range, §59A "Path and query"). */
export function itemYears(w: ItemWork): { readonly first: number | null; readonly last: number | null } {
  const last = w.computable ? lastYearOf(w) : null;
  const ends = w.parts
    .map((p) => (p.stopFrom !== null ? p.perItem : w.selected === 'POOLED_BASIS' ? p.pooled : p.perItem).lastMonth)
    .filter((m): m is number => m !== null);
  return { first: w.startMonth === null ? null : yearOfMonth(w.startMonth), last: last ?? (ends.length === 0 ? null : yearOfMonth(Math.max(...ends))) };
}

export const itemParticipants = (w: ItemWork) => w.parts.map((p) => p.participant);

const sortFlags = (flags: readonly Flag[]) => [...flags].sort((a, b) => byText(a.code, b.code));

function mergeOwnerFlags(entries: readonly { ownerPartyId: string; flags: readonly Flag[] }[]): Flag[] {
  const byCode = new Map<string, Set<string>>();
  for (const { ownerPartyId, flags } of entries) for (const f of flags) byCode.set(f.code, (byCode.get(f.code) ?? new Set()).add(ownerPartyId));
  return sortFlags([...byCode.entries()].map(([code, ids]) => ({ code, details: { ownerPartyIds: [...ids].sort(byText) } })));
}

export type { ItemWork };

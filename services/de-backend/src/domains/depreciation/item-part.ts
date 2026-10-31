import { addDays, divideHalfUp, type BusinessDate, type RuleRegistry } from '../../shared/index.js';
import { isConfirmed, type DepreciationAsset } from './asset.js';
import { NOT_OWNED_PART, type CapitalizedItem, type ItemRef } from './capitalized-item.js';
import { ONE, ZERO, add, byText, cmp, div, firstDay, frac, lastDayOf, maxDate, minF, monthOf, ofShare, rateOfYear, yearOfDate, type Frac } from './exact.js';
import { buildingRuleOn, movableRuleOn } from './rate.js';
import type { BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import type { Flag, ItemComponent, ScheduleAcquisition, ScheduleOwnership } from './schedule-model.js';
import type { Part, Work } from './purchase-work.js';

/**
 * An owner's part of a capitalised item (api-design.md §59B "Per owner", §58C): the owner's tenure on the item's date
 * (never before the owner's start, VC-X-33), the cut-off and the disposal year, the still-held fraction, the rate (the
 * owner's purchase rate, the band, or a separate asset's `1/n`) and the pool. Moved out of `schedule-items.ts`
 * unchanged (issue #191).
 */

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
export interface PartRate {
  readonly kind: 'BAND' | 'SHORTER_USEFUL_LIFE' | 'USEFUL_LIFE';
  readonly usefulLifeYears: number | null;
  /** The annual rate of `year`, undefined without a rule version for it. */
  readonly annualOf: (year: number) => Frac | undefined;
}

export interface Reading {
  /** month → the part's exact amount of the month in cents (signed). */
  readonly monthly: Map<number, Frac>;
  /** year → counted months and the last counted month's fraction. */
  readonly counted: Map<number, { months: number; fraction: Frac }>;
  lastMonth: number | null;
  /** The month in which the part's consumed fraction reached 1. */
  exhaustedMonth: number | null;
}

export interface ItemPart {
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

export interface ItemWork {
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

export const twelfth = (annual: Frac) => div(annual, frac(12n, 1n));
export const cents = (b: bigint) => frac(b, 1n);
export const roundCents = (c: Frac) => divideHalfUp(c.n, c.d);

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

/** One part of an item: its owner's tenure on the item's date, the cut-off, the still-held fraction and the rate. */
export function partOf(
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
  // The owner's purchase components of this tenure, read where their Ownerships begin (`ownedFrom`).
  const tenurePurchases = separate
    ? []
    : ctx.works
        .flatMap((w) => w.parts.filter((p) => p.ownerPartyId === part.participant && p.hasTenure).map((p) => ({ w, p })))
        .filter(({ w }) => tenureOf(rows, w.ownedFrom)?.from === tenureFrom)
        .sort((x, y) => byText(x.w.ownedFrom, y.w.ownedFrom) || byText(x.w.componentId, y.w.componentId));
  // Never before the owner's start (§59B): unknown while the purchase opening the tenure has no `economicTransferDate`,
  // and never taken from its contract date (VC-X-33).
  const opening = tenurePurchases.find(({ w }) => w.ownedFrom === tenureFrom)?.w;
  const startUnknown = input.notBeforeOwnerStart && opening !== undefined && opening.start === null;
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
  if (startUnknown && opening !== undefined) {
    partReasons.push({ code: 'TRANSFER_DATE_MISSING', details: { acquisitionId: opening.acquisition.id, contractDate: opening.acquisition.contractDate } });
  }
  let rate: PartRate | null;
  let poolKey: string;
  let purchases: { w: Work; p: Part }[] = [];
  if (separate) {
    rate = usefulLifeRate(registry, asset);
    poolKey = `${part.participant}|${tenureFrom}`;
  } else {
    purchases = tenurePurchases;
    const governing = purchases.find(({ w, p }) => w.ownedFrom <= date && (p.tenureEnd === null || date <= p.tenureEnd));
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

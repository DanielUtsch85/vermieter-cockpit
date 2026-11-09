import { ownershipStart } from '../acquisition/index.js';
import { addDays, divideHalfUp, type BusinessDate, type RuleRegistry } from '../../shared/index.js';
import { isConfirmed, type DepreciationAsset } from './asset.js';
import { NOT_OWNED_PART, type CapitalizedItem, type ItemRef } from './capitalized-item.js';
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
  sub,
  monthLabel,
  monthOf,
  ofShare,
  rateOfYear,
  yearOfDate,
  yearOfMonth,
  type Frac,
} from './exact.js';
import { isMethodReason } from './purchase-method.js';
import { isShorterLifeBlockingReason } from './shorter-life.js';
import { buildingRuleOn, movableRuleOn } from './rate.js';
import { AFA_BUILDING_LINEAR, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
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
  /**
   * §59G Part 2: the step of month `m` given the part's consumed fraction `used` (`1/(L − m + 1)` of what is left from
   * the switch, the band before it), so every part of the pool ends in `L`; undefined for a rate of whole years.
   */
  readonly stepOf?: (m: number, used: Frac) => Frac;
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
  /** Part-level reasons: the part is not computed in any year (`USEFUL_LIFE_NOT_CONFIRMED`, a method reason of §59C). */
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
  /** §59F: the completion of the work (a building's item), the item's date (interest) or `acquiredOn` (a separate asset). */
  readonly startDateSource: 'PERFORMANCE_UNTIL' | 'ITEM_DATE' | 'ACQUIRED_ON';
  readonly startMonth: number | null;
  readonly method: ItemComponent['start']['method'];
  readonly reasons: Flag[];
  readonly flags: Flag[];
  readonly parts: ItemPart[];
  readonly selected: 'POOLED_BASIS' | 'PER_ITEM_SERIES';
  readonly parameters: { readonly disposalVerified: boolean; readonly rateVerified: (year: number, shorter: boolean) => boolean };
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
  for (let extended = true; extended;) {
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
  for (let extended = until !== null; extended && until !== null;) {
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
  return acquisitions.find((a) => a.status === 'CONFIRMED' && a.sellerPartyIds.includes(seller) && ownershipStart(a) === day);
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
  let stopFrom: ItemPart['stopFrom'] = null;
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
      }
      // §59C: a later cost runs with the method of its owner's purchase. A method reason of the purchase that gives the
      // rate, or of any purchase of the owner's pool (whose months the pooled end reads), stops the part in every year:
      // it is never computed linearly under a method nobody confirmed.
      const methodBlocked = [governing, ...purchases.filter((x) => x !== governing)]
        .map(({ w }) => w.reasons.find((r) => isMethodReason(r.code)))
        .find((r) => r !== undefined);
      if (methodBlocked !== undefined) {
        partReasons.push({ code: methodBlocked.code, details: { acquisitionId: methodBlocked.details['acquisitionId'] } });
        rate = null;
      } else if (partReasons.some((r) => r.code === 'USEFUL_LIFE_NOT_CONFIRMED')) {
        rate = null;
      } else {
        // §59G Part 1: a purchase of the pool whose shorter life is not judged computable (no valuation date, before the
        // purchase, a later evidence not released) stops the part in every year, as an unconfirmed entry does.
        const blocked = [governing, ...purchases.filter((x) => x !== governing)]
          .map(({ w }) => w.reasons.find((r) => isShorterLifeBlockingReason(r.code)))
          .find((r) => r !== undefined);
        const versions = registry.versions(AFA_BUILDING_LINEAR) as readonly { readonly parameters: BuildingLinearParameters }[];
        const shorterLifeRule = (buildingRuleOn(registry, yearOfDate(date)) ?? versions[versions.length - 1])?.parameters.subsequentCostRate.shorterLife;
        const pool = [governing, ...purchases.filter((x) => x !== governing)];
        const guard = blocked === undefined ? shorterLifeGuard(pool, firstMonth, shorterLifeRule ?? 'NOT_COMPUTABLE') : null;
        if (blocked !== undefined) {
          partReasons.push({ code: blocked.code, details: { acquisitionId: blocked.details['acquisitionId'] } });
          rate = null;
        } else if (guard !== null && 'spread' in guard) {
          // §59G Part 2 (`REMAINING_USEFUL_LIFE`): what is left of the part runs with the purchase to its last month `L`;
          // an owner of the purchase not computed from `YE` (release, declared AfA) stops the part from then too.
          const { w: pw, switchMonth, lastMonth, usefulLifeYears } = guard.spread;
          rate = spreadRate(registry, asset, { switchMonth, lastMonth, usefulLifeYears, firstMonth });
          const own = purchases.find(({ w, p }) => w === pw && p.ownerPartyId === part.participant)?.p.residualStop;
          if (own !== null && own !== undefined && own.reasons[0] !== undefined) stopFrom = { year: own.year, reason: own.reasons[0] };
        } else if (guard !== null && guard.fromYear === null) {
          partReasons.push(guard.reason);
          rate = null;
        } else {
          // The rate reads the purchase's `rateEntry` (§59G): the entry only when it applies from the start. A pool whose
          // purchase applies a shorter life never gets here (the guard above), so a later cost never runs at `1/n`.
          const atDate = rateOfYear(registry, yearOfDate(date), asset.buildingCompletionYear, governing.w.rateEntry);
          const years = governing.w.rateEntry?.usefulLifeYears;
          rate =
            years !== undefined && atDate?.kind === 'SHORTER_USEFUL_LIFE'
              ? {
                  kind: 'SHORTER_USEFUL_LIFE',
                  usefulLifeYears: years,
                  annualOf: (y) => (buildingRuleOn(registry, y) === undefined ? undefined : frac(1n, BigInt(years))),
                }
              : bandRate(registry, asset);
          if (guard !== null && guard.fromYear !== null) stopFrom = { year: guard.fromYear, reason: guard.reason };
        }
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
    stopFrom,
    poolKey,
    purchases,
    pooled: empty(),
    perItem: empty(),
    endToVerify: null,
  };
}

type Guard =
  | { readonly fromYear: number | null; readonly reason: Flag }
  | { readonly spread: { readonly w: Work; readonly switchMonth: number; readonly lastMonth: number; readonly usefulLifeYears: number } };

/**
 * §59G: a later cost in a pool with a purchase whose shorter life applies. One that starts after the evidenced remaining
 * life has ended (`afterRemainingLife`) needs a new evidence: `REMAINING_USEFUL_LIFE_ENDED`. Otherwise, under Part 2
 * (`subsequentCostRate.shorterLife: REMAINING_USEFUL_LIFE`), it runs with the governing purchase to `L` (`spread`):
 * from the first month for `FROM_START`, from the switch for `FROM_EVIDENCE_YEAR` (the band's rate before it, open
 * question 8). **Still not supported** (`SUBSEQUENT_COST_SHORTER_LIFE_NOT_SUPPORTED`): such a purchase in the pool that
 * is not the governing one (two rates in one pool), a governing purchase that is not computable, and every case under
 * Part 1's `NOT_COMPUTABLE` (in every year for an evidence from the start, `fromYear: null`; from the evidence's year
 * for a later one). `null` when no purchase applies one.
 */
function shorterLifeGuard(pool: readonly { readonly w: Work }[], firstMonth: number, rule: 'REMAINING_USEFUL_LIFE' | 'NOT_COMPUTABLE'): Guard | null {
  for (const [index, { w }] of pool.entries()) {
    const c = w.shorterLife;
    const appliesFromStart = c.kind === 'FROM_START' && [...w.rates.values()].some((r) => r.kind === 'SHORTER_USEFUL_LIFE');
    const appliesLater = c.kind === 'FROM_EVIDENCE_YEAR' && c.shorter;
    if (!appliesFromStart && !appliesLater) continue;
    const lastMonth = c.kind === 'FROM_EVIDENCE_YEAR' ? c.lastMonth : w.lastMonth;
    const acquisitionId = w.acquisition.id;
    if (lastMonth !== null && firstMonth > lastMonth) {
      return { fromYear: null, reason: { code: 'REMAINING_USEFUL_LIFE_ENDED', details: { acquisitionId, lastMonth: monthLabel(lastMonth) } } };
    }
    const reason = { code: 'SUBSEQUENT_COST_SHORTER_LIFE_NOT_SUPPORTED', details: { acquisitionId, usefulLifeYears: c.entry.usefulLifeYears } };
    const governing = index === 0;
    if (rule === 'REMAINING_USEFUL_LIFE' && governing && w.computable && lastMonth !== null && (c.kind === 'FROM_START' || w.residual !== null)) {
      const switchMonth = c.kind === 'FROM_EVIDENCE_YEAR' ? c.switchMonth : (w.firstMonth as number);
      return { spread: { w, switchMonth, lastMonth, usefulLifeYears: c.entry.usefulLifeYears } };
    }
    if (c.kind === 'FROM_START' || yearOfMonth(firstMonth) >= c.fromYear) return { fromYear: null, reason };
    return { fromYear: c.fromYear, reason };
  }
  return null;
}

/**
 * §59G Part 2: a later cost's rate in a shorter-life pool. Before the switch `S` the band's rate (a part begun before a
 * late evidence's switch, open question 8); from `S` (or its own first month, if later) each month takes `1/(L − m + 1)`
 * of what is left, so the part ends in `L` to the cent and the pool needs no overflow. `annualOf` is the band before
 * `S`'s year and `12/(L − first + 1)` from it (display and the rule's presence only; the walk reads `stepOf`).
 */
export function spreadRate(
  registry: RuleRegistry,
  asset: DepreciationAsset,
  c: { readonly switchMonth: number; readonly lastMonth: number; readonly usefulLifeYears: number; readonly firstMonth: number },
): PartRate {
  const band = bandRate(registry, asset);
  const from = Math.max(c.switchMonth, c.firstMonth);
  return {
    kind: 'SHORTER_USEFUL_LIFE',
    usefulLifeYears: c.usefulLifeYears,
    annualOf: (y) => {
      const annual = band.annualOf(y);
      if (annual === undefined || y < yearOfMonth(from)) return annual;
      return frac(12n, BigInt(c.lastMonth - from + 1));
    },
    stepOf: (m, used) => {
      if (m < c.switchMonth) return minF(twelfth(band.annualOf(yearOfMonth(m)) ?? ZERO), sub(ONE, used));
      if (m > c.lastMonth) return ZERO;
      return div(sub(ONE, used), frac(BigInt(c.lastMonth - m + 1), 1n));
    },
  };
}

export function bandRate(registry: RuleRegistry, asset: DepreciationAsset): PartRate {
  return { kind: 'BAND', usefulLifeYears: null, annualOf: (y) => rateOfYear(registry, y, asset.buildingCompletionYear, undefined)?.annual };
}

export function usefulLifeRate(registry: RuleRegistry, asset: DepreciationAsset): PartRate {
  const years = asset.usefulLifeYears ?? 0;
  return {
    kind: 'USEFUL_LIFE',
    usefulLifeYears: years,
    annualOf: (y) => (years < 1 || movableRuleOn(registry, y) === undefined ? undefined : frac(1n, BigInt(years))),
  };
}

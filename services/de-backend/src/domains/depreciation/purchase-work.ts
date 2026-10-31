import { addDays, centsOf, type BusinessDate, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import { buildingAcquisitionCost, largestRemainder, type BuildingAcquisitionCost } from '../acquisition/index.js';
import { isConfirmed, type DepreciationAsset, type ShorterUsefulLife } from './asset.js';
import {
  ONE,
  ZERO,
  add,
  byText,
  cmp,
  div,
  frac,
  minF,
  monthOf,
  ofShare,
  rateOfYear,
  show,
  sub,
  yearOfDate,
  yearOfMonth,
  type Frac,
  type YearRate,
} from './exact.js';
import { buildingRuleOn } from './rate.js';
import type { BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import { RANGE_MAX_YEAR, type Flag, type ScheduleAcquisition, type ScheduleOwnership } from './schedule-model.js';

/**
 * A purchase component of the schedule under derivation (api-design.md §59A): its start and first year (never the
 * contract date, VC-X-33), the rule version of its start (`DE_AFA_BUILDING_LINEAR` @1/@2 by year), its basis, its owner
 * parts with the share bought (§28.1A), its reasons and flags, and its nominal months. Moved out of `schedule.ts`
 * unchanged (issue #191).
 */

/** A buyer's part of a purchase component (internal; `schedule-items.ts` pools item parts with it, §59B). */
export interface Part {
  readonly ownerPartyId: string;
  readonly ownershipId: string;
  readonly share: Frac;
  readonly shareBefore: Frac;
  readonly acquired: Frac;
  readonly weight: Frac;
  basisCents: bigint | null;
  tenureEnd: BusinessDate | null;
  hasTenure: boolean;
  lastDay: BusinessDate | null;
  lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' | 'VALID_UNTIL' | null;
  /** The running fraction's changes after the start (§59A, §28.1A): `{ date, f }` ascending. */
  changes: { date: BusinessDate; f: Frac; from: Frac; to: Frac; split: boolean; componentIds: string[] }[];
  /** First year not computable for want of the buyer's transfer date, with its details. */
  missingFrom: { year: number; details: Record<string, unknown> } | null;
  /** Per year: counted months, the last counted month's fraction, the exact cumulative share of the basis. */
  years: Map<number, { months: number; fraction: Frac; cumulative: Frac }>;
  /** Disposal months (the tenure's end or a reduction) with a cut-off: year → details. */
  disposals: Map<number, Record<string, unknown>>;
  /** The still-held fraction of a month (§59A, `endMonthCounts`), set once the part's months are walked. */
  fractionAt: ((m: number) => Frac) | null;
}

/** A purchase component under derivation (internal; read by `schedule-items.ts`). */
export interface Work {
  readonly acquisition: ScheduleAcquisition;
  readonly componentId: string;
  /** The AfA's start: `economicTransferDate`, never the contract date; `null` without it (`TRANSFER_DATE_MISSING`). */
  readonly start: BusinessDate | null;
  /**
   * The day the buyers' Ownerships carrying the Acquisition begin (§27.1's `transferDate`, P2-D6): the tenure, the share
   * bought (§28.1A) and the coverage are read there. Equal to `start` whenever that is known.
   */
  readonly ownedFrom: BusinessDate;
  readonly firstMonth: number | null;
  /** The first year (without a start, the contract's: `economicTransferDate` is never before `contractDate`, §27.1). */
  readonly firstYear: number;
  readonly cost: BuildingAcquisitionCost;
  readonly reasons: Flag[];
  readonly flags: Flag[];
  readonly entry: ShorterUsefulLife | undefined;
  readonly parts: Part[];
  computable: boolean;
  /** month index → the nominal share of the basis depreciated in it (capped), from the first month to the last. */
  readonly monthly: Map<number, Frac>;
  lastMonth: number | null;
  /** year → the rate of the year, when known. */
  readonly rates: Map<number, YearRate>;
}

export const heldOn = (rows: readonly ScheduleOwnership[], day: BusinessDate) =>
  rows.filter((r) => r.validFrom <= day && (r.validUntil === null || r.validUntil >= day)).reduce((sum, r) => add(sum, ofShare(r.share)), ZERO);

/** What every purchase component of one derivation reads (`deriveSchedule`'s inputs and the asset's reasons). */
export interface PurchaseContext {
  readonly registry: RuleRegistry;
  readonly asset: DepreciationAsset;
  readonly latest: RuleVersion<BuildingLinearParameters> | undefined;
  readonly supportedFrom: BusinessDate | null;
  readonly assetReasons: readonly Flag[];
  readonly carrying: (id: string) => ScheduleOwnership[];
  readonly rowsOf: (partyId: string) => ScheduleOwnership[];
}

/** One listed Acquisition as a purchase component (§59A): the start, the basis, the owner parts, the months. */
export function purchaseWorkOf(ctx: PurchaseContext, a: ScheduleAcquisition, ownedFrom: BusinessDate): Work {
  const { registry, asset, latest, supportedFrom, assetReasons, carrying, rowsOf } = ctx;
  // §59A open question 6, decided 2026-10-31: without `economicTransferDate` there is no start, never the contract date.
  const start = a.economicTransferDate;
  const startYear = start === null ? null : yearOfDate(start);
  const ruleAtStart = (startYear === null ? undefined : buildingRuleOn(registry, startYear)) ?? latest;
  const firstYearRule = ruleAtStart?.parameters;
  const startMonthCounts = firstYearRule?.firstYear.startMonthCounts ?? true;
  const firstMonth = start === null ? null : monthOf(start) + (startMonthCounts ? 0 : 1);
  const cost = buildingAcquisitionCost(
    { acquisition: a, costs: a.costs, allocation: a.allocation },
    {
      excludedCostCategories: firstYearRule?.basis.excludedCostCategories ?? [],
      confirmedAllocationReviewStates: firstYearRule?.basis.allocationReviewStates ?? [],
    },
  );
  // The owner parts: the Ownerships carrying the id, one per Party (the purchase row, the earliest).
  const acquiredShare = ofShare(a.acquiredShare);
  const dayBefore = addDays(ownedFrom, -1);
  const byParty = new Map<string, ScheduleOwnership>();
  for (const o of [...carrying(a.id)].sort((x, y) => byText(x.validFrom, y.validFrom) || byText(x.id, y.id))) {
    if (!byParty.has(o.partyId)) byParty.set(o.partyId, o);
  }
  const parts: Part[] = [...byParty.values()]
    .sort((x, y) => byText(x.partyId, y.partyId))
    .map((o) => {
      const rows = rowsOf(o.partyId);
      // §28.1A: the share bought is the increase over the day before the transfer date.
      const shareBefore = heldOn(rows, dayBefore);
      const acquired = sub(heldOn(rows, ownedFrom), shareBefore);
      return {
        ownerPartyId: o.partyId,
        ownershipId: o.id,
        share: ofShare(o.share),
        shareBefore,
        acquired,
        weight: div(acquired, acquiredShare),
        basisCents: null,
        tenureEnd: null,
        hasTenure: false,
        lastDay: null,
        lastDaySource: null,
        changes: [],
        missingFrom: null,
        years: new Map(),
        disposals: new Map(),
        fractionAt: null,
      };
    });

  const reasons: Flag[] = [];
  if (cost.reason !== null) reasons.push({ code: cost.reason, details: {} });
  const entry = asset.shorterUsefulLives.find((e) => e.acquisitionId === a.id);
  if (entry !== undefined && !isConfirmed(entry.reviewState)) {
    reasons.push({ code: 'USEFUL_LIFE_NOT_CONFIRMED', details: { usefulLifeYears: entry.usefulLifeYears, reviewState: entry.reviewState } });
  }
  if (start === null) reasons.push({ code: 'TRANSFER_DATE_MISSING', details: { contractDate: a.contractDate } });
  const historical = supportedFrom === null || (start !== null && start < supportedFrom) || a.contractDate < supportedFrom;
  if (historical) reasons.push({ code: 'HISTORICAL_RULE_NOT_SUPPORTED', details: { contractDate: a.contractDate, startDate: start, supportedFrom } });
  const completionYear = asset.buildingCompletionYear;
  // Without a start neither check nor walk: both need the start year (they follow once the date is entered).
  const methodFrom = startYear === null ? undefined : buildingRuleOn(registry, startYear)?.parameters.methodUnknownFromCompletionYear;
  if (completionYear !== null && methodFrom !== undefined && startYear === completionYear && completionYear >= methodFrom) {
    reasons.push({ code: 'DEPRECIATION_METHOD_UNKNOWN', details: { completionYear, firstYear: startYear } });
  }

  // The nominal months (§59A "The arithmetic"): rate_j / 12 each, capped so the whole never exceeds the basis.
  const monthly = new Map<number, Frac>();
  const rates = new Map<number, YearRate>();
  const yearsWithoutRule: number[] = [];
  let lastMonth: number | null = null;
  const supportedYear = supportedFrom === null ? RANGE_MAX_YEAR + 1 : yearOfDate(supportedFrom);
  if (completionYear !== null && firstMonth !== null && startYear !== null) {
    let done = ZERO;
    // At most 99 years (1/99 is the smallest rate), so a century bounds the walk, past 2100 too (`range.truncated`).
    for (let m = firstMonth; cmp(done, ONE) < 0 && yearOfMonth(m) <= startYear + 100; m++) {
      const year = yearOfMonth(m);
      let rate = rates.get(year);
      if (rate === undefined && !rates.has(year)) {
        const found = rateOfYear(registry, year, completionYear, entry);
        if (found !== undefined) rates.set(year, found);
        rate = found;
        if (found === undefined && year >= supportedYear && !yearsWithoutRule.includes(year)) yearsWithoutRule.push(year);
      }
      if (rate === undefined) continue;
      const q = minF(div(rate.annual, frac(12n, 1n)), sub(ONE, done));
      monthly.set(m, q);
      done = add(done, q);
      lastMonth = m;
    }
  }
  if (yearsWithoutRule.length > 0 && !historical) reasons.push({ code: 'NO_APPLICABLE_RULE', details: { yearsWithoutRule } });

  const flags: Flag[] = [];
  const rateList = [...rates.values()];
  if (rateList.some((r) => r.notShorter) && entry !== undefined) {
    flags.push({
      code: 'USEFUL_LIFE_NOT_SHORTER',
      details: {
        usefulLifeYears: entry.usefulLifeYears,
        shorterThanYears: rateList.find((r) => r.notShorter)?.band.shorterUsefulLife.shorterThanYears ?? null,
      },
    });
  }
  if (rateList.some((r) => r.kind === 'SHORTER_USEFUL_LIFE') && entry !== undefined) {
    flags.push({ code: 'SHORTER_USEFUL_LIFE', details: { usefulLifeYears: entry.usefulLifeYears } });
    // §59A: applied from the start; evidence dated after the first year is open (open question 4).
    if (startYear !== null && entry.evidence.date > `${startYear}-12-31`)
      flags.push({ code: 'USEFUL_LIFE_START_TO_VERIFY', details: { evidenceDate: entry.evidence.date, firstYear: startYear } });
  }
  const unpaid = a.costs.filter((c) => c.paymentStatus !== 'PAID').map((c) => c.id);
  if (unpaid.length > 0) flags.push({ code: 'ACQUISITION_COST_UNPAID', details: { costIds: [...unpaid].sort(byText) } });

  // BUYER_ALREADY_OWNER (§28.1A): only a CONFIRMED one whose increases do not make up `acquiredShare` (legacy).
  if (a.status === 'CONFIRMED') {
    const actual = parts.reduce((sum, p) => add(sum, p.acquired), ZERO);
    if (parts.some((p) => cmp(p.acquired, ZERO) <= 0) || cmp(actual, acquiredShare) !== 0) {
      const holders = parts.filter((p) => cmp(p.shareBefore, ZERO) > 0).map((p) => p.ownerPartyId);
      reasons.push({
        code: 'BUYER_ALREADY_OWNER',
        details: { ownerPartyIds: holders.length > 0 ? holders : parts.map((p) => p.ownerPartyId), expected: show(acquiredShare), actual: show(actual) },
      });
    }
  }

  // The owners' bases: largest remainder by weight, ties by ownerPartyId (§27.4); only for weights that make up 1.
  const weightsValid =
    parts.length > 0 &&
    parts.every((p) => cmp(p.weight, ZERO) > 0) &&
    cmp(
      parts.reduce((s, p) => add(s, p.weight), ZERO),
      ONE,
    ) === 0;
  if (cost.basisAmount !== null && weightsValid) {
    const basisCents = centsOf(cost.basisAmount);
    const split = largestRemainder(
      basisCents,
      parts.map((p) => ({ key: p.ownerPartyId, weight: { numerator: p.weight.n, denominator: p.weight.d } })),
    );
    for (const p of parts) p.basisCents = split.get(p.ownerPartyId) ?? 0n;
  }
  return {
    acquisition: a,
    componentId: `ACQUISITION:${a.id}`,
    start,
    ownedFrom,
    firstMonth,
    firstYear: firstMonth === null ? yearOfDate(a.contractDate) : yearOfMonth(firstMonth),
    cost,
    reasons,
    flags,
    entry,
    parts,
    computable: assetReasons.length === 0 && reasons.length === 0 && lastMonth !== null && parts.length > 0 && parts.every((p) => p.basisCents !== null),
    monthly,
    lastMonth,
    rates,
  };
}

import {
  Money,
  addDays,
  centsOf,
  divideHalfUp,
  moneyOfCents,
  type BusinessDate,
  type RuleRegistry,
  type RuleStatus,
  type RuleVersion,
} from '../../shared/index.js';
import { buildingAcquisitionCost, largestRemainder, transferDate, type BuildingAcquisitionCost } from '../acquisition/index.js';
import { continuousOwners } from '../ownership/index.js';
import { isConfirmed, type DepreciationAsset, type ShorterUsefulLife } from './asset.js';
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
  type YearRate,
} from './exact.js';
import { componentIdOf, isCapitalized, sameItem, type CapitalizedItem, type ItemRef } from './capitalized-item.js';
import { buildingRuleOn, movableRuleOn, reciprocalPercent } from './rate.js';
import { AFA_BUILDING_LINEAR, type BuildingBand, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import { AFA_MOVABLE_LINEAR, type MovableLinearParameters } from './rules/de-afa-movable-linear.js';
import { deriveItemWorks, itemComponentOf, itemYears, type ItemComponent, type ItemWork } from './schedule-items.js';

/**
 * The depreciation schedule of the purchase (api-design.md §59A, backlog VC-8-02; P8-D2, P8-D3, P8-D5, P8-D8, P8-D9;
 * §28.1A "Effect on §59A"). Derived on every read from one snapshot, never stored: per Acquisition (a component) and per
 * owner part, month by month in exact fractions, each owner's year rounded once, cumulatively, half-up to the cent. A
 * figure that cannot be derived is `null` with a reason, never 0.00 (decided 2026-10-31). The capitalised items
 * (`CAPITALIZED_ITEM`) and a separate asset's schedule are VC-8-03's (§59B, `schedule-items.ts`); recorded versions
 * (VC-8-04) and the tax-year view (VC-8-05) build on this.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Inputs (read by the repository in one snapshot)

export interface ScheduleCost {
  readonly id: string;
  readonly category: string;
  readonly amount: Money;
  /** §27.2's payment status of the `ACTIVE` cost. */
  readonly paymentStatus: string | null;
}

export interface ScheduleAllocation {
  readonly id: string;
  readonly method: string;
  readonly reviewState: string;
  readonly totalAllocableAmount: Money;
  readonly buildingAmount: Money;
}

/** An Acquisition of the asset's PropertyReference that is not `CANCELLED`, with its `ACTIVE` costs and current allocation. */
export interface ScheduleAcquisition {
  readonly id: string;
  readonly status: string;
  readonly purchasePrice: Money;
  readonly acquiredShare: { readonly numerator: number; readonly denominator: number };
  readonly contractDate: BusinessDate;
  readonly economicTransferDate: BusinessDate | null;
  readonly sellerPartyIds: readonly string[];
  readonly costs: readonly ScheduleCost[];
  readonly allocation: ScheduleAllocation | null;
}

/** A `VALID` Ownership of the asset's PropertyReference. */
export interface ScheduleOwnership {
  readonly id: string;
  readonly partyId: string;
  readonly share: { readonly numerator: number; readonly denominator: number };
  readonly validFrom: BusinessDate;
  readonly validUntil: BusinessDate | null;
  readonly acquisitionId: string | null;
}

export interface ScheduleInput {
  readonly asset: DepreciationAsset;
  readonly acquisitions: readonly ScheduleAcquisition[];
  readonly ownerships: readonly ScheduleOwnership[];
  /** Today in Europe/Berlin: `computedOn` and the default range only; the figures never depend on it. */
  readonly today: BusinessDate;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly ownerPartyId: string | null;
  /** §59B: the capitalised items of the PropertyReference (and a separate asset's linked items), from Taxation's derivation. */
  readonly capitalizedItems?: readonly CapitalizedItem[];
  /** §59B: the links of the PropertyReference's `ACTIVE` separate assets (the building excludes their items). */
  readonly links?: readonly AssetLink[];
}

/** An item linked to an `ACTIVE` separate asset (§59B, migration 0051). */
export interface AssetLink extends ItemRef {
  readonly assetId: string;
}

/** What the snapshot read gives the derivation (§59A "One snapshot"). */
export interface ScheduleRead {
  readonly asset: DepreciationAsset;
  readonly acquisitions: readonly ScheduleAcquisition[];
  readonly ownerships: readonly ScheduleOwnership[];
  readonly capitalizedItems: readonly CapitalizedItem[];
  readonly links: readonly AssetLink[];
  /** Whether `ownerPartyId` names a Party of the caller's Realm; `null` without one. */
  readonly ownerPartyFound: boolean | null;
}

/** The schedule's inputs in one `REPEATABLE READ READ ONLY` transaction (P8-D14); undefined for an unknown or foreign asset. */
export interface DepreciationScheduleSource {
  read(assetId: string, mreRealmId: string, ownerPartyId: string | null): Promise<ScheduleRead | undefined>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Output

export interface Flag {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type CalculationStatus = 'NOT_CALCULABLE' | 'PROVISIONAL' | 'CALCULATED';
export type ScheduleStatus = 'AVAILABLE' | 'PARTIAL' | 'DEPRECIATION_NOT_AVAILABLE';

/** Open: a person must act (P7-D8); informative: nothing to do. Everything not listed here is open. */
export const INFORMATIVE_CODES: readonly string[] = [
  'SHORTER_USEFUL_LIFE',
  'ACQUISITION_COST_UNPAID',
  'OWNER_SHARE_CHANGED',
  // §59B
  'ANSCHAFFUNGSNAHE_CAPITALIZED',
  'CAPITALIZED_REFUND',
  'DATE_IS_BOOKING_DATE',
  'WITHDRAWAL_DATE_ASSUMED',
  'GWG_THRESHOLD_MAY_APPLY',
];
const isOpen = (code: string) => !INFORMATIVE_CODES.includes(code);

export interface ComponentBasis {
  readonly amount: Money | null;
  readonly purchasePrice: Money;
  readonly acquisitionCosts: Money;
  readonly excludedCosts: readonly { readonly category: string; readonly amount: Money }[];
  readonly allocationId: string | null;
  readonly allocationMethod: string | null;
  readonly allocationReviewState: string | null;
  readonly totalAllocableAmount: Money | null;
  readonly buildingAmount: Money | null;
}

export interface ComponentRate {
  readonly kind: 'BAND' | 'SHORTER_USEFUL_LIFE';
  readonly band: BuildingBand;
  readonly ratePercent: string;
  readonly rate: string;
  readonly usefulLifeYears: number | null;
  readonly legalBasis: string;
}

export interface ComponentOwner {
  readonly ownerPartyId: string;
  readonly ownershipId: string;
  readonly share: string;
  /** §28.1A: the share held the day before the transfer date, and the increase bought in this component. */
  readonly shareBefore: string;
  readonly acquiredShare: string;
  readonly weight: string;
  readonly basis: Money | null;
  readonly tenure: {
    /** The component's start; `null` while it is unknown (`TRANSFER_DATE_MISSING`). */
    readonly from: BusinessDate | null;
    readonly lastDay: BusinessDate | null;
    readonly lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' | 'VALID_UNTIL' | null;
  };
}

export interface OwnerYear {
  readonly ownerPartyId: string;
  readonly months: number | null;
  readonly fraction: string | null;
  readonly amount: Money | null;
  readonly residualValue: Money | null;
  readonly calculationStatus: CalculationStatus;
  readonly reasons: readonly Flag[];
  readonly flags: readonly Flag[];
}

export interface YearRule {
  readonly ruleCode: string;
  readonly version: number;
  readonly band: BuildingBand | null;
  readonly legalBasis: string | null;
}

export interface ComponentYear {
  readonly year: number;
  readonly rule: YearRule | null;
  readonly months: number | null;
  readonly amount: Money | null;
  readonly cumulative: Money | null;
  readonly residualValue: Money | null;
  readonly calculationStatus: CalculationStatus;
  readonly reasons: readonly Flag[];
  readonly owners: readonly OwnerYear[];
  /** §59B: the `NOT_OWNED` part's amount of an item component; `null` on a purchase and without one. */
  readonly notOwned: Money | null;
  readonly flags: readonly Flag[];
}

export interface ScheduleComponent {
  readonly componentId: string;
  readonly kind: 'ACQUISITION';
  readonly acquisitionId: string;
  readonly acquisitionStatus: string;
  readonly status: 'COMPUTABLE' | 'NOT_COMPUTABLE';
  readonly reasons: readonly Flag[];
  readonly basis: ComponentBasis;
  /** `null` without `economicTransferDate`: the component is not computable (`TRANSFER_DATE_MISSING`, VC-X-33). */
  readonly start: {
    readonly date: BusinessDate;
    readonly dateSource: 'ECONOMIC_TRANSFER_DATE';
    readonly month: string;
    readonly firstYearMonths: number;
  } | null;
  readonly rate: ComponentRate | null;
  readonly end: { readonly lastYear: number; readonly lastMonth: string } | null;
  readonly owners: readonly ComponentOwner[];
  readonly years: readonly ComponentYear[];
  readonly flags: readonly Flag[];
}

export interface ScheduleYear {
  readonly year: number;
  readonly status: ScheduleStatus;
  readonly calculationStatus: CalculationStatus;
  readonly amount: Money | null;
  readonly residualValue: Money | null;
  readonly owners: readonly { readonly ownerPartyId: string; readonly amount: Money | null }[] | null;
  readonly notOwned: Money | null;
  readonly reasons: readonly Flag[];
  readonly flags: readonly Flag[];
}

export interface DepreciationSchedule {
  readonly assetId: string;
  readonly propertyReferenceId: string;
  readonly assetType: string;
  readonly level: 'PROPERTY' | 'OWNER';
  readonly ownerPartyId: string | null;
  readonly computedOn: BusinessDate;
  readonly range: { readonly from: number; readonly to: number; readonly truncated: boolean };
  readonly status: ScheduleStatus;
  readonly reasons: readonly Flag[];
  /** §59B: the schedule's own flags (`GWG_THRESHOLD_MAY_APPLY` on a separate asset). */
  readonly flags: readonly Flag[];
  readonly asset: {
    readonly status: string;
    readonly buildingCompletionYear?: number | null;
    readonly description?: string | null;
    readonly usefulLifeYears?: number | null;
    readonly acquiredOn?: BusinessDate | null;
    readonly reviewState: string;
  };
  /** The purchase components (§59A) and the item components (§59B), in that order. */
  readonly components: readonly (ScheduleComponent | ItemComponent)[];
  /** §59B: on the building, the items of `ACTIVE` separate assets (by `componentId`); on a separate asset `null`. */
  readonly excludedItems: readonly { readonly componentId: string; readonly separateAssetId: string }[] | null;
  readonly years: readonly ScheduleYear[];
  readonly review: { readonly open: readonly { code: string; count: number }[]; readonly info: readonly { code: string; count: number }[] };
  readonly ruleVersions: readonly {
    readonly ruleCode: string;
    readonly version: number;
    readonly title: string;
    readonly legalBasis: string;
    readonly status: RuleStatus;
    readonly years: readonly number[];
  }[];
}

export const RANGE_MIN_YEAR = 2000;
export const RANGE_MAX_YEAR = 2100;

// ---------------------------------------------------------------------------------------------------------------------
// The derivation

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

/** Days on which a held share or a component start can change something, for one Party. */
function eventDays(rows: readonly ScheduleOwnership[], starts: readonly BusinessDate[]): BusinessDate[] {
  const days = new Set<BusinessDate>(starts);
  for (const r of rows) {
    days.add(r.validFrom);
    if (r.validUntil !== null) days.add(addDays(r.validUntil, 1));
  }
  return [...days].sort(byText);
}

const heldOn = (rows: readonly ScheduleOwnership[], day: BusinessDate) =>
  rows.filter((r) => r.validFrom <= day && (r.validUntil === null || r.validUntil >= day)).reduce((sum, r) => add(sum, ofShare(r.share)), ZERO);

/** The cut-off of a disposal on `day` (the first day the Party no longer holds it): a `CONFIRMED` purchase from it on that day. */
function buyerOn(acquisitions: readonly ScheduleAcquisition[], seller: string, day: BusinessDate): ScheduleAcquisition | undefined {
  return acquisitions.find((a) => a.status === 'CONFIRMED' && a.sellerPartyIds.includes(seller) && (a.economicTransferDate ?? a.contractDate) === day);
}

export function deriveSchedule(input: ScheduleInput, registry: RuleRegistry): DepreciationSchedule {
  const { asset } = input;
  const versions = registry.versions(AFA_BUILDING_LINEAR) as readonly RuleVersion<BuildingLinearParameters>[];
  const latest = versions[versions.length - 1];
  // DE computes no year before the first version, and a contract before it may run a method DE does not know (§59A).
  const supportedFrom = versions[0]?.effectiveFrom ?? null;
  const separate = asset.assetType === 'SEPARATE_ASSET';
  const capitalizedItems = input.capitalizedItems ?? [];
  const links = input.links ?? [];
  const assetReasons: Flag[] = [];
  if (asset.status === 'VOID') assetReasons.push({ code: 'ASSET_VOID', details: {} });
  if (!separate && asset.buildingCompletionYear === null) assetReasons.push({ code: 'COMPLETION_YEAR_MISSING', details: {} });
  if (!isConfirmed(asset.reviewState)) assetReasons.push({ code: 'ASSET_NOT_CONFIRMED', details: {} });
  // §59B: a separate asset without a counting CAPITALIZED item has nothing to depreciate.
  const linkedItems = asset.items.map((ref) => ({ ref, item: capitalizedItems.find((i) => sameItem(i, ref)) ?? null }));
  if (separate && !linkedItems.some(({ item }) => item !== null && isCapitalized(item) && item.anschaffungsnaheAcquisitionId === null)) {
    assetReasons.push({ code: 'NO_CAPITALIZED_ITEMS', details: {} });
  }

  const carrying = (id: string) => input.ownerships.filter((o) => o.acquisitionId === id);
  // A separate asset has no purchase components: its cost is its items (§59B).
  const listed = (separate ? [] : input.acquisitions)
    .filter((a) => a.status === 'CONFIRMED' || (a.status === 'DRAFT' && carrying(a.id).length > 0))
    .map((a) => ({ a, ownedFrom: transferDate(a) }))
    .sort((x, y) => byText(x.ownedFrom, y.ownedFrom) || byText(x.a.id, y.a.id));
  const rowsOf = (partyId: string) => input.ownerships.filter((o) => o.partyId === partyId);

  const works: Work[] = listed.map(({ a, ownedFrom }) => {
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
  });

  // The tenure and the still-held fraction per Party, over all its components at once (§59A, §28.1A). A separate
  // asset's owners are its items' (§59B): OWNER_WITHOUT_ACQUISITION concerns the building's purchases only.
  const parties = separate
    ? []
    : [...new Set([...input.ownerships.map((o) => o.partyId), ...works.flatMap((w) => w.parts.map((p) => p.ownerPartyId))])].sort(byText);
  const coverage = new Map<string, { date: BusinessDate; held: Frac; covered: Frac }[]>();
  for (const partyId of parties) {
    const rows = rowsOf(partyId);
    const mine = works.flatMap((w) => w.parts.filter((p) => p.ownerPartyId === partyId).map((p) => ({ w, p })));
    for (const { w, p } of mine) {
      const tenure = continuousOwners(
        rows.map((r) => ({ id: r.id, partyId: r.partyId, validFrom: r.validFrom, validUntil: r.validUntil })),
        w.ownedFrom,
      ).find(() => true);
      p.hasTenure = tenure !== undefined;
      p.tenureEnd = tenure?.validUntil ?? null;
    }
    const f = new Map<Part, Frac>();
    const steps: { date: BusinessDate; held: Frac; covered: Frac }[] = [];
    let heldBefore = ZERO;
    for (const day of eventDays(
      rows,
      mine.map(({ w }) => w.ownedFrom),
    )) {
      const held = heldOn(rows, day);
      for (const { w, p } of mine) if (w.ownedFrom === day && p.hasTenure) f.set(p, ONE);
      const active = mine.filter(({ w, p }) => p.hasTenure && w.ownedFrom <= day && (p.tenureEnd === null || day <= p.tenureEnd));
      const attributed = active.reduce((sum, { p }) => add(sum, mul(cmp(p.acquired, ZERO) > 0 ? p.acquired : ZERO, f.get(p) ?? ZERO)), ZERO);
      if (cmp(held, attributed) < 0 && cmp(attributed, ZERO) > 0) {
        // A share reduced within the tenure: every component the Party holds that day falls pro rata (§28.1A).
        const factor = div(held, attributed);
        const componentIds = active.map(({ w }) => w.componentId);
        for (const { p } of active) {
          const next = mul(f.get(p) ?? ZERO, factor);
          f.set(p, next);
          p.changes.push({ date: day, f: next, from: heldBefore, to: held, split: active.length > 1, componentIds });
        }
      }
      const covered = active.reduce((sum, { p }) => add(sum, mul(cmp(p.acquired, ZERO) > 0 ? p.acquired : ZERO, f.get(p) ?? ZERO)), ZERO);
      steps.push({ date: day, held, covered });
      heldBefore = held;
    }
    coverage.set(partyId, steps);
  }

  // Per owner part: the cut-off, the months and the exact cumulative AfA (§59A "Per owner").
  for (const w of works) {
    const { start, firstMonth } = w;
    if (w.lastMonth === null || start === null || firstMonth === null) continue;
    const parameters = (w.rates.get(w.firstYear) ?? [...w.rates.values()][0])?.rule.parameters ?? latest?.parameters;
    const disposal = parameters?.end.disposal;
    const endMonthCounts = disposal?.endMonthCounts ?? true;
    for (const p of w.parts) {
      if (!p.hasTenure) continue;
      const missing = (day: BusinessDate, buyer: ScheduleAcquisition | undefined) => {
        const year = yearOfDate(addDays(day, -1));
        if (p.missingFrom === null || year < p.missingFrom.year) {
          p.missingFrom = { year, details: { validUntil: addDays(day, -1), buyerAcquisitionId: buyer?.id ?? null } };
        }
      };
      const cutOff = (day: BusinessDate): boolean => {
        const buyer = buyerOn(input.acquisitions, p.ownerPartyId, day);
        if (buyer === undefined || buyer.economicTransferDate === null) {
          missing(day, buyer);
          return false;
        }
        return true;
      };
      if (p.tenureEnd !== null) {
        const after = addDays(p.tenureEnd, 1);
        p.lastDay = p.tenureEnd;
        p.lastDaySource = cutOff(after) ? 'BUYER_ECONOMIC_TRANSFER_DATE' : 'VALID_UNTIL';
      }
      const reductions = p.changes.filter((c) => p.tenureEnd === null || c.date <= p.tenureEnd);
      const reducedWithCutOff = reductions.filter((c) => cutOff(c.date));
      const fractionOn = (day: BusinessDate): Frac => {
        if (day < start || (p.lastDay !== null && day > p.lastDay)) return ZERO;
        let value = ONE;
        for (const c of p.changes) if (c.date <= day) value = c.f;
        return value;
      };
      const fractionAt = (m: number) => (endMonthCounts ? fractionOn(maxDate(firstDay(m), start)) : fractionOn(lastDayOf(m)));
      p.fractionAt = fractionAt;
      let cumulative = ZERO;
      for (let m = firstMonth; m <= w.lastMonth; m++) {
        const q = w.monthly.get(m) ?? ZERO;
        const f = fractionAt(m);
        cumulative = add(cumulative, mul(f, q));
        const year = yearOfMonth(m);
        const seen = p.years.get(year) ?? { months: 0, fraction: ZERO, cumulative: ZERO };
        p.years.set(year, cmp(f, ZERO) > 0 ? { months: seen.months + 1, fraction: f, cumulative } : { ...seen, cumulative });
      }
      const legalBasis = disposal?.legalBasis ?? null;
      const noteDisposal = (lastDay: BusinessDate) => {
        const year = yearOfDate(lastDay);
        p.disposals.set(year, { lastDay, months: p.years.get(year)?.months ?? 0, endMonthCounts, legalBasis });
      };
      if (p.lastDaySource === 'BUYER_ECONOMIC_TRANSFER_DATE' && p.lastDay !== null) noteDisposal(p.lastDay);
      for (const c of reducedWithCutOff) noteDisposal(addDays(c.date, -1));
    }
  }

  // §59B: the item components. The building takes every capitalised item not linked to an ACTIVE separate asset; a
  // separate asset its linked items.
  const itemContext = { registry, asset, assetReasons, works, ownerships: input.ownerships, acquisitions: input.acquisitions };
  const excluded = separate ? [] : capitalizedItems.filter((i) => isCapitalized(i) && links.some((l) => sameItem(l, i)));
  const itemWorks: ItemWork[] = deriveItemWorks(
    itemContext,
    separate
      ? linkedItems
      : capitalizedItems
          .filter((i) => isCapitalized(i) && !excluded.includes(i))
          .map((item) => ({ ref: item as ItemRef, item: item as CapitalizedItem | null })),
  );
  const excludedItems = separate
    ? null
    : excluded
        .map((i) => ({ componentId: componentIdOf(i), separateAssetId: (links.find((l) => sameItem(l, i)) as AssetLink).assetId }))
        .sort((a, b) => byText(a.componentId, b.componentId));

  // The range (§59A "Path and query"): defaults from the components, clamped to 2000–2100.
  const todayYear = yearOfDate(input.today);
  const clamp = (y: number) => Math.min(RANGE_MAX_YEAR, Math.max(RANGE_MIN_YEAR, y));
  const lastYearOf = (w: Work): number | null => {
    const years = w.parts.flatMap((p) => [...p.years.entries()].filter(([, v]) => v.months > 0).map(([y]) => y));
    return years.length === 0 ? null : Math.max(...years);
  };
  const computableLast = [...works.filter((w) => w.computable).map(lastYearOf), ...itemWorks.filter((w) => w.computable).map((w) => itemYears(w).last)].filter(
    (y): y is number => y !== null,
  );
  const naturalTo = computableLast.length === 0 ? todayYear : Math.max(...computableLast);
  const starts = [
    ...works.map((w) => (w.start === null ? w.firstYear : yearOfDate(w.start))),
    ...itemWorks.map((w) => itemYears(w).first).filter((y): y is number => y !== null),
  ];
  const from = input.from ?? clamp(starts.length === 0 ? todayYear : Math.min(...starts));
  let to = input.to ?? clamp(naturalTo);
  if (to < from) to = from;
  const truncated = input.to === undefined && naturalTo > RANGE_MAX_YEAR;

  const level = input.ownerPartyId === null ? 'PROPERTY' : 'OWNER';
  const shown = input.ownerPartyId === null ? works : works.filter((w) => w.parts.some((p) => p.ownerPartyId === input.ownerPartyId));
  const partsShown = (w: Work) => (input.ownerPartyId === null ? w.parts : w.parts.filter((p) => p.ownerPartyId === input.ownerPartyId));

  const components: (ScheduleComponent | ItemComponent)[] = [
    ...shown.map((w) => componentOf(w, partsShown(w), { from, to }, assetReasons)),
    ...itemWorks
      .filter((w) => input.ownerPartyId === null || w.parts.some((p) => p.participant === input.ownerPartyId))
      .map((w) => itemComponentOf(w, itemContext, { from, to }, input.ownerPartyId, INFORMATIVE_CODES)),
  ];

  // The schedule's years: components summed, never distributed (P8-D8, F4b).
  const years: ScheduleYear[] = [];
  for (let year = from; year <= to; year++) {
    const active = components
      .map((c) => ({ c, y: c.years.find((y) => y.year === year) }))
      .filter((x): x is { c: ScheduleComponent | ItemComponent; y: ComponentYear } => x.y !== undefined);
    const calculable = active.filter(({ y }) => y.calculationStatus !== 'NOT_CALCULABLE');
    const sum = (values: readonly (Money | null)[]) =>
      values.some((v) => v === null) ? null : moneyOfCents(values.reduce((s, v) => s + centsOf(v as Money), 0n));
    const ownerIds = [...new Set(active.flatMap(({ y }) => y.owners.map((o) => o.ownerPartyId)))].sort(byText);
    const flags: Flag[] = mergeFlags(active.flatMap(({ c, y }) => [...c.flags, ...y.flags].map((f) => ({ componentId: c.componentId, flag: f }))));
    for (const partyId of input.ownerPartyId === null ? parties : [input.ownerPartyId]) {
      const gap = uncoveredIn(coverage.get(partyId) ?? [], year);
      if (gap !== undefined) flags.push({ code: 'OWNER_WITHOUT_ACQUISITION', details: { ownerPartyId: partyId, ...gap } });
    }
    const reasons = [...assetReasons, ...mergeFlags(active.flatMap(({ c, y }) => y.reasons.map((f) => ({ componentId: c.componentId, flag: f }))))];
    // A year with some figures (a component, or one owner of it) is PARTIAL; one without any is not available.
    const someFigure = active.some(({ y }) => y.owners.some((o) => o.calculationStatus !== 'NOT_CALCULABLE'));
    const status: ScheduleStatus =
      assetReasons.length > 0
        ? 'DEPRECIATION_NOT_AVAILABLE'
        : calculable.length === active.length
          ? 'AVAILABLE'
          : someFigure
            ? 'PARTIAL'
            : 'DEPRECIATION_NOT_AVAILABLE';
    const notCalculable = assetReasons.length > 0 || calculable.length < active.length;
    const calculationStatus: CalculationStatus = notCalculable
      ? 'NOT_CALCULABLE'
      : active.some(({ y }) => y.calculationStatus === 'PROVISIONAL') || flags.some((f) => isOpen(f.code))
        ? 'PROVISIONAL'
        : 'CALCULATED';
    years.push({
      year,
      status,
      calculationStatus,
      amount: notCalculable ? null : sum(active.map(({ y }) => y.amount)),
      residualValue: notCalculable ? null : sum(active.map(({ y }) => y.residualValue)),
      owners:
        level === 'OWNER'
          ? null
          : ownerIds.map((ownerPartyId) => ({
              ownerPartyId,
              amount: sum(active.flatMap(({ y }) => y.owners.filter((o) => o.ownerPartyId === ownerPartyId).map((o) => o.amount))),
            })),
      // §59B: the NOT_OWNED parts of the item components, summed; null at the owner level and without one.
      notOwned:
        level === 'OWNER' || notCalculable || !active.some(({ y }) => y.notOwned !== null)
          ? null
          : sum(active.flatMap(({ y }) => (y.notOwned === null ? [] : [y.notOwned]))),
      reasons: sortFlags(reasons),
      flags: sortFlags(flags),
    });
  }

  // §59B: a separate asset whose cost is at most the GWG threshold (gross, or net when every item has a net amount).
  const scheduleFlags: Flag[] = [];
  if (separate) {
    const counted = linkedItems.flatMap(({ item }) => (item !== null && isCapitalized(item) && item.anschaffungsnaheAcquisitionId === null ? [item] : []));
    const versions = registry.versions(AFA_MOVABLE_LINEAR) as readonly RuleVersion<MovableLinearParameters>[];
    const rule = (asset.acquiredOn === null ? undefined : movableRuleOn(registry, yearOfDate(asset.acquiredOn))) ?? versions[versions.length - 1];
    if (counted.length > 0 && rule !== undefined) {
      const threshold = centsOf(Money.of(rule.parameters.gwgHint.netThreshold, counted[0]?.lineAmount.currency ?? 'EUR'));
      const gross = counted.reduce((s, i) => s + centsOf(i.lineAmount), 0n);
      const net = counted.every((i) => i.netAmount !== null) ? counted.reduce((s, i) => s + centsOf(i.netAmount as Money), 0n) : null;
      if (gross <= threshold || (net !== null && net <= threshold)) {
        scheduleFlags.push({
          code: 'GWG_THRESHOLD_MAY_APPLY',
          details: {
            netThreshold: rule.parameters.gwgHint.netThreshold,
            grossCost: moneyOfCents(gross).toJSON(),
            netCost: net === null ? null : moneyOfCents(net).toJSON(),
            legalBasis: rule.parameters.gwgHint.legalBasis,
          },
        });
      }
    }
  }

  const status: ScheduleStatus =
    assetReasons.length > 0
      ? 'DEPRECIATION_NOT_AVAILABLE'
      : components.every((c) => c.status === 'COMPUTABLE')
        ? 'AVAILABLE'
        : components.some((c) => c.status === 'COMPUTABLE')
          ? 'PARTIAL'
          : 'DEPRECIATION_NOT_AVAILABLE';

  return {
    assetId: asset.id,
    propertyReferenceId: asset.propertyReferenceId,
    assetType: asset.assetType,
    level,
    ownerPartyId: input.ownerPartyId,
    computedOn: input.today,
    range: { from, to, truncated },
    status,
    reasons: assetReasons,
    flags: scheduleFlags,
    asset: separate
      ? {
          status: asset.status,
          description: asset.description,
          usefulLifeYears: asset.usefulLifeYears,
          acquiredOn: asset.acquiredOn,
          reviewState: asset.reviewState,
        }
      : { status: asset.status, buildingCompletionYear: asset.buildingCompletionYear, reviewState: asset.reviewState },
    components,
    excludedItems,
    years,
    review: reviewOf(assetReasons, scheduleFlags, components, years),
    ruleVersions: ruleVersionsOf(components, registry, input.today),
  };
}

/** The component of §59A's response, its years limited to the range. */
function componentOf(w: Work, parts: readonly Part[], range: { readonly from: number; readonly to: number }, assetReasons: readonly Flag[]): ScheduleComponent {
  const a = w.acquisition;
  const lastYear = w.computable
    ? Math.max(...w.parts.flatMap((p) => [...p.years.entries()].filter(([, v]) => v.months > 0).map(([y]) => y)), w.firstYear)
    : null;
  const lastMonth =
    w.computable && w.lastMonth !== null
      ? Math.max(...w.parts.flatMap((p) => (p.lastDay === null ? [w.lastMonth as number] : [Math.min(w.lastMonth as number, monthOf(p.lastDay))])))
      : null;
  const rateYear = Math.max(w.firstYear, Math.min(range.to, lastYear ?? range.to));
  const yr = w.rates.get(rateYear) ?? [...w.rates.entries()].filter(([y]) => y <= rateYear).pop()?.[1];
  const rate: ComponentRate | null =
    yr === undefined
      ? null
      : yr.kind === 'SHORTER_USEFUL_LIFE' && w.entry !== undefined
        ? {
            kind: 'SHORTER_USEFUL_LIFE',
            band: yr.band.band,
            ratePercent: reciprocalPercent(w.entry.usefulLifeYears),
            rate: show(yr.annual),
            usefulLifeYears: w.entry.usefulLifeYears,
            legalBasis: yr.band.shorterUsefulLife.legalBasis,
          }
        : { kind: 'BAND', band: yr.band.band, ratePercent: yr.band.ratePercent, rate: show(yr.annual), usefulLifeYears: null, legalBasis: yr.band.legalBasis };
  const componentOpen = w.flags.some((f) => isOpen(f.code));
  const reasonsOfComponent = [...assetReasons, ...w.reasons];

  const ownerYearOf = (p: Part, year: number): OwnerYear => {
    const ruleOfYear = w.rates.get(year)?.rule;
    if (!w.computable || p.basisCents === null) {
      return {
        ownerPartyId: p.ownerPartyId,
        months: null,
        fraction: null,
        amount: null,
        residualValue: null,
        calculationStatus: 'NOT_CALCULABLE',
        reasons: reasonsOfComponent,
        flags: [],
      };
    }
    if (p.missingFrom !== null && year >= p.missingFrom.year) {
      return {
        ownerPartyId: p.ownerPartyId,
        months: null,
        fraction: null,
        amount: null,
        residualValue: null,
        calculationStatus: 'NOT_CALCULABLE',
        reasons: [{ code: 'DISPOSAL_DATE_MISSING', details: p.missingFrom.details }],
        flags: [],
      };
    }
    const b = p.basisCents;
    const rounded = (c: Frac) => divideHalfUp(b * c.n, c.d);
    const now = cumulativeOf(p, year);
    const before = cumulativeOf(p, year - 1);
    const y = p.years.get(year);
    const flags: Flag[] = [];
    if (ruleOfYear !== undefined && !ruleOfYear.parameters.verified) {
      flags.push({ code: 'HISTORICAL_RULE_TO_VERIFY', details: { ruleCode: ruleOfYear.ruleCode, version: ruleOfYear.version } });
    }
    const disposal = p.disposals.get(year);
    if (disposal !== undefined && ruleOfYear !== undefined && !ruleOfYear.parameters.end.disposal.verified)
      flags.push({ code: 'DISPOSAL_YEAR_TO_VERIFY', details: disposal });
    for (const c of p.changes.filter((c) => yearOfDate(c.date) === year && (p.tenureEnd === null || c.date <= p.tenureEnd))) {
      flags.push({ code: 'OWNER_SHARE_CHANGED', details: { date: c.date, from: show(c.from), to: show(c.to) } });
      if (c.split)
        flags.push({ code: 'SHARE_REDUCTION_SPLIT_TO_VERIFY', details: { date: c.date, from: show(c.from), to: show(c.to), componentIds: c.componentIds } });
    }
    const open = componentOpen || flags.some((f) => isOpen(f.code));
    return {
      ownerPartyId: p.ownerPartyId,
      months: y?.months ?? 0,
      fraction: y === undefined || y.months === 0 ? null : show(y.fraction),
      amount: moneyOfCents(rounded(now) - rounded(before)),
      residualValue: moneyOfCents(b - rounded(now)),
      calculationStatus: open ? 'PROVISIONAL' : 'CALCULATED',
      reasons: [],
      flags: sortFlags(flags),
    };
  };
  const listedIn = (p: Part, year: number) => {
    if (!w.computable) return true;
    if (!p.hasTenure) return false;
    const end = p.lastDay === null ? (lastYear as number) : Math.min(lastYear as number, yearOfDate(p.lastDay));
    return year >= w.firstYear && year <= end;
  };

  const yearsTo = w.computable ? Math.min(range.to, lastYear as number) : range.to;
  const years: ComponentYear[] = [];
  for (let year = Math.max(range.from, w.firstYear); year <= yearsTo; year++) {
    const owners = parts.filter((p) => listedIn(p, year)).map((p) => ownerYearOf(p, year));
    const yr = w.rates.get(year);
    const rule: YearRule | null = (() => {
      if (yr !== undefined) return { ruleCode: yr.rule.ruleCode, version: yr.rule.version, band: yr.band.band, legalBasis: yr.band.legalBasis };
      return null;
    })();
    const notCalculable = owners.some((o) => o.calculationStatus === 'NOT_CALCULABLE') || !w.computable;
    const sumOf = (values: readonly bigint[]) => moneyOfCents(values.reduce((s, v) => s + v, 0n));
    // The component's cumulative and residual value are over every part, also a part already sold (its residual stays).
    const known = w.computable && parts.every((p) => p.basisCents !== null && (p.missingFrom === null || p.missingFrom.year > year));
    const cumulativeCents = known ? parts.map((p) => divideHalfUp((p.basisCents as bigint) * cumulativeOf(p, year).n, cumulativeOf(p, year).d)) : null;
    years.push({
      year,
      rule,
      months: w.computable ? countMonths(w, year) : null,
      amount: notCalculable ? null : sumOf(owners.map((o) => centsOf(o.amount as Money))),
      cumulative: notCalculable || cumulativeCents === null ? null : sumOf(cumulativeCents),
      residualValue: notCalculable || cumulativeCents === null ? null : sumOf(parts.map((p, i) => (p.basisCents as bigint) - (cumulativeCents[i] as bigint))),
      calculationStatus: notCalculable
        ? 'NOT_CALCULABLE'
        : owners.some((o) => o.calculationStatus === 'PROVISIONAL') || componentOpen
          ? 'PROVISIONAL'
          : 'CALCULATED',
      reasons: notCalculable ? mergeOwnerFlags(owners.map((o) => ({ ownerPartyId: o.ownerPartyId, flags: o.reasons }))) : [],
      owners,
      notOwned: null,
      flags: mergeOwnerFlags(owners.map((o) => ({ ownerPartyId: o.ownerPartyId, flags: o.flags }))),
    });
  }

  return {
    componentId: w.componentId,
    kind: 'ACQUISITION',
    acquisitionId: a.id,
    acquisitionStatus: a.status,
    status: w.computable ? 'COMPUTABLE' : 'NOT_COMPUTABLE',
    reasons: w.reasons,
    basis: {
      amount: w.cost.basisAmount,
      purchasePrice: w.cost.purchasePrice,
      acquisitionCosts: w.cost.acquisitionCosts,
      excludedCosts: w.cost.excludedCosts,
      allocationId: a.allocation?.id ?? null,
      allocationMethod: a.allocation?.method ?? null,
      allocationReviewState: a.allocation?.reviewState ?? null,
      totalAllocableAmount: a.allocation?.totalAllocableAmount ?? null,
      buildingAmount: a.allocation?.buildingAmount ?? null,
    },
    start:
      w.start === null || w.firstMonth === null
        ? null
        : {
            date: w.start,
            dateSource: 'ECONOMIC_TRANSFER_DATE',
            month: monthLabel(monthOf(w.start)),
            firstYearMonths: yearOfMonth(w.firstMonth) === yearOfDate(w.start) ? 12 - (w.firstMonth % 12) : 0,
          },
    rate,
    end: lastYear === null || lastMonth === null ? null : { lastYear, lastMonth: monthLabel(lastMonth) },
    owners: parts.map((p) => ({
      ownerPartyId: p.ownerPartyId,
      ownershipId: p.ownershipId,
      share: show(p.share),
      shareBefore: show(p.shareBefore),
      acquiredShare: show(p.acquired),
      weight: show(p.weight),
      basis: p.basisCents === null ? null : moneyOfCents(p.basisCents),
      tenure: { from: w.start, lastDay: p.lastDay, lastDaySource: p.lastDaySource },
    })),
    years,
    flags: sortFlags(w.flags),
  };
}

/** The exact cumulative share of the basis to the end of `year` (0 before the first year, the last value after). */
function cumulativeOf(p: Part, year: number): Frac {
  let value = ZERO;
  for (const [y, v] of [...p.years.entries()].sort(([x], [z]) => x - z)) if (y <= year) value = v.cumulative;
  return value;
}

function countMonths(w: Work, year: number): number {
  let months = 0;
  for (const m of w.monthly.keys()) if (yearOfMonth(m) === year && cmp(w.monthly.get(m) as Frac, ZERO) > 0) months++;
  return months;
}

/** The first day of `year` on which the Party holds more than its components cover (`OWNER_WITHOUT_ACQUISITION`). */
function uncoveredIn(steps: readonly { date: BusinessDate; held: Frac; covered: Frac }[], year: number) {
  const start = `${year}-01-01` as BusinessDate;
  const end = `${year}-12-31` as BusinessDate;
  const inYear = steps.filter((s, i) => s.date <= end && (s.date >= start || (steps[i + 1]?.date ?? '9999-12-31') > start));
  const gap = inYear.find((s) => cmp(s.held, s.covered) > 0);
  return gap === undefined ? undefined : { from: maxDate(gap.date, start), heldShare: show(gap.held), coveredShare: show(gap.covered) };
}

const sortFlags = (flags: readonly Flag[]) => [...flags].sort((a, b) => byText(a.code, b.code));

/** Each code once, the components named (§59A "A year's flags"). */
function mergeFlags(entries: readonly { componentId: string; flag: Flag }[]): Flag[] {
  const byCode = new Map<string, Set<string>>();
  for (const { componentId, flag } of entries) byCode.set(flag.code, (byCode.get(flag.code) ?? new Set()).add(componentId));
  return [...byCode.entries()].map(([code, ids]) => ({ code, details: { componentIds: [...ids].sort(byText) } }));
}

/** Each code once, the owners named. */
function mergeOwnerFlags(entries: readonly { ownerPartyId: string; flags: readonly Flag[] }[]): Flag[] {
  const byCode = new Map<string, Set<string>>();
  for (const { ownerPartyId, flags } of entries) for (const f of flags) byCode.set(f.code, (byCode.get(f.code) ?? new Set()).add(ownerPartyId));
  return sortFlags([...byCode.entries()].map(([code, ids]) => ({ code, details: { ownerPartyIds: [...ids].sort(byText) } })));
}

/** Over the range: each code once with the number of components (or owner-years, or owner and year) carrying it. */
function reviewOf(
  assetReasons: readonly Flag[],
  scheduleFlags: readonly Flag[],
  components: readonly (ScheduleComponent | ItemComponent)[],
  years: readonly ScheduleYear[],
) {
  const counts = new Map<string, number>();
  const count = (code: string, n = 1) => counts.set(code, (counts.get(code) ?? 0) + n);
  for (const r of [...assetReasons, ...scheduleFlags]) count(r.code);
  for (const c of components) {
    for (const code of new Set([...c.reasons, ...c.flags].map((f) => f.code))) count(code);
    for (const y of c.years)
      for (const o of y.owners) for (const code of new Set([...(c.status === 'COMPUTABLE' ? o.reasons : []), ...o.flags].map((f) => f.code))) count(code);
  }
  for (const y of years) for (const f of y.flags) if (f.code === 'OWNER_WITHOUT_ACQUISITION') count(f.code);
  const list = (open: boolean) =>
    [...counts.entries()]
      .filter(([code]) => isOpen(code) === open)
      .sort(([a], [b]) => byText(a, b))
      .map(([code, n]) => ({ code, count: n }));
  return { open: list(true), info: list(false) };
}

function ruleVersionsOf(components: readonly (ScheduleComponent | ItemComponent)[], registry: RuleRegistry, today: BusinessDate) {
  const named = new Map<string, { ruleCode: string; version: number; years: Set<number> }>();
  for (const c of components) {
    for (const y of c.years) {
      if (y.rule === null) continue;
      const key = `${y.rule.ruleCode}@${y.rule.version}`;
      const entry = named.get(key) ?? { ruleCode: y.rule.ruleCode, version: y.rule.version, years: new Set<number>() };
      entry.years.add(y.year);
      named.set(key, entry);
    }
  }
  return [...named.values()]
    .sort((a, b) => byText(a.ruleCode, b.ruleCode) || a.version - b.version)
    .flatMap((v) => {
      const rule = registry.find({ ruleCode: v.ruleCode, version: v.version });
      if (rule === undefined) return [];
      return [
        {
          ruleCode: v.ruleCode,
          version: v.version,
          title: rule.title,
          legalBasis: rule.legalBasis,
          status: registry.status(rule, today),
          years: [...v.years].sort((x, y) => x - y),
        },
      ];
    });
}

/**
 * Whether `partyId` owns the PropertyReference at any time or bought a listed component (§59A, `NOT_AN_OWNER`): a buyer
 * of a listed component holds a `VALID` Ownership carrying its id, so the `VALID` Ownerships answer both.
 */
export function isOwnerOf(ownerships: readonly ScheduleOwnership[], partyId: string): boolean {
  return ownerships.some((o) => o.partyId === partyId);
}

import {
  addDays,
  addMonths,
  centsOf,
  decimalOf,
  divideHalfEven,
  divideHalfUp,
  moneyOfCents,
  type BusinessDate,
  type Money,
  type RuleRef,
  type RuleRegistry,
  type RuleVersion,
} from '../../shared/index.js';
import { NO_RULE_COST_CLASSIFICATION, buildingAcquisitionCost, type BasisCost, type UnclassifiedCost } from '../acquisition/index.js';
import {
  NO_HAUSGELD,
  mergeCostLines,
  readHausgeld,
  readRangeOf,
  type HausgeldInput,
  type MissingStatement,
  type UnjudgedLine,
} from './anschaffungsnahe-hausgeld.js';
import { partInWindow, performedOutside, type Performance } from './performance.js';
import { ANSCHAFFUNGSNAHE, type AnschaffungsnaheParameters } from './rules/de-anschaffungsnahe.js';
import type { TreatmentPart } from './treatment-parts.js';
import type { Origin, ReviewState, SourceType, TaxCategory, Treatment } from './vocabulary.js';

/**
 * The anschaffungsnahe check per Acquisition (api-design.md §58B, P7-D6, § 6 Abs. 1 Nr. 1a EStG, checklist A2): the
 * Erhaltungsaufwand of the 3 years after the transfer, net where known, against 15 % of the building's acquisition
 * cost. Derived on read, never stored; it suggests `CAPITALIZED` and never changes a classification or the
 * Acquisition. Exact in cents: the one rounding is the building's acquisition cost; the comparison is on fractions.
 * §59F (VC-X-38): it measures the period of performance, never the booking date, and decides by lower and upper bounds.
 */

/** A counting source of the Acquisition's PropertyReference with its current meaning (the classification, else the default). */
export interface CheckSource {
  readonly sourceType: SourceType;
  readonly sourceId: string;
  readonly sourcePosition: number | null;
  /** The booking date, the withdrawal's (or assumed) date, the use's date: shown, never the date of the work (§59F). */
  readonly date: BusinessDate;
  /** `BOOKING` for a split, else the WEG source's `dateSource`. */
  readonly dateSource: string;
  readonly taxYear: number;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: ReviewState;
  readonly origin: Origin;
  readonly classificationId: string | null;
  /** The source's gross amount, unsigned. */
  readonly grossAmount: Money;
  readonly direction: 'INFLOW' | 'OUTFLOW';
  readonly netAmount: Money | null;
  readonly annuallyRecurring: boolean;
  readonly anschaffungsnaheAcquisitionId: string | null;
  /** §59F (VC-X-38): the current classification's period of performance; `null` without one. */
  readonly performance: Performance | null;
  /** VC-X-38 Part 2: the current classification's partial treatment (on its anschaffungsnahe link); absent or `null` without. */
  readonly treatmentParts?: readonly TreatmentPart[] | null;
  /** The source's own flags carried into the check (an assumed withdrawal date). */
  readonly sourceFlags: readonly { readonly code: string; readonly details: object }[];
  /** §58M (VC-X-27): a cost line's statement period and account; `later` for a statement beyond the read range. */
  readonly costLine?: { readonly statementPeriod: Range; readonly account: string; readonly later: boolean };
}

export interface CheckAcquisition {
  readonly id: string;
  readonly propertyReferenceId: string;
  readonly status: string;
  /**
   * §58K (VC-X-34): the transfer of economic ownership, `economicTransferDate`; `null` without it. Never the contract
   * date: without it the check is `NOT_COMPUTABLE`, `TRANSFER_DATE_MISSING`.
   */
  readonly transferDate: BusinessDate | null;
  /** §58K: shown in the `TRANSFER_DATE_MISSING` flag, and the first year a check without a window is listed in. */
  readonly contractDate: BusinessDate;
  readonly acquiredShare: { readonly numerator: number; readonly denominator: number };
  readonly purchasePrice: Money;
}

export interface CheckAllocation {
  readonly id: string;
  readonly reviewState: string;
  readonly totalAllocableAmount: Money;
  readonly buildingAmount: Money;
}

export const NOT_COMPUTABLE_REASONS = [
  // §58K (VC-X-34): no `economicTransferDate`, so no window and no rule version; first, before NO_APPLICABLE_RULE.
  'TRANSFER_DATE_MISSING',
  'NO_APPLICABLE_RULE',
  'ACQUISITION_NOT_CONFIRMED',
  'NO_ALLOCATION',
  'ALLOCATION_NOT_CONFIRMED',
  'NO_BUILDING',
  // §59D: only while the sum lies between 15 % of the two bounds.
  'ACQUISITION_COST_UNCLASSIFIED',
  // §59F: the sum's bounds (by the performance) lie on both sides of 15 %.
  'PERFORMANCE_IN_WINDOW_UNKNOWN',
  // §59F: not above by the upper bound, but an undated source lies outside the search range (sources not complete).
  'SOURCES_OUTSIDE_SEARCH_RANGE',
] as const;
export type NotComputableReason = (typeof NOT_COMPUTABLE_REASONS)[number];
export type CheckStatus = 'NOT_COMPUTABLE' | 'ABOVE_THRESHOLD' | 'NOT_ABOVE_THRESHOLD';
export type NotFinalReason =
  /** §58K (VC-X-34): no `economicTransferDate`; nothing but the date clears it. */
  | 'TRANSFER_DATE_MISSING'
  | 'GROSS_AMOUNTS'
  | 'UNCLASSIFIED_SOURCES'
  | 'WINDOW_OPEN'
  | 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED'
  /** §58M (M7): a financial year of the read range without its `CONFIRMED` statement, or not ended. */
  | 'WEG_STATEMENT_MISSING'
  /** §58M (M6): above, with a cost line among the summed: the Hausgeld deducted needs the advisor's review. */
  | 'HAUSGELD_MAINTENANCE_ABOVE_THRESHOLD'
  /** §59F: above, but whether each undated source is anschaffungsnah depends on its dates. */
  | 'PERFORMANCE_IN_WINDOW_UNKNOWN'
  /** §59F: an undated source outside the search range: the sources are not complete. */
  | 'SOURCES_OUTSIDE_SEARCH_RANGE'
  /** §59D: the outcome holds by the bounds, but `threshold` and `percentOfBasis` wait for the costs' classification. */
  | 'ACQUISITION_COSTS_UNCLASSIFIED';

export type CheckEntryFlag =
  | { readonly code: 'VAT_NOT_SEPARATED'; readonly details: { readonly acquisitionId: string } }
  | {
      readonly code: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN';
      readonly details: { readonly acquisitionId: string; readonly final: boolean; readonly rule: RuleRef; readonly paidFromHausgeld?: true };
    }
  | { readonly code: 'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE'; readonly details: { readonly acquisitionId: string } }
  | { readonly code: string; readonly details: object };

export interface CheckEntry {
  readonly sourceType: SourceType;
  readonly sourceId: string;
  readonly sourcePosition: number | null;
  readonly date: BusinessDate;
  readonly taxYear: number;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: ReviewState;
  readonly origin: Origin;
  readonly classificationId: string | null;
  readonly grossAmount: Money;
  readonly netAmount: Money | null;
  /** `netAmount`, else the gross amount; signed (an `INFLOW`, a refund, negative). */
  readonly amountUsed: Money;
  /** §59F: as stored, or `null`. */
  readonly performance: Performance | null;
  /** §59F: the part performed in the window, as bounds (equal when exact); `null` for `excluded` and `unclassified`. */
  readonly inWindow: { readonly lower: Money; readonly upper: Money } | null;
  readonly suggestedTreatment: 'CAPITALIZED' | null;
  /** Why an `excluded` source is left out; `null` in the other lists. */
  readonly reason: ExcludedReason | null;
  /**
   * §59F (the owner's decision 239-8, 2026-11-02): on an `unclassified` entry only, whether its date lies beyond the
   * search range (within the outer bound); absent in the other lists.
   */
  readonly beyondSearchRange?: boolean;
  /** §58M: on a cost line's entry only, its statement's period and the account as printed. */
  readonly costLine?: { readonly statementPeriod: Range; readonly account: string };
  readonly flags: readonly CheckEntryFlag[];
}

/** `ANNUALLY_RECURRING` (A2); `PERFORMED_OUTSIDE_WINDOW` (§59F): performed wholly outside, whatever its booking date. */
export type ExcludedReason = 'ANNUALLY_RECURRING' | 'PERFORMED_OUTSIDE_WINDOW';

export type CheckFlag =
  | { readonly code: 'NOT_FINAL'; readonly details: { readonly reasons: readonly NotFinalReason[]; readonly note?: string } }
  /** §58M narrows it to the unjudged lines (`lines`); a rule without `hausgeldMaintenance` names the statements only. */
  | {
      readonly code: 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED';
      readonly details: { readonly statementIds: readonly string[]; readonly lines?: readonly UnjudgedLine[] };
    }
  | { readonly code: 'WEG_STATEMENT_MISSING'; readonly details: { readonly missing: readonly MissingStatement[] } }
  | {
      readonly code: 'HAUSGELD_MAINTENANCE_ANSCHAFFUNGSNAH';
      readonly details: {
        readonly lines: readonly {
          readonly statementId: string;
          readonly position: number;
          readonly inWindow: { readonly lower: Money; readonly upper: Money };
        }[];
      };
    }
  | { readonly code: 'PARTIAL_ACQUISITION'; readonly details: { readonly acquiredShare: string } }
  /** §58K (VC-X-34): open; the same code and details as §59A's component reason. */
  | { readonly code: 'TRANSFER_DATE_MISSING'; readonly details: { readonly contractDate: BusinessDate } };

export interface CheckBasis {
  readonly allocationId: string;
  readonly allocationReviewState: string;
  readonly purchasePrice: Money;
  /** The `ACTIVE` costs without the excluded categories. */
  readonly acquisitionCosts: Money;
  readonly totalAllocableAmount: Money;
  readonly buildingAmount: Money;
  /** Without the unclassified costs (the lower bound, §59D). */
  readonly basisAmount: Money;
  /** §59D: with the unclassified costs (the upper bound); equal to `basisAmount` without any. */
  readonly basisAmountWithUnclassified: Money;
  readonly unclassifiedCosts: readonly UnclassifiedCost[];
}

type Range = { readonly from: BusinessDate; readonly until: BusinessDate };

export interface AnschaffungsnaheCheck {
  readonly acquisitionId: string;
  readonly propertyReferenceId: string;
  readonly acquisitionStatus: string;
  /** §58K: `economicTransferDate`, else `null` (the check then has no window). */
  readonly transferDate: BusinessDate | null;
  /** §58K: the view lists a check without a window in every year from this date's year on; not in the check's DTO. */
  readonly contractDate: BusinessDate;
  readonly window: Range | null;
  /** §59F: where undated sources are summed in the upper bound, and how far undated ones are listed at all. */
  readonly searchRange: Range | null;
  readonly outerBound: Range | null;
  readonly acquiredShare: { readonly numerator: number; readonly denominator: number };
  readonly rule: RuleRef | null;
  readonly status: CheckStatus;
  readonly notComputableReason: NotComputableReason | null;
  readonly basis: CheckBasis | null;
  readonly thresholdPercent: number | null;
  /** basis × percent / 100, exact (up to four places), never rounded; `null` when not computable. */
  readonly threshold: string | null;
  /** §59D: the threshold of `basisAmountWithUnclassified`, exact; `null` when equal to `threshold` or not computable. */
  readonly thresholdWithUnclassified: string | null;
  /** §59F: the lower bound of the sum (the parts certainly performed in the window). */
  readonly sum: Money;
  /** sum × acquiredShare, shown rounded half-up to the cent; the comparison uses the exact fraction. */
  readonly attributableAmount: Money;
  /** attributable / basis × 100, rounded half-even to two places (§87), for display only. */
  readonly percentOfBasis: string | null;
  /** §59F: the upper bound (with the undated sources of the search range); equal to the lower when nothing is open. */
  readonly sumUpper: Money;
  readonly attributableAmountUpper: Money;
  readonly percentOfBasisUpper: string | null;
  readonly sources: readonly CheckEntry[];
  readonly excluded: readonly CheckEntry[];
  readonly unclassified: readonly CheckEntry[];
  /** §59F: summed sources without a performance in the search range (in the upper bound only). */
  readonly undetermined: readonly CheckEntry[];
  /** §59F: undated sources beyond the search range, within the outer bound: listed, never summed. */
  readonly outsideSearchRange: readonly CheckEntry[];
  readonly affectedYears: readonly number[] | null;
  readonly final: boolean;
  readonly flags: readonly CheckFlag[];
}

/** The rule applicable on the transfer date, typed. */
export function anschaffungsnaheRuleOn(registry: RuleRegistry, transferDate: BusinessDate): RuleVersion<AnschaffungsnaheParameters> | undefined {
  return registry.select(ANSCHAFFUNGSNAHE, transferDate) as RuleVersion<AnschaffungsnaheParameters> | undefined;
}

/**
 * The window (§ 108 AO with §§ 187 Abs. 1, 188 Abs. 2 BGB): from the transfer date to the same calendar day
 * `windowYears` later, both inclusive; a window from 29 February ends on 28 February (§ 188 Abs. 3 BGB).
 */
export function anschaffungsnaheWindow(transferDate: BusinessDate, windowYears: number): Range {
  return { from: transferDate, until: addMonths(transferDate, windowYears * 12) };
}

/** §59F: the search range of the undated sources and the outer bound of the listed ones, from the rule's parameters. */
export function searchRangesOf(window: Range, p: AnschaffungsnaheParameters): { readonly searchRange: Range; readonly outerBound: Range } {
  const q = p.performance;
  return {
    searchRange: { from: addDays(window.from, -q.undatedReadBeforeWindowDays), until: addDays(window.until, q.undatedReadAfterWindowDays) },
    outerBound: { from: addMonths(window.from, -12 * q.plausibleYearsFromSourceDate), until: addMonths(window.until, 12 * q.plausibleYearsFromSourceDate) },
  };
}

const NOTE_GROSS = 'Summed at gross amounts where no netAmount is given: the gross amount reaches the threshold sooner than the net one would.';
const within = (range: Range | null, date: BusinessDate) => range !== null && date >= range.from && date <= range.until;
/** An undated source in the upper bound only; a refund (negative) in the lower bound only (§59F). */
const undatedBounds = (cents: bigint) => ({ lower: cents < 0n ? cents : 0n, upper: cents < 0n ? 0n : cents });

/** A summed source with its part in the window, in cents (`lower` ≤ `upper`). */
interface Placed {
  readonly s: CheckSource;
  readonly lower: bigint;
  readonly upper: bigint;
}

/**
 * The check (§58B, §59F). `sources` are the counting sources of the PropertyReference in the order of the per-property
 * list. A source with a performance counts by the part performed in the window (bounds, never estimated), whatever its
 * booking date; one without counts in the upper bound only while its own date lies in the search range, and is listed
 * (`outsideSearchRange`) within the outer bound. §58M: with the rule's `hausgeldMaintenance` the judged maintenance lines
 * of `hausgeld`'s statements are sources too, an unjudged line or a missing statement holds the result open; without it,
 * a `CONFIRMED` statement (`statements`) whose period overlaps the window makes the result `NOT_FINAL`, as before.
 */
export function checkAnschaffungsnahe(
  input: {
    readonly acquisition: CheckAcquisition;
    readonly costs: readonly BasisCost[];
    readonly allocation: CheckAllocation | null;
    readonly sources: readonly CheckSource[];
    readonly statements: readonly { readonly id: string; readonly periodFrom: BusinessDate; readonly periodUntil: BusinessDate }[];
    /** §58M: the confirmed statements with their cost lines and the memberships; read only with `hausgeldMaintenance`. */
    readonly hausgeld?: HausgeldInput;
    readonly today: BusinessDate;
  },
  registry: RuleRegistry,
): AnschaffungsnaheCheck {
  const { acquisition } = input;
  // §58K (VC-X-34): no rule, window or source from the contract date; without the transfer date the check reads nothing.
  const transfer = acquisition.transferDate;
  const rule = transfer === null ? undefined : anschaffungsnaheRuleOn(registry, transfer);
  const share = acquisition.acquiredShare;
  const n = BigInt(share.numerator);
  const d = BigInt(share.denominator);
  const p = rule?.parameters;
  const window = p === undefined || transfer === null ? null : anschaffungsnaheWindow(transfer, p.windowYears);
  const ranges = window === null || p === undefined ? null : searchRangesOf(window, p);
  const searchRange = ranges?.searchRange ?? null;
  const outerBound = ranges?.outerBound ?? null;
  const q = p?.hausgeldMaintenance;
  const hausgeld =
    window === null || ranges === null || q === undefined
      ? null
      : readHausgeld(input.hausgeld ?? NO_HAUSGELD, window, readRangeOf(window, ranges, q), ranges.outerBound, q, input.today);
  const erhaltung = (s: CheckSource) => p !== undefined && p.taxCategories.includes(s.taxCategory);
  const summedSource = (s: CheckSource) =>
    erhaltung(s) &&
    !s.annuallyRecurring &&
    s.treatment !== null &&
    ((p?.countedTreatments ?? []).includes(s.treatment) || (s.treatment === 'CAPITALIZED' && s.anschaffungsnaheAcquisitionId === acquisition.id));
  const used = (s: CheckSource) => {
    const cents = centsOf(s.netAmount ?? s.grossAmount);
    return s.direction === 'INFLOW' ? -cents : cents;
  };

  // §59F: sort the sources. Never the booking date as the date of the work; no relevant source dropped by its date.
  const summed: Placed[] = [];
  const undetermined: Placed[] = [];
  const outside: CheckSource[] = [];
  const performedOut: CheckSource[] = [];
  const recurring: CheckSource[] = [];
  const unclassified: { readonly s: CheckSource; readonly beyond: boolean }[] = [];
  for (const s of window === null ? [] : mergeCostLines(input.sources, hausgeld?.sources ?? [])) {
    const w = window as Range;
    const overlaps = s.performance !== null && !performedOutside(s.performance, w);
    const undatedNear = s.performance === null && within(searchRange, s.date);
    if (s.costLine !== undefined) {
      // §58M: a statement read overlaps the search range, so its undated line is undetermined, never outside; a later
      // statement's line (performed in the window) is listed, never summed (M3).
      if (s.costLine.later) outside.push(s);
      else if (s.annuallyRecurring) recurring.push(s);
      else if (s.performance === null) undetermined.push({ s, ...undatedBounds(used(s)) });
      else if (overlaps) summed.push({ s, ...partInWindow(s.performance, used(s), w) });
      else performedOut.push(s);
    } else if (s.taxCategory === 'UNCLASSIFIED') {
      // §59F (the owner's decision 239-8, 2026-11-02): beyond the search range but within the outer bound it is listed
      // too, marked, and keeps the check open (`UNCLASSIFIED_SOURCES`); it never makes the check NOT_COMPUTABLE.
      if (within(searchRange, s.date)) unclassified.push({ s, beyond: false });
      else if (within(outerBound, s.date)) unclassified.push({ s, beyond: true });
    } else if (erhaltung(s) && s.annuallyRecurring) {
      if (overlaps || undatedNear) recurring.push(s);
    } else if (!summedSource(s)) {
      continue;
    } else if (s.performance !== null) {
      if (overlaps) summed.push({ s, ...partInWindow(s.performance, used(s), w) });
      else if (within(searchRange, s.date)) performedOut.push(s);
    } else if (undatedNear) {
      undetermined.push({ s, ...undatedBounds(used(s)) });
    } else if (within(outerBound, s.date)) {
      outside.push(s);
    }
  }
  const placed = [...summed, ...undetermined];
  const sumCents = placed.reduce((total, x) => total + x.lower, 0n);
  const sumUpperCents = placed.reduce((total, x) => total + x.upper, 0n);

  // The building's acquisition cost: the allocation's ratio applied to price + costs (open question 5), rounded once. One
  // function with the AfA schedule (§59A), in the Acquisition domain; the check keeps its own NO_APPLICABLE_RULE in front.
  // §59D: which costs enter is the rule's `costClassification`; without a rule nothing is decided by a classification.
  const cost = buildingAcquisitionCost(
    { acquisition, costs: input.costs, allocation: input.allocation },
    {
      excludedCostCategories: p?.excludedCostCategories ?? ['FINANCING_RELATED'],
      confirmedAllocationReviewStates: ['CONFIRMED', 'ADVISOR_CONFIRMED'],
      costClassification: p?.costClassification ?? NO_RULE_COST_CLASSIFICATION,
    },
  );
  const basisCents = cost.basisAmount === null ? 0n : centsOf(cost.basisAmount);
  const upperCents = cost.basisAmountWithUnclassified === null ? basisCents : centsOf(cost.basisAmountWithUnclassified);
  const basis: CheckBasis | null =
    cost.allocation === null || cost.basisAmount === null
      ? null
      : {
          allocationId: cost.allocation.id,
          allocationReviewState: cost.allocation.reviewState,
          purchasePrice: cost.purchasePrice,
          acquisitionCosts: cost.acquisitionCosts,
          totalAllocableAmount: cost.allocation.totalAllocableAmount,
          buildingAmount: cost.allocation.buildingAmount,
          basisAmount: cost.basisAmount,
          basisAmountWithUnclassified: cost.basisAmountWithUnclassified ?? cost.basisAmount,
          unclassifiedCosts: cost.unclassifiedCosts,
        };

  const percent = BigInt(p?.thresholdPercent ?? 0);
  // Above: sum × n / d > basis × percent / 100, in cents and without a division (§58B).
  const aboveOf = (sum: bigint, basisOf: bigint) => sum * n * 100n > basisOf * percent * d;
  // §59D and §59F: only the bounds decide. The sum's lower bound above 15 % of the basis's upper bound is above whatever
  // the dates and the classification; the sum's upper bound not above 15 % of the basis's lower bound is not above (and
  // final only with complete sources); in between the check is not computable. Never decided on a guess.
  const costOpen = cost.reason === 'ACQUISITION_COST_UNCLASSIFIED';
  const datesOpen = sumCents !== sumUpperCents;
  const basisLeavesOpen = (sum: bigint) => aboveOf(sum, basisCents) && !aboveOf(sum, upperCents);
  let notComputableReason: NotComputableReason | null;
  if (transfer === null) notComputableReason = 'TRANSFER_DATE_MISSING';
  else if (rule === undefined) notComputableReason = 'NO_APPLICABLE_RULE';
  else if (cost.reason !== null && !costOpen) notComputableReason = cost.reason;
  else if (aboveOf(sumCents, upperCents)) notComputableReason = null;
  else if (!aboveOf(sumUpperCents, basisCents)) notComputableReason = outside.length > 0 ? 'SOURCES_OUTSIDE_SEARCH_RANGE' : null;
  else
    notComputableReason =
      costOpen && (!datesOpen || basisLeavesOpen(sumCents) || basisLeavesOpen(sumUpperCents))
        ? 'ACQUISITION_COST_UNCLASSIFIED'
        : 'PERFORMANCE_IN_WINDOW_UNKNOWN';
  const above = notComputableReason === null && aboveOf(sumCents, upperCents);
  const status: CheckStatus = notComputableReason !== null ? 'NOT_COMPUTABLE' : above ? 'ABOVE_THRESHOLD' : 'NOT_ABOVE_THRESHOLD';

  // §58M narrows the flag to the unjudged lines; a rule without `hausgeldMaintenance` flags every overlapping statement.
  const statementIds =
    window === null
      ? []
      : hausgeld !== null
        ? [...new Set(hausgeld.unjudged.map((l) => l.statementId))].sort()
        : input.statements
            .filter((s) => s.periodFrom <= window.until && s.periodUntil >= window.from)
            .map((s) => s.id)
            .sort();
  const missing = hausgeld?.missing ?? [];
  // §58M (M6): above with a cost line summed: the outcome stands, no suggestion on the line, the advisor reviews.
  const hausgeldAbove = status === 'ABOVE_THRESHOLD' ? summed.filter((x) => x.s.costLine !== undefined) : [];
  const reasons: NotFinalReason[] = transfer === null ? ['TRANSFER_DATE_MISSING'] : [];
  if (placed.some((x) => x.s.netAmount === null)) reasons.push('GROSS_AMOUNTS');
  if (unclassified.length > 0) reasons.push('UNCLASSIFIED_SOURCES');
  if (window !== null && input.today <= window.until) reasons.push('WINDOW_OPEN');
  if (statementIds.length > 0) reasons.push('WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED');
  if (missing.length > 0) reasons.push('WEG_STATEMENT_MISSING');
  if (hausgeldAbove.length > 0) reasons.push('HAUSGELD_MAINTENANCE_ABOVE_THRESHOLD');
  // §59F (the owner's decision of 2026-11-02, open question 7): undated sources in the search range hold open an outcome
  // above (or one not decided), never one not above by the upper bound; sources outside it hold open every outcome.
  if (datesOpen && status !== 'NOT_ABOVE_THRESHOLD') reasons.push('PERFORMANCE_IN_WINDOW_UNKNOWN');
  if (outside.length > 0) reasons.push('SOURCES_OUTSIDE_SEARCH_RANGE');
  if (cost.unclassifiedCosts.length > 0) reasons.push('ACQUISITION_COSTS_UNCLASSIFIED');
  const final = reasons.length === 0;
  const ruleRef = rule === undefined ? null : { ruleCode: rule.ruleCode, version: rule.version };
  const w = window ?? { from: acquisition.contractDate, until: acquisition.contractDate };
  const whollyIn = (s: CheckSource) => s.performance !== null && s.performance.from >= w.from && s.performance.until <= w.until;

  const entry = (
    s: CheckSource,
    list: 'SUMMED' | 'UNDETERMINED' | 'OUTSIDE' | 'OTHER',
    bounds: Placed | null,
    reason: ExcludedReason | null = null,
  ): CheckEntry => {
    const flags: CheckEntryFlag[] = [...s.sourceFlags];
    const counted = list === 'SUMMED' || list === 'UNDETERMINED';
    const inWindow = bounds === null ? null : { lower: moneyOfCents(bounds.lower), upper: moneyOfCents(bounds.upper) };
    if (counted && s.netAmount === null) flags.push({ code: 'VAT_NOT_SEPARATED', details: { acquisitionId: acquisition.id } });
    if (list === 'UNDETERMINED' || (list === 'OUTSIDE' && s.performance === null)) {
      flags.push({ code: 'PERFORMANCE_DATE_MISSING', details: { date: s.date, dateSource: s.dateSource } });
    }
    const straddles = list === 'SUMMED' && !whollyIn(s);
    if (straddles && s.performance !== null && inWindow !== null) {
      const bound = { lower: inWindow.lower.toJSON(), upper: inWindow.upper.toJSON() };
      if (s.performance.from < w.from) flags.push({ code: 'PERFORMANCE_STRADDLES_WINDOW', details: { edge: 'START', ...bound } });
      if (s.performance.until > w.until) flags.push({ code: 'PERFORMANCE_STRADDLES_WINDOW', details: { edge: 'END', ...bound } });
    }
    if (s.performance?.progressEstimated === true) flags.push({ code: 'PERFORMANCE_PROGRESS_ESTIMATED', details: {} });
    if (list === 'SUMMED' && status === 'ABOVE_THRESHOLD' && ruleRef !== null) {
      // §59F (the owner's decision of 2026-11-02, open question 8): a straddling source is never suggested as a whole.
      // VC-X-38 Part 2 (239-2): a partial treatment on this check is the evidenced split, so none is required any more.
      const details = { acquisitionId: acquisition.id, final, rule: ruleRef };
      // §58M (M6): a cost line is in the Hausgeld the view deducts; no classification takes it out, so no suggestion.
      const split = (s.treatmentParts ?? null) !== null && s.treatment === 'CAPITALIZED' && s.anschaffungsnaheAcquisitionId === acquisition.id;
      if (s.costLine !== undefined) flags.push({ code: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', details: { ...details, paidFromHausgeld: true } });
      else
        flags.push({
          code: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN',
          details:
            straddles && inWindow !== null
              ? { ...details, inWindow: { lower: inWindow.lower.toJSON(), upper: inWindow.upper.toJSON() }, splitRequired: !split }
              : details,
        });
    }
    if (counted && status === 'NOT_ABOVE_THRESHOLD' && s.treatment === 'CAPITALIZED' && s.anschaffungsnaheAcquisitionId === acquisition.id) {
      flags.push({ code: 'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE', details: { acquisitionId: acquisition.id } });
    }
    return {
      sourceType: s.sourceType,
      sourceId: s.sourceId,
      sourcePosition: s.sourcePosition,
      date: s.date,
      taxYear: s.taxYear,
      taxCategory: s.taxCategory,
      treatment: s.treatment,
      reviewState: s.reviewState,
      origin: s.origin,
      classificationId: s.classificationId,
      grossAmount: s.grossAmount,
      netAmount: s.netAmount,
      amountUsed: moneyOfCents(used(s)),
      performance: s.performance,
      inWindow,
      suggestedTreatment: list === 'SUMMED' && !straddles && status === 'ABOVE_THRESHOLD' && s.costLine === undefined ? 'CAPITALIZED' : null,
      reason,
      ...(s.costLine === undefined ? {} : { costLine: { statementPeriod: s.costLine.statementPeriod, account: s.costLine.account } }),
      flags,
    };
  };

  const flags: CheckFlag[] = [];
  if (!final) flags.push({ code: 'NOT_FINAL', details: reasons.includes('GROSS_AMOUNTS') ? { reasons, note: NOTE_GROSS } : { reasons } });
  if (statementIds.length > 0) {
    flags.push({ code: 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED', details: hausgeld === null ? { statementIds } : { statementIds, lines: hausgeld.unjudged } });
  }
  if (missing.length > 0) flags.push({ code: 'WEG_STATEMENT_MISSING', details: { missing } });
  if (hausgeldAbove.length > 0) {
    const lines = hausgeldAbove.map((x) => ({
      statementId: x.s.sourceId,
      position: x.s.sourcePosition as number,
      inWindow: { lower: moneyOfCents(x.lower), upper: moneyOfCents(x.upper) },
    }));
    flags.push({ code: 'HAUSGELD_MAINTENANCE_ANSCHAFFUNGSNAH', details: { lines } });
  }
  if (transfer === null) flags.push({ code: 'TRANSFER_DATE_MISSING', details: { contractDate: acquisition.contractDate } });
  if (n < d) flags.push({ code: 'PARTIAL_ACQUISITION', details: { acquiredShare: `${share.numerator}/${share.denominator}` } });
  const computable = status !== 'NOT_COMPUTABLE';
  const percentOf = (sum: bigint) => (computable && basisCents > 0n ? decimalOf(divideHalfEven(sum * n * 10_000n, d * basisCents), 2) : null);
  const sources = summed.map((x) => entry(x.s, 'SUMMED', x));
  return {
    acquisitionId: acquisition.id,
    propertyReferenceId: acquisition.propertyReferenceId,
    acquisitionStatus: acquisition.status,
    transferDate: transfer,
    contractDate: acquisition.contractDate,
    window,
    searchRange,
    outerBound,
    acquiredShare: share,
    rule: ruleRef,
    status,
    notComputableReason,
    basis,
    thresholdPercent: p?.thresholdPercent ?? null,
    // basis × percent / 100 in ten-thousandths of a euro: exact, never rounded.
    threshold: computable ? trimDecimal(decimalOf(basisCents * percent, 4)) : null,
    thresholdWithUnclassified: computable && upperCents !== basisCents ? trimDecimal(decimalOf(upperCents * percent, 4)) : null,
    sum: moneyOfCents(sumCents),
    attributableAmount: moneyOfCents(divideHalfUp(sumCents * n, d)),
    percentOfBasis: percentOf(sumCents),
    sumUpper: moneyOfCents(sumUpperCents),
    attributableAmountUpper: moneyOfCents(divideHalfUp(sumUpperCents * n, d)),
    percentOfBasisUpper: percentOf(sumUpperCents),
    sources,
    excluded: [
      ...recurring.map((s) => entry(s, 'OTHER', null, 'ANNUALLY_RECURRING')),
      ...performedOut.map((s) => entry(s, 'OTHER', null, 'PERFORMED_OUTSIDE_WINDOW')),
    ],
    unclassified: unclassified.map((u) => ({ ...entry(u.s, 'OTHER', null), beyondSearchRange: u.beyond })),
    undetermined: undetermined.map((x) => entry(x.s, 'UNDETERMINED', x)),
    outsideSearchRange: outside.map((s) => entry(s, 'OUTSIDE', null)),
    affectedYears:
      status === 'ABOVE_THRESHOLD'
        ? [...new Set(sources.filter((e) => e.suggestedTreatment !== null).map((e) => e.taxYear))].sort((a, b) => a - b)
        : computable
          ? []
          : null,
    final,
    flags,
  };
}

/** Trailing zeros beyond the cents dropped: `"29700.0000"` → `"29700.00"`, `"0.1250"` → `"0.125"`. */
function trimDecimal(value: string): string {
  const [whole, fraction = ''] = value.split('.') as [string, string?];
  const kept = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${kept}`;
}

// The meaning flags a source takes from the checks (§58B, §59F), in a file of its own (the size limit).
export { checkFlagsOf } from './anschaffungsnahe-flags.js';

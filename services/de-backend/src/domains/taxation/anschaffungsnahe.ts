import { addDays, addMonths, type BusinessDate, type Money } from '../../shared/index.js';
import { centsOf, decimalOf, divideHalfEven, divideHalfUp, moneyOfCents } from './cents.js';
import { ANSCHAFFUNGSNAHE, type AnschaffungsnaheParameters } from './rules/de-anschaffungsnahe.js';
import type { RuleRegistry } from './rules/registry.js';
import type { RuleRef, RuleVersion } from './rules/rule-version.js';
import type { Origin, ReviewState, SourceType, TaxCategory, Treatment } from './vocabulary.js';

/**
 * The anschaffungsnahe check per Acquisition (api-design.md §58B, P7-D6, § 6 Abs. 1 Nr. 1a EStG, checklist A2): the
 * Erhaltungsaufwand of the 3 years after the transfer, net where known, against 15 % of the building's acquisition
 * cost. Derived on read, never stored; it suggests `CAPITALIZED` and never changes a classification or the
 * Acquisition. Exact in cents: the one rounding is the building's acquisition cost; the comparison is on fractions.
 */

/** Days from a window edge within which the booking date may differ from the day the work was carried out (§58B). */
export const BOOKING_DATE_EDGE_DAYS = 90;

/** A counting source of the Acquisition's PropertyReference with its current meaning (the classification, else the default). */
export interface CheckSource {
  readonly sourceType: SourceType;
  readonly sourceId: string;
  readonly sourcePosition: number | null;
  /** The booking date, the withdrawal's (or assumed) date, the use's date. */
  readonly date: BusinessDate;
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
  /** The source's own flags carried into the check (an assumed withdrawal date). */
  readonly sourceFlags: readonly { readonly code: string; readonly details: object }[];
}

export interface CheckAcquisition {
  readonly id: string;
  readonly propertyReferenceId: string;
  readonly status: string;
  readonly transferDate: BusinessDate;
  readonly acquiredShare: { readonly numerator: number; readonly denominator: number };
  readonly purchasePrice: Money;
}

export interface CheckAllocation {
  readonly id: string;
  readonly reviewState: string;
  readonly totalAllocableAmount: Money;
  readonly buildingAmount: Money;
}

export const NOT_COMPUTABLE_REASONS = ['NO_APPLICABLE_RULE', 'ACQUISITION_NOT_CONFIRMED', 'NO_ALLOCATION', 'ALLOCATION_NOT_CONFIRMED', 'NO_BUILDING'] as const;
export type NotComputableReason = (typeof NOT_COMPUTABLE_REASONS)[number];
export type CheckStatus = 'NOT_COMPUTABLE' | 'ABOVE_THRESHOLD' | 'NOT_ABOVE_THRESHOLD';
export type NotFinalReason = 'GROSS_AMOUNTS' | 'UNCLASSIFIED_SOURCES' | 'WINDOW_OPEN' | 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED' | 'DATES_NEAR_WINDOW_EDGE';

export type CheckEntryFlag =
  | { readonly code: 'VAT_NOT_SEPARATED'; readonly details: { readonly acquisitionId: string } }
  | { readonly code: 'DATE_IS_BOOKING_DATE'; readonly details: { readonly edge: 'START' | 'END'; readonly date: BusinessDate } }
  | {
      readonly code: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN';
      readonly details: { readonly acquisitionId: string; readonly final: boolean; readonly rule: RuleRef };
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
  readonly suggestedTreatment: 'CAPITALIZED' | null;
  /** Why an `excluded` source is left out; `null` in `sources` and `unclassified`. */
  readonly reason: ExcludedReason | null;
  readonly flags: readonly CheckEntryFlag[];
}

/**
 * `ANNUALLY_RECURRING` (A2); `AFTER_WINDOW_NEAR_EDGE`: dated within 90 days after the window's end (owner's request on
 * VC-7-03): work carried out in the third year but booked after it counts by law (BMF 20.10.2017), so it is shown,
 * never summed, and keeps the result from looking final.
 */
export type ExcludedReason = 'ANNUALLY_RECURRING' | 'AFTER_WINDOW_NEAR_EDGE';

export type CheckFlag =
  | { readonly code: 'NOT_FINAL'; readonly details: { readonly reasons: readonly NotFinalReason[]; readonly note?: string } }
  | { readonly code: 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED'; readonly details: { readonly statementIds: readonly string[] } }
  | { readonly code: 'PARTIAL_ACQUISITION'; readonly details: { readonly acquiredShare: string } };

export interface CheckBasis {
  readonly allocationId: string;
  readonly allocationReviewState: string;
  readonly purchasePrice: Money;
  /** The `ACTIVE` costs without the excluded categories. */
  readonly acquisitionCosts: Money;
  readonly totalAllocableAmount: Money;
  readonly buildingAmount: Money;
  readonly basisAmount: Money;
}

export interface AnschaffungsnaheCheck {
  readonly acquisitionId: string;
  readonly propertyReferenceId: string;
  readonly acquisitionStatus: string;
  readonly transferDate: BusinessDate;
  readonly window: { readonly from: BusinessDate; readonly until: BusinessDate } | null;
  readonly acquiredShare: { readonly numerator: number; readonly denominator: number };
  readonly rule: RuleRef | null;
  readonly status: CheckStatus;
  readonly notComputableReason: NotComputableReason | null;
  readonly basis: CheckBasis | null;
  readonly thresholdPercent: number | null;
  /** basis × percent / 100, exact (up to four places), never rounded; `null` when not computable. */
  readonly threshold: string | null;
  readonly sum: Money;
  /** sum × acquiredShare, shown rounded half-up to the cent; the comparison uses the exact fraction. */
  readonly attributableAmount: Money;
  /** attributable / basis × 100, rounded half-even to two places (§87), for display only. */
  readonly percentOfBasis: string | null;
  readonly sources: readonly CheckEntry[];
  readonly excluded: readonly CheckEntry[];
  readonly unclassified: readonly CheckEntry[];
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
export function anschaffungsnaheWindow(transferDate: BusinessDate, windowYears: number): { readonly from: BusinessDate; readonly until: BusinessDate } {
  return { from: transferDate, until: addMonths(transferDate, windowYears * 12) };
}

const dayNumber = (date: BusinessDate) => {
  const d = new Date(0);
  d.setUTCFullYear(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.round(d.getTime() / 86_400_000);
};

const NOTE_GROSS = 'Summed at gross amounts where no netAmount is given: the gross amount reaches the threshold sooner than the net one would.';

/**
 * The check (§58B). `sources` are the counting sources of the PropertyReference in the order of the per-property
 * list; those dated in the window are sorted into the summed, the excluded (annually recurring) and the
 * unclassified ones. `statements` are the `CONFIRMED` statements of the PropertyReference's memberships: one whose
 * period overlaps the window makes the result `NOT_FINAL` (maintenance paid from the Hausgeld is not counted).
 */
export function checkAnschaffungsnahe(
  input: {
    readonly acquisition: CheckAcquisition;
    readonly costs: readonly { readonly category: string; readonly amount: Money }[];
    readonly allocation: CheckAllocation | null;
    readonly sources: readonly CheckSource[];
    readonly statements: readonly { readonly id: string; readonly periodFrom: BusinessDate; readonly periodUntil: BusinessDate }[];
    readonly today: BusinessDate;
  },
  registry: RuleRegistry,
): AnschaffungsnaheCheck {
  const { acquisition } = input;
  const rule = anschaffungsnaheRuleOn(registry, acquisition.transferDate);
  const share = acquisition.acquiredShare;
  const n = BigInt(share.numerator);
  const d = BigInt(share.denominator);
  const window = rule === undefined ? null : anschaffungsnaheWindow(acquisition.transferDate, rule.parameters.windowYears);
  const inWindow = window === null ? [] : input.sources.filter((s) => s.date >= window.from && s.date <= window.until);
  const p = rule?.parameters;
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
  const edgeFlag = (s: CheckSource): CheckEntryFlag[] => {
    if (window === null) return [];
    if (s.date > window.until) return [{ code: 'DATE_IS_BOOKING_DATE', details: { edge: 'END', date: s.date } }];
    if (dayNumber(s.date) - dayNumber(window.from) <= BOOKING_DATE_EDGE_DAYS) return [{ code: 'DATE_IS_BOOKING_DATE', details: { edge: 'START', date: s.date } }];
    if (dayNumber(window.until) - dayNumber(s.date) <= BOOKING_DATE_EDGE_DAYS) return [{ code: 'DATE_IS_BOOKING_DATE', details: { edge: 'END', date: s.date } }];
    return [];
  };
  const summed = inWindow.filter(summedSource);
  const recurring = inWindow.filter((s) => s.annuallyRecurring);
  // The strip after the window's end: the summed sources' filter, and unclassified ones; never summed.
  const stripEnd = window === null ? null : addDays(window.until, BOOKING_DATE_EDGE_DAYS);
  const afterWindow =
    window === null || stripEnd === null
      ? []
      : input.sources.filter((s) => s.date > window.until && s.date <= stripEnd && (summedSource(s) || s.taxCategory === 'UNCLASSIFIED'));
  const excluded = [...recurring, ...afterWindow];
  const unclassified = inWindow.filter((s) => s.taxCategory === 'UNCLASSIFIED');
  const sumCents = summed.reduce((total, s) => total + used(s), 0n);

  // The building's acquisition cost: the allocation's ratio applied to price + costs (open question 5), rounded once.
  const excludedCategories = p?.excludedCostCategories ?? ['FINANCING_RELATED'];
  const costCents = input.costs.filter((c) => !excludedCategories.includes(c.category)).reduce((total, c) => total + centsOf(c.amount), 0n);
  const priceCents = centsOf(acquisition.purchasePrice);
  const allocation = input.allocation;
  const totalCents = allocation === null ? 0n : centsOf(allocation.totalAllocableAmount);
  const buildingCents = allocation === null ? 0n : centsOf(allocation.buildingAmount);
  const basisCents = allocation === null || totalCents === 0n ? 0n : divideHalfUp((priceCents + costCents) * buildingCents, totalCents);
  const basis: CheckBasis | null =
    allocation === null
      ? null
      : {
          allocationId: allocation.id,
          allocationReviewState: allocation.reviewState,
          purchasePrice: acquisition.purchasePrice,
          acquisitionCosts: moneyOfCents(costCents),
          totalAllocableAmount: allocation.totalAllocableAmount,
          buildingAmount: allocation.buildingAmount,
          basisAmount: moneyOfCents(basisCents),
        };

  const notComputableReason: NotComputableReason | null =
    rule === undefined
      ? 'NO_APPLICABLE_RULE'
      : acquisition.status !== 'CONFIRMED'
        ? 'ACQUISITION_NOT_CONFIRMED'
        : allocation === null
          ? 'NO_ALLOCATION'
          : allocation.reviewState !== 'CONFIRMED' && allocation.reviewState !== 'ADVISOR_CONFIRMED'
            ? 'ALLOCATION_NOT_CONFIRMED'
            : buildingCents === 0n
              ? 'NO_BUILDING'
              : null;
  const percent = BigInt(p?.thresholdPercent ?? 0);
  // Above: sum × n / d > basis × percent / 100, in cents and without a division (§58B).
  const above = notComputableReason === null && sumCents * n * 100n > basisCents * percent * d;
  const status: CheckStatus = notComputableReason !== null ? 'NOT_COMPUTABLE' : above ? 'ABOVE_THRESHOLD' : 'NOT_ABOVE_THRESHOLD';

  const statementIds =
    window === null
      ? []
      : input.statements
          .filter((s) => s.periodFrom <= window.until && s.periodUntil >= window.from)
          .map((s) => s.id)
          .sort();
  const reasons: NotFinalReason[] = [];
  if (summed.some((s) => s.netAmount === null)) reasons.push('GROSS_AMOUNTS');
  if (unclassified.length > 0) reasons.push('UNCLASSIFIED_SOURCES');
  if (window !== null && input.today <= window.until) reasons.push('WINDOW_OPEN');
  if (statementIds.length > 0) reasons.push('WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED');
  if ([...summed, ...excluded, ...unclassified].some((s) => edgeFlag(s).length > 0)) reasons.push('DATES_NEAR_WINDOW_EDGE');
  const final = reasons.length === 0;
  const ruleRef = rule === undefined ? null : { ruleCode: rule.ruleCode, version: rule.version };

  const entry = (s: CheckSource, isSummed: boolean, reason: ExcludedReason | null = null): CheckEntry => {
    const flags: CheckEntryFlag[] = [...s.sourceFlags, ...edgeFlag(s)];
    if (isSummed && s.netAmount === null) flags.push({ code: 'VAT_NOT_SEPARATED', details: { acquisitionId: acquisition.id } });
    if (isSummed && status === 'ABOVE_THRESHOLD' && ruleRef !== null) {
      flags.push({ code: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', details: { acquisitionId: acquisition.id, final, rule: ruleRef } });
    }
    if (isSummed && status === 'NOT_ABOVE_THRESHOLD' && s.treatment === 'CAPITALIZED' && s.anschaffungsnaheAcquisitionId === acquisition.id) {
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
      suggestedTreatment: isSummed && status === 'ABOVE_THRESHOLD' ? 'CAPITALIZED' : null,
      reason,
      flags,
    };
  };

  const flags: CheckFlag[] = [];
  if (!final) flags.push({ code: 'NOT_FINAL', details: reasons.includes('GROSS_AMOUNTS') ? { reasons, note: NOTE_GROSS } : { reasons } });
  if (statementIds.length > 0) flags.push({ code: 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED', details: { statementIds } });
  if (n < d) flags.push({ code: 'PARTIAL_ACQUISITION', details: { acquiredShare: `${share.numerator}/${share.denominator}` } });
  const computable = status !== 'NOT_COMPUTABLE';
  return {
    acquisitionId: acquisition.id,
    propertyReferenceId: acquisition.propertyReferenceId,
    acquisitionStatus: acquisition.status,
    transferDate: acquisition.transferDate,
    window,
    acquiredShare: share,
    rule: ruleRef,
    status,
    notComputableReason,
    basis,
    thresholdPercent: p?.thresholdPercent ?? null,
    // basis × percent / 100 in ten-thousandths of a euro: exact, never rounded.
    threshold: computable ? trimDecimal(decimalOf(basisCents * percent, 4)) : null,
    sum: moneyOfCents(sumCents),
    attributableAmount: moneyOfCents(divideHalfUp(sumCents * n, d)),
    percentOfBasis: computable ? decimalOf(divideHalfEven(sumCents * n * 10_000n, d * basisCents), 2) : null,
    sources: summed.map((s) => entry(s, true)),
    excluded: [...recurring.map((s) => entry(s, false, 'ANNUALLY_RECURRING')), ...afterWindow.map((s) => entry(s, false, 'AFTER_WINDOW_NEAR_EDGE'))],
    unclassified: unclassified.map((s) => entry(s, false)),
    affectedYears: status === 'ABOVE_THRESHOLD' ? [...new Set(summed.map((s) => s.taxYear))].sort((a, b) => a - b) : computable ? [] : null,
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

/** The meaning flags a source takes from the checks that sum it (§58B): never the edge flag, which is the check's own. */
export function checkFlagsOf(
  checks: readonly AnschaffungsnaheCheck[],
  source: { readonly sourceType: SourceType; readonly sourceId: string; readonly sourcePosition: number | null },
): {
  readonly flags: readonly CheckEntryFlag[];
  readonly suggestion: {
    readonly treatment: 'CAPITALIZED';
    readonly reason: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN';
    readonly acquisitionIds: readonly string[];
    readonly final: boolean;
  } | null;
} {
  const flags: CheckEntryFlag[] = [];
  const above: AnschaffungsnaheCheck[] = [];
  for (const check of checks) {
    if (check.status === 'NOT_COMPUTABLE') continue;
    const found = check.sources.find((e) => e.sourceType === source.sourceType && e.sourceId === source.sourceId && e.sourcePosition === source.sourcePosition);
    if (found === undefined) continue;
    for (const flag of found.flags) {
      if (['VAT_NOT_SEPARATED', 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', 'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE'].includes(flag.code)) flags.push(flag);
    }
    if (check.status === 'ABOVE_THRESHOLD') above.push(check);
  }
  return {
    flags,
    suggestion:
      above.length === 0
        ? null
        : {
            treatment: 'CAPITALIZED',
            reason: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN',
            acquisitionIds: above.map((c) => c.acquisitionId).sort(),
            final: above.every((c) => c.final),
          },
  };
}

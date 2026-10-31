import { centsOf, divideHalfUp, moneyOfCents, type Money } from '../../shared/index.js';
import { ZERO, cmp, monthLabel, monthOf, show, yearOfDate, yearOfMonth, type Frac } from './exact.js';
import { reciprocalPercent } from './rate.js';
import type { ComponentRate, ComponentYear, Flag, OwnerYear, ScheduleComponent, YearRule } from './schedule-model.js';
import { isOpen, mergeOwnerFlags, sortFlags } from './schedule-review.js';
import type { Part, Work } from './purchase-work.js';

/**
 * A purchase component of §59A's response (api-design.md §59A): its rate, its end, its owners and its years with each
 * owner's year rounded once, cumulatively, half-up (P8-D8), `NOT_CALCULABLE` / `PROVISIONAL` / `CALCULATED` with
 * reasons apart from flags. Moved out of `schedule.ts` unchanged (issue #191).
 */

/** The component of §59A's response, its years limited to the range. */
export function componentOf(
  w: Work,
  parts: readonly Part[],
  range: { readonly from: number; readonly to: number },
  assetReasons: readonly Flag[],
): ScheduleComponent {
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

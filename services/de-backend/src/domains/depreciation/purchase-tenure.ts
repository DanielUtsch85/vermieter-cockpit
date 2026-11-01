import { addDays, type BusinessDate, type RuleVersion } from '../../shared/index.js';
import { continuousOwners } from '../ownership/index.js';
import { ONE, ZERO, add, byText, cmp, div, firstDay, lastDayOf, maxDate, mul, show, yearOfDate, yearOfMonth, type Frac } from './exact.js';
import type { BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import type { ScheduleAcquisition, ScheduleInput, ScheduleOwnership } from './schedule-model.js';
import { heldOn, type Part, type Work } from './purchase-work.js';

/**
 * The owners' tenure in the purchase components (api-design.md §59A, §28.1A; P8-D8, P8-D9): the still-held fraction
 * over all of a Party's components, a reduced share, the end of the tenure with its cut-off (the buyer's transfer
 * date) and the disposal year's months, and `OWNER_WITHOUT_ACQUISITION`. Moved out of `schedule.ts` unchanged
 * (issue #191).
 */

/** A Party's held and covered share from a day on (`OWNER_WITHOUT_ACQUISITION`). */
export type CoverageStep = { date: BusinessDate; held: Frac; covered: Frac };

/** Days on which a held share or a component start can change something, for one Party. */
function eventDays(rows: readonly ScheduleOwnership[], starts: readonly BusinessDate[]): BusinessDate[] {
  const days = new Set<BusinessDate>(starts);
  for (const r of rows) {
    days.add(r.validFrom);
    if (r.validUntil !== null) days.add(addDays(r.validUntil, 1));
  }
  return [...days].sort(byText);
}

/** The cut-off of a disposal on `day` (the first day the Party no longer holds it): a `CONFIRMED` purchase from it on that day. */
function buyerOn(acquisitions: readonly ScheduleAcquisition[], seller: string, day: BusinessDate): ScheduleAcquisition | undefined {
  return acquisitions.find((a) => a.status === 'CONFIRMED' && a.sellerPartyIds.includes(seller) && (a.economicTransferDate ?? a.contractDate) === day);
}

/** The tenure and the still-held fraction per Party, over all its components at once; the coverage per Party. */
export function walkTenures(parties: readonly string[], works: readonly Work[], rowsOf: (partyId: string) => ScheduleOwnership[]): Map<string, CoverageStep[]> {
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
  return coverage;
}

/** Per owner part: the cut-off, the months and the exact cumulative AfA (§59A "Per owner"). */
export function walkOwnerMonths(
  input: Pick<ScheduleInput, 'acquisitions'>,
  works: readonly Work[],
  latest: RuleVersion<BuildingLinearParameters> | undefined,
): void {
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
      accumulateMonths(w, p, fractionAt);
      const legalBasis = disposal?.legalBasis ?? null;
      const noteDisposal = (lastDay: BusinessDate) => {
        const year = yearOfDate(lastDay);
        p.disposals.set(year, { lastDay, months: p.years.get(year)?.months ?? 0, endMonthCounts, legalBasis });
      };
      if (p.lastDaySource === 'BUYER_ECONOMIC_TRANSFER_DATE' && p.lastDay !== null) noteDisposal(p.lastDay);
      for (const c of reducedWithCutOff) noteDisposal(addDays(c.date, -1));
    }
  }
}

/** The first day of `year` on which the Party holds more than its components cover (`OWNER_WITHOUT_ACQUISITION`). */
export function uncoveredIn(steps: readonly { date: BusinessDate; held: Frac; covered: Frac }[], year: number) {
  const start = `${year}-01-01` as BusinessDate;
  const end = `${year}-12-31` as BusinessDate;
  const inYear = steps.filter((s, i) => s.date <= end && (s.date >= start || (steps[i + 1]?.date ?? '9999-12-31') > start));
  const gap = inYear.find((s) => cmp(s.held, s.covered) > 0);
  return gap === undefined ? undefined : { from: maxDate(gap.date, start), heldShare: show(gap.held), coveredShare: show(gap.covered) };
}

/**
 * A purchase part's months (§59A "Per owner"): the counted months, the last counted month's fraction and the exact
 * cumulative share of the basis per year, from the component's nominal months and the part's still-held fraction.
 * Shared by the derivation and the recomputation of a recorded version (§60).
 */
export function accumulateMonths(w: Pick<Work, 'firstMonth' | 'lastMonth' | 'monthly'>, p: Pick<Part, 'years'>, fractionAt: (m: number) => Frac): void {
  if (w.firstMonth === null || w.lastMonth === null) return;
  let cumulative = ZERO;
  for (let m = w.firstMonth; m <= w.lastMonth; m++) {
    const q = w.monthly.get(m) ?? ZERO;
    const f = fractionAt(m);
    cumulative = add(cumulative, mul(f, q));
    const year = yearOfMonth(m);
    const seen = p.years.get(year) ?? { months: 0, fraction: ZERO, cumulative: ZERO };
    p.years.set(year, cmp(f, ZERO) > 0 ? { months: seen.months + 1, fraction: f, cumulative } : { ...seen, cumulative });
  }
}

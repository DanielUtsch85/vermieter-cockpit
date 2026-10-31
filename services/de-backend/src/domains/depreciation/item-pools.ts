import type { RuleVersion } from '../../shared/index.js';
import { ONE, ZERO, add, cmp, div, minF, monthLabel, monthOf, mul, rateOfYear, sub, yearOfDate, yearOfMonth, type Frac } from './exact.js';
import { AFA_BUILDING_LINEAR, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import type { Flag } from './schedule-model.js';
import type { Part, Work } from './purchase-work.js';
import { cents, twelfth, type ItemContext, type ItemPart, type ItemWork, type Reading } from './item-part.js';

/**
 * The end of the capitalised items (api-design.md §59B "The end"): both readings of every pool, `POOLED_BASIS` (one
 * basis per ownership tenure) and `PER_ITEM_SERIES`, the years in which they differ, and a pool whose purchase is not
 * computable. Moved out of `schedule-items.ts` unchanged (issue #191).
 */

/** The last month of a purchase if every year ran at the rate of its band (or `1/n`): `nominalLastMonth` of §59B. */
function nominalLastMonth(ctx: ItemContext, w: Work): number | null {
  // Without a start (TRANSFER_DATE_MISSING) there are no nominal months, never from the contract date.
  if (w.firstMonth === null) return null;
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
export function walkPools(ctx: ItemContext, works: readonly ItemWork[]): void {
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
        const historical =
          w.reasons.some((r) => r.code === 'HISTORICAL_RULE_NOT_SUPPORTED' || r.code === 'NO_APPLICABLE_RULE') || (nominal === null && w.start !== null);
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
        if (w.firstMonth === null || m < w.firstMonth || p.fractionAt === null || p.basisCents === null) continue;
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
export function lastYearOf(w: ItemWork): number | null {
  const years = w.parts.flatMap((p) => {
    const reading = w.selected === 'POOLED_BASIS' ? p.pooled : p.perItem;
    return [...(reading.lastMonth === null ? [] : [yearOfMonth(reading.lastMonth)]), ...(p.endToVerify === null ? [] : [p.endToVerify.to])];
  });
  return years.length === 0 ? null : Math.max(...years);
}

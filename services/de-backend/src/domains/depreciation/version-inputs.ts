import { centsOf, type Money, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import { NOT_OWNED_PART } from './capitalized-item.js';
import { ZERO, add, byText, cmp, monthLabel, monthOf, show, yearOfDate, yearOfMonth, type Frac } from './exact.js';
import { ruleVersionHash, type Fingerprinter } from './fingerprint.js';
import type { ItemPart, ItemWork } from './item-part.js';
import { roundCents, tenureOf } from './item-part.js';
import { buildingRuleOn, movableRuleOn } from './rate.js';
import type { Part, Work } from './purchase-work.js';
import { AFA_BUILDING_LINEAR, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import { SCHEDULE_CALCULATION_VERSION, scheduleWorks, type ScheduleWorks } from './schedule.js';
import type { ScheduleInput } from './schedule-model.js';
import type { PartRateKind, VersionComponent, VersionEntry, VersionFraction, VersionInputs, VersionPart, VersionRule } from './version-model.js';

/**
 * Stage 1 of a recorded version (api-design.md §60 "What a version stores"): the derivation's inputs read off the
 * derivation's components (`scheduleWorks`), as rows, and its output as entries per year, component and owner part.
 * `computeVersionEntries` (`version-compute.ts`) recomputes the same entries from these inputs alone; `entriesOf` is
 * the one function both read the entries with.
 */

const ownerKey = (participant: string) => (participant === NOT_OWNED_PART ? NOT_OWNED_PART : `OWNER:${participant}`);
const dec = (year: number) => year * 12 + 11;

/** The running fraction's changes from `firstMonth` through December of `horizon`. */
function fractionsOf(fractionAt: ((m: number) => Frac) | null, firstMonth: number | null, horizon: number): VersionFraction[] {
  if (fractionAt === null || firstMonth === null) return [];
  const rows: VersionFraction[] = [];
  let last: Frac | null = null;
  for (let m = firstMonth; m <= dec(horizon); m++) {
    const f = fractionAt(m);
    if (last === null || cmp(f, last) !== 0) rows.push({ month: monthLabel(m), fraction: show(f) });
    last = f;
  }
  return rows;
}

/** The first year a component is active in (§59A's default `from`), or `null` without a known start. */
export function firstYearOfComponent(c: Pick<VersionComponent, 'start'>): number | null {
  return c.start.month === null ? null : Number(c.start.month.slice(0, 4));
}

/** Whether a pool's purchases all compute (§59B: otherwise the pooled reading is not used). */
const purchasesKnown = (p: ItemPart) => p.purchases.every(({ w, p: q }) => w.computable && q.basisCents !== null && q.fractionAt !== null);

/**
 * The derivation inputs of the asset (§60 stage 1), with the fractions through December of `horizon`. Not-computable
 * components are kept as markers, so a fingerprint sees them; a recorded version holds none in its run (§60 step 4).
 */
export function resolveScheduleInputs(
  input: Omit<ScheduleInput, 'today' | 'from' | 'to' | 'ownerPartyId'>,
  registry: RuleRegistry,
  fingerprinter: Fingerprinter,
  horizon: number,
): { readonly inputs: VersionInputs; readonly works: ScheduleWorks } {
  const derived = scheduleWorks(input, registry);
  const { asset } = input;
  const currency = 'EUR';
  // The pools (§59B "The rate in a pool"): an item part's owner tenure; a purchase part's key is its owner's tenure on
  // its own start, whatever items exist, so a later item never changes an earlier year's inputs.
  const poolOf = new Map<ItemPart, string>();
  for (const w of derived.itemWorks) {
    for (const p of w.parts) {
      const unpooled = !w.separate && w.selected === 'POOLED_BASIS' && !purchasesKnown(p);
      poolOf.set(p, unpooled ? `UNPOOLED:${w.componentId}|${p.participant}` : p.poolKey);
    }
  }
  const purchasePool = new Map<Part, string>();
  for (const w of derived.works) {
    for (const p of w.parts) {
      const from = p.hasTenure
        ? tenureOf(
            input.ownerships.filter((o) => o.partyId === p.ownerPartyId),
            w.ownedFrom,
          )?.from
        : undefined;
      if (from !== undefined) purchasePool.set(p, `${p.ownerPartyId}|${from}`);
    }
  }
  const components: VersionComponent[] = [];
  for (const w of derived.works) components.push(purchaseComponent(w, components.length, asset.shorterUsefulLives, horizon, purchasePool, registry));
  for (const w of derived.itemWorks) components.push(itemComponent(w, components.length, horizon, poolOf));
  const firstYears = components.map(firstYearOfComponent).filter((y): y is number => y !== null);
  const rules: VersionRule[] = [];
  if (firstYears.length > 0) {
    const ruleOn = (year: number) => (asset.assetType === 'SEPARATE_ASSET' ? movableRuleOn(registry, year) : buildingRuleOn(registry, year));
    for (let year = Math.min(...firstYears); year <= horizon; year++) {
      if (!firstYears.some((y) => y <= year)) continue;
      const rule = ruleOn(year);
      if (rule === undefined) continue;
      const last = rules[rules.length - 1];
      if (last !== undefined && last.ruleCode === rule.ruleCode && last.version === rule.version) {
        rules[rules.length - 1] = { ...last, lastYear: year };
      } else {
        rules.push({ ruleCode: rule.ruleCode, version: rule.version, ruleVersionHash: ruleVersionHash(rule, fingerprinter), firstYear: year, lastYear: year });
      }
    }
    rules.sort((a, b) => byText(a.ruleCode, b.ruleCode) || a.version - b.version);
  }
  return {
    inputs: {
      currency,
      asset: {
        assetType: asset.assetType,
        depreciationMethod: asset.depreciationMethod,
        buildingCompletionYear: asset.buildingCompletionYear,
        description: asset.description,
        usefulLifeYears: asset.usefulLifeYears,
        acquiredOn: asset.acquiredOn,
        reviewState: asset.reviewState,
        assetVersion: asset.version,
      },
      calculationVersion: SCHEDULE_CALCULATION_VERSION,
      rules,
      components,
    },
    works: derived,
  };
}

function purchaseComponent(
  w: Work,
  position: number,
  entries: readonly { readonly acquisitionId: string; readonly usefulLifeYears: number }[],
  horizon: number,
  pools: Map<Part, string>,
  registry: RuleRegistry,
): VersionComponent {
  const a = w.acquisition;
  const shorter = w.entry !== undefined && [...w.rates.values()].some((r) => r.kind === 'SHORTER_USEFUL_LIFE');
  const rateKind: PartRateKind = shorter ? 'SHORTER_USEFUL_LIFE' : 'BAND';
  const usefulLifeYears = shorter ? (entries.find((e) => e.acquisitionId === a.id)?.usefulLifeYears ?? null) : null;
  // The cost categories the rule of the start excludes (§59A, P8-D2 (1)); the ids counted and excluded.
  const rule = (w.start === null ? undefined : buildingRuleOn(registry, yearOfDate(w.start))) ?? latestBuilding(registry);
  const excludedCategories = rule?.parameters.basis.excludedCostCategories ?? [];
  const excluded = a.costs.filter((c) => excludedCategories.includes(c.category));
  const counted = a.costs.filter((c) => !excludedCategories.includes(c.category));
  const sum = (costs: readonly { amount: Money }[]) => costs.reduce((s, c) => s + centsOf(c.amount), 0n);
  const parts: VersionPart[] = w.parts.map((p) => ({
    partKey: ownerKey(p.ownerPartyId),
    ownerPartyId: p.ownerPartyId,
    ownershipIds: [p.ownershipId],
    share: show(p.share),
    weight: show(p.weight),
    basis: p.basisCents ?? 0n,
    firstMonth: w.firstMonth === null ? monthLabel(monthOf(a.contractDate)) : monthLabel(w.firstMonth),
    rateKind,
    usefulLifeYears,
    tenureFrom: w.start,
    lastDay: p.lastDay,
    lastDaySource: p.lastDaySource,
    poolKey: pools.get(p) ?? null,
    fractions: p.hasTenure ? fractionsOf(p.fractionAt, w.firstMonth, horizon) : [],
  }));
  return {
    componentId: w.componentId,
    kind: 'ACQUISITION',
    position,
    computable: w.computable,
    basis: w.cost.basisAmount === null ? 0n : centsOf(w.cost.basisAmount),
    start: { date: w.start, dateSource: 'ECONOMIC_TRANSFER_DATE', method: 'TRANSFER_DATE', month: w.firstMonth === null ? null : monthLabel(w.firstMonth) },
    rate: { kind: rateKind, usefulLifeYears },
    acquisition:
      a.allocation === null
        ? null
        : {
            acquisitionId: a.id,
            purchasePrice: centsOf(a.purchasePrice),
            countedCostIds: counted.map((c) => c.id).sort(byText),
            countedCostsTotal: sum(counted),
            excludedCostIds: excluded.map((c) => c.id).sort(byText),
            excludedCostsTotal: sum(excluded),
            allocationId: a.allocation.id,
            allocationReviewState: a.allocation.reviewState,
            totalAllocableAmount: centsOf(a.allocation.totalAllocableAmount),
            buildingAmount: centsOf(a.allocation.buildingAmount),
            shorterLifeReviewState: shorter ? (w.entry?.reviewState ?? null) : null,
          },
    method:
      w.method === null
        ? null
        : {
            consideration: w.method.entry.consideration,
            method: w.method.entry.method,
            specialDepreciation: [...w.method.entry.specialDepreciation],
            subsidiesReceived: w.method.entry.subsidiesReceived,
            newBuildingByConversion: w.method.entry.newBuildingByConversion,
            otherSpecialCase: w.method.entry.otherSpecialCase,
            reviewState: w.method.entry.reviewState,
          },
    item: null,
    parts,
  };
}

function itemComponent(w: ItemWork, position: number, horizon: number, pools: Map<ItemPart, string>): VersionComponent {
  const item = w.item;
  const rate = w.parts.find((p) => p.rate !== null)?.rate ?? null;
  const parts: VersionPart[] = [...w.parts]
    .sort((x, y) => byText(ownerKey(x.participant), ownerKey(y.participant)))
    .map((p) => ({
      partKey: ownerKey(p.participant),
      ownerPartyId: p.participant === NOT_OWNED_PART ? null : p.participant,
      ownershipIds: [...p.ownershipIds].sort(byText),
      share: show(p.share),
      weight: show(p.share),
      basis: p.basisCents,
      firstMonth: monthLabel(p.firstMonth),
      rateKind: p.rate?.kind ?? null,
      usefulLifeYears: p.rate?.usefulLifeYears ?? null,
      tenureFrom: p.tenureFrom,
      lastDay: p.lastDay,
      lastDaySource: p.lastDaySource,
      poolKey: pools.get(p) ?? p.poolKey,
      fractions: fractionsOf(p.fractionAt, p.firstMonth, horizon),
    }));
  return {
    componentId: w.componentId,
    kind: 'CAPITALIZED_ITEM',
    position,
    computable: w.computable && w.parts.every((p) => p.rate !== null && p.partReasons.length === 0),
    basis: item === null ? 0n : centsOf(item.lineAmount),
    start: {
      date: w.startDate,
      dateSource: w.separate ? 'ACQUIRED_ON' : 'ITEM_DATE',
      method: w.method,
      month: w.startMonth === null ? null : monthLabel(w.startMonth),
    },
    rate: { kind: rate?.kind ?? (w.separate ? 'USEFUL_LIFE' : 'BAND'), usefulLifeYears: rate?.usefulLifeYears ?? null },
    acquisition: null,
    method: null,
    item:
      item === null
        ? null
        : {
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            sourcePosition: item.sourcePosition,
            classificationId: item.classificationId,
            classificationReviewState: item.reviewState,
            taxCategory: item.taxCategory,
            itemDate: item.date,
            itemDateSource: item.dateSource,
            itemTaxYear: item.taxYear,
            anschaffungsnaheAcquisitionId: item.anschaffungsnaheAcquisitionId,
          },
    parts,
  };
}

const latestBuilding = (registry: RuleRegistry) => {
  const versions = registry.versions(AFA_BUILDING_LINEAR) as readonly RuleVersion<BuildingLinearParameters>[];
  return versions[versions.length - 1];
};

/** The cumulative exact share of a purchase part to the end of `year`. */
function purchaseCumulative(p: Part, year: number): Frac {
  let value = ZERO;
  for (const [y, v] of [...p.years.entries()].sort(([x], [z]) => x - z)) if (y <= year) value = v.cumulative;
  return value;
}

/**
 * The entries of `fromYear … toYear` (§60, data-model §40) of the computable components, and each year's total and
 * residual value (the residual over every part of a component, a part already sold included, as §59A).
 */
export function entriesOf(
  works: readonly Work[],
  itemWorks: readonly ItemWork[],
  fromYear: number,
  toYear: number,
): { readonly entries: VersionEntry[]; readonly totals: Map<number, { amount: bigint; residualValue: bigint }> } {
  const entries: VersionEntry[] = [];
  const totals = new Map<number, { amount: bigint; residualValue: bigint }>();
  const tally = (year: number, amount: bigint, residual: bigint) => {
    const t = totals.get(year) ?? { amount: 0n, residualValue: 0n };
    totals.set(year, { amount: t.amount + amount, residualValue: t.residualValue + residual });
  };
  for (const w of works) {
    if (!w.computable || w.firstMonth === null) continue;
    const yearsWithMonths = w.parts.flatMap((p) => [...p.years.entries()].filter(([, v]) => v.months > 0).map(([y]) => y));
    const lastYear = Math.max(w.firstYear, ...yearsWithMonths);
    for (let year = Math.max(fromYear, w.firstYear); year <= Math.min(toYear, lastYear); year++) {
      for (const p of w.parts) {
        const b = p.basisCents as bigint;
        const rounded = (c: Frac) => roundCents({ n: b * c.n, d: c.d });
        const now = rounded(purchaseCumulative(p, year));
        tally(year, 0n, b - now);
        const end = p.lastDay === null ? lastYear : Math.min(lastYear, yearOfDate(p.lastDay));
        if (!p.hasTenure || year > end) continue;
        const amount = now - rounded(purchaseCumulative(p, year - 1));
        const y = p.years.get(year);
        tally(year, amount, 0n);
        entries.push({
          year,
          componentId: w.componentId,
          partKey: ownerKey(p.ownerPartyId),
          months: y?.months ?? 0,
          fraction: y === undefined || y.months === 0 ? null : show(y.fraction),
          amount,
          cumulative: now,
          residualValue: b - now,
        });
      }
    }
  }
  for (const w of itemWorks) {
    if (!w.computable || w.startMonth === null) continue;
    const componentFirst = yearOfMonth(w.startMonth);
    const lastOf = (p: ItemPart) => {
      const reading = p.stopFrom !== null ? p.perItem : w.selected === 'POOLED_BASIS' ? p.pooled : p.perItem;
      return Math.max(yearOfMonth(p.firstMonth), reading.lastMonth === null ? yearOfMonth(p.firstMonth) : yearOfMonth(reading.lastMonth));
    };
    const componentLast = Math.max(componentFirst, ...w.parts.map(lastOf));
    for (const p of w.parts) {
      if (p.rate === null || p.partReasons.length > 0) continue;
      const reading = p.stopFrom !== null ? p.perItem : w.selected === 'POOLED_BASIS' ? p.pooled : p.perItem;
      const cumulative = (year: number) => {
        let total = ZERO;
        for (const [m, amount] of reading.monthly) if (yearOfMonth(m) <= year) total = add(total, amount);
        return roundCents(total);
      };
      const first = yearOfMonth(p.firstMonth);
      const last = lastOf(p);
      const end = p.lastDay === null ? last : Math.min(last, yearOfDate(p.lastDay));
      for (let year = Math.max(fromYear, componentFirst); year <= Math.min(toYear, componentLast); year++) {
        const now = cumulative(year);
        tally(year, 0n, p.basisCents - now);
        if (year < first || year > end) continue;
        const amount = now - cumulative(year - 1);
        const counted = reading.counted.get(year);
        tally(year, amount, 0n);
        entries.push({
          year,
          componentId: w.componentId,
          partKey: ownerKey(p.participant),
          months: counted?.months ?? 0,
          fraction: counted === undefined ? null : show(counted.fraction),
          amount,
          cumulative: now,
          residualValue: p.basisCents - now,
        });
      }
    }
  }
  entries.sort((a, b) => a.year - b.year || byText(a.componentId, b.componentId) || byText(a.partKey, b.partKey));
  return { entries, totals };
}

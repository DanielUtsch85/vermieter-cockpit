import type { BusinessDate, RuleRegistry, RuleVersion } from '../../shared/index.js';
import type { DepreciationAsset, ShorterUsefulLife } from './asset.js';
import { NOT_OWNED_PART } from './capitalized-item.js';
import { ZERO, byText, frac, monthOf, yearOfDate, type Frac } from './exact.js';
import { bandRate, usefulLifeRate, type ItemContext, type ItemPart, type ItemWork, type PartRate, type Reading } from './item-part.js';
import { walkPools } from './item-pools.js';
import { buildingRuleOn } from './rate.js';
import { accumulateMonths } from './purchase-tenure.js';
import { nominalMonths, type Part, type Work } from './purchase-work.js';
import { AFA_BUILDING_LINEAR, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import { RANGE_MAX_YEAR } from './schedule-model.js';
import { entriesOf } from './version-inputs.js';
import type { VersionComponent, VersionEntry, VersionInputs, VersionPart } from './version-model.js';

/**
 * Stage 2 from stored inputs (api-design.md §60 "Reproducible"): a recorded version's components and owner parts,
 * read back from their rows, rebuilt as the derivation's components under work and run through the very same arithmetic
 * (`nominalMonths`, `accumulateMonths`, `walkPools`, `entriesOf`), under the rule versions the registry has. No
 * snapshot, no Ownership, no Acquisition is read: only the stored inputs.
 */

const parseFrac = (text: string): Frac => {
  const [n, d] = text.split('/') as [string, string];
  return frac(BigInt(n), BigInt(d));
};

/** The stored still-held fraction of a month: the last row at or before it (the first row's before the first). */
function fractionAtOf(rows: VersionPart['fractions']): ((m: number) => Frac) | null {
  if (rows.length === 0) return null;
  const steps = rows.map((r) => ({ m: monthOf(`${r.month}-01` as BusinessDate), f: parseFrac(r.fraction) }));
  return (m: number) => {
    let value = steps[0]?.f ?? ZERO;
    for (const s of steps) if (s.m <= m) value = s.f;
    return value;
  };
}

const emptyReading = (): Reading => ({ monthly: new Map(), counted: new Map(), lastMonth: null, exhaustedMonth: null });

/** The stored inputs as the derivation's components under work, their months and pools walked. */
export function rebuildWorks(inputs: VersionInputs, registry: RuleRegistry): { readonly works: Work[]; readonly itemWorks: ItemWork[] } {
  const facts = inputs.asset;
  const asset = {
    assetType: facts.assetType,
    buildingCompletionYear: facts.buildingCompletionYear,
    usefulLifeYears: facts.usefulLifeYears,
    acquiredOn: facts.acquiredOn,
  } as unknown as DepreciationAsset;
  const versions = registry.versions(AFA_BUILDING_LINEAR) as readonly RuleVersion<BuildingLinearParameters>[];
  const supportedFrom = versions[0]?.effectiveFrom ?? null;
  const supportedYear = supportedFrom === null ? RANGE_MAX_YEAR + 1 : yearOfDate(supportedFrom);
  const partsByPool = new Map<string, { w: Work; p: Part }[]>();

  const works: Work[] = [];
  for (const c of inputs.components.filter((x) => x.kind === 'ACQUISITION' && x.computable)) {
    const work = purchaseWork(c, registry, facts.buildingCompletionYear, supportedYear);
    works.push(work);
    c.parts.forEach((stored, i) => {
      const p = work.parts[i] as Part;
      if (stored.poolKey !== null) partsByPool.set(stored.poolKey, [...(partsByPool.get(stored.poolKey) ?? []), { w: work, p }]);
    });
  }

  const ctx: ItemContext = { registry, asset, assetReasons: [], works, ownerships: [], acquisitions: [] };
  const separate = facts.assetType === 'SEPARATE_ASSET';
  const itemWorks: ItemWork[] = inputs.components
    .filter((x) => x.kind === 'CAPITALIZED_ITEM' && x.computable)
    .map((c) => itemWork(c, ctx, separate, partsByPool));
  walkPools(ctx, itemWorks);
  return { works, itemWorks };
}

function purchaseWork(c: VersionComponent, registry: RuleRegistry, completionYear: number | null, supportedYear: number): Work {
  const start = c.start.date as BusinessDate;
  const firstMonth = monthOf(`${c.start.month as string}-01` as BusinessDate);
  const entry =
    c.rate.kind === 'SHORTER_USEFUL_LIFE' && c.rate.usefulLifeYears !== null
      ? ({ acquisitionId: c.acquisition?.acquisitionId ?? '', usefulLifeYears: c.rate.usefulLifeYears, reviewState: 'CONFIRMED' } as ShorterUsefulLife)
      : undefined;
  const nominal =
    completionYear === null
      ? { monthly: new Map<number, Frac>(), rates: new Map(), yearsWithoutRule: [], lastMonth: null }
      : nominalMonths(registry, { firstMonth, startYear: yearOfDate(start), completionYear, entry, supportedYear });
  const parts: Part[] = c.parts.map((stored) => {
    const fractionAt = fractionAtOf(stored.fractions);
    const part: Part = {
      ownerPartyId: stored.ownerPartyId as string,
      ownershipId: stored.ownershipIds[0] ?? '',
      share: parseFrac(stored.share),
      shareBefore: ZERO,
      acquired: parseFrac(stored.weight),
      weight: parseFrac(stored.weight),
      basisCents: stored.basis,
      tenureEnd: stored.lastDay,
      hasTenure: fractionAt !== null,
      lastDay: stored.lastDay,
      lastDaySource: stored.lastDaySource,
      changes: [],
      missingFrom: null,
      years: new Map(),
      disposals: new Map(),
      fractionAt,
    };
    if (fractionAt !== null) accumulateMonths({ firstMonth, lastMonth: nominal.lastMonth, monthly: nominal.monthly }, part, fractionAt);
    return part;
  });
  return {
    acquisition: { id: c.acquisition?.acquisitionId ?? '' } as Work['acquisition'],
    componentId: c.componentId,
    start,
    ownedFrom: start,
    firstMonth,
    firstYear: Math.floor(firstMonth / 12),
    cost: {} as Work['cost'],
    reasons: [],
    flags: [],
    entry,
    // A recorded component is computable, so its method entry was a confirmed STANDARD one (§59C); the arithmetic does not read it.
    method: null,
    parts,
    computable: nominal.lastMonth !== null,
    monthly: nominal.monthly,
    lastMonth: nominal.lastMonth,
    rates: nominal.rates,
  };
}

function itemWork(c: VersionComponent, ctx: ItemContext, separate: boolean, pools: Map<string, { w: Work; p: Part }[]>): ItemWork {
  const { registry, asset } = ctx;
  const itemDate = c.item?.itemDate ?? (c.start.date as BusinessDate);
  const versions = registry.versions(AFA_BUILDING_LINEAR) as readonly RuleVersion<BuildingLinearParameters>[];
  const rule = buildingRuleOn(registry, yearOfDate(itemDate)) ?? versions[versions.length - 1];
  const rateOf = (p: VersionPart): PartRate | null => {
    switch (p.rateKind) {
      case 'USEFUL_LIFE':
        return usefulLifeRate(registry, asset);
      case 'SHORTER_USEFUL_LIFE': {
        const years = BigInt(p.usefulLifeYears ?? 0);
        return {
          kind: 'SHORTER_USEFUL_LIFE',
          usefulLifeYears: p.usefulLifeYears,
          annualOf: (y) => (buildingRuleOn(registry, y) === undefined || years < 1n ? undefined : frac(1n, years)),
        };
      }
      case 'BAND':
        return bandRate(registry, asset);
      default:
        return null;
    }
  };
  const parts: ItemPart[] = c.parts.map((stored) => {
    const fractionAt = fractionAtOf(stored.fractions) ?? (() => ZERO);
    const purchases = stored.poolKey === null ? [] : [...(pools.get(stored.poolKey) ?? [])];
    purchases.sort((x, y) => byText(x.w.ownedFrom, y.w.ownedFrom) || byText(x.w.componentId, y.w.componentId));
    return {
      participant: stored.ownerPartyId ?? NOT_OWNED_PART,
      ownershipIds: stored.ownershipIds,
      share: parseFrac(stored.share),
      basisCents: stored.basis,
      firstMonth: monthOf(`${stored.firstMonth}-01` as BusinessDate),
      tenureFrom: stored.tenureFrom,
      lastDay: stored.lastDay,
      lastDaySource: stored.lastDaySource,
      missingFrom: null,
      disposals: new Map(),
      changes: [],
      fractionAt,
      rate: rateOf(stored),
      partReasons: [],
      stopFrom: null,
      poolKey: stored.poolKey ?? `${c.componentId}|${stored.partKey}`,
      purchases,
      pooled: emptyReading(),
      perItem: emptyReading(),
      endToVerify: null,
    };
  });
  return {
    item: null,
    ref: {
      sourceType: (c.item?.sourceType ?? 'TRANSACTION_SPLIT') as ItemWork['ref']['sourceType'],
      sourceId: c.item?.sourceId ?? '',
      sourcePosition: c.item?.sourcePosition ?? null,
    },
    componentId: c.componentId,
    separate,
    startDate: c.start.date,
    startMonth: c.start.month === null ? null : monthOf(`${c.start.month}-01` as BusinessDate),
    method: c.start.method as ItemWork['method'],
    reasons: [],
    flags: [],
    parts,
    selected: separate ? 'PER_ITEM_SERIES' : (rule?.parameters.subsequentCostEnd.method ?? 'POOLED_BASIS'),
    parameters: { disposalVerified: true, rateVerified: () => true },
    computable: true,
  };
}

/** `computeSchedule(storedInputs, registry)` of §60, restricted to the entries: what a version's check recomputes. */
export function computeVersionEntries(inputs: VersionInputs, registry: RuleRegistry, fromYear: number, throughYear: number): VersionEntry[] {
  const { works, itemWorks } = rebuildWorks(inputs, registry);
  return entriesOf(works, itemWorks, fromYear, throughYear).entries;
}

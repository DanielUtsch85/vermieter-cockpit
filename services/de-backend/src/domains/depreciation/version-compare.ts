import type { BusinessDate, RuleRegistry } from '../../shared/index.js';
import { canonicalJson, ruleVersionHash, type Fingerprinter } from './fingerprint.js';
import { SCHEDULE_CALCULATION_VERSION, deriveSchedule } from './schedule.js';
import type { DepreciationSchedule, ScheduleRead } from './schedule-model.js';
import { computeVersionEntries } from './version-compute.js';
import { inputFingerprint, outputFingerprint, sameInputs, sameRules, truncateInputs, countedComponent } from './version-fingerprint.js';
import { entriesOf, resolveScheduleInputs } from './version-inputs.js';
import type { ScheduleVersion, VersionEntry, VersionInputs } from './version-model.js';

/**
 * The comparison of a year with the asset's `CURRENT` version and the reproduction of a version (api-design.md §60
 * "Changed since recorded", "Reproducible"): `NOT_RECORDED`, `UNCHANGED` or `CHANGED_SINCE_RECORDED` with its causes,
 * the owners' and the components' figures; `RECORDED_VERSION_NOT_REPRODUCIBLE` with its causes and years.
 */

export type RecordingState = 'NOT_RECORDED' | 'UNCHANGED' | 'CHANGED_SINCE_RECORDED';

/** Today's derivation of the asset at the property level (§60: the asset's fingerprint at both levels). */
export interface LiveSchedule {
  readonly schedule: DepreciationSchedule;
  readonly inputs: VersionInputs;
  readonly entries: readonly VersionEntry[];
  readonly totals: ReadonlyMap<number, { readonly amount: bigint; readonly residualValue: bigint }>;
}

/** Derives the asset's schedule through `horizon` at the property level, its inputs (stage 1) and its entries. */
export function liveSchedule(read: ScheduleRead, registry: RuleRegistry, fingerprinter: Fingerprinter, today: BusinessDate, horizon: number): LiveSchedule {
  const base = { asset: read.asset, acquisitions: read.acquisitions, ownerships: read.ownerships, capitalizedItems: read.capitalizedItems, links: read.links };
  const schedule = deriveSchedule({ ...base, today, to: horizon, ownerPartyId: null }, registry);
  const { inputs, works } = resolveScheduleInputs(base, registry, fingerprinter, Math.max(horizon, schedule.range.to));
  const { entries, totals } = entriesOf(works.works, works.itemWorks, schedule.range.from, schedule.range.to);
  return { schedule, inputs, entries, totals };
}

export const activeIn = (live: LiveSchedule, year: number) => live.schedule.components.some((c) => c.years.some((y) => y.year === year));
export const availableIn = (live: LiveSchedule, year: number) => live.schedule.years.find((y) => y.year === year)?.status === 'AVAILABLE';
const ofYear = (entries: readonly VersionEntry[], year: number) => entries.filter((e) => e.year === year);
const sumOf = (entries: readonly VersionEntry[]) => entries.reduce((s, e) => s + e.amount, 0n);

export interface YearComparison {
  readonly year: number;
  readonly state: RecordingState | null;
  readonly inputFingerprint: string;
  readonly recorded: bigint | null;
  readonly derived: bigint | null;
  readonly amountChanged: boolean;
  readonly causes: readonly ('INPUTS' | 'RULE_VERSION' | 'CALCULATION')[];
  readonly owners: readonly {
    readonly partKey: string;
    readonly ownerPartyId: string | null;
    readonly recorded: bigint | null;
    readonly derived: bigint | null;
  }[];
  readonly components: readonly { readonly componentId: string; readonly change: string; readonly recorded: bigint | null; readonly derived: bigint | null }[];
}

/** The comparison of `year` (§60): with `ownerPartyId`, `CHANGED_SINCE_RECORDED` only when the owner's own parts differ. */
export function compareYear(
  version: ScheduleVersion | null,
  live: LiveSchedule,
  year: number,
  fingerprinter: Fingerprinter,
  ownerPartyId: string | null = null,
): YearComparison {
  const fingerprint = inputFingerprint(live.inputs, year, fingerprinter);
  const base = { year, inputFingerprint: fingerprint, recorded: null, derived: null, amountChanged: false, causes: [], owners: [], components: [] };
  if (!activeIn(live, year)) return { ...base, state: null };
  const stored = version?.years.find((y) => y.year === year);
  if (version === null || stored === undefined) return { ...base, state: 'NOT_RECORDED' };
  const available = availableIn(live, year);
  const derivedEntries = ofYear(live.entries, year);
  const recordedEntries = ofYear(version.entries, year);
  const outputNow = available ? outputFingerprint(derivedEntries, fingerprinter) : null;
  if (stored.inputFingerprint === fingerprint && stored.outputFingerprint === outputNow) return { ...base, state: 'UNCHANGED' };

  const causes: YearComparison['causes'][number][] = [];
  if (!sameInputs(version.inputs, live.inputs, year)) causes.push('INPUTS');
  if (!sameRules(version.inputs, live.inputs, year)) causes.push('RULE_VERSION');
  if (version.calculationVersion !== live.inputs.calculationVersion || (causes.length === 0 && stored.outputFingerprint !== outputNow))
    causes.push('CALCULATION');
  const derived = available ? (live.totals.get(year)?.amount ?? sumOf(derivedEntries)) : null;
  const keys = [...new Set([...recordedEntries, ...derivedEntries].map((e) => e.partKey))].sort();
  const owners = keys.map((partKey) => ({
    partKey,
    ownerPartyId: partKey.startsWith('OWNER:') ? partKey.slice(6) : null,
    recorded: sumOf(recordedEntries.filter((e) => e.partKey === partKey)),
    derived: available ? sumOf(derivedEntries.filter((e) => e.partKey === partKey)) : null,
  }));
  const storedComponents = new Map(truncateInputs(version.inputs, year).components.map((c) => [c.componentId, c]));
  const liveComponents = new Map(truncateInputs(live.inputs, year).components.map((c) => [c.componentId, c]));
  const components = [...new Set([...storedComponents.keys(), ...liveComponents.keys()])].sort().flatMap((componentId) => {
    const s = storedComponents.get(componentId);
    const l = liveComponents.get(componentId);
    const recorded = s === undefined ? null : sumOf(recordedEntries.filter((e) => e.componentId === componentId));
    const now = l === undefined || !available ? null : sumOf(derivedEntries.filter((e) => e.componentId === componentId));
    const change =
      s === undefined
        ? 'ADDED'
        : l === undefined
          ? 'REMOVED'
          : canonicalJson(countedComponent(s)) !== canonicalJson(countedComponent(l))
            ? 'INPUTS_CHANGED'
            : recorded !== now
              ? 'AMOUNT_CHANGED'
              : null;
    return change === null ? [] : [{ componentId, change, recorded, derived: now }];
  });
  const changed: YearComparison = {
    ...base,
    state: 'CHANGED_SINCE_RECORDED',
    recorded: stored.amount,
    derived,
    amountChanged: derived !== stored.amount,
    causes,
    owners,
    components,
  };
  if (ownerPartyId === null) return changed;
  // The owner level: changed only when the owner's own entries or a component the owner has a part in differ.
  const key = `OWNER:${ownerPartyId}`;
  const own = owners.find((o) => o.partKey === key);
  const ownComponent = components.some((c) =>
    [storedComponents.get(c.componentId), liveComponents.get(c.componentId)].some((x) => x?.parts.some((p) => p.partKey === key)),
  );
  const ruleOrCalculation = causes.includes('RULE_VERSION') || causes.includes('CALCULATION');
  if (!ruleOrCalculation && !ownComponent && (own === undefined || own.recorded === own.derived)) return { ...base, state: 'UNCHANGED' };
  return {
    ...changed,
    recorded: own?.recorded ?? 0n,
    derived: own === undefined ? (available ? 0n : null) : own.derived,
    amountChanged: own === undefined ? false : own.recorded !== own.derived,
    owners: own === undefined ? [] : [own],
  };
}

export interface Reproduction {
  readonly reproducible: boolean;
  readonly causes: readonly ('RULE_HASH_CHANGED' | 'CALCULATION_VERSION_CHANGED' | 'ENTRIES_DIFFER')[];
  readonly years: readonly number[];
}

/** `computeSchedule(storedInputs, registry)` must give the stored entries exactly, under the same rule hashes (§60). */
export function reproduce(version: ScheduleVersion, registry: RuleRegistry, fingerprinter: Fingerprinter): Reproduction {
  const causes: Reproduction['causes'][number][] = [];
  const all = Array.from({ length: version.throughYear - version.fromYear + 1 }, (_, i) => version.fromYear + i);
  const hashChanged = version.inputs.rules.some((r) => {
    const rule = registry.find({ ruleCode: r.ruleCode, version: r.version });
    return rule === undefined || ruleVersionHash(rule, fingerprinter) !== r.ruleVersionHash;
  });
  if (hashChanged) causes.push('RULE_HASH_CHANGED');
  if (version.calculationVersion !== SCHEDULE_CALCULATION_VERSION)
    return { reproducible: false, causes: [...causes, 'CALCULATION_VERSION_CHANGED'], years: all };
  const recomputed = computeVersionEntries(version.inputs, registry, version.fromYear, version.throughYear);
  const view = (entries: readonly VersionEntry[], year: number) => canonicalJson(ofYear(entries, year).map((e) => ({ ...e, year: e.year })));
  const differing = all.filter((year) => view(recomputed, year) !== view(version.entries, year));
  if (differing.length > 0) causes.push('ENTRIES_DIFFER');
  if (causes.length === 0) return { reproducible: true, causes: [], years: [] };
  return { reproducible: false, causes, years: hashChanged ? all : differing };
}

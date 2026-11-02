import type { BusinessDate, RuleRegistry } from '../../shared/index.js';
import { byText } from './exact.js';
import type { Flag, ItemComponent, ScheduleComponent, ScheduleYear } from './schedule-model.js';

/**
 * Open and informative codes, the merged flags of a year, the review and the rule versions of the schedule
 * (api-design.md §59A "A year's flags", P7-D8). Moved out of `schedule.ts` unchanged (issue #191).
 */

/** Open: a person must act (P7-D8); informative: nothing to do. Everything not listed here is open. */
export const INFORMATIVE_CODES: readonly string[] = [
  'SHORTER_USEFUL_LIFE',
  'ACQUISITION_COST_UNPAID',
  'OWNER_SHARE_CHANGED',
  // §59B
  'ANSCHAFFUNGSNAHE_CAPITALIZED',
  'CAPITALIZED_REFUND',
  'WITHDRAWAL_DATE_ASSUMED',
  'GWG_THRESHOLD_MAY_APPLY',
];
export const isOpen = (code: string) => !INFORMATIVE_CODES.includes(code);

/**
 * §59F (the owner's decision 239-7, 2026-11-02): a level by state, as §58C's `ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN` and
 * §59E's `CONSTRUCTION_PERIOD_TREATMENT_MIXED`. `CAPITALIZED_YEAR_DIFFERS` is informative where the item's start comes
 * from its performance (`dateSource` `PERFORMANCE_UNTIL`), open otherwise. Every other code keeps its level by code.
 */
const LEVEL_BY_DETAILS: Readonly<Record<string, (details: Readonly<Record<string, unknown>>) => boolean>> = {
  CAPITALIZED_YEAR_DIFFERS: (details) => details['dateSource'] !== 'PERFORMANCE_UNTIL',
};

/** Whether a flag as raised (its details intact) is open; a merged flag (details replaced) is judged by its sources. */
export const flagIsOpen = (flag: Flag): boolean => LEVEL_BY_DETAILS[flag.code]?.(flag.details) ?? isOpen(flag.code);

export const sortFlags = (flags: readonly Flag[]) => [...flags].sort((a, b) => byText(a.code, b.code));

/** Each code once, the components named (§59A "A year's flags"). */
export function mergeFlags(entries: readonly { componentId: string; flag: Flag }[]): Flag[] {
  const byCode = new Map<string, Set<string>>();
  for (const { componentId, flag } of entries) byCode.set(flag.code, (byCode.get(flag.code) ?? new Set()).add(componentId));
  return [...byCode.entries()].map(([code, ids]) => ({ code, details: { componentIds: [...ids].sort(byText) } }));
}

/** Each code once, the owners named. */
export function mergeOwnerFlags(entries: readonly { ownerPartyId: string; flags: readonly Flag[] }[]): Flag[] {
  const byCode = new Map<string, Set<string>>();
  for (const { ownerPartyId, flags } of entries) for (const f of flags) byCode.set(f.code, (byCode.get(f.code) ?? new Set()).add(ownerPartyId));
  return sortFlags([...byCode.entries()].map(([code, ids]) => ({ code, details: { ownerPartyIds: [...ids].sort(byText) } })));
}

/** Over the range: each code once with the number of components (or owner-years, or owner and year) carrying it. */
export function reviewOf(
  assetReasons: readonly Flag[],
  scheduleFlags: readonly Flag[],
  components: readonly (ScheduleComponent | ItemComponent)[],
  years: readonly ScheduleYear[],
) {
  // Each code once per carrier, counted where any of its flags there is open, else as informative (§59F, 239-7).
  const counts = { open: new Map<string, number>(), info: new Map<string, number>() };
  const count = (flags: readonly Flag[]) => {
    for (const code of new Set(flags.map((f) => f.code))) {
      const map = flags.some((f) => f.code === code && flagIsOpen(f)) ? counts.open : counts.info;
      map.set(code, (map.get(code) ?? 0) + 1);
    }
  };
  for (const r of [...assetReasons, ...scheduleFlags]) count([r]);
  for (const c of components) {
    count([...c.reasons, ...c.flags]);
    for (const y of c.years) for (const o of y.owners) count([...(c.status === 'COMPUTABLE' ? o.reasons : []), ...o.flags]);
  }
  for (const y of years) for (const f of y.flags) if (f.code === 'OWNER_WITHOUT_ACQUISITION') count([f]);
  const list = (map: Map<string, number>) => [...map.entries()].sort(([a], [b]) => byText(a, b)).map(([code, n]) => ({ code, count: n }));
  return { open: list(counts.open), info: list(counts.info) };
}

export function ruleVersionsOf(components: readonly (ScheduleComponent | ItemComponent)[], registry: RuleRegistry, today: BusinessDate) {
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

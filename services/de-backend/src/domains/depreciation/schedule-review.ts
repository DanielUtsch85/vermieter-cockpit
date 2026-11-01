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
  'DATE_IS_BOOKING_DATE',
  'WITHDRAWAL_DATE_ASSUMED',
  'GWG_THRESHOLD_MAY_APPLY',
];
export const isOpen = (code: string) => !INFORMATIVE_CODES.includes(code);

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

import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { monthOfDate, perItem } from './schedule-items.test-support.js';
import { computeVersionEntries } from './version-compute.js';
import { reproduce } from './version-compare.js';
import { truncateInputs } from './version-fingerprint.js';
import { live, recordInMemory, scenarios } from './version.test-support.js';

/**
 * Reproducible (api-design.md §60): stage 2 run on the stored inputs alone (`computeVersionEntries`) gives the
 * derivation's entries exactly, for every scenario, registry and `throughYear`; the entries sum to the schedule's years;
 * `reproduce` names its three causes.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);

describe('the stored inputs recompute to the derivation’s entries (§60 "Reproducible")', () => {
  for (const [name, input] of Object.entries(scenarios())) {
    for (const [label, reg] of [
      ['the registry', registry],
      ['PER_ITEM_SERIES', perItem],
      ['MONTH_OF_DATE', monthOfDate],
    ] as const) {
      it(`${name} under ${label}: throughYears to 2080 (past the pools’ end), to the cent, and the year totals equal the schedule’s`, () => {
        const state = live(input, reg, 2080);
        expect(state.entries.length).toBeGreaterThan(10);
        for (const through of [state.schedule.range.from, state.schedule.range.from + 1, 2030, 2045, 2076, 2077, 2080]) {
          const stored = truncateInputs(state.inputs, through);
          const recomputed = computeVersionEntries(stored, reg, state.schedule.range.from, through);
          expect(recomputed).toEqual(state.entries.filter((e) => e.year <= through));
        }
        for (const y of state.schedule.years.filter((x) => x.status === 'AVAILABLE')) {
          const total = state.entries.filter((e) => e.year === y.year).reduce((s, e) => s + e.amount, 0n);
          expect([y.year, total]).toEqual([y.year, y.amount === null ? 0n : BigInt(y.amount.amount.replace('.', '').replace(/^(-?)0+(?=\d)/, '$1'))]);
        }
      });
    }
  }

  it('counter-check: a tampered owner entry with the same year total is ENTRIES_DIFFER (not the year totals only)', () => {
    const version = recordInMemory(scenarios()['ACC8, the purchase'] as never, registry, 2027);
    expect(reproduce(version, registry, { sha256Hex: (t) => t })).toEqual({ reproducible: true, causes: [], years: [] });
    const entries = version.entries.map((e, i) =>
      e.year === 2027 && i % 2 === 0 ? { ...e, amount: e.amount + 1n } : e.year === 2027 ? { ...e, amount: e.amount - 1n } : e,
    );
    expect(reproduce({ ...version, entries }, registry, { sha256Hex: (t) => t })).toEqual({ reproducible: false, causes: ['ENTRIES_DIFFER'], years: [2027] });
  });

  it('a raised calculation version is CALCULATION_VERSION_CHANGED, never recomputed as if current', () => {
    const version = recordInMemory(scenarios()['ACC8, the purchase'] as never, registry, 2027);
    expect(reproduce({ ...version, calculationVersion: 2 }, registry, { sha256Hex: (t) => t })).toMatchObject({
      reproducible: false,
      causes: ['CALCULATION_VERSION_CHANGED'],
      years: [2026, 2027],
    });
  });

  it('a test registry with another parameter under the same version is RULE_HASH_CHANGED', () => {
    const version = recordInMemory(scenarios()['ACC8, the purchase'] as never, registry, 2027);
    const changed = new RuleRegistry(
      DEPRECIATION_RULE_VERSIONS.map((v) => (v.ruleCode === 'DE_AFA_BUILDING_LINEAR' && v.version === 2 ? { ...v, title: `${v.title} (geändert)` } : v)),
    );
    expect(reproduce(version, changed, { sha256Hex: (t) => t })).toMatchObject({ reproducible: false, causes: ['RULE_HASH_CHANGED'] });
  });
});

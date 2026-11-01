import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { monthOfDate, perItem } from './schedule-items.test-support.js';
import { computeVersionEntries } from './version-compute.js';
import { truncateInputs } from './version-fingerprint.js';
import { RANDOM_TODAY, randomSchedule, seeded, type RandomIds } from './version-random.test-support.js';
import { live } from './version.test-support.js';

/**
 * VC-X-35 (api-design.md §60 "As implemented (VC-8-04)" 1 and 13): stage 2 on the stored inputs alone gives the
 * derivation's entries exactly, over seeded random schedules (`version-random.test-support.ts`: purchases, owners,
 * sales, capitalised items, refunds, a linked item, separate assets) instead of the six fixed scenarios of
 * `version-reproduce.test.ts`, under the three registries, each truncated at three `throughYear`s. No database: the
 * stored-row round trip of the same random schedules is `depreciation-schedule-version-roundtrip.test.ts`'s.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
const uuid = (n: number) => `0000dada-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IDS: RandomIds = {
  assetId: uuid(1),
  separateAssetId: uuid(2),
  propertyReferenceId: uuid(3),
  parties: [uuid(11), uuid(12), uuid(13), uuid(14), uuid(15)],
  acquisitions: [
    { id: uuid(21), allocationId: uuid(31) },
    { id: uuid(22), allocationId: uuid(32) },
  ],
  classifications: [uuid(41), uuid(42)],
};
/** About half a second a case (three derivations of up to 90 years), hence the explicit timeout. */
const CASES = 12;

describe('random schedules: the stored inputs recompute to the derivation’s entries (VC-X-35)', () => {
  it(`${CASES} seeded random schedules × three registries × three throughYears, to the cent`, { timeout: 30_000 }, () => {
    const random = seeded(35_2026);
    let compared = 0;
    for (let run = 0; run < CASES; run++) {
      const { input, throughYear, label } = randomSchedule(random, IDS, run);
      for (const [name, reg] of [
        ['the registry', registry],
        ['PER_ITEM_SERIES', perItem],
        ['MONTH_OF_DATE', monthOfDate],
      ] as const) {
        const state = live(input, reg, throughYear, RANDOM_TODAY);
        const from = state.schedule.range.from;
        for (const through of new Set([from, Math.floor((from + throughYear) / 2), throughYear])) {
          const where = `run ${run} under ${name} through ${through}: ${label}`;
          const complete = state.schedule.years.every((y) => y.year > through || y.status === 'AVAILABLE');
          if (!complete) continue;
          const recomputed = computeVersionEntries(truncateInputs(state.inputs, through), reg, from, through);
          expect(recomputed, where).toEqual(state.entries.filter((e) => e.year <= through));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(CASES * 3 * 2);
  });
});

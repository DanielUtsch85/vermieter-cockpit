import { describe, expect, it } from 'vitest';
import { DE_AFA_BUILDING_LINEAR_V2, ruleVersionHash } from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { sha256Fingerprinter } from './sha256-fingerprinter.js';

/**
 * The frozen rule versions (api-design.md §60 "Rule versions: frozen from VC-8-04 on", decided 2026-10-31, third set,
 * open question 11): the `ruleVersionHash` of each, read from the registry, pinned as literals. Any edit of a covered
 * field (`title`, `legalBasis`, `effectiveFrom`, `parameters`, `source`) turns this red; an `effectiveTo` set does not.
 *
 * Until the first productive enablement of `DEPRECIATION_RECORDING_ENABLED` (the binding freeze point), the AfA versions
 * may still take the tax advisor's answers in place: such a change updates these literals explicitly, in the same
 * commit. From the first productive enablement on, a change is a new version and these literals are never updated.
 */
const PINNED: readonly (readonly [string, number, string])[] = [
  ['DE_CATEGORY_DEFAULTS', 1, '4f4564da44620baf6861f3a17505f92a6add75456a9d5de35e086944a21584de'],
  // Updated in place by §60 open question 11 (before the first productive enablement; recording still disabled) for the
  // tax review of 01.11.2026, mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01
  // (docs/germany/pruefbericht-2026-11-01.md, "Nach Bestätigung auflösbare VERIFY-Punkte"): `verified.rates` of @1,
  // `end.disposal.verified`, the new `shareReduction`, and the sources. Before: @1 75dec496…3bc6, @2 6ccacf8e…6827,
  // movable @1 8a5d3a77…3ece (its `end` is the building rule's).
  ['DE_AFA_BUILDING_LINEAR', 1, '6c590e6c25686fb47bc25570f5b801437ba15271d3bb7dae8a1c10bb209c12ff'],
  ['DE_AFA_BUILDING_LINEAR', 2, 'f8b7119cb1324332d6e5556b823a82550b946c366f2d43c49ab9ad19a8501025'],
  ['DE_AFA_MOVABLE_LINEAR', 1, '85d929633060b63636187e42a65e5856bdc58c65f86bd1ae22284a8278b1f06a'],
];

describe('the frozen rule versions (§60)', () => {
  it.each(PINNED)('%s@%i keeps its pinned hash', (ruleCode, version, hash) => {
    const rule = TAX_RULES.find({ ruleCode, version });
    expect(rule).toBeDefined();
    expect(ruleVersionHash(rule as NonNullable<typeof rule>, sha256Fingerprinter)).toBe(hash);
  });

  it('counter-checks on a copy of the building rule: shorterThanYears, title or legalBasis change the hash; effectiveTo does not', () => {
    const v = DE_AFA_BUILDING_LINEAR_V2;
    const hash = (rule: typeof v) => ruleVersionHash(rule, sha256Fingerprinter);
    const bands = v.parameters.bands.map((b, i) =>
      i === 0 ? { ...b, shorterUsefulLife: { ...b.shorterUsefulLife, shorterThanYears: b.shorterUsefulLife.shorterThanYears + 1 } } : b,
    );
    expect(hash({ ...v, parameters: { ...v.parameters, bands } })).not.toBe(hash(v));
    expect(hash({ ...v, title: `${v.title} ` })).not.toBe(hash(v));
    expect(hash({ ...v, legalBasis: `${v.legalBasis} ` })).not.toBe(hash(v));
    expect(hash({ ...v, effectiveTo: '2040-01-01' as BusinessDate })).toBe(hash(v));
  });
});

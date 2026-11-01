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
  ['DE_AFA_BUILDING_LINEAR', 1, '75dec496fa1db545e40d91d6935f30c3d09f6b507967f47149f7aed8d2ac3bc6'],
  ['DE_AFA_BUILDING_LINEAR', 2, '6ccacf8e783f8bb2d83d8dc9fff65c216688772ed9b2aa0885b6e63345256827'],
  ['DE_AFA_MOVABLE_LINEAR', 1, '8a5d3a7790a0d8e08337800cd054bd3876edf6b58b72c881f6e66ee3f73b3ece'],
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

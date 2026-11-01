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
  // Again for @1 on 2026-11-01: `verified.shorterUsefulLifeThresholds` true (the owner decided that Frage 8 covers @1's
  // two bands of 50 and 40 years). Before: 6c590e6c…12ff.
  // Again for @1 and @2 for §59C (VC-X-37, decided by the owner on 2026-11-01; Prüfbericht 01.11.2026, Frage 2): the new
  // parameter `methodStatus` in both versions, the withdrawn DEPRECIATION_METHOD_UNKNOWN noted, and Frage 2 in both
  // sources. Recording is still disabled. Before: @1 a020ad6d…5f1f, @2 f8b7119c…1025.
  // Again for @1 and @2 for §59D (VC-X-42, decided by the owner on 2026-11-01; Prüfbericht 2026-11-01, Fragen 10 und 24,
  // mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01): the new parameter
  // `basis.costClassification` in both versions, and Frage 24 in both sources. Recording is still disabled.
  // Before: @1 0f63d02c…bb64, @2 4ff946eb…54c6.
  ['DE_AFA_BUILDING_LINEAR', 1, '260758f8b1bd16d85179b3e08faae6893b8060dbf66ce10fff9d7c7760c84bda'],
  ['DE_AFA_BUILDING_LINEAR', 2, '4b2b9c28909fe8c518e8f06ea29bfcf0363738c11abed63c385bff808bb38c3a'],
  ['DE_AFA_MOVABLE_LINEAR', 1, '85d929633060b63636187e42a65e5856bdc58c65f86bd1ae22284a8278b1f06a'],
  // A Phase-7 rule, pinned from §59D on (VC-X-42; §59D open question 3, decided by the owner on 2026-11-01): changed in
  // place by the parameter `costClassification` (Prüfbericht 2026-11-01, Fragen 10 und 24, mündlich bestätigt durch den
  // Steuerberater, laut Projektinhaber am 2026-11-01), with a change note in its `source`. Its freeze point is the
  // documented go-live of the first productive installation (the owner's version decision of 2026-11-01), not the
  // enablement of recording: until then a change updates this literal explicitly, in the same commit.
  ['DE_ANSCHAFFUNGSNAHE', 1, 'e8e55a5894d1eed98cd53e772c539d06a4c7ca1e7ca1c93200e2dd81fdc7c3ff'],
  // New with §59E (VC-X-36, decided by the owner on 2026-11-01; Prüfbericht 2026-11-01, Frage 23, mündlich bestätigt
  // durch den Steuerberater, laut Projektinhaber am 2026-11-01): a classification's `treatmentRule`, so pinned from its
  // first commit on; a change is `@2` (§59E "Frozen rules"). The AfA rules and DE_CATEGORY_DEFAULTS@1 are unchanged.
  ['DE_CONSTRUCTION_PERIOD_INTEREST', 1, '554fb1d188d9e4660e4628f4b35c9ed855f91cc312627e630e400af917b9809b'],
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
    // §59C: the method status's standard is a covered parameter too.
    const methodStatus = { ...v.parameters.methodStatus, confirmedReviewStates: ['ADVISOR_CONFIRMED'] };
    expect(hash({ ...v, parameters: { ...v.parameters, methodStatus } })).not.toBe(hash(v));
    // §59D: the cost classification policy is a covered parameter too.
    const basis = { ...v.parameters.basis, costClassification: { ...v.parameters.basis.costClassification, requiredFor: ['OTHER'] } };
    expect(hash({ ...v, parameters: { ...v.parameters, basis } })).not.toBe(hash(v));
    expect(hash({ ...v, effectiveTo: '2040-01-01' as BusinessDate })).toBe(hash(v));
  });
});

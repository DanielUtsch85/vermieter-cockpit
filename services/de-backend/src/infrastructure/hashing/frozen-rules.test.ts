import { describe, expect, it } from 'vitest';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2, ruleVersionHash } from '../../domains/depreciation/index.js';
import { DE_ANSCHAFFUNGSNAHE_V1, DE_CASH_TIMING_V1 } from '../../domains/taxation/index.js';
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
  // Again for @1 and @2 for §59G Part 1 (VC-X-41; Prüfbericht 2026-11-01, Fragen 8 und 9, mündlich bestätigt durch den
  // Steuerberater, laut Projektinhaber am 2026-11-01; the owner's decisions of 2026-11-02): `shorterUsefulLife` gains the
  // Stichtag, the cases and the late evidence's release, `subsequentCostRate` drops `shorterLifeVerified` for
  // `shorterLife`/`afterRemainingLife` NOT_COMPUTABLE. Recording is still disabled. Before: @1 260758f8…4bda, @2 4b2b9c28…8c3a.
  // Again for @1 and @2 for §59F (VC-X-38; Prüfbericht 2026-11-01, Frage 5, mündlich bestätigt durch den Steuerberater,
  // laut Projektinhaber am 2026-11-01; the owner's decisions of 2026-11-02): `subsequentCostStart` takes the completion of
  // the work (`date`, `performanceRequired`, `spansYearEnd`, `exemptTaxCategories`), `verified` true for the confirmed
  // rule and `notBeforeOwnerStart` as an open reading of its own. Recording is still disabled.
  // Before: @1 b9e8bfd9…d21f, @2 efe5ba03…cf9e.
  // Again for @1 and @2 for §59G (VC-X-41; Entscheidung des Projektinhabers, 2026-11-02, 238-3): only the entry's own
  // `evidence.documentReference` counts as the late evidence, so `shorterUsefulLife.lateEvidenceRelease.evidence` is
  // `ENTRY_DOCUMENT_REFERENCE` (was `true`, which also took the asset's `sourceReferences`). Recording is still disabled.
  // Before: @1 4e3c7f46…678c, @2 bbe0fecc…2d84 (the counter-check below recomputes both).
  ['DE_AFA_BUILDING_LINEAR', 1, 'e7cc8abb4b2fdcf033f050137e6c2647ddf15786ec2c5d6ad854b61867875fce'],
  ['DE_AFA_BUILDING_LINEAR', 2, 'b7cd96ab674b84f672887fcff7dc8db1be2ceebacfdbe4a8c830c75ce07f33d8'],
  ['DE_AFA_MOVABLE_LINEAR', 1, '85d929633060b63636187e42a65e5856bdc58c65f86bd1ae22284a8278b1f06a'],
  // A Phase-7 rule, pinned from §59D on (VC-X-42; §59D open question 3, decided by the owner on 2026-11-01): changed in
  // place by the parameter `costClassification` (Prüfbericht 2026-11-01, Fragen 10 und 24, mündlich bestätigt durch den
  // Steuerberater, laut Projektinhaber am 2026-11-01), with a change note in its `source`. Its freeze point is the
  // documented go-live of the first productive installation (the owner's version decision of 2026-11-01), not the
  // enablement of recording: until then a change updates this literal explicitly, in the same commit.
  // Again for §59F (VC-X-38; Prüfbericht 2026-11-01, Fragen 14 und 16, mündlich bestätigt durch den Steuerberater, laut
  // Projektinhaber am 2026-11-01; the owner's decisions of 2026-11-01 and 2026-11-02): the parameter `performance` and the
  // change note in its `source`. Before: e8e55a58…c3ff.
  // Again for VC-X-38 Part 2 (§59F; Entscheidung des Projektinhabers, 2026-11-02, 239-2): the parameter
  // `performance.partialTreatment` (the window part CAPITALIZED, the rest DEDUCTIBLE, the amounts from the evidenced
  // points) and the change note in its `source`. Recording is still disabled. Before: 6f14e4ac…1c57 (the counter-check
  // below recomputes it).
  ['DE_ANSCHAFFUNGSNAHE', 1, 'dadb1895baf30b42ea3dd5029e04a1888fc7dc96c1d7cab155efc397d7ad6587'],
  // New with §59E (VC-X-36, decided by the owner on 2026-11-01; Prüfbericht 2026-11-01, Frage 23, mündlich bestätigt
  // durch den Steuerberater, laut Projektinhaber am 2026-11-01): a classification's `treatmentRule`, so pinned from its
  // first commit on; a change is `@2` (§59E "Frozen rules"). The AfA rules and DE_CATEGORY_DEFAULTS@1 are unchanged.
  ['DE_CONSTRUCTION_PERIOD_INTEREST', 1, '554fb1d188d9e4660e4628f4b35c9ed855f91cc312627e630e400af917b9809b'],
  // A Phase-7 rule, pinned from §58F on (VC-X-39): changed in place by the parameter `dueDate.recordedSources` and a
  // change note in its `source` (Prüfbericht 2026-11-01, Frage 18, mündlich bestätigt durch den Steuerberater, laut
  // Projektinhaber am 2026-11-01; owner decisions 2026-11-01 and 2026-11-02: no 10-day shift without a recorded due
  // date, parameter and hash updated explicitly, no backfill). Before (never pinned): b7fa5cf1…87f8. Its freeze point is
  // the documented go-live of the first productive installation: until then a change updates this literal explicitly,
  // in the same commit; after it, a change is `@2`.
  ['DE_CASH_TIMING', 1, 'dab6ce4e53383d47c0505dee9988316075c9c25cc2bb28abfb2ff75b292241cf'],
];

/** The change note VC-X-38 Part 2 added to `DE_ANSCHAFFUNGSNAHE@1`'s `source`. */
const PART_2_NOTE = '; VC-X-38 Part 2 in place: performance.partialTreatment, Entscheidung des Projektinhabers 2026-11-02 (239-2), api-design §59F';

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
    // §59F: the start's performance rule and its open reading are covered parameters too.
    const start = { ...v.parameters.subsequentCostStart, notBeforeOwnerStart: { ...v.parameters.subsequentCostStart.notBeforeOwnerStart, verified: true } };
    expect(hash({ ...v, parameters: { ...v.parameters, subsequentCostStart: start } })).not.toBe(hash(v));
    const spans = { ...v.parameters.subsequentCostStart, exemptTaxCategories: ['LOAN_INTEREST'] };
    expect(hash({ ...v, parameters: { ...v.parameters, subsequentCostStart: spans } })).not.toBe(hash(v));
    expect(hash({ ...v, effectiveTo: '2040-01-01' as BusinessDate })).toBe(hash(v));
  });

  it('counter-check of 238-3 (§59G): the building rules with the late release as before (evidence true) had the former pinned hashes', () => {
    const before = (rule: typeof DE_AFA_BUILDING_LINEAR_V2) => {
      const shorterUsefulLife = rule.parameters.shorterUsefulLife;
      const lateEvidenceRelease = { ...shorterUsefulLife.lateEvidenceRelease, evidence: true };
      return ruleVersionHash(
        { ...rule, parameters: { ...rule.parameters, shorterUsefulLife: { ...shorterUsefulLife, lateEvidenceRelease } } } as unknown as typeof rule,
        sha256Fingerprinter,
      );
    };
    expect(before(DE_AFA_BUILDING_LINEAR_V1)).toBe('4e3c7f46f55783d5846f66fcb37096d91416d6da5362d28734d4166c3488678c');
    expect(before(DE_AFA_BUILDING_LINEAR_V2)).toBe('bbe0feccf97fdbf76c0125cc33cb0c371202c9f2f5f2f27d5d11bb8033942d84');
    const v = DE_AFA_BUILDING_LINEAR_V2;
    const notRequired = {
      ...v.parameters.shorterUsefulLife,
      lateEvidenceRelease: { ...v.parameters.shorterUsefulLife.lateEvidenceRelease, evidence: 'NOT_REQUIRED' as const },
    };
    expect(ruleVersionHash({ ...v, parameters: { ...v.parameters, shorterUsefulLife: notRequired } }, sha256Fingerprinter)).not.toBe(
      ruleVersionHash(v, sha256Fingerprinter),
    );
  });

  it('counter-checks on a copy of the cash rule (§58F): recordedSources with PERIOD_START changes the hash; effectiveTo does not', () => {
    const v = DE_CASH_TIMING_V1;
    const hash = (rule: typeof v) => ruleVersionHash(rule, sha256Fingerprinter);
    const dueDate = { ...v.parameters.dueDate, recordedSources: [...v.parameters.dueDate.recordedSources, 'PERIOD_START'] };
    expect(hash({ ...v, parameters: { ...v.parameters, dueDate } })).not.toBe(hash(v));
    // The rule as it was before VC-X-39 (no dueDate, the source without the change note): the hash never pinned.
    const before = {
      ...v,
      parameters: { windowDays: v.parameters.windowDays, recurringCategories: v.parameters.recurringCategories } as typeof v.parameters,
      source: 'docs/germany/taxation.md §3 (v0.2); phase-7-plan P7-D3 (review on #156); api-design §58A (review on #159); verification-checklist A4',
    };
    expect(hash(before)).toBe('b7fa5cf1648fb12179487933fd305f895983853021362877ff6c4c38a74487f8');
    expect(hash({ ...v, effectiveTo: '2040-01-01' as BusinessDate })).toBe(hash(v));
  });

  it('counter-checks on a copy of the check rule (§59F): the search range days and the outer bound change the hash; the version before VC-X-38 had the pinned e8e55a58…c3ff', () => {
    const v = DE_ANSCHAFFUNGSNAHE_V1;
    const hash = (rule: typeof v) => ruleVersionHash(rule, sha256Fingerprinter);
    for (const performance of [
      { ...v.parameters.performance, undatedReadAfterWindowDays: 366 },
      { ...v.parameters.performance, plausibleYearsFromSourceDate: 4 },
    ]) {
      expect(hash({ ...v, parameters: { ...v.parameters, performance } })).not.toBe(hash(v));
    }
    const { performance: _withdrawn, ...withoutPerformance } = v.parameters;
    const before = {
      ...v,
      parameters: withoutPerformance as typeof v.parameters,
      source: v.source.replace(
        '; VC-X-38 in place: Prüfbericht 2026-11-01, Fragen 14, 16 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01); owner decision 2026-11-01, api-design §59F' +
          PART_2_NOTE,
        '',
      ),
    };
    expect(hash(before)).toBe('e8e55a5894d1eed98cd53e772c539d06a4c7ca1e7ca1c93200e2dd81fdc7c3ff');
  });

  it('counter-checks on a copy of the check rule (VC-X-38 Part 2): the partial treatment changes the hash; the version before it had the pinned 6f14e4ac…1c57', () => {
    const v = DE_ANSCHAFFUNGSNAHE_V1;
    const hash = (rule: typeof v) => ruleVersionHash(rule, sha256Fingerprinter);
    const partial = v.parameters.performance.partialTreatment;
    expect(partial).toBeDefined();
    const withPartial = (p: object | undefined) => ({
      ...v,
      parameters: { ...v.parameters, performance: { ...v.parameters.performance, partialTreatment: p } },
    });
    expect(hash(withPartial({ ...partial, grossWindowPart: 'PRO_RATA_HALF_EVEN' }) as typeof v)).not.toBe(hash(v));
    const { partialTreatment: _withdrawn, ...performanceBefore } = v.parameters.performance;
    const before = { ...v, parameters: { ...v.parameters, performance: performanceBefore }, source: v.source.replace(PART_2_NOTE, '') };
    expect(before.source).not.toBe(v.source);
    expect(hash(before)).toBe('6f14e4ac6a9639f1cabb134036519af8f64bbd73ae430c0b1e7f44cfc5111c57');
  });
});

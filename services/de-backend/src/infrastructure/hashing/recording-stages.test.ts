import { describe, expect, it } from 'vitest';
import { DE_RECORDING_STAGES_V1, RECORDING_STAGE_RULES, ruleVersionHash } from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { sha256Fingerprinter } from './sha256-fingerprinter.js';

/**
 * `DE_RECORDING_STAGES@1` (VC-X-45, api-design.md §60A, A3): data in a registry of its own, pinned here by its hash so
 * that a change of the mapping is a new version (`@2`), never an edit in place. It is not in `TAX_RULES`, so it is not
 * one of the frozen calculation rules (`frozen-rules.test.ts`), no component's year names it, and no input fingerprint
 * or recorded version covers it.
 */
const PINNED = '24fafc1ed3fcd06f42d7bc3bf87306e20eb282597947425b44ac4347b07be247';

describe('DE_RECORDING_STAGES@1 (§60A)', () => {
  it('keeps its pinned hash', () => {
    expect(ruleVersionHash(DE_RECORDING_STAGES_V1, sha256Fingerprinter)).toBe(PINNED);
  });

  it('lives in its own registry, never in TAX_RULES (not frozen, not fingerprinted)', () => {
    expect(RECORDING_STAGE_RULES.find({ ruleCode: 'DE_RECORDING_STAGES', version: 1 })).toBe(DE_RECORDING_STAGES_V1);
    expect(TAX_RULES.codes()).not.toContain('DE_RECORDING_STAGES');
  });

  it('counter-check: a changed stage of one criterion changes the hash', () => {
    const criteria = DE_RECORDING_STAGES_V1.parameters.criteria.map((c) => (c.code === 'CAPITALIZED_ITEM' ? { ...c, stage: 3 as const } : c));
    expect(ruleVersionHash({ ...DE_RECORDING_STAGES_V1, parameters: { criteria } }, sha256Fingerprinter)).not.toBe(PINNED);
  });
});

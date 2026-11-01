// The first import, before anything else: Taxation loads first (api-design §59, no TDZ between the domains).
import { TAXATION_RULE_VERSIONS } from '../taxation/index.js';
import { describe, expect, it } from 'vitest';
import { TAX_RULES } from './index.js';

/** Load order (§59): this file loads Taxation before Depreciation and `tax-rules/`, in its own module graph. */
describe('load order: Taxation first', () => {
  it('TAX_RULES holds DE_AFA_BUILDING_LINEAR@1 and @2, DE_AFA_MOVABLE_LINEAR@1 and eight codes (DE_CONSTRUCTION_PERIOD_INTEREST since VC-X-36)', () => {
    expect(TAXATION_RULE_VERSIONS).toHaveLength(6);
    expect(TAX_RULES.find({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 1 })).toBeDefined();
    expect(TAX_RULES.find({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 })).toBeDefined();
    expect(TAX_RULES.find({ ruleCode: 'DE_AFA_MOVABLE_LINEAR', version: 1 })).toBeDefined();
    expect(TAX_RULES.codes()).toHaveLength(8);
  });
});

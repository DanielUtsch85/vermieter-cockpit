// The first import, before anything else: Depreciation loads first (api-design §59, no TDZ between the domains).
import { DEPRECIATION_RULE_VERSIONS } from '../depreciation/index.js';
import { describe, expect, it, vi } from 'vitest';
import { TAX_RULES } from './index.js';

/**
 * Load order (§59): each test file is a fresh module graph (vitest `isolate`), so this file loads Depreciation before
 * Taxation and `tax-rules/`. A cycle between the domains would leave a binding uninitialised here.
 */
describe('load order: Depreciation first', () => {
  // Two versions since VC-8-02 (§59A "The rule versions"): @1 for 2006–2022, today's @2.
  it('TAX_RULES holds DE_AFA_BUILDING_LINEAR@1 and @2 and six codes', () => {
    expect(DEPRECIATION_RULE_VERSIONS).toHaveLength(2);
    expect(TAX_RULES.find({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 1 })).toBeDefined();
    expect(TAX_RULES.find({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 })).toBeDefined();
    expect(TAX_RULES.codes()).toHaveLength(6);
  });

  it('after vi.resetModules(): depreciation/index.js, then tax-rules/index.js, imported dynamically', async () => {
    vi.resetModules();
    const depreciation = await import('../depreciation/index.js');
    const { TAX_RULES: fresh } = await import('./index.js');
    expect(depreciation.DEPRECIATION_RULE_VERSIONS).toHaveLength(2);
    expect(fresh).not.toBe(TAX_RULES);
    expect(fresh.find({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 1 })).toBeDefined();
    expect(fresh.find({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 })).toBeDefined();
    expect(fresh.codes()).toHaveLength(6);
  });
});

// The first import, before anything else: Depreciation loads first (api-design §59B "Load order").
import { DEPRECIATION_RULE_VERSIONS } from '../../domains/depreciation/index.js';
import { describe, it, vi } from 'vitest';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { toCapitalizedItem } from './capitalized-items.js';
import { assertLoaded } from './capitalized-items-load-order.test-support.js';

/**
 * Load order (§59B): each test file is a fresh module graph (vitest `isolate`). This one loads Depreciation's index
 * first, then the adapter where Depreciation and Taxation meet; a cycle between them would leave a binding
 * uninitialised here. The third case imports the adapter first, then both domain indexes dynamically.
 */
describe('load order: Depreciation, then the adapter', () => {
  it('both Depreciation rules, eight codes, the mapping of a CapitalizedSource', () => {
    assertLoaded(DEPRECIATION_RULE_VERSIONS, TAX_RULES, toCapitalizedItem);
  });

  it('after vi.resetModules(): the adapter first, then both domain indexes, imported dynamically', async () => {
    vi.resetModules();
    const adapter = await import('./capitalized-items.js');
    const depreciation = await import('../../domains/depreciation/index.js');
    await import('../../domains/taxation/index.js');
    const { TAX_RULES: fresh } = await import('../../domains/tax-rules/index.js');
    assertLoaded(depreciation.DEPRECIATION_RULE_VERSIONS, fresh, adapter.toCapitalizedItem);
  });
});

// The first import, before anything else: Taxation loads first (api-design §59B "Load order").
import { TAXATION_RULE_VERSIONS } from '../../domains/taxation/index.js';
import { describe, expect, it } from 'vitest';
import { DEPRECIATION_RULE_VERSIONS } from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { toCapitalizedItem } from './capitalized-items.js';
import { assertLoaded } from './capitalized-items-load-order.test-support.js';

/** Load order (§59B): this file loads Taxation's index first, then Depreciation's and the adapter, in its own module graph. */
describe('load order: Taxation, then the adapter', () => {
  it('both Depreciation rules, seven codes, the mapping of a CapitalizedSource', () => {
    expect(TAXATION_RULE_VERSIONS).toHaveLength(5);
    assertLoaded(DEPRECIATION_RULE_VERSIONS, TAX_RULES, toCapitalizedItem);
  });
});

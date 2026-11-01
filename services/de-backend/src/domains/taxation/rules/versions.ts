import type { RuleVersion } from '../../../shared/index.js';
import { DE_82B_DISTRIBUTION_V1 } from './de-82b-distribution.js';
import { DE_ANSCHAFFUNGSNAHE_V1 } from './de-anschaffungsnahe.js';
import { DE_CASH_TIMING_V1 } from './de-cash-timing.js';
import { DE_CATEGORY_DEFAULTS_V1 } from './de-category-defaults.js';
import { DE_CONSTRUCTION_PERIOD_INTEREST_V1 } from './de-construction-period-interest.js';
import { DE_WEG_SPENDING_V1 } from './de-weg-spending.js';

/**
 * Taxation's rule versions (api-design.md §58, §59; P8-D11): `domains/tax-rules/` composes them with Depreciation's into
 * `TAX_RULES`. A version stays here while a stored reference names it.
 */
export const TAXATION_RULE_VERSIONS: readonly RuleVersion[] = [
  DE_CATEGORY_DEFAULTS_V1,
  DE_CASH_TIMING_V1,
  DE_WEG_SPENDING_V1,
  DE_82B_DISTRIBUTION_V1,
  DE_ANSCHAFFUNGSNAHE_V1,
  DE_CONSTRUCTION_PERIOD_INTEREST_V1,
];

import type { RuleVersion } from '../../../shared/index.js';
import { DE_AFA_BUILDING_LINEAR_V1 } from './de-afa-building-linear.js';

/** Depreciation's rule versions (api-design.md §59, P8-D11): `domains/tax-rules/` composes them into `TAX_RULES`. */
export const DEPRECIATION_RULE_VERSIONS: readonly RuleVersion[] = [DE_AFA_BUILDING_LINEAR_V1];

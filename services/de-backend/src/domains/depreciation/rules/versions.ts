import type { RuleVersion } from '../../../shared/index.js';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2 } from './de-afa-building-linear.js';
import { DE_AFA_MOVABLE_LINEAR_V1 } from './de-afa-movable-linear.js';

/** Depreciation's rule versions (api-design.md §59, §59A, §59B, P8-D11): `domains/tax-rules/` composes them into `TAX_RULES`. */
export const DEPRECIATION_RULE_VERSIONS: readonly RuleVersion[] = [DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2, DE_AFA_MOVABLE_LINEAR_V1];

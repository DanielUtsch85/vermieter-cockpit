import { RuleRegistry } from '../../shared/index.js';
import { DEPRECIATION_RULE_VERSIONS } from '../depreciation/index.js';
import { TAXATION_RULE_VERSIONS } from '../taxation/index.js';

/**
 * The registry of the backend (api-design.md §58, §59; P8-D11): every rule version of the code, composed above both
 * domains from the versions each exports. Nothing in `domains/taxation/` or `domains/depreciation/` imports this module,
 * so neither domain loads the other through it. A version stays while a stored reference names it.
 */
export const TAX_RULES = new RuleRegistry([...TAXATION_RULE_VERSIONS, ...DEPRECIATION_RULE_VERSIONS]);

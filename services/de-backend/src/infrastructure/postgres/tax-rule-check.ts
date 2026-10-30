import type { Kysely } from 'kysely';
import { TAX_RULES, ruleKey, type RuleRef, type RuleRegistry } from '../../domains/taxation/index.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';

/**
 * The start check of api-design.md §58 (P7-D1, review on #156): every distinct `ruleCode@version` stored in
 * `tax_classification` must resolve against the registry. Like a failed migration, a missing one aborts the start; the
 * error names the missing references. Returns the stored references when all resolve.
 */
export async function checkStoredRuleReferences(db: Kysely<Database>, registry: RuleRegistry = TAX_RULES): Promise<readonly RuleRef[]> {
  const stored = await new PostgresTaxClassificationRepository(db, registry).storedRuleReferences();
  const missing = registry.unregistered(stored);
  if (missing.length > 0) {
    throw new Error(`Stored tax rule references are not registered: ${missing.map(ruleKey).join(', ')} (api-design §58); the backend does not start`);
  }
  return stored;
}

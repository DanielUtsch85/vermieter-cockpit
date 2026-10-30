import type { Kysely } from 'kysely';
import type { DepreciationAssetRepository } from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { ruleKey, type RuleRef, type RuleRegistry } from '../../shared/index.js';
import { PostgresDepreciationAssetRepository } from './depreciation-asset-repository.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';

/** A source of stored rule references besides Taxation's own (§59: Depreciation's). */
export type StoredRuleSource = Pick<DepreciationAssetRepository, 'storedRuleReferences'>;

/**
 * The start check of api-design.md §58 (P7-D1, review on #156): every distinct `ruleCode@version` stored must resolve
 * against the registry, Taxation's (`tax_classification`, both references) and, since VC-8-01, Depreciation's (§59; none
 * before VC-8-04 records schedule versions). Like a failed migration, a missing one aborts the start; the error names the
 * missing references. Returns the stored references, each once, when all resolve.
 */
export async function checkStoredRuleReferences(
  db: Kysely<Database>,
  registry: RuleRegistry = TAX_RULES,
  depreciation: StoredRuleSource = new PostgresDepreciationAssetRepository(db),
): Promise<readonly RuleRef[]> {
  const taxation = await new PostgresTaxClassificationRepository(db, registry).storedRuleReferences();
  const stored = [...new Map([...taxation, ...(await depreciation.storedRuleReferences())].map((ref) => [ruleKey(ref), ref])).values()];
  const missing = registry.unregistered(stored);
  if (missing.length > 0) {
    throw new Error(`Stored tax rule references are not registered: ${missing.map(ruleKey).join(', ')} (api-design §58); the backend does not start`);
  }
  return stored;
}

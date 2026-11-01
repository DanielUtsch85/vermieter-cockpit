import type { Kysely } from 'kysely';
import { ruleVersionHash, type DepreciationAssetRepository, type Fingerprinter } from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { ruleKey, type RuleRef, type RuleRegistry } from '../../shared/index.js';
import { sha256Fingerprinter } from '../hashing/index.js';
import { PostgresDepreciationAssetRepository } from './depreciation-asset-repository.js';
import { storedRuleVersionHashes } from './depreciation-schedule-version-reads.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';

/**
 * A source of stored rule references besides Taxation's own (§59, §60: Depreciation's recorded schedule versions), with
 * the rule-version hash each recorded version stored.
 */
export type StoredRuleSource = Pick<DepreciationAssetRepository, 'storedRuleReferences'> & {
  readonly storedRuleVersionHashes?: () => Promise<readonly (RuleRef & { readonly ruleVersionHash: string })[]>;
};

/**
 * The start check of api-design.md §58 (P7-D1, review on #156) and §60: every distinct `ruleCode@version` stored must
 * resolve against the registry, Taxation's (`tax_classification`, both references) and Depreciation's (the rules of
 * `depreciation_schedule_version_rule`), and every recorded `rule_version_hash` must equal the registry's hash of that
 * version (VC-8-04: a frozen rule changed in place stops the backend before a read could show a figure under it). Like a
 * failed migration, a failure aborts the start, naming the references (and both hashes). Returns the stored references,
 * each once, when all resolve.
 */
export async function checkStoredRuleReferences(
  db: Kysely<Database>,
  registry: RuleRegistry = TAX_RULES,
  depreciation: StoredRuleSource = {
    storedRuleReferences: () => new PostgresDepreciationAssetRepository(db).storedRuleReferences(),
    storedRuleVersionHashes: () => storedRuleVersionHashes(db),
  },
  fingerprinter: Fingerprinter = sha256Fingerprinter,
): Promise<readonly RuleRef[]> {
  const taxation = await new PostgresTaxClassificationRepository(db, registry).storedRuleReferences();
  const stored = [...new Map([...taxation, ...(await depreciation.storedRuleReferences())].map((ref) => [ruleKey(ref), ref])).values()];
  const missing = registry.unregistered(stored);
  if (missing.length > 0) {
    throw new Error(`Stored tax rule references are not registered: ${missing.map(ruleKey).join(', ')} (api-design §58); the backend does not start`);
  }
  const changed = (await (depreciation.storedRuleVersionHashes?.() ?? Promise.resolve([]))).flatMap((ref) => {
    const rule = registry.find(ref);
    const now = rule === undefined ? null : ruleVersionHash(rule, fingerprinter);
    return now === ref.ruleVersionHash ? [] : [`${ruleKey(ref)} (recorded ${ref.ruleVersionHash}, registry ${now ?? 'none'})`];
  });
  if (changed.length > 0) {
    throw new Error(
      `Recorded rule versions changed in place: ${changed.join(', ')} (api-design §60: a frozen version is never edited); the backend does not start`,
    );
  }
  return stored;
}

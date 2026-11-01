import type { RuleVersion } from '../../shared/index.js';
import { canonicalJson, type Fingerprinter } from '../../shared/index.js';

/**
 * The hashing of recorded schedule versions (api-design.md §60 "Reproducible", "Changed since recorded"). The canonical
 * JSON, the port the SHA-256 comes through and the fingerprint pattern live in `shared/canonical-json.ts` (shared with
 * Taxation, §58E) and are re-exported here; the rule-version hash is Depreciation's own.
 */
export { FINGERPRINT, canonicalJson, centsText } from '../../shared/index.js';
export type { Fingerprinter } from '../../shared/index.js';

/**
 * The `ruleVersionHash` of §60 (review on #180): SHA-256 of the canonical JSON of the rule version without
 * `effectiveTo` (the one field a frozen version still takes) and without `status` (derived from today). A change of
 * `title`, `legalBasis`, `effectiveFrom`, `parameters` or `source` changes it; the freeze forbids exactly those.
 */
export function ruleVersionHash(rule: RuleVersion, fingerprinter: Fingerprinter): string {
  const { ruleCode, version, title, legalBasis, effectiveFrom, parameters, source } = rule;
  return fingerprinter.sha256Hex(canonicalJson({ ruleCode, version, title, legalBasis, effectiveFrom, parameters, source }));
}

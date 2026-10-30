import type { BusinessDate } from '../../../shared/index.js';
import { DE_82B_DISTRIBUTION_V1 } from './de-82b-distribution.js';
import { DE_ANSCHAFFUNGSNAHE_V1 } from './de-anschaffungsnahe.js';
import { DE_CASH_TIMING_V1 } from './de-cash-timing.js';
import { DE_CATEGORY_DEFAULTS_V1 } from './de-category-defaults.js';
import { DE_WEG_SPENDING_V1 } from './de-weg-spending.js';
import { ruleKey, type RuleRef, type RuleStatus, type RuleVersion } from './rule-version.js';

/**
 * The registry of rule versions (api-design.md §58, P7-D1): selection by date, the derived status, and whether a stored
 * reference resolves. Read-only; a rule changes by a code change. The constructor refuses an inconsistent set (two
 * versions of one rule overlapping, a duplicate version, an empty period), so a bad registry never starts.
 */
export class RuleRegistry {
  private readonly byCode: ReadonlyMap<string, readonly RuleVersion[]>;

  constructor(versions: readonly RuleVersion[]) {
    const byCode = new Map<string, RuleVersion[]>();
    for (const v of versions) byCode.set(v.ruleCode, [...(byCode.get(v.ruleCode) ?? []), v]);
    for (const [code, list] of byCode) {
      list.sort((a, b) => a.version - b.version);
      list.forEach((v, i) => {
        if (!Number.isInteger(v.version) || v.version < 1) throw new Error(`rule ${ruleKey(v)}: the version is a positive integer`);
        if (v.effectiveTo !== null && v.effectiveTo <= v.effectiveFrom) throw new Error(`rule ${ruleKey(v)}: effectiveTo is after effectiveFrom`);
        const previous = list[i - 1];
        if (previous === undefined) return;
        if (previous.version === v.version) throw new Error(`rule ${code}: version ${v.version} is registered twice`);
        // Later versions start later, and only once the earlier one ended: two versions never overlap (§58).
        if (previous.effectiveTo === null || previous.effectiveTo > v.effectiveFrom) {
          throw new Error(`rule ${code}: versions ${previous.version} and ${v.version} overlap`);
        }
      });
    }
    this.byCode = byCode;
  }

  /** Every rule code, ascending. */
  codes(): readonly string[] {
    return [...this.byCode.keys()].sort();
  }

  /** The versions of one rule, ascending; empty when unknown. */
  versions(ruleCode: string): readonly RuleVersion[] {
    return this.byCode.get(ruleCode) ?? [];
  }

  /** The version applicable on `date`: `effectiveFrom` ≤ date < `effectiveTo` (or open). */
  select(ruleCode: string, date: BusinessDate): RuleVersion | undefined {
    return this.versions(ruleCode).find((v) => v.effectiveFrom <= date && (v.effectiveTo === null || date < v.effectiveTo));
  }

  find(ref: RuleRef): RuleVersion | undefined {
    return this.versions(ref.ruleCode).find((v) => v.version === ref.version);
  }

  isRegistered(ruleCode: string, version: number): boolean {
    return this.find({ ruleCode, version }) !== undefined;
  }

  status(rule: RuleVersion, today: BusinessDate): RuleStatus {
    if (today < rule.effectiveFrom) return 'PENDING';
    if (rule.effectiveTo === null || today < rule.effectiveTo) return 'ACTIVE';
    return this.versions(rule.ruleCode).some((v) => v.version > rule.version) ? 'SUPERSEDED' : 'RETIRED';
  }

  /** The references that do not resolve, each once, in key order (the start check, §58). */
  unregistered(refs: readonly RuleRef[]): RuleRef[] {
    const missing = new Map<string, RuleRef>();
    for (const ref of refs) if (!this.isRegistered(ref.ruleCode, ref.version)) missing.set(ruleKey(ref), { ruleCode: ref.ruleCode, version: ref.version });
    return [...missing.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, ref]) => ref);
  }
}

/** The registry of the backend: every rule version of the code. A version stays while a stored reference names it. */
export const TAX_RULES = new RuleRegistry([DE_CATEGORY_DEFAULTS_V1, DE_CASH_TIMING_V1, DE_WEG_SPENDING_V1, DE_82B_DISTRIBUTION_V1, DE_ANSCHAFFUNGSNAHE_V1]);

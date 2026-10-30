import type { BusinessDate } from './business-date.js';

/**
 * A rule version (api-design.md §58, phase-7-plan P7-D1, taxation.md §9, ADR-041): a versioned code module, never a
 * database row. The database stores only the reference `ruleCode@version` on the record that applied it.
 */
export interface RuleVersion<P = unknown> {
  readonly ruleCode: string;
  /** 1, 2, …: a changed rule is a new version; the old one stays in the code and its tests. */
  readonly version: number;
  readonly title: string;
  /** E.g. `§ 9 EStG`. */
  readonly legalBasis: string;
  /** Applicable from this date (inclusive). */
  readonly effectiveFrom: BusinessDate;
  /** Applicable before this date (exclusive); `null` while open. */
  readonly effectiveTo: BusinessDate | null;
  /** The rule's own data. */
  readonly parameters: P;
  /** Provenance: the documents and decisions the rule follows. */
  readonly source: string;
}

/** The stored reference to an applied rule version. */
export interface RuleRef {
  readonly ruleCode: string;
  readonly version: number;
}

/**
 * Derived from today (§58): `ACTIVE` applicable today, `SUPERSEDED` ended with a later version, `RETIRED` ended
 * without a successor. `PENDING` is a version not yet effective: §58 names no state for it (none is registered).
 */
export const RULE_STATUSES = ['ACTIVE', 'SUPERSEDED', 'RETIRED', 'PENDING'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export const ruleKey = (ref: RuleRef) => `${ref.ruleCode}@${ref.version}`;

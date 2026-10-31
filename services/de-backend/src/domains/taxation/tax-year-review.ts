import type { BusinessDate, RuleRef, RuleRegistry } from '../../shared/index.js';
import type { AnschaffungsnaheCheck } from './anschaffungsnahe.js';
import type { TaxYearItem, TaxYearReview, TaxYearRuleVersion, ViewFlag } from './tax-year-response.js';
import type { Origin, ReviewState, Treatment } from './vocabulary.js';
import { REVIEW_STATES } from './vocabulary.js';

/**
 * The review of the tax-year view (api-design.md §58C "Review"): which flags are open, whether the year is final, and
 * the rule versions its items name.
 */

const CONFIRMABLE = new Set([
  'ATTRIBUTED_BY_10_DAY_RULE',
  'DUE_DATE_ASSUMED',
  'ECONOMIC_PERIOD_ASSUMED',
  'NO_ECONOMIC_PERIOD',
  'WITHDRAWAL_DATE_ASSUMED',
  'WEG_FINANCIAL_YEAR_NOT_CALENDAR',
]);
const OPEN_ITEM_FLAGS = new Set([
  'NEEDS_REVIEW',
  'UNCLASSIFIED',
  'CLASSIFICATION_ON_CORRECTED_SPLIT',
  'PREDECESSOR_CLASSIFIED',
  'REFUND_YEAR_UNKNOWN',
  'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE',
  'ATTRIBUTION_INPUT_CHANGED',
  // §58D: about the Loan's allocation itself; no classification of the split clears them.
  'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY',
  'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS',
]);
/** Every flag of the year is open (§58C's review table). */
const OPEN_YEAR_FLAGS = new Set([
  'DEPRECIATION_NOT_AVAILABLE',
  'ATTRIBUTION_INPUT_CHANGED',
  'ATTRIBUTION_HISTORY_INCONSISTENT',
  'OWNERSHIP_INCOMPLETE',
  'UNATTRIBUTED_ITEMS',
  'LOAN_INTEREST_NOT_ATTRIBUTED',
  'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL',
]);

/**
 * Whether an item's flag needs a person (§58C's review table): `ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN` while the item is
 * not `CAPITALIZED`; an attribution flag while no confirmed classification stands for the item; every flag the table
 * does not name as open is informative.
 */
export function flagIsOpen(code: string, item: { readonly treatment: Treatment | null; readonly origin: Origin; readonly reviewState: ReviewState }): boolean {
  if (OPEN_YEAR_FLAGS.has(code) || OPEN_ITEM_FLAGS.has(code)) return true;
  if (code === 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN') return item.treatment !== 'CAPITALIZED';
  if (CONFIRMABLE.has(code)) return !(item.origin === 'CLASSIFICATION' && (item.reviewState === 'USER_CONFIRMED' || item.reviewState === 'ADVISOR_CONFIRMED'));
  return false;
}

export function reviewOf(yearFlags: readonly ViewFlag[], items: readonly TaxYearItem[]): TaxYearReview {
  const open = new Map<string, number>();
  const info = new Map<string, number>();
  const bump = (map: Map<string, number>, code: string) => map.set(code, (map.get(code) ?? 0) + 1);
  for (const f of yearFlags) bump(OPEN_YEAR_FLAGS.has(f.code) ? open : info, f.code);
  const itemCodes = new Map<string, { open: number; info: number }>();
  for (const item of items) {
    for (const code of new Set(item.flags.map((f) => f.code))) {
      const seen = itemCodes.get(code) ?? { open: 0, info: 0 };
      if (flagIsOpen(code, item)) seen.open += 1;
      else seen.info += 1;
      itemCodes.set(code, seen);
    }
  }
  for (const [code, counts] of [...itemCodes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (counts.open > 0) open.set(code, (open.get(code) ?? 0) + counts.open);
    if (counts.info > 0) info.set(code, (info.get(code) ?? 0) + counts.info);
  }
  const reviewStates = Object.fromEntries(REVIEW_STATES.map((s) => [s, items.filter((i) => i.reviewState === s).length])) as Record<ReviewState, number>;
  const list = (map: Map<string, number>) => [...map.entries()].map(([code, count]) => ({ code, count }));
  return { final: open.size === 0, open: list(open), info: list(info), reviewStates };
}

export function ruleVersionsOf(
  items: readonly TaxYearItem[],
  checks: readonly AnschaffungsnaheCheck[],
  registry: RuleRegistry,
  today: BusinessDate,
): TaxYearRuleVersion[] {
  const counted = new Map<string, { ref: RuleRef; count: number }>();
  const count = (refs: readonly (RuleRef | null | undefined)[]) => {
    const keys = new Map<string, RuleRef>();
    for (const ref of refs) if (ref !== null && ref !== undefined) keys.set(`${ref.ruleCode}@${ref.version}`, ref);
    for (const [key, ref] of keys) counted.set(key, { ref, count: (counted.get(key)?.count ?? 0) + 1 });
  };
  for (const item of items) {
    const attribution = item.attribution as { readonly rule?: RuleRef | null } | null;
    count([item.rule, item.treatmentRule, attribution?.rule, item.distribution?.rule]);
  }
  for (const check of checks) count([check.rule]);
  return [...counted.values()]
    .map(({ ref, count: itemCount }) => {
      const version = registry.find(ref);
      return {
        ruleCode: ref.ruleCode,
        version: ref.version,
        title: version?.title ?? null,
        legalBasis: version?.legalBasis ?? null,
        status: version === undefined ? null : registry.status(version, today),
        itemCount,
      };
    })
    .sort((a, b) => (a.ruleCode !== b.ruleCode ? (a.ruleCode < b.ruleCode ? -1 : 1) : a.version - b.version));
}

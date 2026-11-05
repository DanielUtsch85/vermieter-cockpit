import type { BusinessDate, RuleRef, RuleRegistry } from '../../shared/index.js';
import type { AnschaffungsnaheCheck } from './anschaffungsnahe.js';
import type { TaxYearItem, TaxYearReview, TaxYearRuleVersion, ViewFlag } from './tax-year-response.js';
import type { Origin, ReviewState, Treatment } from './vocabulary.js';
import { REVIEW_STATES } from './vocabulary.js';
import { OPEN_AFA_YEAR_FLAGS } from './tax-year-depreciation.js';
import { OWNERSHIP_START_FLAG, ownershipStartIsOpen } from './ownership-start-changes.js';
import { PROPOSED_BY_10_DAY_RULE, proposalIsOpen, yearProposalIsOpen } from './ten-day-proposal.js';

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
  // §58D: about the Loan's allocation itself; no classification of the split clears it.
  'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS',
  // §59E: Bauzeitzinsen. CONSTRUCTION_PERIOD_TREATMENT_MIXED is informative once the record is ADVISOR_CONFIRMED.
  'INTEREST_CAPITALIZED_CONDITIONS_MISSING',
  'CONSTRUCTION_PERIOD_DATE_OUTSIDE',
  'CONSTRUCTION_PERIOD_TREATMENT_MIXED',
]);
/** Every flag of the year is open (§58C's review table). */
const OPEN_YEAR_FLAGS = new Set([
  'DEPRECIATION_NOT_AVAILABLE',
  'ATTRIBUTION_HISTORY_INCONSISTENT',
  'OWNERSHIP_INCOMPLETE',
  'UNATTRIBUTED_ITEMS',
  'LOAN_INTEREST_NOT_ATTRIBUTED',
  'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL',
  // VC-8-05: the AfA's year flags (the status's and §60's recording flags, one per asset); GWG_THRESHOLD_MAY_APPLY is informative.
  ...OPEN_AFA_YEAR_FLAGS,
]);

/**
 * §58E (codes kept, the level by state; decided 2026-11-01, question 6): `ATTRIBUTION_INPUT_CHANGED` is open while one
 * of its entries has no matching acknowledgement, informative once every entry has one. Its details are the year flag's
 * entries or the item flag's (one per change that moved the item); both carry `acknowledgement`.
 */
export function attributionChangeIsOpen(details: unknown): boolean {
  return !Array.isArray(details) || details.length === 0 || details.some((e) => (e as { acknowledgement?: unknown } | null)?.acknowledgement == null);
}

/** §58E Part 3: `LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY` is open while its set has no `ACTIVE` confirmation. */
export function priceKeyIsOpen(details: unknown): boolean {
  return (details as { confirmation?: unknown } | undefined)?.confirmation == null;
}

/**
 * §58I open question 4 (Entscheidung des Projektinhabers, 2026-11-03): `NOT_COUNTED` is open where a classification no
 * longer fits its source, a deposit closed anew (`CLOSING_CHANGED`) or a WEG use changed (`USE_CHANGED`), so the year is
 * not final until the source is classified anew; every other reason (a source that does not count) stays informative.
 */
export function notCountedIsOpen(details: unknown): boolean {
  const d = details as { reason?: unknown; notCountedReason?: unknown } | null | undefined;
  return d?.reason === 'CLOSING_CHANGED' || d?.notCountedReason === 'USE_CHANGED';
}

/**
 * Whether an item's flag needs a person (§58C's review table): `ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN` while the item is
 * not `CAPITALIZED`; an attribution flag while no confirmed classification stands for the item; `PROPOSED_BY_10_DAY_RULE`
 * while no confirmed classification sets `taxYear` (§58F); every flag the table
 * does not name as open is informative.
 */
export function flagIsOpen(
  code: string,
  item: { readonly treatment: Treatment | null; readonly origin: Origin; readonly reviewState: ReviewState; readonly attribution?: unknown },
  details?: unknown,
): boolean {
  // §58F: only a confirmed taxYear decides the proposal; a confirmation without one does not (never in CONFIRMABLE).
  if (code === PROPOSED_BY_10_DAY_RULE) return proposalIsOpen({ ...item, attribution: item.attribution });
  if (code === 'CONSTRUCTION_PERIOD_TREATMENT_MIXED')
    return (details as { recordReviewState?: unknown } | undefined)?.recordReviewState !== 'ADVISOR_CONFIRMED';
  // §58G: PROPERTY_PART_CHANGED takes the same rule (open while an entry is not acknowledged; then informative).
  if (code === 'ATTRIBUTION_INPUT_CHANGED' || code === 'PROPERTY_PART_CHANGED') return attributionChangeIsOpen(details);
  if (code === 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY') return priceKeyIsOpen(details);
  // §58L rule 8 (Entscheidung des Projektinhabers, 2026-11-04, L8): open with more than one VALID set, else informative.
  if (code === 'INTEREST_PERIOD_UNKNOWN') return ((details as { validAllocationSets?: number } | undefined)?.validAllocationSets ?? 2) > 1;
  if (code === 'NOT_COUNTED') return notCountedIsOpen(details);
  if (OPEN_YEAR_FLAGS.has(code) || OPEN_ITEM_FLAGS.has(code)) return true;
  if (code === 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN') return item.treatment !== 'CAPITALIZED';
  if (CONFIRMABLE.has(code)) return !(item.origin === 'CLASSIFICATION' && (item.reviewState === 'USER_CONFIRMED' || item.reviewState === 'ADVISOR_CONFIRMED'));
  return false;
}

/**
 * `afaUnits` (VC-8-05): each AfA item's flags and each gap's reason codes, with their carried levels; a code counts once
 * per unit, as a cash item's.
 */
export function reviewOf(
  yearFlags: readonly ViewFlag[],
  items: readonly TaxYearItem[],
  afaUnits: readonly (readonly { readonly code: string; readonly open: boolean }[])[] = [],
): TaxYearReview {
  const open = new Map<string, number>();
  const info = new Map<string, number>();
  const bump = (map: Map<string, number>, code: string) => map.set(code, (map.get(code) ?? 0) + 1);
  // §58F: the year flag of the 10-day proposal is open while one of its splits is (informative once each is decided).
  // §58E: ATTRIBUTION_INPUT_CHANGED is informative once every change is acknowledged.
  const yearFlagOpen = (f: ViewFlag) =>
    f.code === PROPOSED_BY_10_DAY_RULE
      ? yearProposalIsOpen(f.details)
      : f.code === 'ATTRIBUTION_INPUT_CHANGED' || f.code === 'PROPERTY_PART_CHANGED'
        ? attributionChangeIsOpen(f.details)
        : f.code === OWNERSHIP_START_FLAG
          ? // §58N: open while an OPEN entry is not acknowledged (Entscheidung des Projektinhabers, 2026-11-04, Frage 5).
            ownershipStartIsOpen(f.details)
          : OPEN_YEAR_FLAGS.has(f.code);
  for (const f of yearFlags) bump(yearFlagOpen(f) ? open : info, f.code);
  const itemCodes = new Map<string, { open: number; info: number }>();
  for (const item of items) {
    for (const code of new Set(item.flags.map((f) => f.code))) {
      const seen = itemCodes.get(code) ?? { open: 0, info: 0 };
      if (item.flags.some((f) => f.code === code && flagIsOpen(code, item, f.details))) seen.open += 1;
      else seen.info += 1;
      itemCodes.set(code, seen);
    }
  }
  for (const unit of afaUnits) {
    for (const code of new Set(unit.map((u) => u.code))) {
      const seen = itemCodes.get(code) ?? { open: 0, info: 0 };
      if (unit.some((u) => u.code === code && u.open)) seen.open += 1;
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
  afaRefs: readonly RuleRef[] = [],
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
  // VC-8-05: each AfA item's rule version.
  for (const ref of afaRefs) count([ref]);
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

import type { BusinessDate, Money } from '../../shared/index.js';
import { yearOf } from './cash-timing.js';
import {
  categoryDefaultsOn,
  supersedesCheck,
  type CreateRefusal,
  type DepositNotCounted,
  type NewTaxClassification,
  type TaxClassification,
} from './classification.js';
import { CATEGORY_DEFAULTS } from './rules/de-category-defaults.js';
import type { RuleRegistry } from './rules/registry.js';
import type { RuleRef } from './rules/rule-version.js';
import type { Origin, ReviewState, TaxCategory, Treatment } from './vocabulary.js';

/**
 * The retained deposit as a source of classification (api-design.md §58A, phase-7-plan P7-D4, checklist A11): the
 * amount a `CLOSED` deposit keeps at its closing, in the year of the closing date. No cash moves: the deposit's cash
 * was received earlier and stays as it is. Never income by default.
 */

/** A security deposit as tax reads it. */
export interface DepositFacts {
  readonly securityDepositId: string;
  readonly status: string;
  readonly closingDate: BusinessDate | null;
  /** §47.4's `retainedAmount`; 0 while not `CLOSED`. */
  readonly retainedAmount: Money;
  /** The PropertyReference its Tenant's rent is booked on, where exactly one (§58A's per-property list). */
  readonly propertyReferenceId: string | null;
}

export type DepositTaxMeaningFlag =
  | {
      readonly code: 'NOT_COUNTED';
      readonly details: { readonly depositStatus: string; readonly retainedAmount: Money; readonly reason: DepositNotCounted['reason'] };
    }
  | { readonly code: 'RULE_SUPERSEDED'; readonly details: { readonly ruleCode: string; readonly version: number; readonly applicableVersion: number } };

export interface DepositTaxMeaning extends DepositFacts {
  readonly sourceType: 'DEPOSIT_CLOSING';
  readonly sourceId: string;
  readonly counts: boolean;
  /** The year of the closing date; `null` while not `CLOSED`. */
  readonly taxYear: number | null;
  readonly amount: Money;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: ReviewState;
  readonly origin: Origin;
  readonly rule: RuleRef | null;
  readonly classificationId: string | null;
  readonly flags: readonly DepositTaxMeaningFlag[];
}

/**
 * Why the deposit, or a classification of it, does not count; `null` when it counts: `CLOSED` with a retained amount
 * > 0, and (for a classification) the closing it classified is still the deposit's (a reopen and a new closing need a
 * new classification, §58A).
 */
export function depositNotCounted(facts: DepositFacts, classification: Pick<TaxClassification, 'depositClosing'> | null): DepositNotCounted | null {
  const refusal = (reason: DepositNotCounted['reason']): DepositNotCounted => ({
    kind: 'DEPOSIT_NOT_COUNTED',
    depositStatus: facts.status,
    retainedAmount: facts.retainedAmount,
    reason,
  });
  if (facts.status !== 'CLOSED' || facts.closingDate === null) return refusal('NOT_CLOSED');
  if (!facts.retainedAmount.isPositive()) return refusal('NOTHING_RETAINED');
  const closing = classification?.depositClosing ?? null;
  if (closing !== null && (closing.closingDate !== facts.closingDate || !closing.retainedAmount.equals(facts.retainedAmount))) {
    return refusal('CLOSING_CHANGED');
  }
  return null;
}

/**
 * The tax meaning of a retained deposit (§58A): its current classification, else the default of `DE_CATEGORY_DEFAULTS`
 * on the closing date (`UNCLASSIFIED`, no treatment, `NEEDS_REVIEW`).
 */
export function deriveDepositTaxMeaning(
  facts: DepositFacts,
  classification: TaxClassification | null,
  registry: RuleRegistry,
  today: BusinessDate,
): DepositTaxMeaning {
  const notCounted = depositNotCounted(facts, classification);
  const flags: DepositTaxMeaningFlag[] = [];
  if (notCounted !== null) {
    flags.push({
      code: 'NOT_COUNTED',
      details: { depositStatus: notCounted.depositStatus, retainedAmount: notCounted.retainedAmount, reason: notCounted.reason },
    });
  }
  const base = {
    ...facts,
    sourceType: 'DEPOSIT_CLOSING',
    sourceId: facts.securityDepositId,
    counts: notCounted === null,
    taxYear: facts.closingDate === null ? null : yearOf(facts.closingDate),
    amount: facts.retainedAmount,
  } as const;
  if (classification !== null) {
    const applicable = registry.select(classification.rule.ruleCode, today);
    if (applicable !== undefined && applicable.version > classification.rule.version) {
      flags.push({
        code: 'RULE_SUPERSEDED',
        details: { ruleCode: classification.rule.ruleCode, version: classification.rule.version, applicableVersion: applicable.version },
      });
    }
    return {
      ...base,
      taxCategory: classification.taxCategory,
      treatment: classification.treatment,
      reviewState: classification.reviewState,
      origin: 'CLASSIFICATION',
      rule: classification.rule,
      classificationId: classification.id,
      flags,
    };
  }
  const rule = categoryDefaultsOn(registry, facts.closingDate ?? today);
  const meaning = rule?.parameters.depositClosing.default ?? { taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' };
  return {
    ...base,
    ...meaning,
    origin: 'DEFAULT',
    rule: rule === undefined ? null : { ruleCode: rule.ruleCode, version: rule.version },
    classificationId: null,
    flags,
  };
}

/**
 * The checks of a deposit classification after the deposit was found (§58A, in order): it counts, a rule version
 * applies on the closing date, the line and the treatment are the deposit's (`TREATMENT_NOT_ALLOWED`), `supersedes`
 * names the current classification.
 */
export function planDepositClassification(
  facts: DepositFacts,
  currentId: string | null,
  request: Pick<NewTaxClassification, 'taxCategory' | 'treatment' | 'supersedes'>,
  registry: RuleRegistry,
): { readonly kind: 'CLASSIFY'; readonly rule: RuleRef; readonly closingDate: BusinessDate } | CreateRefusal {
  const notCounted = depositNotCounted(facts, null);
  if (notCounted !== null) return notCounted;
  const closingDate = facts.closingDate as BusinessDate;
  const rule = categoryDefaultsOn(registry, closingDate);
  if (rule === undefined) return { kind: 'NO_APPLICABLE_RULE', ruleCode: CATEGORY_DEFAULTS, date: closingDate };
  const allowed = rule.parameters.depositClosing;
  if (!allowed.taxCategories.includes(request.taxCategory) || request.treatment === null || !allowed.treatments.includes(request.treatment)) {
    return { kind: 'TREATMENT_NOT_ALLOWED', categoryType: null, allowed: allowed.treatments, taxCategories: allowed.taxCategories };
  }
  return supersedesCheck(currentId, request.supersedes) ?? { kind: 'CLASSIFY', rule: { ruleCode: rule.ruleCode, version: rule.version }, closingDate };
}

import type { BusinessDate } from '../../../shared/index.js';
import type { TaxCategory, Treatment, WegSourceType } from '../vocabulary.js';
import type { CategoryDefault } from './de-category-defaults.js';
import type { RuleVersion } from './rule-version.js';

/** The parameters of what the WEG spends (api-design.md §58B, P7-D5). */
export interface WegSpendingParameters {
  /** The sources this rule gives a default to. */
  readonly sourceTypes: readonly WegSourceType[];
  /** Derived on read, never stored: DE does not decide Erhaltungsaufwand or Herstellungskosten (weg.md §8). */
  readonly default: CategoryDefault;
  /** The lines a classification may give them, each with its treatments (`TREATMENT_NOT_ALLOWED` otherwise). */
  readonly lines: Readonly<Partial<Record<TaxCategory, readonly Treatment[]>>>;
}

export const WEG_SPENDING = 'DE_WEG_SPENDING';

/**
 * Version 1 (§58B): a reserve withdrawal and a Sonderumlage use count once, when the WEG spends the money, as
 * Erhaltungsaufwand (`DEDUCTIBLE`, `DISTRIBUTED_82B`), Herstellungskosten (`CAPITALIZED`) or not at all. From 2000-01-01
 * as `DE_CATEGORY_DEFAULTS@1`: the judgment interprets the law in force. The database repeats these lines and
 * treatments literally (0047's `tax_classification_weg_lines`); another version needs a migration that changes them.
 */
export const DE_WEG_SPENDING_V1: RuleVersion<WegSpendingParameters> = {
  ruleCode: WEG_SPENDING,
  version: 1,
  title: 'WEG-Rücklage und Sonderumlage: abziehbar bei Verausgabung',
  legalBasis: '§ 9 Abs. 1, § 11 Abs. 2 EStG; BFH IX R 19/24',
  effectiveFrom: '2000-01-01' as BusinessDate,
  effectiveTo: null,
  parameters: {
    sourceTypes: ['WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE'],
    default: { taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' },
    lines: { WEG_SPENDING: ['DEDUCTIBLE', 'DISTRIBUTED_82B', 'CAPITALIZED'], NOT_RELEVANT: ['NOT_RELEVANT'] },
  },
  source: 'BFH IX R 19/24 vom 14.01.2025; docs/germany/taxation.md §8; phase-7-plan P7-D5; api-design §58B (review on #167); verification-checklist E1',
};

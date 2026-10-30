import type { BusinessDate } from '../../../shared/index.js';
import type { TaxCategory } from '../vocabulary.js';
import type { RuleVersion } from './rule-version.js';

/** The parameters of the § 82b EStDV election (api-design.md §58B, P7-D6). */
export interface Distribution82bParameters {
  readonly minYears: number;
  readonly maxYears: number;
  /** Erhaltungsaufwand only. */
  readonly taxCategories: readonly TaxCategory[];
  /** The building serves mostly (> 50 %) residential purposes: the user confirms it with the election (§ 82b Abs. 1). */
  readonly requiresMostlyResidentialConfirmation: boolean;
}

export const DISTRIBUTION_82B = 'DE_82B_DISTRIBUTION';

/**
 * Version 1 (§58B): Erhaltungsaufwand distributed evenly over 2 to 5 years; the rest falls into the year ownership
 * ends (§ 82b Abs. 2). From 2004-01-01 (§ 84 Abs. 4a EStDV: Erhaltungsaufwand after 31.12.2003; open question 9). The
 * database repeats the years and lines literally (0047's `tax_classification_distribution` and `_fit`).
 */
export const DE_82B_DISTRIBUTION_V1: RuleVersion<Distribution82bParameters> = {
  ruleCode: DISTRIBUTION_82B,
  version: 1,
  title: 'Verteilung größeren Erhaltungsaufwands (§ 82b EStDV)',
  legalBasis: '§ 82b EStDV; § 84 Abs. 4a EStDV',
  effectiveFrom: '2004-01-01' as BusinessDate,
  effectiveTo: null,
  parameters: { minYears: 2, maxYears: 5, taxCategories: ['MAINTENANCE', 'WEG_SPENDING'], requiresMostlyResidentialConfirmation: true },
  source: 'docs/germany/taxation.md §6; phase-7-plan P7-D6; api-design §58B (review on #167); verification-checklist A5',
};

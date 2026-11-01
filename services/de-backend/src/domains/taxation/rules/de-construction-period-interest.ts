import type { BusinessDate, RuleVersion } from '../../../shared/index.js';
import type { TaxCategory } from '../vocabulary.js';

/** The parameters of Bauzeitzinsen (api-design.md §59E "The new rule"): which splits are interest, and the conditions. */
export interface ConstructionPeriodInterestParameters {
  /** A split of a PropertyReference with one of these financial category codes is interest (a Loan's split always is). */
  readonly interestCategoryCodes: readonly string[];
  /** A split whose classification names one of these lines is interest, whatever its category. */
  readonly interestTaxCategories: readonly TaxCategory[];
  /** `CAPITALIZED` interest needs a construction-period record (`CONSTRUCTION_PERIOD_INTEREST_REQUIRED`). */
  readonly capitalizedRequiresRecord: boolean;
  /** The record's review states that make its sources count. */
  readonly recordReviewStates: readonly string[];
  /** A record saying `advanceExpenseDeductible` makes `CAPITALIZED` impossible (case A: no free choice). */
  readonly deductibleBlocksCapitalization: boolean;
}

export const CONSTRUCTION_PERIOD_INTEREST = 'DE_CONSTRUCTION_PERIOD_INTEREST';

/**
 * Version 1 (§59E, VC-X-36): interest is capitalised only as Bauzeitzinsen of a Herstellung measure with its facts
 * recorded and confirmed, never when it is deductible as vorab entstandene Werbungskosten, and never for the land. From
 * 2000-01-01, as `DE_CATEGORY_DEFAULTS@1` (which stays unchanged): it applies to every year DE classifies. The database
 * repeats the interest codes, the lines and the record requirement literally (0055's `tax_classification_construction_period`);
 * another version needs a migration that changes them. A classification naming a record stores this version as its
 * `treatmentRule`, so a later change is `@2`.
 */
export const DE_CONSTRUCTION_PERIOD_INTEREST_V1: RuleVersion<ConstructionPeriodInterestParameters> = {
  ruleCode: CONSTRUCTION_PERIOD_INTEREST,
  version: 1,
  title: 'Bauzeitzinsen: aktivierbar nur nach geprüften Voraussetzungen, nie für Grund und Boden',
  legalBasis: '§ 255 Abs. 3 S. 2 HGB; § 9 Abs. 1 S. 3 Nr. 1 EStG; BFH IX R 2/12',
  effectiveFrom: '2000-01-01' as BusinessDate,
  effectiveTo: null,
  parameters: {
    interestCategoryCodes: ['LOAN_INTEREST'],
    interestTaxCategories: ['LOAN_INTEREST', 'FINANCING_COSTS'],
    capitalizedRequiresRecord: true,
    recordReviewStates: ['CONFIRMED', 'ADVISOR_CONFIRMED'],
    deductibleBlocksCapitalization: true,
  },
  source:
    'docs/germany/pruefbericht-2026-11-01.md, Frage 23 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01); api-design §59E (VC-X-36, decided by the owner on 2026-11-01)',
};

import type { BusinessDate, RuleVersion } from '../../../shared/index.js';
import type { TaxCategory, Treatment } from '../vocabulary.js';

/** The parameters of the anschaffungsnahe check (api-design.md §58B, P7-D6). */
export interface AnschaffungsnaheParameters {
  /** "15 Prozent … übersteigen": exactly the threshold is not above. */
  readonly thresholdPercent: number;
  /** From the transfer date to the same calendar day this many years later, both inclusive. */
  readonly windowYears: number;
  readonly taxCategories: readonly TaxCategory[];
  /** The treatments of Erhaltungsaufwand that are summed. */
  readonly countedTreatments: readonly Treatment[];
  /** Acquisition cost categories left out of the building's acquisition cost (A6). */
  readonly excludedCostCategories: readonly string[];
}

export const ANSCHAFFUNGSNAHE = 'DE_ANSCHAFFUNGSNAHE';

/**
 * Version 1 (§58B): Erhaltungsaufwand within 3 years of the transfer whose net sum exceeds 15 % of the building's
 * acquisition cost is Herstellungskosten (§ 6 Abs. 1 Nr. 1a EStG). From 2004-01-01 (measures begun after 31.12.2003;
 * open question 9), selected by the Acquisition's transfer date. The database repeats the 3-year window literally
 * (0047's `tax_classification_anschaffungsnahe`).
 */
export const DE_ANSCHAFFUNGSNAHE_V1: RuleVersion<AnschaffungsnaheParameters> = {
  ruleCode: ANSCHAFFUNGSNAHE,
  version: 1,
  title: 'Anschaffungsnahe Herstellungskosten (15 %, 3 Jahre)',
  legalBasis: '§ 6 Abs. 1 Nr. 1a EStG',
  effectiveFrom: '2004-01-01' as BusinessDate,
  effectiveTo: null,
  parameters: {
    thresholdPercent: 15,
    windowYears: 3,
    taxCategories: ['MAINTENANCE', 'WEG_SPENDING'],
    countedTreatments: ['DEDUCTIBLE', 'DISTRIBUTED_82B'],
    excludedCostCategories: ['FINANCING_RELATED'],
  },
  source: 'docs/germany/taxation.md §6; phase-7-plan P7-D6; api-design §58B (review on #167); verification-checklist A2, A6',
};

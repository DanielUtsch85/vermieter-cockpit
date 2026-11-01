import type { BusinessDate, RuleVersion } from '../../../shared/index.js';
import type { CostClassificationParameters } from '../../acquisition/index.js';
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
  /**
   * §59D (VC-X-42): which costs enter the denominator only by a confirmed classification, and which purposes enter;
   * equal to `DE_AFA_BUILDING_LINEAR`'s `basis.costClassification` (a registry test), so both compute one basis.
   */
  readonly costClassification: CostClassificationParameters;
}

export const ANSCHAFFUNGSNAHE = 'DE_ANSCHAFFUNGSNAHE';

/**
 * Version 1 (§58B): Erhaltungsaufwand within 3 years of the transfer whose net sum exceeds 15 % of the building's
 * acquisition cost is Herstellungskosten (§ 6 Abs. 1 Nr. 1a EStG). From 2004-01-01 (measures begun after 31.12.2003;
 * open question 9), selected by the Acquisition's transfer date. The database repeats the 3-year window literally
 * (0047's `tax_classification_anschaffungsnahe`).
 *
 * Changed in place on 2026-11-01 (§59D open question 3, decided by the owner: the Phase-7 rules are corrected in the
 * same version until the documented go-live of the first productive installation): the parameter `costClassification`
 * (tax review of 2026-11-01, questions 10 and 24). Its hash is pinned in `frozen-rules.test.ts` from then on.
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
    costClassification: {
      requiredFor: ['NOTARY', 'LAND_REGISTRY', 'OTHER'],
      basisPurposes: ['OWNERSHIP_TRANSFER'],
      confirmedReviewStates: ['CONFIRMED', 'ADVISOR_CONFIRMED'],
      legalBasis: '§ 255 Abs. 1 HGB i. V. m. § 9b Abs. 1 EStG; Finanzierungskosten keine Anschaffungskosten',
      source: 'Prüfbericht 2026-11-01, Fragen 10 und 24 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01)',
    },
  },
  source:
    'docs/germany/taxation.md §6; phase-7-plan P7-D6; api-design §58B (review on #167); verification-checklist A2, A6; changed in place 2026-11-01 by api-design §59D (VC-X-42): costClassification, Prüfbericht 2026-11-01, Fragen 10 und 24 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01)',
};

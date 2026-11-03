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
  /**
   * §59F (VC-X-38): the check measures the period of performance on a classification, never the booking date. Undated
   * sources whose own date lies in the search range (`undatedReadBeforeWindowDays` before the window to
   * `undatedReadAfterWindowDays` after it) enter the upper bound only; undated ones beyond it, but within
   * `plausibleYearsFromSourceDate` of the window, are listed (`outsideSearchRange`) and keep the check from being decided
   * by the upper bound. A performance lies within `plausibleYearsFromSourceDate` of its source's date.
   */
  readonly performance: PerformanceParameters;
}

export interface PerformanceParameters {
  readonly dateMeasured: 'PERFORMANCE';
  readonly undatedReadBeforeWindowDays: number;
  readonly undatedReadAfterWindowDays: number;
  readonly outsideSearchRange: 'LISTED_NOT_DECIDED';
  readonly plausibleYearsFromSourceDate: number;
  readonly progressEvidenceRequired: boolean;
  readonly estimatedProgress: 'NOT_EVIDENCED';
  readonly straddlingSource: 'SHARE_SHOWN_SPLIT_REQUIRED';
  /**
   * §59F (VC-X-38 Part 2; Entscheidung des Projektinhabers, 2026-11-02, 239-2): the evidenced split of a source straddling
   * the window, recorded on one classification: the part performed in the window `CAPITALIZED` on the check, the rest
   * `DEDUCTIBLE`, the amounts from the evidenced points only (exact, never estimated, never by calendar days). The gross
   * part in the window is the gross amount × the part of the amount used / the amount used, half-up to the cent; the rest
   * is the gross amount less it, so the parts sum to the source's amount. No cash correction. Without this parameter a
   * partial treatment is refused (`PERFORMANCE_REQUIRED`, `STRADDLES_WINDOW`), as before.
   */
  readonly partialTreatment?: PartialTreatmentParameters;
  readonly legalBasis: string;
  readonly source: string;
}

export interface PartialTreatmentParameters {
  readonly windowPart: 'CAPITALIZED';
  readonly rest: 'DEDUCTIBLE';
  readonly amountsFrom: 'EVIDENCED_POINTS';
  readonly grossWindowPart: 'PRO_RATA_HALF_UP';
  readonly cashCorrection: false;
  readonly source: string;
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
 *
 * Changed in place again for §59F (VC-X-38; the owner's decisions of 2026-11-01 and 2026-11-02): the parameter
 * `performance` (tax review of 2026-11-01, questions 14 and 16). The pinned hash is updated explicitly.
 *
 * Changed in place again for VC-X-38 Part 2 (Entscheidung des Projektinhabers, 2026-11-02, 239-2): the parameter
 * `performance.partialTreatment`. The pinned hash is updated explicitly.
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
    performance: {
      dateMeasured: 'PERFORMANCE',
      undatedReadBeforeWindowDays: 90,
      undatedReadAfterWindowDays: 365,
      outsideSearchRange: 'LISTED_NOT_DECIDED',
      plausibleYearsFromSourceDate: 3,
      progressEvidenceRequired: true,
      estimatedProgress: 'NOT_EVIDENCED',
      straddlingSource: 'SHARE_SHOWN_SPLIT_REQUIRED',
      partialTreatment: {
        windowPart: 'CAPITALIZED',
        rest: 'DEDUCTIBLE',
        amountsFrom: 'EVIDENCED_POINTS',
        grossWindowPart: 'PRO_RATA_HALF_UP',
        cashCorrection: false,
        source:
          'Entscheidung des Projektinhabers, 2026-11-02 (239-2); Prüfbericht 2026-11-01, Frage 14: die bis Fristende erbrachten Leistungen (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01)',
      },
      legalBasis: '§ 6 Abs. 1 Nr. 1a EStG; BMF 20.10.2017, Rn. 1 ff. (Durchführung der Maßnahme)',
      source: 'Prüfbericht 2026-11-01, Fragen 14 und 16 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01)',
    },
  },
  source:
    'docs/germany/taxation.md §6; phase-7-plan P7-D6; api-design §58B (review on #167); verification-checklist A2, A6; changed in place 2026-11-01 by api-design §59D (VC-X-42): costClassification, Prüfbericht 2026-11-01, Fragen 10 und 24 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01); VC-X-38 in place: Prüfbericht 2026-11-01, Fragen 14, 16 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01); owner decision 2026-11-01, api-design §59F; VC-X-38 Part 2 in place: performance.partialTreatment, Entscheidung des Projektinhabers 2026-11-02 (239-2), api-design §59F',
};

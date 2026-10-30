import type { BusinessDate, RuleVersion } from '../../../shared/index.js';

export const BUILDING_BANDS = ['A', 'B', 'C'] as const;
export type BuildingBand = (typeof BUILDING_BANDS)[number];

/** One rate band of § 7 Abs. 4 S. 1 Nr. 2 EStG, by the building's completion year (both ends inclusive, `null` open). */
export interface BuildingRateBand {
  readonly band: BuildingBand;
  readonly completedFromYear: number | null;
  readonly completedToYear: number | null;
  /** A §87 decimal string, computed exactly ("3", "2", "2.5"). */
  readonly ratePercent: string;
  readonly legalBasis: string;
  /** § 7 Abs. 4 S. 2 EStG: a useful life is shorter only below this many years, which the statute names per band. */
  readonly shorterUsefulLife: { readonly shorterThanYears: number; readonly legalBasis: string };
}

/** The parameters of the linear building AfA (api-design.md §59, P8-D4). */
export interface BuildingLinearParameters {
  readonly bands: readonly BuildingRateBand[];
  /** The claimed rate is `1/usefulLifeYears`, and only below the band's `shorterThanYears`. */
  readonly shorterUsefulLife: { readonly legalBasis: string; readonly rate: 'RECIPROCAL_OF_YEARS' };
}

export const AFA_BUILDING_LINEAR = 'DE_AFA_BUILDING_LINEAR';

const SHORTER = '§ 7 Abs. 4 S. 2 EStG';

/**
 * Version 1 (§59): the rate of a building in private assets by its completion year (3 % / 2 % / 2.5 %, B1–B3), and the
 * thresholds of a shorter actual useful life (33 / 50 / 40 years, B7; read in the official text on 30.10.2026). From
 * 2023-01-01, the first year the 3 % band applies, selected by the tax year computed: no earlier year is assumed until
 * its bands are verified (phase-8-plan §3, 4). Parameters are added additively until VC-8-04 freezes the version.
 */
export const DE_AFA_BUILDING_LINEAR_V1: RuleVersion<BuildingLinearParameters> = {
  ruleCode: AFA_BUILDING_LINEAR,
  version: 1,
  title: 'Lineare Gebäude-AfA im Privatvermögen (§ 7 Abs. 4 EStG)',
  legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 und S. 2 EStG',
  effectiveFrom: '2023-01-01' as BusinessDate,
  effectiveTo: null,
  parameters: {
    bands: [
      {
        band: 'A',
        completedFromYear: 2023,
        completedToYear: null,
        ratePercent: '3',
        legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. a EStG',
        shorterUsefulLife: { shorterThanYears: 33, legalBasis: SHORTER },
      },
      {
        band: 'B',
        completedFromYear: 1925,
        completedToYear: 2022,
        ratePercent: '2',
        legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG',
        shorterUsefulLife: { shorterThanYears: 50, legalBasis: SHORTER },
      },
      {
        band: 'C',
        completedFromYear: null,
        completedToYear: 1924,
        ratePercent: '2.5',
        legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. c EStG',
        shorterUsefulLife: { shorterThanYears: 40, legalBasis: SHORTER },
      },
    ],
    shorterUsefulLife: { legalBasis: SHORTER, rate: 'RECIPROCAL_OF_YEARS' },
  },
  source: 'docs/germany/depreciation.md §3 v0.2 (verified 29.10.2026); verification-checklist B1–B3, B7; phase-8-plan P8-D4, P8-D11',
};

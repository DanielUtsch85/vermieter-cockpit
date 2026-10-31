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

/** The parameters of the linear building AfA (api-design.md §59, P8-D4; §59A, P8-D2, P8-D5, P8-D8, P8-D9). */
export interface BuildingLinearParameters {
  readonly bands: readonly BuildingRateBand[];
  /** The claimed rate is `1/usefulLifeYears`, and only below the band's `shorterThanYears`. */
  readonly shorterUsefulLife: { readonly legalBasis: string; readonly rate: 'RECIPROCAL_OF_YEARS' };
  /**
   * Whether the version may give a figure without the open flag `HISTORICAL_RULE_TO_VERIFY` (§59A, decided 2026-10-31):
   * false until the tax advisor confirms an earlier version; a confirmation is a new version once VC-8-04 froze them.
   */
  readonly verified: boolean;
  /** The building's acquisition cost (§58B, P8-D2): the same excluded categories as `DE_ANSCHAFFUNGSNAHE@1`. */
  readonly basis: {
    readonly excludedCostCategories: readonly string[];
    readonly allocationReviewStates: readonly string[];
    readonly rounding: 'HALF_UP_CENT';
  };
  /** § 7 Abs. 1 S. 4 EStG (B6, P8-D5): less 1/12 per full month before the start month, so the start month counts. */
  readonly firstYear: { readonly startMonthCounts: boolean; readonly legalBasis: string };
  /** The end (depreciation.md §7, P8-D9): the remainder in the last month; the year of disposal pro rata by months. */
  readonly end: {
    readonly exhaustion: 'REMAINDER_IN_LAST_MONTH';
    readonly disposal: {
      readonly method: 'PRO_RATA_MONTHS';
      /** The buyer's transfer of economic ownership; without it the year is not computable (`DISPOSAL_DATE_MISSING`). */
      readonly cutOff: 'BUYER_ECONOMIC_TRANSFER_DATE';
      readonly endMonthCounts: boolean;
      readonly verified: boolean;
      readonly legalBasis: string;
    };
  };
  readonly rounding: { readonly unit: 'CENT'; readonly mode: 'HALF_UP'; readonly method: 'CUMULATIVE_PER_OWNER_PART' };
  /**
   * A new building bought in its completion year from this completion year on is not computable
   * (`DEPRECIATION_METHOD_UNKNOWN`): § 7b (from 2018) or § 7 Abs. 5a EStG (from 2023) may have been claimed (B4).
   */
  readonly methodUnknownFromCompletionYear: number;
}

export const AFA_BUILDING_LINEAR = 'DE_AFA_BUILDING_LINEAR';

const SHORTER = '§ 7 Abs. 4 S. 2 EStG';
const TITLE = 'Lineare Gebäude-AfA im Privatvermögen (§ 7 Abs. 4 EStG)';
const LEGAL_BASIS = '§ 7 Abs. 4 S. 1 Nr. 2 und S. 2 EStG';

/** The parameters both versions share (§59A); only the bands and `verified` differ. */
const COMMON = {
  shorterUsefulLife: { legalBasis: SHORTER, rate: 'RECIPROCAL_OF_YEARS' },
  basis: { excludedCostCategories: ['FINANCING_RELATED'], allocationReviewStates: ['CONFIRMED', 'ADVISOR_CONFIRMED'], rounding: 'HALF_UP_CENT' },
  firstYear: { startMonthCounts: true, legalBasis: '§ 7 Abs. 1 S. 4 EStG' },
  end: {
    exhaustion: 'REMAINDER_IN_LAST_MONTH',
    disposal: {
      method: 'PRO_RATA_MONTHS',
      cutOff: 'BUYER_ECONOMIC_TRANSFER_DATE',
      endMonthCounts: true,
      verified: false,
      legalBasis: 'R 7.4 Abs. 8 EStR (reviewer input on #173; VERIFY)',
    },
  },
  rounding: { unit: 'CENT', mode: 'HALF_UP', method: 'CUMULATIVE_PER_OWNER_PART' },
  methodUnknownFromCompletionYear: 2018,
} as const;

const SOURCE_SCHEDULE = 'depreciation.md §5, §7 v0.2; verification-checklist B5, B6; phase-8-plan P8-D2, P8-D5, P8-D8, P8-D9; api-design §59A';

/**
 * Version 1 (§59A "The rule versions", decided 2026-10-31): the years 2006–2022, with the lettering of § 7 Abs. 4 S. 1
 * Nr. 2 EStG before the JStG 2022 (Buchst. a 2 % after 31.12.1924, Buchst. b 2.5 % before 1.1.1925) and the thresholds
 * of S. 2 then (50 / 40 years). The text was read in the official consolidated text (Stand 2.7.2012 and 13.2.2022) and
 * BT-Drs. 20/3879, 20/8628 on 31.10.2026 (depreciation.md §3). `verified` stays false until the tax advisor confirms
 * the version (beratungsfragen.md §4): every year it computes is provisional.
 */
export const DE_AFA_BUILDING_LINEAR_V1: RuleVersion<BuildingLinearParameters> = {
  ruleCode: AFA_BUILDING_LINEAR,
  version: 1,
  title: TITLE,
  legalBasis: LEGAL_BASIS,
  effectiveFrom: '2006-01-01' as BusinessDate,
  effectiveTo: '2023-01-01' as BusinessDate,
  parameters: {
    ...COMMON,
    bands: [
      {
        band: 'A',
        completedFromYear: 1925,
        completedToYear: null,
        ratePercent: '2',
        legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. a EStG a. F.',
        shorterUsefulLife: { shorterThanYears: 50, legalBasis: SHORTER },
      },
      {
        band: 'B',
        completedFromYear: null,
        completedToYear: 1924,
        ratePercent: '2.5',
        legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG a. F.',
        shorterUsefulLife: { shorterThanYears: 40, legalBasis: SHORTER },
      },
    ],
    verified: false,
  },
  source: `api-design §59A (decided 2026-10-31); EStG i. d. F. vor dem JStG 2022 (BGBl. I S. 2294); BT-Drs. 20/3879 S. 88; ${SOURCE_SCHEDULE}`,
};

/**
 * Version 2 (§59; version 1 until VC-8-02 renumbered it, §59A): the rate of a building in private assets by its
 * completion year (3 % / 2 % / 2.5 %, B1–B3), and the thresholds of a shorter actual useful life (33 / 50 / 40 years,
 * B7; read in the official text on 30.10.2026). From 2023-01-01, the first year the 3 % band applies, selected by the
 * tax year computed. Parameters are added additively until VC-8-04 freezes the versions.
 */
export const DE_AFA_BUILDING_LINEAR_V2: RuleVersion<BuildingLinearParameters> = {
  ruleCode: AFA_BUILDING_LINEAR,
  version: 2,
  title: TITLE,
  legalBasis: LEGAL_BASIS,
  effectiveFrom: '2023-01-01' as BusinessDate,
  effectiveTo: null,
  parameters: {
    ...COMMON,
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
    // Today's text, read in the official text before VC-8-01 (30.10.2026): no historical version to confirm.
    verified: true,
  },
  source: `docs/germany/depreciation.md §3 v0.2 (verified 29.10.2026); verification-checklist B1–B3, B7; phase-8-plan P8-D4, P8-D11; ${SOURCE_SCHEDULE}`,
};

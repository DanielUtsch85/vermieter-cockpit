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
   * Whether the version may give a figure without the open flag `HISTORICAL_RULE_TO_VERIFY` (§59A, decided 2026-10-31),
   * split by what a confirmation covers: `rates` the bands (their `ratePercent` by the completion year), and
   * `shorterUsefulLifeThresholds` the years of S. 2 (`shorterThanYears`). A year is flagged while `rates` is false, and
   * a year computed with a shorter useful life also while `shorterUsefulLifeThresholds` is false. Neither covers the
   * methods DE does not recognise (§ 7 Abs. 5, 5a, § 7b, §§ 7h/7i, VC-X-37): those are no parameter of this rule.
   * The answers are taken in the same version until the first productive enablement (§60, open question 11).
   */
  readonly verified: { readonly rates: boolean; readonly shorterUsefulLifeThresholds: boolean };
  /** The building's acquisition cost (§58B, P8-D2): the same excluded categories as `DE_ANSCHAFFUNGSNAHE@1`. */
  readonly basis: {
    readonly excludedCostCategories: readonly string[];
    readonly allocationReviewStates: readonly string[];
    readonly rounding: 'HALF_UP_CENT';
    /** §59B (P8-D2): the classification states that feed a capitalised item's component; any other is not computed. */
    readonly capitalizedItemReviewStates: readonly string[];
    /**
     * §59B: the item's signed gross `lineAmount` of §58C, never its `netAmount`: non-deductible input VAT belongs to the
     * cost (§ 9b Abs. 1 EStG), within the scope without a VAT option (P8-D13). Prüfbericht 01.11.2026, Frage 10;
     * mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01.
     */
    readonly capitalizedItemAmount: 'GROSS_LINE_AMOUNT';
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
   * §28.1A, §59A: a share an owner reduces while holding several purchase components falls pro rata across all of them
   * (`PRO_RATA_ALL_COMPONENTS`, never the earliest or latest first). Open (`SHARE_REDUCTION_SPLIT_TO_VERIFY`) while
   * `verified` is false.
   */
  readonly shareReduction: { readonly method: 'PRO_RATA_ALL_COMPONENTS'; readonly verified: boolean; readonly legalBasis: string };
  /**
   * A new building bought in its completion year from this completion year on is not computable
   * (`DEPRECIATION_METHOD_UNKNOWN`): § 7b (from 2018) or § 7 Abs. 5a EStG (from 2023) may have been claimed (B4).
   */
  readonly methodUnknownFromCompletionYear: number;
  /**
   * §59B (P8-D6, B11): from when a later capitalised cost counts. `START_OF_YEAR` (R 7.4 Abs. 9 S. 3 EStR, decided
   * provisionally 2026-10-31) or `MONTH_OF_DATE`; never before the owner's start. Open (`SUBSEQUENT_COST_START_TO_VERIFY`)
   * while `verified` is false.
   */
  readonly subsequentCostStart: {
    readonly method: SubsequentCostStartMethod;
    readonly notBeforeOwnerStart: boolean;
    readonly verified: boolean;
    readonly legalBasis: string;
  };
  /** §59B (B11): a later cost runs at the owner's purchase rate; a shorter life is open while `shorterLifeVerified` is false. */
  readonly subsequentCostRate: { readonly rate: 'OWNER_PURCHASE_RATE'; readonly shorterLifeVerified: boolean };
  /**
   * §59B (R 7.4 Abs. 9 S. 1–2 EStR, decided provisionally 2026-10-31): one pooled basis per ownership tenure
   * (`POOLED_BASIS`) or each item part its own series (`PER_ITEM_SERIES`); both are computed, and the years in which
   * they differ are open (`SUBSEQUENT_COST_END_TO_VERIFY`). The remaining useful life of S. 2 is not computed.
   */
  readonly subsequentCostEnd: {
    readonly method: SubsequentCostEndMethod;
    readonly remainingUsefulLife: { readonly allowed: boolean; readonly computed: boolean };
    readonly verified: boolean;
    readonly legalBasis: string;
  };
}

export const SUBSEQUENT_COST_START_METHODS = ['START_OF_YEAR', 'MONTH_OF_DATE'] as const;
export type SubsequentCostStartMethod = (typeof SUBSEQUENT_COST_START_METHODS)[number];
export const SUBSEQUENT_COST_END_METHODS = ['POOLED_BASIS', 'PER_ITEM_SERIES'] as const;
export type SubsequentCostEndMethod = (typeof SUBSEQUENT_COST_END_METHODS)[number];

export const AFA_BUILDING_LINEAR = 'DE_AFA_BUILDING_LINEAR';

const SHORTER = '§ 7 Abs. 4 S. 2 EStG';
const TITLE = 'Lineare Gebäude-AfA im Privatvermögen (§ 7 Abs. 4 EStG)';
const LEGAL_BASIS = '§ 7 Abs. 4 S. 1 Nr. 2 und S. 2 EStG';

/**
 * The tax review of 01.11.2026 (docs/germany/pruefbericht-2026-11-01.md), taken into these versions in place before
 * the first productive enablement (api-design §60, open question 11; the pinned hashes of `frozen-rules.test.ts`).
 */
const CONFIRMED = 'Prüfbericht 01.11.2026, mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01';

/** The parameters both versions share (§59A); only the bands and `verified` differ. */
const COMMON = {
  shorterUsefulLife: { legalBasis: SHORTER, rate: 'RECIPROCAL_OF_YEARS' },
  basis: {
    excludedCostCategories: ['FINANCING_RELATED'],
    allocationReviewStates: ['CONFIRMED', 'ADVISOR_CONFIRMED'],
    rounding: 'HALF_UP_CENT',
    capitalizedItemReviewStates: ['USER_CONFIRMED', 'ADVISOR_CONFIRMED'],
    capitalizedItemAmount: 'GROSS_LINE_AMOUNT',
  },
  firstYear: { startMonthCounts: true, legalBasis: '§ 7 Abs. 1 S. 4 EStG' },
  end: {
    exhaustion: 'REMAINDER_IN_LAST_MONTH',
    disposal: {
      method: 'PRO_RATA_MONTHS',
      cutOff: 'BUYER_ECONOMIC_TRANSFER_DATE',
      endMonthCounts: true,
      verified: true,
      legalBasis: `R 7.4 Abs. 8 EStR; ${CONFIRMED}: Frage 4, the month of disposal counts in full for the seller`,
    },
  },
  rounding: { unit: 'CENT', mode: 'HALF_UP', method: 'CUMULATIVE_PER_OWNER_PART' },
  shareReduction: {
    method: 'PRO_RATA_ALL_COMPONENTS',
    verified: true,
    legalBasis: `${CONFIRMED}: Frage 11, a partial sale takes the share of each purchase pro rata, never FIFO or LIFO`,
  },
  methodUnknownFromCompletionYear: 2018,
  // §59B (VC-8-03), added to both versions additively: neither is frozen before VC-8-04.
  subsequentCostStart: {
    method: 'START_OF_YEAR',
    notBeforeOwnerStart: true,
    verified: false,
    legalBasis: 'R 7.4 Abs. 9 S. 3 EStR (reviewer input on #173; VERIFY)',
  },
  subsequentCostRate: { rate: 'OWNER_PURCHASE_RATE', shorterLifeVerified: false },
  subsequentCostEnd: {
    method: 'POOLED_BASIS',
    remainingUsefulLife: { allowed: true, computed: false },
    verified: false,
    legalBasis: 'R 7.4 Abs. 9 S. 1–2 EStR (review on #179; VERIFY)',
  },
} as const;

const SOURCE_SCHEDULE =
  'depreciation.md §5, §7 v0.2; verification-checklist B5, B6; phase-8-plan P8-D2, P8-D5, P8-D8, P8-D9; api-design §59A; depreciation.md §6 v0.2; verification-checklist B11; phase-8-plan P8-D6';

/**
 * Version 1 (§59A "The rule versions", decided 2026-10-31): the years 2006–2022, with the lettering of § 7 Abs. 4 S. 1
 * Nr. 2 EStG before the JStG 2022 (Buchst. a 2 % after 31.12.1924, Buchst. b 2.5 % before 1.1.1925) and the thresholds
 * of S. 2 then (50 / 40 years). The text was read in the official consolidated text (Stand 2.7.2012 and 13.2.2022) and
 * BT-Drs. 20/3879, 20/8628 on 31.10.2026 (depreciation.md §3). The rates by the completion year are confirmed
 * (Prüfbericht 01.11.2026, Frage 1; mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01):
 * `verified.rates` is true. Frage 8 confirms the thresholds < 33 / < 50 / < 40 in today's lettering; whether < 50 / < 40
 * held in 2006–2022 the review does not say expressly, and the text of 2006–2011 was not read directly (depreciation.md
 * §3). Until the owner decides that Frage 8 covers this lettering too, a year computed with a shorter useful life keeps
 * `HISTORICAL_RULE_TO_VERIFY` (`verified.shorterUsefulLifeThresholds` false).
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
    verified: { rates: true, shorterUsefulLifeThresholds: false },
  },
  source: `api-design §59A (decided 2026-10-31); EStG i. d. F. vor dem JStG 2022 (BGBl. I S. 2294); BT-Drs. 20/3879 S. 88; ${SOURCE_SCHEDULE}; ${CONFIRMED}: Fragen 1, 4, 10, 11`,
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
    verified: { rates: true, shorterUsefulLifeThresholds: true },
  },
  source: `docs/germany/depreciation.md §3 v0.2 (verified 29.10.2026); verification-checklist B1–B3, B7; phase-8-plan P8-D4, P8-D11; ${SOURCE_SCHEDULE}; ${CONFIRMED}: Fragen 4, 10, 11`,
};

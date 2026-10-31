import type { BusinessDate, RuleVersion } from '../../../shared/index.js';
import { DE_AFA_BUILDING_LINEAR_V2, type BuildingLinearParameters } from './de-afa-building-linear.js';

/** The parameters of the linear AfA of a movable separate asset (api-design.md §59B, P8-D7; § 7 Abs. 1 EStG). */
export interface MovableLinearParameters {
  /** The useful life is the asset's own fact (`usefulLifeYears`, B8); DE has no table of useful lives. */
  readonly usefulLife: { readonly from: 'ASSET'; readonly minYears: number; readonly maxYears: number; readonly rate: 'RECIPROCAL_OF_YEARS' };
  /** § 7 Abs. 1 S. 4 EStG (B6): the month of `acquiredOn` counts in full. */
  readonly firstYear: { readonly startMonthCounts: boolean; readonly from: 'ACQUIRED_ON'; readonly legalBasis: string };
  /** The items: the same review states and amount as the building's (§59B); a later item is open (`LATER_ITEM_TO_VERIFY`). */
  readonly basis: {
    readonly itemReviewStates: readonly string[];
    readonly amount: 'GROSS_LINE_AMOUNT';
    readonly laterItems: { readonly verified: boolean };
  };
  /** The same end as the building rule's (§59A): one end and one rounding for both. */
  readonly end: BuildingLinearParameters['end'];
  readonly rounding: BuildingLinearParameters['rounding'];
  /** B9: the GWG of § 6 Abs. 2 EStG is a hint only; the Sammelposten is not modelled. */
  readonly gwgHint: { readonly netThreshold: string; readonly legalBasis: string; readonly sammelposten: boolean };
}

export const AFA_MOVABLE_LINEAR = 'DE_AFA_MOVABLE_LINEAR';

/**
 * Version 1 (§59B, VC-8-03): from 2023-01-01, aligned with `DE_AFA_BUILDING_LINEAR@2`. A separate asset acquired
 * before 2023 is not computed (`NO_APPLICABLE_RULE`, decided 2026-10-31) until a verified earlier version exists.
 * Frozen with VC-8-04, as the building rule.
 */
export const DE_AFA_MOVABLE_LINEAR_V1: RuleVersion<MovableLinearParameters> = {
  ruleCode: AFA_MOVABLE_LINEAR,
  version: 1,
  title: 'Lineare AfA beweglicher Wirtschaftsgüter (§ 7 Abs. 1 EStG)',
  legalBasis: '§ 7 Abs. 1 EStG (S. 4: the first year)',
  effectiveFrom: '2023-01-01' as BusinessDate,
  effectiveTo: null,
  parameters: {
    usefulLife: { from: 'ASSET', minYears: 1, maxYears: 99, rate: 'RECIPROCAL_OF_YEARS' },
    firstYear: { startMonthCounts: true, from: 'ACQUIRED_ON', legalBasis: '§ 7 Abs. 1 S. 4 EStG' },
    basis: { itemReviewStates: ['USER_CONFIRMED', 'ADVISOR_CONFIRMED'], amount: 'GROSS_LINE_AMOUNT', laterItems: { verified: false } },
    end: DE_AFA_BUILDING_LINEAR_V2.parameters.end,
    rounding: DE_AFA_BUILDING_LINEAR_V2.parameters.rounding,
    gwgHint: { netThreshold: '800.00', legalBasis: '§ 9 Abs. 1 S. 3 Nr. 7 S. 2 i. V. m. § 6 Abs. 2 S. 1–3 EStG', sammelposten: false },
  },
  source: 'docs/germany/depreciation.md §5, §6 v0.2 (verified 29.10.2026); verification-checklist B6, B8, B9; phase-8-plan P8-D7; api-design §59B',
};

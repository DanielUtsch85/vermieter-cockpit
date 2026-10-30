import type { BusinessDate } from '../../../shared/index.js';
import type { RuleVersion } from './rule-version.js';

/** The parameters of the tax year of cash (api-design.md §58A, P7-D3). */
export interface CashTimingParameters {
  /** The days on either side of the year-end: 22 December to 10 January for 10 (A4). */
  readonly windowDays: number;
  /** The regularly recurring categories, by `financial_category.code`; every other category takes the booking year. */
  readonly recurringCategories: readonly string[];
}

export const CASH_TIMING = 'DE_CASH_TIMING';

/**
 * Version 1 (§58A): the calendar year of the booking date (Zufluss/Abfluss, § 11 Abs. 1 S. 1, Abs. 2 S. 1 EStG), except
 * for a regularly recurring amount whose due date and payment both fall within 10 days of the year-end: it belongs to
 * the year it economically belongs to (§ 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG; taxation.md §3, checklist A4).
 */
export const DE_CASH_TIMING_V1: RuleVersion<CashTimingParameters> = {
  ruleCode: CASH_TIMING,
  version: 1,
  title: 'Steuerjahr des Zu- und Abflusses (10-Tage-Regel)',
  legalBasis: '§ 11 Abs. 1 S. 2 und Abs. 2 S. 2 EStG',
  effectiveFrom: '2000-01-01' as BusinessDate,
  effectiveTo: null,
  parameters: {
    windowDays: 10,
    recurringCategories: ['RENT_BASE', 'RENT_OPERATING_COST_ADVANCE', 'WEG_RECOVERABLE', 'WEG_NON_RECOVERABLE', 'LOAN_INTEREST'],
  },
  source: 'docs/germany/taxation.md §3 (v0.2); phase-7-plan P7-D3 (review on #156); api-design §58A (review on #159); verification-checklist A4',
};

import type { BusinessDate, Money } from '../shared/index.js';

/** The refusals of a classification's period of performance (api-design.md §59F "API", VC-X-38). */

/** A split that is interest by §59E's list takes no performance (→ 400 NOT_ALLOWED at `performance`). */
export class PerformanceNotAllowedError extends Error {
  override readonly name = 'PerformanceNotAllowedError';

  constructor() {
    super('performance is not allowed on interest');
  }
}

/** A point not below the amount used (→ 422 PERFORMANCE_PROGRESS_EXCEEDS_AMOUNT). */
export class PerformanceProgressExceedsAmountError extends Error {
  override readonly name = 'PerformanceProgressExceedsAmountError';

  constructor(
    readonly amountUsed: Money,
    readonly amount: Money,
  ) {
    super(`A point of ${amount.amount} is not below the amount used ${amountUsed.amount}`);
  }
}

/** Points without a source reference (→ 422 PERFORMANCE_EVIDENCE_REQUIRED, the owner's decision of 2026-11-02). */
export class PerformanceEvidenceRequiredError extends Error {
  override readonly name = 'PerformanceEvidenceRequiredError';

  constructor() {
    super('Points of performance need at least one source reference as evidence');
  }
}

/** A date outside the plausible years around the source's date (→ 422 PERFORMANCE_OUT_OF_RANGE). */
export class PerformanceOutOfRangeError extends Error {
  override readonly name = 'PerformanceOutOfRangeError';

  constructor(
    readonly details: {
      readonly sourceDate: BusinessDate;
      readonly from: BusinessDate;
      readonly until: BusinessDate;
      readonly allowedFrom: BusinessDate;
      readonly allowedUntil: BusinessDate;
    },
  ) {
    super(`The performance ${details.from}–${details.until} lies outside ${details.allowedFrom}–${details.allowedUntil}`);
  }
}

import type { BusinessDate, Money, RuleRef, RuleStatus } from '../../shared/index.js';
import type { AllocationBasis } from '../financing/index.js';
import type { Direction } from '../ledger/index.js';
import type { CheckStatus, NotFinalReason } from './anschaffungsnahe.js';
import type { RefundInfo } from './cash-timing.js';
import type { TreatmentSuggestion } from './tax-meaning.js';
import type { Distribution } from './distribution-82b.js';
import type { Origin, ReviewState, SourceType, TaxCategory, Treatment } from './vocabulary.js';
import type { ConfirmationMark } from './tax-statements.js';
import type { TreatmentPart } from './treatment-parts.js';
import type { InterestPeriodSource } from './loan-interest-periods.js';

/** The tax-year view as it answers (api-design.md §58C "Response"): its items, lines, sections, totals and review. */

export type Level = 'PROPERTY' | 'OWNER';

export interface ViewFlag {
  readonly code: string;
  readonly details: unknown;
}

/** An item of the view (§58C "Response"). */
export interface TaxYearItem {
  readonly sourceType: SourceType;
  readonly sourceId: string;
  readonly sourcePosition: number | null;
  readonly transactionId: string | null;
  readonly date: BusinessDate;
  readonly dateSource: string;
  readonly taxYear: number | null;
  readonly direction: Direction | null;
  readonly amount: Money;
  readonly lineAmount: Money | null;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: ReviewState;
  readonly origin: Origin;
  readonly classificationId: string | null;
  readonly rule: RuleRef | null;
  readonly treatmentRule: RuleRef | null;
  readonly attribution: unknown;
  readonly refund: RefundInfo | null;
  readonly distribution:
    | (Distribution & { readonly yearAmount: Money; readonly ownerParts: readonly { readonly year: number; readonly amount: Money }[] | null })
    | null;
  readonly suggestion: TreatmentSuggestion | null;
  readonly share: { readonly ownershipId: string; readonly share: string; readonly amount: Money | null } | null;
  readonly flags: readonly ViewFlag[];
  /** "nicht zugeordnet" only: why, the candidates, and the deposit's tax meaning or the Loan's allocation on the day. */
  readonly notAttributed: {
    readonly reason: string;
    readonly candidates: readonly string[];
    readonly href: string;
    /** §58L: a Loan's split only: its interest period (`null` without one) and the days without a set. */
    readonly interestPeriod?: TaxYearLoanAllocation['interestPeriod'];
    readonly uncovered?: readonly { readonly from: BusinessDate; readonly until: BusinessDate }[];
  } | null;
  /** An item from a Loan's interest split only (§58D): the set covering its booking date and this property's part. */
  readonly loanAllocation: TaxYearLoanAllocation | null;
  /** §59F (VC-X-38 Part 2): the part of a partially treated source the item stands for (`lineAmount` is its amount); absent otherwise. */
  readonly treatmentPart?: TreatmentPart;
  /** An item of `capitalized` only (VC-8-05): the AfA component it became, or `NO_ASSET`; `null` when no asset lists it. */
  readonly component?: CapitalizedComponent | null;
}

/** The component a capitalised item became (§58C "VC-8-05", `capitalized`). */
export interface CapitalizedComponent {
  readonly assetId: string | null;
  readonly assetType: 'BUILDING' | 'SEPARATE_ASSET' | null;
  readonly componentId: string | null;
  readonly computable: boolean;
  readonly reasons: readonly ViewFlag[];
}

/** A component computed for `year` on an AfA line (§58C "VC-8-05"): never a cash item, no Transaction, no split. */
export interface AfaItem {
  readonly assetId: string;
  readonly assetType: 'BUILDING' | 'SEPARATE_ASSET';
  readonly description: string | null;
  readonly componentId: string;
  readonly kind: 'ACQUISITION' | 'CAPITALIZED_ITEM';
  readonly acquisitionId: string | null;
  readonly source: { readonly sourceType: string; readonly sourceId: string; readonly sourcePosition: number | null } | null;
  readonly basis: Money | null;
  readonly rate: {
    readonly kind: string;
    readonly rate: string;
    readonly ratePercent: string;
    readonly usefulLifeYears: number | null;
    readonly legalBasis: string;
  } | null;
  readonly start: {
    readonly date: BusinessDate | null;
    readonly dateSource: string;
    readonly method: string;
    readonly month: string | null;
    readonly firstYearMonths: number | null;
  } | null;
  readonly months: number | null;
  readonly amount: Money;
  readonly rule: RuleRef | null;
  /** `null` at the property level; the owner's (or `NOT_OWNED`'s) part of the schedule, never re-split. */
  readonly share: {
    readonly ownershipId: string;
    readonly share: string | null;
    readonly amount: Money;
    readonly ownershipIds: readonly string[];
    readonly partKey: string;
  } | null;
  readonly href: string;
  readonly flags: readonly ViewFlag[];
}

/** `AFA_BUILDING` or `AFA_SEPARATE_ASSETS`, after `OTHER_EXPENSE` (decided 2026-10-31, second set, Q4). */
export interface AfaLine {
  readonly line: 'AFA_BUILDING' | 'AFA_SEPARATE_ASSETS';
  readonly taxCategory: null;
  readonly total: Money;
  readonly itemCount: number;
  readonly subtotals: null;
  readonly items: readonly AfaItem[];
}

/** The `depreciation` block (§58C "VC-8-05"), replacing Phase 7's `DEPRECIATION_NOT_AVAILABLE` placeholder. */
export interface TaxYearDepreciationBlock {
  readonly status: 'AVAILABLE' | 'PARTIAL' | 'DEPRECIATION_NOT_AVAILABLE';
  readonly amount: Money | null;
  readonly assets: readonly {
    readonly assetId: string;
    readonly assetType: 'BUILDING' | 'SEPARATE_ASSET';
    readonly description: string | null;
    readonly reviewState: string;
    readonly status: 'AVAILABLE' | 'PARTIAL' | 'DEPRECIATION_NOT_AVAILABLE';
    readonly amount: Money | null;
    readonly itemCount: number;
    readonly reasons: readonly ViewFlag[];
    readonly recording: {
      readonly state: string;
      readonly versionId: string | null;
      readonly versionNumber: number | null;
      readonly throughYear: number | null;
      readonly reproducible: boolean | null;
    } | null;
    readonly href: string;
  }[];
  readonly gaps: readonly {
    readonly code: string;
    readonly assetId: string | null;
    readonly componentId: string | null;
    readonly ownerPartyIds: readonly string[];
    readonly details: unknown;
  }[];
  readonly note: string;
}

/**
 * The Loan's allocation behind an interest item (api-design.md §58D "API shape", §58L "In the view"): the set when one
 * set covers the whole interest period (or, without a period, the split's booking date; all `null` otherwise), the
 * property's reduced weight `w_P` (`share`, equal to its share in that one set) and its non-negative part of the split
 * (both `null` when not attributed). At the owner level `propertyPart` stays the property's part.
 */
export interface TaxYearLoanAllocation {
  readonly loanId: string;
  /** §58L: the split's interest period; `null` without one (rule 8, `INTEREST_PERIOD_UNKNOWN`). */
  readonly interestPeriod: { readonly from: BusinessDate; readonly until: BusinessDate; readonly source: InterestPeriodSource } | null;
  /** §58L: the runs of days with one set, by `from`, with P's share in each (`null` where P has no entry); `[]` without a period. */
  readonly segments: readonly {
    readonly from: BusinessDate;
    readonly until: BusinessDate;
    readonly allocationSetId: string;
    readonly basis: AllocationBasis;
    readonly share: string | null;
    /** §58V: the segment set's part outside letting, `null` without. */
    readonly outsideLettingShare: string | null;
  }[];
  readonly allocationSetId: string | null;
  readonly validFrom: BusinessDate | null;
  readonly validUntil: BusinessDate | null;
  readonly basis: AllocationBasis | null;
  readonly share: string | null;
  readonly propertyPart: Money | null;
  /** §58E: the set's `ACTIVE` tax confirmation; `null` without one and on every `MANUAL` or one-entry set. */
  readonly taxConfirmation: ConfirmationMark | null;
  /**
   * §58V (Entscheidung des Projektinhabers, 2026-11-07, question 6): the split's weight outside letting `w_O` and its
   * part, the same in every view of the split; no figure of any view. `null` without one and on a not attributed split.
   */
  readonly outsideLetting: { readonly share: string; readonly part: Money } | null;
}

export interface TaxYearLine {
  /** The line code: the `taxCategory` on a cash line (VC-8-05). */
  readonly line: string;
  readonly taxCategory: TaxCategory;
  readonly total: Money;
  readonly itemCount: number;
  readonly subtotals: { readonly immediate: Money; readonly distributed82b: Money } | null;
  readonly items: readonly TaxYearItem[];
}

export interface TaxYearSection {
  readonly total: Money;
  readonly lines: readonly TaxYearLine[];
  /** Werbungskosten only (VC-8-05): `AFA_BUILDING` and `AFA_SEPARATE_ASSETS`, answered after the cash lines. */
  readonly afaLines?: readonly AfaLine[];
}

export interface TaxYearResult {
  readonly amount: Money;
  readonly kind: 'SURPLUS' | 'LOSS' | 'ZERO';
  readonly basis: 'AFTER_DEPRECIATION' | 'PARTIAL_DEPRECIATION' | 'BEFORE_DEPRECIATION';
}

/** An owner's (or `NOT_OWNED`'s) totals at the property level: summed from their item parts, never distributed. */
export interface TaxYearTotals {
  readonly einnahmen: { readonly total: Money; readonly lines: readonly Omit<TaxYearLine, 'items'>[] };
  readonly werbungskosten: {
    readonly total: Money;
    readonly lines: readonly Omit<TaxYearLine, 'items'>[];
    readonly afaLines?: readonly Omit<AfaLine, 'items'>[];
  };
  readonly result: TaxYearResult;
  readonly capitalized: { readonly total: Money };
}

export interface TaxYearAcquisition {
  readonly acquisitionId: string;
  /** §58K (VC-X-34): `null` without `economicTransferDate` (then `window` is `null` and the check `NOT_COMPUTABLE`). */
  readonly transferDate: BusinessDate | null;
  readonly window: { readonly from: BusinessDate; readonly until: BusinessDate } | null;
  readonly status: CheckStatus;
  readonly final: boolean;
  readonly notFinalReasons: readonly NotFinalReason[];
  readonly href: string;
}

export interface TaxYearRuleVersion {
  readonly ruleCode: string;
  readonly version: number;
  readonly title: string | null;
  readonly legalBasis: string | null;
  readonly status: RuleStatus | null;
  readonly itemCount: number;
}

export interface TaxYearReview {
  readonly final: boolean;
  readonly open: readonly { readonly code: string; readonly count: number }[];
  readonly info: readonly { readonly code: string; readonly count: number }[];
  readonly reviewStates: Readonly<Record<ReviewState, number>>;
}

export interface TaxYearView {
  readonly propertyReferenceId: string;
  readonly year: number;
  readonly ownerPartyId: string | null;
  readonly level: Level;
  readonly computedOn: BusinessDate;
  readonly einnahmen: TaxYearSection;
  readonly werbungskosten: TaxYearSection;
  readonly depreciation: TaxYearDepreciationBlock;
  readonly result: TaxYearResult;
  readonly capitalized: { readonly total: Money; readonly items: readonly TaxYearItem[] };
  readonly notInView: { readonly items: readonly TaxYearItem[] };
  readonly unclassified: { readonly items: readonly TaxYearItem[] };
  readonly notAttributed: { readonly items: readonly TaxYearItem[] };
  readonly acquisitions: readonly TaxYearAcquisition[];
  readonly owners: readonly (TaxYearTotals & { readonly ownerPartyId: string; readonly ownershipIds: readonly string[] })[] | null;
  readonly notOwned: TaxYearTotals | null;
  readonly flags: readonly ViewFlag[];
  readonly review: TaxYearReview;
  readonly ruleVersions: readonly TaxYearRuleVersion[];
}

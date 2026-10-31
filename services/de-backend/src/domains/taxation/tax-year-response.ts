import type { BusinessDate, Money, RuleRef, RuleStatus } from '../../shared/index.js';
import type { AllocationBasis } from '../financing/index.js';
import type { Direction } from '../ledger/index.js';
import type { CheckStatus, NotFinalReason } from './anschaffungsnahe.js';
import type { RefundInfo } from './cash-timing.js';
import type { TreatmentSuggestion } from './tax-meaning.js';
import type { Distribution } from './distribution-82b.js';
import type { Origin, ReviewState, SourceType, TaxCategory, Treatment } from './vocabulary.js';

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
  readonly notAttributed: { readonly reason: string; readonly candidates: readonly string[]; readonly href: string } | null;
  /** An item from a Loan's interest split only (§58D): the set covering its booking date and this property's part. */
  readonly loanAllocation: TaxYearLoanAllocation | null;
}

/**
 * The Loan's allocation behind an interest item (api-design.md §58D "API shape"): the set covering the split's booking
 * date (all `null` for `NO_LOAN_ALLOCATION`), the property's reduced share in it and its non-negative part of the split
 * (both `null` when not attributed). At the owner level `propertyPart` stays the property's part.
 */
export interface TaxYearLoanAllocation {
  readonly loanId: string;
  readonly allocationSetId: string | null;
  readonly validFrom: BusinessDate | null;
  readonly validUntil: BusinessDate | null;
  readonly basis: AllocationBasis | null;
  readonly share: string | null;
  readonly propertyPart: Money | null;
}

export interface TaxYearLine {
  readonly taxCategory: TaxCategory;
  readonly total: Money;
  readonly itemCount: number;
  readonly subtotals: { readonly immediate: Money; readonly distributed82b: Money } | null;
  readonly items: readonly TaxYearItem[];
}

export interface TaxYearSection {
  readonly total: Money;
  readonly lines: readonly TaxYearLine[];
}

export interface TaxYearResult {
  readonly amount: Money;
  readonly kind: 'SURPLUS' | 'LOSS' | 'ZERO';
  readonly basis: 'BEFORE_DEPRECIATION';
}

/** An owner's (or `NOT_OWNED`'s) totals at the property level: summed from their item parts, never distributed. */
export interface TaxYearTotals {
  readonly einnahmen: { readonly total: Money; readonly lines: readonly Omit<TaxYearLine, 'items'>[] };
  readonly werbungskosten: { readonly total: Money; readonly lines: readonly Omit<TaxYearLine, 'items'>[] };
  readonly result: TaxYearResult;
  readonly capitalized: { readonly total: Money };
}

export interface TaxYearAcquisition {
  readonly acquisitionId: string;
  readonly transferDate: BusinessDate;
  readonly window: { readonly from: BusinessDate; readonly until: BusinessDate };
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
  readonly depreciation: { readonly status: 'DEPRECIATION_NOT_AVAILABLE'; readonly amount: null; readonly note: string };
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

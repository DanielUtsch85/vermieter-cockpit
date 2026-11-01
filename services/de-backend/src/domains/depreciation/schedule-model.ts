import type { BusinessDate, Money, RuleStatus } from '../../shared/index.js';
import type { BasisCostClassification, UnclassifiedCost } from '../acquisition/index.js';
import type { DepreciationAsset } from './asset.js';
import type { CapitalizedItem, ItemRef } from './capitalized-item.js';
import type { BuildingBand } from './rules/de-afa-building-linear.js';
import type { ScheduleVersion } from './version-model.js';

/**
 * The schedule's inputs and its response (api-design.md §59A, §59B): the snapshot read by the repository, the purchase
 * components (`ACQUISITION`) and the item components (`CAPITALIZED_ITEM`), their years and the schedule's years. Types
 * only, besides the range's bounds; moved out of `schedule.ts` and `schedule-items.ts` unchanged (issue #191).
 */

// ---------------------------------------------------------------------------------------------------------------------
// Inputs (read by the repository in one snapshot)

export interface ScheduleCost {
  readonly id: string;
  readonly category: string;
  readonly amount: Money;
  /** §27.2's payment status of the `ACTIVE` cost. */
  readonly paymentStatus: string | null;
  /** §59D: the current classification, `null` without one. */
  readonly classification: BasisCostClassification | null;
}

export interface ScheduleAllocation {
  readonly id: string;
  readonly method: string;
  readonly reviewState: string;
  readonly totalAllocableAmount: Money;
  readonly buildingAmount: Money;
}

/** An Acquisition of the asset's PropertyReference that is not `CANCELLED`, with its `ACTIVE` costs and current allocation. */
export interface ScheduleAcquisition {
  readonly id: string;
  readonly status: string;
  readonly purchasePrice: Money;
  readonly acquiredShare: { readonly numerator: number; readonly denominator: number };
  readonly contractDate: BusinessDate;
  readonly economicTransferDate: BusinessDate | null;
  readonly sellerPartyIds: readonly string[];
  readonly costs: readonly ScheduleCost[];
  readonly allocation: ScheduleAllocation | null;
}

/** A `VALID` Ownership of the asset's PropertyReference. */
export interface ScheduleOwnership {
  readonly id: string;
  readonly partyId: string;
  readonly share: { readonly numerator: number; readonly denominator: number };
  readonly validFrom: BusinessDate;
  readonly validUntil: BusinessDate | null;
  readonly acquisitionId: string | null;
}

export interface ScheduleInput {
  readonly asset: DepreciationAsset;
  readonly acquisitions: readonly ScheduleAcquisition[];
  readonly ownerships: readonly ScheduleOwnership[];
  /** Today in Europe/Berlin: `computedOn` and the default range only; the figures never depend on it. */
  readonly today: BusinessDate;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly ownerPartyId: string | null;
  /** §59B: the capitalised items of the PropertyReference (and a separate asset's linked items), from Taxation's derivation. */
  readonly capitalizedItems?: readonly CapitalizedItem[];
  /** §59B: the links of the PropertyReference's `ACTIVE` separate assets (the building excludes their items). */
  readonly links?: readonly AssetLink[];
}

/** An item linked to an `ACTIVE` separate asset (§59B, migration 0051). */
export interface AssetLink extends ItemRef {
  readonly assetId: string;
}

/** What the snapshot read gives the derivation (§59A "One snapshot"). */
export interface ScheduleRead {
  readonly asset: DepreciationAsset;
  readonly acquisitions: readonly ScheduleAcquisition[];
  readonly ownerships: readonly ScheduleOwnership[];
  readonly capitalizedItems: readonly CapitalizedItem[];
  readonly links: readonly AssetLink[];
  /** Whether `ownerPartyId` names a Party of the caller's Realm; `null` without one. */
  readonly ownerPartyFound: boolean | null;
  /** §60: the asset's `CURRENT` recorded version, read in the same snapshot; `null` without one. */
  readonly currentVersion?: ScheduleVersion | null;
}

/** The schedule's inputs in one `REPEATABLE READ READ ONLY` transaction (P8-D14); undefined for an unknown or foreign asset. */
export interface DepreciationScheduleSource {
  read(assetId: string, mreRealmId: string, ownerPartyId: string | null): Promise<ScheduleRead | undefined>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Output

export interface Flag {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type CalculationStatus = 'NOT_CALCULABLE' | 'PROVISIONAL' | 'CALCULATED';
export type ScheduleStatus = 'AVAILABLE' | 'PARTIAL' | 'DEPRECIATION_NOT_AVAILABLE';

export interface ComponentBasis {
  readonly amount: Money | null;
  readonly purchasePrice: Money;
  readonly acquisitionCosts: Money;
  /** §59D: by category and purpose (`null` for an excluded category). */
  readonly excludedCosts: readonly { readonly category: string; readonly purpose: string | null; readonly amount: Money }[];
  /** §59D: the costs that are not classified (not in `amount`), and the basis with them (the upper bound). */
  readonly unclassifiedCosts: readonly UnclassifiedCost[];
  readonly amountWithUnclassified: Money | null;
  readonly allocationId: string | null;
  readonly allocationMethod: string | null;
  readonly allocationReviewState: string | null;
  readonly totalAllocableAmount: Money | null;
  readonly buildingAmount: Money | null;
}

export interface ComponentRate {
  readonly kind: 'BAND' | 'SHORTER_USEFUL_LIFE';
  readonly band: BuildingBand;
  readonly ratePercent: string;
  readonly rate: string;
  readonly usefulLifeYears: number | null;
  readonly legalBasis: string;
}

export interface ComponentOwner {
  readonly ownerPartyId: string;
  readonly ownershipId: string;
  readonly share: string;
  /** §28.1A: the share held the day before the transfer date, and the increase bought in this component. */
  readonly shareBefore: string;
  readonly acquiredShare: string;
  readonly weight: string;
  readonly basis: Money | null;
  readonly tenure: {
    /** The component's start; `null` while it is unknown (`TRANSFER_DATE_MISSING`). */
    readonly from: BusinessDate | null;
    readonly lastDay: BusinessDate | null;
    readonly lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' | 'VALID_UNTIL' | null;
  };
}

export interface OwnerYear {
  readonly ownerPartyId: string;
  readonly months: number | null;
  readonly fraction: string | null;
  readonly amount: Money | null;
  readonly residualValue: Money | null;
  readonly calculationStatus: CalculationStatus;
  readonly reasons: readonly Flag[];
  readonly flags: readonly Flag[];
}

export interface YearRule {
  readonly ruleCode: string;
  readonly version: number;
  readonly band: BuildingBand | null;
  readonly legalBasis: string | null;
}

export interface ComponentYear {
  readonly year: number;
  readonly rule: YearRule | null;
  readonly months: number | null;
  readonly amount: Money | null;
  readonly cumulative: Money | null;
  readonly residualValue: Money | null;
  readonly calculationStatus: CalculationStatus;
  readonly reasons: readonly Flag[];
  readonly owners: readonly OwnerYear[];
  /** §59B: the `NOT_OWNED` part's amount of an item component; `null` on a purchase and without one. */
  readonly notOwned: Money | null;
  readonly flags: readonly Flag[];
}

/** §59C: the purchase's method entry as stored (without the evidence), with its derived status and causes. */
export interface ComponentMethod {
  readonly consideration: string;
  readonly method: string;
  readonly specialDepreciation: readonly string[];
  readonly subsidiesReceived: boolean;
  readonly newBuildingByConversion: boolean;
  readonly otherSpecialCase: boolean;
  readonly otherSpecialCaseNote: string | null;
  readonly reviewState: string;
  readonly advisorPartyId: string | null;
  readonly notes: string | null;
  /** `null` only without a rule version to judge it. */
  readonly methodStatus: 'STANDARD' | 'NOT_SUPPORTED' | null;
  readonly causes: readonly string[] | null;
}

export interface ScheduleComponent {
  readonly componentId: string;
  readonly kind: 'ACQUISITION';
  readonly acquisitionId: string;
  readonly acquisitionStatus: string;
  readonly status: 'COMPUTABLE' | 'NOT_COMPUTABLE';
  readonly reasons: readonly Flag[];
  /** §59C: `null` without an entry (the component is then `DEPRECIATION_METHOD_NOT_CONFIRMED`). */
  readonly method: ComponentMethod | null;
  readonly basis: ComponentBasis;
  /** `null` without `economicTransferDate`: the component is not computable (`TRANSFER_DATE_MISSING`, VC-X-33). */
  readonly start: {
    readonly date: BusinessDate;
    readonly dateSource: 'ECONOMIC_TRANSFER_DATE';
    readonly month: string;
    readonly firstYearMonths: number;
  } | null;
  readonly rate: ComponentRate | null;
  readonly end: { readonly lastYear: number; readonly lastMonth: string } | null;
  readonly owners: readonly ComponentOwner[];
  readonly years: readonly ComponentYear[];
  readonly flags: readonly Flag[];
}

export interface ScheduleYear {
  readonly year: number;
  readonly status: ScheduleStatus;
  readonly calculationStatus: CalculationStatus;
  readonly amount: Money | null;
  readonly residualValue: Money | null;
  readonly owners: readonly { readonly ownerPartyId: string; readonly amount: Money | null }[] | null;
  readonly notOwned: Money | null;
  readonly reasons: readonly Flag[];
  readonly flags: readonly Flag[];
}

export interface DepreciationSchedule {
  readonly assetId: string;
  readonly propertyReferenceId: string;
  readonly assetType: string;
  readonly level: 'PROPERTY' | 'OWNER';
  readonly ownerPartyId: string | null;
  readonly computedOn: BusinessDate;
  readonly range: { readonly from: number; readonly to: number; readonly truncated: boolean };
  readonly status: ScheduleStatus;
  readonly reasons: readonly Flag[];
  /** §59B: the schedule's own flags (`GWG_THRESHOLD_MAY_APPLY` on a separate asset). */
  readonly flags: readonly Flag[];
  readonly asset: {
    readonly status: string;
    readonly buildingCompletionYear?: number | null;
    readonly description?: string | null;
    readonly usefulLifeYears?: number | null;
    readonly acquiredOn?: BusinessDate | null;
    readonly reviewState: string;
  };
  /** The purchase components (§59A) and the item components (§59B), in that order. */
  readonly components: readonly (ScheduleComponent | ItemComponent)[];
  /** §59B: on the building, the items of `ACTIVE` separate assets (by `componentId`); on a separate asset `null`. */
  readonly excludedItems: readonly { readonly componentId: string; readonly separateAssetId: string }[] | null;
  readonly years: readonly ScheduleYear[];
  readonly review: { readonly open: readonly { code: string; count: number }[]; readonly info: readonly { code: string; count: number }[] };
  readonly ruleVersions: readonly {
    readonly ruleCode: string;
    readonly version: number;
    readonly title: string;
    readonly legalBasis: string;
    readonly status: RuleStatus;
    readonly years: readonly number[];
  }[];
}

export const RANGE_MIN_YEAR = 2000;
export const RANGE_MAX_YEAR = 2100;

// ---------------------------------------------------------------------------------------------------------------------
// The item components (§59B)

export interface ItemSourceView extends ItemRef {
  readonly classificationId: string | null;
  readonly reviewState: string | null;
  readonly taxCategory: string | null;
  readonly date: BusinessDate | null;
  readonly dateSource: string | null;
  readonly taxYear: number | null;
  readonly anschaffungsnaheAcquisitionId: string | null;
  /** §59E, additively: the Loan of a Loan interest source with P's part (`null` otherwise), and the record named. */
  readonly loan: { readonly loanId: string; readonly allocationSetId: string; readonly share: string; readonly propertyPart: Money } | null;
  readonly constructionPeriodInterestId: string | null;
}

export interface ItemComponentRate {
  readonly kind: 'BAND' | 'USEFUL_LIFE';
  readonly band: BuildingBand | null;
  readonly ratePercent: string;
  readonly rate: string;
  readonly usefulLifeYears: number | null;
  readonly legalBasis: string;
}

export interface ItemOwner {
  readonly ownerPartyId: string;
  readonly ownershipIds: readonly string[];
  readonly share: string;
  readonly basis: Money;
  /** `null` while the owner's start is unknown (`TRANSFER_DATE_MISSING`). */
  readonly firstMonth: string | null;
  /** The part's annual rate (`"1/50"`, `"1/30"` with a shorter life), `null` when it is not known. */
  readonly rate: string | null;
  readonly tenure: {
    readonly from: BusinessDate | null;
    readonly lastDay: BusinessDate | null;
    readonly lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' | 'VALID_UNTIL' | null;
  };
}

/** A component of `kind` `CAPITALIZED_ITEM` (§59B "The component"). */
export interface ItemComponent {
  readonly componentId: string;
  readonly kind: 'CAPITALIZED_ITEM';
  readonly source: ItemSourceView;
  readonly status: 'COMPUTABLE' | 'NOT_COMPUTABLE';
  readonly reasons: readonly Flag[];
  readonly basis: { readonly amount: Money | null; readonly netAmount: Money | null; readonly amountUsed: 'GROSS_LINE_AMOUNT' };
  readonly start: {
    readonly date: BusinessDate | null;
    readonly dateSource: 'ITEM_DATE' | 'ACQUIRED_ON';
    readonly method: 'START_OF_YEAR' | 'MONTH_OF_DATE' | 'MONTH_OF_ACQUISITION';
    readonly month: string | null;
    readonly firstYearMonths: number | null;
  };
  readonly rate: ItemComponentRate | null;
  readonly end: { readonly lastYear: number; readonly lastMonth: string } | null;
  readonly owners: readonly ItemOwner[];
  readonly notOwned: { readonly share: string; readonly basis: Money } | null;
  readonly years: readonly ComponentYear[];
  readonly flags: readonly Flag[];
}

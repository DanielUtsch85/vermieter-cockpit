/**
 * Acquisition domain: the purchase of a share of a PropertyReference (data-model.md §13, api-design.md §27.1).
 * See docs/development/coding-guidelines.md §3.
 */
export { ACQUISITION_STATUSES, buyerIncreases, createFingerprint, planCancel, planConfirm, structureViolations, sumOf, transferDate } from './acquisition.js';
export type {
  AcquiredShare,
  Acquisition,
  AcquisitionData,
  AcquisitionFilter,
  AcquisitionId,
  AcquisitionPage,
  AcquisitionRepository,
  AcquisitionStatus,
  BuyerIncrease,
  CancelAcquisitionOutcome,
  CancelPlan,
  ConfirmAcquisitionOutcome,
  ConfirmationInput,
  ConfirmationOwnership,
  ConfirmationViolation,
  ConfirmPlan,
  ExactFraction,
  CreateAcquisitionOutcome,
  NewAcquisition,
} from './acquisition.js';
export {
  COST_CATEGORIES,
  COST_STATUSES,
  checkLink,
  costFingerprint,
  isCurrentTransaction,
  notCountingReason,
  paymentFingerprint,
  paymentStatusOf,
  planUnlink,
  planVoidCost,
} from './cost.js';
export type {
  AcquisitionCost,
  AcquisitionCostRepository,
  AcquisitionPayment,
  CostCategory,
  CostData,
  CostFilter,
  CostStatus,
  CreateCostOutcome,
  LinkContext,
  LinkPaymentOutcome,
  LinkRefusal,
  NewAcquisitionCost,
  NewAcquisitionPayment,
  NotCountingReason,
  PaymentData,
  PaymentFilter,
  PaymentStatus,
  PurchasePricePayments,
  UnlinkPaymentOutcome,
  UnlinkPlan,
  VoidCostOutcome,
  VoidCostPlan,
} from './cost.js';
export { ALLOCATION_METHODS, ALLOCATION_REVIEW_STATES, allocationFingerprint, checkAllocation, shareOf } from './allocation.js';
export type {
  AllocationData,
  AllocationMethod,
  AllocationRefusal,
  AllocationReviewState,
  CreateAllocationOutcome,
  LandBuildingAllocation,
  LandBuildingAllocationRepository,
  NewAllocation,
} from './allocation.js';
export { fromCents, largestRemainder, planOwnerAllocation, toCents } from './owner-allocation.js';
export type { AllocationBasis, AllocationTotals, OwnerAllocationInput, OwnerAllocationPlan, OwnerAllocationSource, OwnerPart } from './owner-allocation.js';
export { BUILDING_COST_REASONS, buildingAcquisitionCost } from './building-cost.js';
export type { BasisAcquisition, BasisAllocation, BasisCost, BasisPolicy, BuildingAcquisitionCost, BuildingCostReason } from './building-cost.js';

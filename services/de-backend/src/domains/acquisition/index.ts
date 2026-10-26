/**
 * Acquisition domain: the purchase of a share of a PropertyReference (data-model.md §13, api-design.md §27.1).
 * See docs/development/coding-guidelines.md §3.
 */
export { ACQUISITION_STATUSES, createFingerprint, planCancel, transferDate } from './acquisition.js';
export type {
  AcquiredShare,
  Acquisition,
  AcquisitionData,
  AcquisitionFilter,
  AcquisitionId,
  AcquisitionPage,
  AcquisitionRepository,
  AcquisitionStatus,
  CancelAcquisitionOutcome,
  CancelPlan,
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

/**
 * Ownership domain: temporal ownership shares per PropertyReference (data-model.md §12, api-design.md §26.1).
 * See docs/development/coding-guidelines.md §3.
 */
export { MAX_SHARE_DENOMINATOR, ZERO, compareToOne, formatShare, gcd, parseShare, sumShares } from './share.js';
export type { Fraction, Share, ShareError } from './share.js';
export { OWNERSHIP_STATUSES, checkInvariants, createFingerprint, ownershipOn, planClose, planVoid } from './ownership.js';
export type {
  AcquisitionRefusal,
  ClosePlan,
  CloseOwnershipOutcome,
  Completeness,
  CreateOwnershipOutcome,
  InvalidOwnershipReason,
  InvariantViolation,
  NewOwnership,
  Ownership,
  OwnershipDay,
  OwnershipId,
  OwnershipPage,
  OwnershipRepository,
  OwnershipStatus,
  PredecessorRefusal,
  VoidOwnershipOutcome,
  VoidPlan,
} from './ownership.js';
export { changeFingerprint, planChange } from './change.js';
export type { ChangeOwnershipOutcome, ChangePlan, ChangeResult, NewOwner, OwnershipChange, OwnershipChangeRepository } from './change.js';

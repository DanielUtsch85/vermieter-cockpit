import type { AuditActor, BusinessDate, Money, VersionConflict } from '../../shared/index.js';
import type { AcquisitionStatus } from './acquisition.js';

/**
 * Acquisition costs and payment links (data-model.md §14, api-design.md §27.2, phase-2-plan P2-D7). The price is
 * entered once on the Acquisition; a cost is an expected transaction cost; a payment links part of a ledger
 * Transaction to the price (`acquisitionCostId = null`) or to one cost. The paid state is derived, never stored, and
 * the ledger is never written.
 */

export const COST_CATEGORIES = ['REAL_ESTATE_TRANSFER_TAX', 'NOTARY', 'LAND_REGISTRY', 'BROKER', 'FINANCING_RELATED', 'OTHER'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const COST_STATUSES = ['ACTIVE', 'VOID'] as const;
export type CostStatus = (typeof COST_STATUSES)[number];

export type PaymentStatus = 'EXPECTED' | 'PARTIALLY_PAID' | 'PAID';

/** Why a payment counts nowhere; the first that applies, in this order (§27.2). */
export type NotCountingReason = 'UNLINKED' | 'ACQUISITION_CANCELLED' | 'TRANSACTION_CORRECTED';

export interface CostData {
  readonly category: CostCategory;
  /** The expected amount, > 0, in the Acquisition's currency. */
  readonly amount: Money;
  readonly incurredDate: BusinessDate | null;
  readonly counterpartyPartyId: string | null;
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

export interface NewAcquisitionCost extends CostData {
  readonly mreRealmId: string;
  readonly acquisitionId: string;
}

export interface AcquisitionCost extends CostData {
  readonly id: string;
  readonly mreRealmId: string;
  readonly acquisitionId: string;
  readonly status: CostStatus;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  /** Sum of the counting payments; zero on a cancelled Acquisition. */
  readonly paidAmount: Money;
  /** `null` for a `VOID` cost and on a `CANCELLED` Acquisition. */
  readonly paymentStatus: PaymentStatus | null;
  readonly createdAt: Date;
  readonly version: number;
}

export interface PaymentData {
  readonly transactionId: string;
  /** `null` = a payment of the purchase price. */
  readonly acquisitionCostId: string | null;
  readonly amount: Money;
}

export interface NewAcquisitionPayment extends PaymentData {
  readonly mreRealmId: string;
  readonly acquisitionId: string;
}

export interface AcquisitionPayment extends PaymentData {
  readonly id: string;
  readonly mreRealmId: string;
  readonly acquisitionId: string;
  readonly counting: boolean;
  readonly notCountingReason: NotCountingReason | null;
  readonly transactionStatus: string;
  /** The Transaction's direct replacement once corrected (it may be corrected itself since); `null` otherwise. */
  readonly replacementTransactionId: string | null;
  readonly unlinkedAt: Date | null;
  readonly unlinkReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** The price's paid state, as a cost's. */
export interface PurchasePricePayments {
  readonly amount: Money;
  readonly paidAmount: Money;
  readonly paymentStatus: PaymentStatus | null;
}

/** Current in the sense of §35.3: `CONFIRMED` or `RECONCILED`, and not a reversal. */
export function isCurrentTransaction(status: string, correctionRole: string | null): boolean {
  return (status === 'CONFIRMED' || status === 'RECONCILED') && correctionRole !== 'REVERSAL';
}

export function paymentStatusOf(amount: Money, paid: Money): PaymentStatus {
  if (!paid.isPositive()) return 'EXPECTED';
  return paid.compare(amount) < 0 ? 'PARTIALLY_PAID' : 'PAID';
}

export function notCountingReason(payment: {
  readonly unlinked: boolean;
  readonly acquisitionStatus: AcquisitionStatus;
  readonly transactionCurrent: boolean;
}): NotCountingReason | null {
  if (payment.unlinked) return 'UNLINKED';
  if (payment.acquisitionStatus === 'CANCELLED') return 'ACQUISITION_CANCELLED';
  if (!payment.transactionCurrent) return 'TRANSACTION_CORRECTED';
  return null;
}

/** What a link has to be checked against, read under the locks of §27.2. */
export interface LinkContext {
  readonly acquisitionStatus: AcquisitionStatus;
  /** The cost's status, or `undefined` for a payment of the price. */
  readonly costStatus?: CostStatus;
  readonly transaction: {
    readonly amount: Money;
    readonly status: string;
    readonly direction: string;
    readonly correctionRole: string | null;
  };
  /** Sum of the live payments of the Transaction (not unlinked, Acquisition not cancelled). */
  readonly linkedOnTransaction: Money;
  /** The cost's expected amount, or the purchase price. */
  readonly expected: Money;
  /** Sum of the counting payments of the cost or the price. */
  readonly paid: Money;
}

export type LinkRefusal =
  | { readonly kind: 'ACQUISITION_CANCELLED' }
  | { readonly kind: 'COST_VOID' }
  | { readonly kind: 'TRANSACTION_NOT_CURRENT'; readonly status: string; readonly correctionRole: string | null }
  | { readonly kind: 'NOT_OUTFLOW' }
  | { readonly kind: 'CURRENCY_MISMATCH' }
  | { readonly kind: 'PAYMENT_EXCEEDS_TRANSACTION'; readonly transactionAmount: Money; readonly linkedAmount: Money; readonly available: Money }
  | {
      readonly kind: 'PAYMENT_EXCEEDS_COST' | 'PAYMENT_EXCEEDS_PRICE';
      readonly expected: Money;
      readonly paid: Money;
      readonly remaining: Money;
    };

/** The checks of §27.2 after the 404s, in their order; `undefined` = the link may be written. */
export function checkLink(amount: Money, context: LinkContext): LinkRefusal | undefined {
  if (context.acquisitionStatus === 'CANCELLED') return { kind: 'ACQUISITION_CANCELLED' };
  if (context.costStatus === 'VOID') return { kind: 'COST_VOID' };
  const { transaction } = context;
  if (!isCurrentTransaction(transaction.status, transaction.correctionRole)) {
    return { kind: 'TRANSACTION_NOT_CURRENT', status: transaction.status, correctionRole: transaction.correctionRole };
  }
  if (transaction.direction !== 'OUTFLOW') return { kind: 'NOT_OUTFLOW' };
  if (transaction.amount.currency !== amount.currency) return { kind: 'CURRENCY_MISMATCH' };
  if (context.linkedOnTransaction.add(amount).compare(transaction.amount) > 0) {
    return {
      kind: 'PAYMENT_EXCEEDS_TRANSACTION',
      transactionAmount: transaction.amount,
      linkedAmount: context.linkedOnTransaction,
      available: transaction.amount.subtract(context.linkedOnTransaction),
    };
  }
  if (context.paid.add(amount).compare(context.expected) > 0) {
    return {
      kind: context.costStatus === undefined ? 'PAYMENT_EXCEEDS_PRICE' : 'PAYMENT_EXCEEDS_COST',
      expected: context.expected,
      paid: context.paid,
      remaining: context.expected.subtract(context.paid),
    };
  }
  return undefined;
}

export type VoidCostPlan =
  | { readonly kind: 'VOID' }
  /** Already `VOID`: a 200 no-op whatever the reason or version. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'ACQUISITION_CANCELLED' }
  | { readonly kind: 'COST_HAS_PAYMENTS'; readonly paymentIds: readonly string[] };

/** `linkedPaymentIds`: the payments linked to the cost and not unlinked. */
export function planVoidCost(cost: { readonly status: CostStatus }, acquisitionStatus: AcquisitionStatus, linkedPaymentIds: readonly string[]): VoidCostPlan {
  if (acquisitionStatus === 'CANCELLED') return { kind: 'ACQUISITION_CANCELLED' };
  if (cost.status === 'VOID') return { kind: 'UNCHANGED' };
  if (linkedPaymentIds.length > 0) return { kind: 'COST_HAS_PAYMENTS', paymentIds: [...linkedPaymentIds].sort() };
  return { kind: 'VOID' };
}

export type UnlinkPlan = { readonly kind: 'UNLINK' } | { readonly kind: 'UNCHANGED' } | { readonly kind: 'ACQUISITION_CANCELLED' };

export function planUnlink(payment: { readonly unlinkedAt: Date | null }, acquisitionStatus: AcquisitionStatus): UnlinkPlan {
  if (acquisitionStatus === 'CANCELLED') return { kind: 'ACQUISITION_CANCELLED' };
  if (payment.unlinkedAt !== null) return { kind: 'UNCHANGED' };
  return { kind: 'UNLINK' };
}

/** Identity of a cost create for `Idempotency-Key` replays: the Acquisition and the normalized payload. */
export function costFingerprint(cost: NewAcquisitionCost): string {
  return JSON.stringify([
    cost.acquisitionId,
    cost.category,
    cost.amount.amount,
    cost.amount.currency,
    cost.incurredDate,
    cost.counterpartyPartyId,
    cost.sourceReferences,
    cost.notes,
  ]);
}

export function paymentFingerprint(payment: NewAcquisitionPayment): string {
  return JSON.stringify([payment.acquisitionId, payment.transactionId, payment.acquisitionCostId, payment.amount.amount, payment.amount.currency]);
}

export type CreateCostOutcome =
  | { readonly kind: 'CREATED'; readonly cost: AcquisitionCost }
  | { readonly kind: 'REPLAYED'; readonly cost: AcquisitionCost }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'ACQUISITION_NOT_FOUND' }
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | { readonly kind: 'ACQUISITION_CANCELLED' };

export type VoidCostOutcome =
  | { readonly kind: 'VOIDED'; readonly cost: AcquisitionCost; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<VoidCostPlan, { kind: 'VOID' | 'UNCHANGED' }>
  | VersionConflict;

export type LinkPaymentOutcome =
  | { readonly kind: 'LINKED'; readonly payment: AcquisitionPayment }
  | { readonly kind: 'REPLAYED'; readonly payment: AcquisitionPayment }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'ACQUISITION_NOT_FOUND' }
  | { readonly kind: 'COST_NOT_FOUND' }
  | { readonly kind: 'TRANSACTION_NOT_FOUND' }
  | LinkRefusal;

export type UnlinkPaymentOutcome =
  | { readonly kind: 'UNLINKED'; readonly payment: AcquisitionPayment; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'ACQUISITION_CANCELLED' }
  | VersionConflict;

export interface CostFilter {
  readonly status?: CostStatus;
}

export interface PaymentFilter {
  /** `null` = the price's payments. */
  readonly acquisitionCostId?: string | null;
  readonly counting?: boolean;
}

/**
 * Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm and Acquisition.
 * Every write runs in one READ COMMITTED transaction that writes the Acquisition's row first (and, for a link, then
 * the Transaction's); reads run in one `REPEATABLE READ READ ONLY` transaction.
 */
export interface AcquisitionCostRepository {
  createCost(cost: NewAcquisitionCost, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateCostOutcome>;
  voidCost(
    acquisitionId: string,
    costId: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidCostOutcome>;
  /** `undefined` for an unknown or foreign Acquisition. */
  listCosts(acquisitionId: string, mreRealmId: string, filter: CostFilter): Promise<readonly AcquisitionCost[] | undefined>;
  linkPayment(
    payment: NewAcquisitionPayment,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<LinkPaymentOutcome>;
  unlinkPayment(
    acquisitionId: string,
    paymentId: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<UnlinkPaymentOutcome>;
  /** `undefined` for an unknown or foreign Acquisition. */
  listPayments(
    acquisitionId: string,
    mreRealmId: string,
    filter: PaymentFilter,
  ): Promise<{ readonly purchasePrice: PurchasePricePayments; readonly items: readonly AcquisitionPayment[] } | undefined>;
}

import {
  costFingerprint,
  paymentFingerprint,
  type AcquisitionCost,
  type AcquisitionCostRepository,
  type AcquisitionPayment,
  type CostData,
  type CostFilter,
  type LinkRefusal,
  type PaymentData,
  type PaymentFilter,
  type PurchasePricePayments,
} from '../domains/acquisition/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { AcquisitionNotFoundError } from './ownerships.js';
import { PartyNotFoundError } from './parties.js';
import { TransactionNotFoundError } from './transaction-splits.js';

/**
 * Acquisition costs and payment links (api-design.md §27.2, backlog VC-2-06), in the caller's verified Realm. Input
 * arrives validated and normalized from the API boundary (amounts > 0, texts trimmed).
 */

/** A `CANCELLED` Acquisition takes no cost or payment writes (→ 409 ACQUISITION_CANCELLED). */
export class AcquisitionCancelledError extends Error {
  override readonly name = 'AcquisitionCancelledError';

  constructor(readonly acquisitionId: string) {
    super(`Acquisition ${acquisitionId} is cancelled`);
  }
}

export class AcquisitionCostNotFoundError extends Error {
  override readonly name = 'AcquisitionCostNotFoundError';

  constructor(readonly acquisitionCostId: string) {
    super(`AcquisitionCost ${acquisitionCostId} not found`);
  }
}

export class AcquisitionPaymentNotFoundError extends Error {
  override readonly name = 'AcquisitionPaymentNotFoundError';

  constructor(readonly paymentId: string) {
    super(`AcquisitionPayment ${paymentId} not found`);
  }
}

/** Payments are still linked to the cost: unlink them first (→ 409 COST_HAS_PAYMENTS). */
export class CostHasPaymentsError extends Error {
  override readonly name = 'CostHasPaymentsError';

  constructor(
    readonly acquisitionCostId: string,
    readonly paymentIds: readonly string[],
  ) {
    super(`AcquisitionCost ${acquisitionCostId} has linked payments ${paymentIds.join(', ')}`);
  }
}

/** A link refused after the 404s (§27.2 steps 3–6); `refusal` names which and carries its details. */
export class PaymentRefusedError extends Error {
  override readonly name = 'PaymentRefusedError';

  constructor(readonly refusal: LinkRefusal) {
    super(`Payment refused: ${refusal.kind}`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export type CreateAcquisitionCost = (
  input: CostData & { readonly principal: RealmPrincipal; readonly acquisitionId: string; readonly idempotencyKey?: string },
) => Promise<{ readonly cost: AcquisitionCost; readonly replayed: boolean }>;

export function createAcquisitionCost(deps: { readonly repository: AcquisitionCostRepository }): CreateAcquisitionCost {
  return async ({ principal, acquisitionId, idempotencyKey, ...fields }) => {
    const cost = { mreRealmId: principal.mreRealmId, acquisitionId, ...fields };
    const outcome = await deps.repository.createCost(
      cost,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: costFingerprint(cost) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { cost: outcome.cost, replayed: false };
      case 'REPLAYED':
        return { cost: outcome.cost, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'ACQUISITION_NOT_FOUND':
        throw new AcquisitionNotFoundError(acquisitionId);
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(outcome.partyId);
      case 'ACQUISITION_CANCELLED':
        throw new AcquisitionCancelledError(acquisitionId);
    }
  };
}

export type VoidAcquisitionCost = (input: {
  readonly principal: RealmPrincipal;
  readonly acquisitionId: string;
  readonly costId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly cost: AcquisitionCost; readonly changed: boolean }>;

export function voidAcquisitionCost(deps: { readonly repository: AcquisitionCostRepository; readonly now?: () => Date }): VoidAcquisitionCost {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, acquisitionId, costId, reason, expectedVersions }) => {
    const outcome = await deps.repository.voidCost(acquisitionId, costId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { cost: outcome.cost, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new AcquisitionCostNotFoundError(costId);
      case 'ACQUISITION_CANCELLED':
        throw new AcquisitionCancelledError(acquisitionId);
      case 'COST_HAS_PAYMENTS':
        throw new CostHasPaymentsError(costId, outcome.paymentIds);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type ListAcquisitionCosts = (input: {
  readonly principal: RealmPrincipal;
  readonly acquisitionId: string;
  readonly filter: CostFilter;
}) => Promise<readonly AcquisitionCost[]>;

export function listAcquisitionCosts(deps: { readonly repository: AcquisitionCostRepository }): ListAcquisitionCosts {
  return async ({ principal, acquisitionId, filter }) => {
    const costs = await deps.repository.listCosts(acquisitionId, principal.mreRealmId, filter);
    if (costs === undefined) throw new AcquisitionNotFoundError(acquisitionId);
    return costs;
  };
}

export type LinkAcquisitionPayment = (
  input: PaymentData & { readonly principal: RealmPrincipal; readonly acquisitionId: string; readonly idempotencyKey?: string },
) => Promise<{ readonly payment: AcquisitionPayment; readonly replayed: boolean }>;

export function linkAcquisitionPayment(deps: { readonly repository: AcquisitionCostRepository }): LinkAcquisitionPayment {
  return async ({ principal, acquisitionId, idempotencyKey, ...fields }) => {
    const payment = { mreRealmId: principal.mreRealmId, acquisitionId, ...fields };
    const outcome = await deps.repository.linkPayment(
      payment,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: paymentFingerprint(payment) },
    );
    switch (outcome.kind) {
      case 'LINKED':
        return { payment: outcome.payment, replayed: false };
      case 'REPLAYED':
        return { payment: outcome.payment, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'ACQUISITION_NOT_FOUND':
        throw new AcquisitionNotFoundError(acquisitionId);
      case 'COST_NOT_FOUND':
        throw new AcquisitionCostNotFoundError(fields.acquisitionCostId ?? '');
      case 'TRANSACTION_NOT_FOUND':
        throw new TransactionNotFoundError(fields.transactionId);
      case 'ACQUISITION_CANCELLED':
        throw new AcquisitionCancelledError(acquisitionId);
      default:
        throw new PaymentRefusedError(outcome);
    }
  };
}

export type UnlinkAcquisitionPayment = (input: {
  readonly principal: RealmPrincipal;
  readonly acquisitionId: string;
  readonly paymentId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly payment: AcquisitionPayment; readonly changed: boolean }>;

export function unlinkAcquisitionPayment(deps: { readonly repository: AcquisitionCostRepository; readonly now?: () => Date }): UnlinkAcquisitionPayment {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, acquisitionId, paymentId, reason, expectedVersions }) => {
    const outcome = await deps.repository.unlinkPayment(acquisitionId, paymentId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'UNLINKED':
        return { payment: outcome.payment, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new AcquisitionPaymentNotFoundError(paymentId);
      case 'ACQUISITION_CANCELLED':
        throw new AcquisitionCancelledError(acquisitionId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type ListAcquisitionPayments = (input: {
  readonly principal: RealmPrincipal;
  readonly acquisitionId: string;
  readonly filter: PaymentFilter;
}) => Promise<{ readonly purchasePrice: PurchasePricePayments; readonly items: readonly AcquisitionPayment[] }>;

export function listAcquisitionPayments(deps: { readonly repository: AcquisitionCostRepository }): ListAcquisitionPayments {
  return async ({ principal, acquisitionId, filter }) => {
    const result = await deps.repository.listPayments(acquisitionId, principal.mreRealmId, filter);
    if (result === undefined) throw new AcquisitionNotFoundError(acquisitionId);
    return result;
  };
}

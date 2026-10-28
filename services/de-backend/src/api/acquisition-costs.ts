import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  AcquisitionCancelledError,
  AcquisitionCostNotFoundError,
  AcquisitionNotFoundError,
  AcquisitionPaymentNotFoundError,
  COST_CATEGORIES,
  COST_STATUSES,
  CostHasPaymentsError,
  IdempotencyKeyConflictError,
  PartyNotFoundError,
  PaymentRefusedError,
  TransactionNotFoundError,
  VersionConflictError,
  type AcquisitionCost,
  type AcquisitionPayment,
  type CreateAcquisitionCost,
  type LinkAcquisitionPayment,
  type LinkRefusal,
  type ListAcquisitionCosts,
  type ListAcquisitionPayments,
  type PurchasePricePayments,
  type UnlinkAcquisitionPayment,
  type VoidAcquisitionCost,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, definedOnly, optionalText, readId } from './acquisitions.js';
import { sendError } from './errors.js';
import { RESOURCE_ID, fieldErrors, money, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const uuid = z.string().regex(RESOURCE_ID).transform((id) => id.toLowerCase());

const positive = (field: string) => (value: { [key: string]: unknown }, ctx: z.RefinementCtx) => {
  // Refinements run even after a field failed to parse: only check what parsed.
  const amount = value[field];
  if (amount instanceof Money && !amount.isPositive()) ctx.addIssue({ code: 'custom', path: [field, 'amount'], params: { code: 'NOT_POSITIVE' } });
};

const costBody = z
  .object({
    category: z.enum(COST_CATEGORIES),
    amount: money,
    incurredDate: businessDate.nullish(),
    counterpartyPartyId: uuid.nullish(),
    sourceReferences: z.array(optionalText(500)).max(10).optional(),
    notes: optionalText(2000).nullish(),
    // Documents and tax classifications do not exist yet: refused, never stored unchecked (as §33.2).
    documentId: z.unknown().optional(),
    taxClassificationId: z.unknown().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    for (const field of ['documentId', 'taxClassificationId'] as const) {
      if (body[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], params: { code: 'NOT_SUPPORTED' } });
    }
    positive('amount')(body, ctx);
  });

const paymentBody = z
  .object({ transactionId: uuid, acquisitionCostId: uuid.nullish(), amount: money })
  .strict()
  .superRefine((body, ctx) => positive('amount')(body, ctx));

const reasonBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const costQuery = z.object({ status: z.enum(COST_STATUSES).optional() }).strict();
const paymentQuery = z
  .object({
    // The literal `null` names the price's payments; an empty value is malformed.
    acquisitionCostId: z.union([z.literal('null').transform(() => null), uuid]).optional(),
    counting: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();

export interface AcquisitionCostCommands {
  readonly createCost: CreateAcquisitionCost;
  readonly voidCost: VoidAcquisitionCost;
  readonly listCosts: ListAcquisitionCosts;
  readonly linkPayment: LinkAcquisitionPayment;
  readonly unlinkPayment: UnlinkAcquisitionPayment;
  readonly listPayments: ListAcquisitionPayments;
}

/** Acquisition costs and payment links (api-design.md §27.2, backlog VC-2-06). */
export function acquisitionCostRoutes(commands: AcquisitionCostCommands): Router {
  const router = express.Router();
  const fail = (res: Response, next: (error: unknown) => void) => (error: unknown) => {
    if (!sendCostError(res, error)) next(error);
  };

  router.post('/acquisitions/:acquisitionId/costs', express.json({ limit: '32kb' }), (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = costBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    commands
      .createCost({
        principal: principalOf(res),
        acquisitionId,
        category: body.category,
        amount: body.amount,
        incurredDate: body.incurredDate ?? null,
        counterpartyPartyId: body.counterpartyPartyId ?? null,
        sourceReferences: (body.sourceReferences ?? []).filter((reference): reference is string => reference !== null),
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ cost, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendOne(res.status(201), cost.version, costDto(cost));
      })
      .catch(fail(res, next));
  });

  router.post('/acquisitions/:acquisitionId/costs/:costId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const costId = readId(req.params['costId'], 'costId', res);
    if (costId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = reasonBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .voidCost({
        principal: principalOf(res),
        acquisitionId,
        costId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ cost }) => sendOne(res, cost.version, costDto(cost)))
      .catch(fail(res, next));
  });

  router.get('/acquisitions/:acquisitionId/costs', (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const parsed = costQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .listCosts({ principal: principalOf(res), acquisitionId, filter: definedOnly(parsed.data) })
      .then((costs) => res.json({ items: costs.map(costDto) }))
      .catch(fail(res, next));
  });

  router.post('/acquisitions/:acquisitionId/payments', express.json({ limit: '16kb' }), (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = paymentBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .linkPayment({
        principal: principalOf(res),
        acquisitionId,
        transactionId: parsed.data.transactionId,
        acquisitionCostId: parsed.data.acquisitionCostId ?? null,
        amount: parsed.data.amount,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ payment, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendOne(res.status(201), payment.version, paymentDto(payment));
      })
      .catch(fail(res, next));
  });

  router.post('/acquisitions/:acquisitionId/payments/:paymentId/unlink', express.json({ limit: '16kb' }), (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const paymentId = readId(req.params['paymentId'], 'paymentId', res);
    if (paymentId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = reasonBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .unlinkPayment({
        principal: principalOf(res),
        acquisitionId,
        paymentId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ payment }) => sendOne(res, payment.version, paymentDto(payment)))
      .catch(fail(res, next));
  });

  router.get('/acquisitions/:acquisitionId/payments', (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const parsed = paymentQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .listPayments({ principal: principalOf(res), acquisitionId, filter: definedOnly(parsed.data) })
      .then(({ purchasePrice, items }) => res.json({ purchasePrice: priceDto(purchasePrice), items: items.map(paymentDto) }))
      .catch(fail(res, next));
  });

  return router;
}

/** A single cost or payment with its version as `ETag` for the next `If-Match` (api-design.md §16.1). */
function sendOne(res: Response, version: number, body: unknown): void {
  res.setHeader('ETag', `"${version}"`);
  res.json(body);
}

/** The refusals of §27.2; false for anything else (→ the error handler). */
function sendCostError(res: Response, error: unknown): boolean {
  if (error instanceof AcquisitionNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Acquisition not found.', { acquisitionId: error.acquisitionId });
  } else if (error instanceof AcquisitionCostNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'AcquisitionCost not found.', { acquisitionCostId: error.acquisitionCostId });
  } else if (error instanceof AcquisitionPaymentNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'AcquisitionPayment not found.', { paymentId: error.paymentId });
  } else if (error instanceof TransactionNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId });
  } else if (error instanceof PartyNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Party not found.', { partyId: error.partyId });
  } else if (error instanceof AcquisitionCancelledError) {
    sendError(res, 409, 'CONFLICT', 'A cancelled Acquisition takes no cost or payment writes.', {
      reason: 'ACQUISITION_CANCELLED',
      acquisitionId: error.acquisitionId,
    });
  } else if (error instanceof CostHasPaymentsError) {
    sendError(res, 409, 'CONFLICT', 'Payments are linked to this cost; unlink them first.', {
      reason: 'COST_HAS_PAYMENTS',
      paymentIds: error.paymentIds,
    });
  } else if (error instanceof PaymentRefusedError) {
    sendRefusal(res, error.refusal);
  } else if (error instanceof VersionConflictError) {
    sendError(res, 412, 'VERSION_CONFLICT', 'The resource changed since the version given in If-Match.', {
      expectedVersions: error.expectedVersions,
      currentVersion: error.currentVersion,
    });
  } else if (error instanceof IdempotencyKeyConflictError) {
    sendError(res, 409, 'CONFLICT', 'Idempotency-Key was already used with a different payload.');
  } else {
    return false;
  }
  return true;
}

function sendRefusal(res: Response, refusal: LinkRefusal): void {
  switch (refusal.kind) {
    case 'ACQUISITION_CANCELLED':
      sendError(res, 409, 'CONFLICT', 'A cancelled Acquisition takes no cost or payment writes.', { reason: refusal.kind });
      return;
    case 'COST_VOID':
      sendError(res, 409, 'CONFLICT', 'The cost is void.', { reason: refusal.kind });
      return;
    case 'TRANSACTION_NOT_CURRENT':
      sendError(res, 422, refusal.kind, 'Only a current Transaction (CONFIRMED or RECONCILED, not a reversal) can be linked.', {
        status: refusal.status,
        correctionRole: refusal.correctionRole,
      });
      return;
    case 'NOT_OUTFLOW':
      sendError(res, 422, refusal.kind, 'Only an OUTFLOW Transaction pays an acquisition.');
      return;
    case 'CURRENCY_MISMATCH':
      sendError(res, 422, refusal.kind, "The Transaction is not in the Acquisition's currency.");
      return;
    case 'PAYMENT_EXCEEDS_TRANSACTION':
      sendError(res, 409, 'INVARIANT_VIOLATION', 'The payments would exceed the Transaction amount.', {
        reason: refusal.kind,
        transactionAmount: refusal.transactionAmount.toJSON(),
        linkedAmount: refusal.linkedAmount.toJSON(),
        available: refusal.available.toJSON(),
      });
      return;
    case 'PAYMENT_EXCEEDS_COST':
    case 'PAYMENT_EXCEEDS_PRICE':
      sendError(res, 409, 'INVARIANT_VIOLATION', 'The payments would exceed the expected amount.', {
        reason: refusal.kind,
        expected: refusal.expected.toJSON(),
        paid: refusal.paid.toJSON(),
        remaining: refusal.remaining.toJSON(),
      });
      return;
  }
}

function costDto(c: AcquisitionCost) {
  return {
    costId: c.id,
    acquisitionId: c.acquisitionId,
    category: c.category,
    amount: c.amount.toJSON(),
    incurredDate: c.incurredDate,
    counterpartyPartyId: c.counterpartyPartyId,
    sourceReferences: c.sourceReferences,
    notes: c.notes,
    status: c.status,
    voidedAt: c.voidedAt?.toISOString() ?? null,
    voidReason: c.voidReason,
    paidAmount: c.paidAmount.toJSON(),
    paymentStatus: c.paymentStatus,
    createdAt: c.createdAt.toISOString(),
    version: c.version,
  };
}

function paymentDto(p: AcquisitionPayment) {
  return {
    paymentId: p.id,
    acquisitionId: p.acquisitionId,
    acquisitionCostId: p.acquisitionCostId,
    transactionId: p.transactionId,
    amount: p.amount.toJSON(),
    counting: p.counting,
    notCountingReason: p.notCountingReason,
    transactionStatus: p.transactionStatus,
    replacementTransactionId: p.replacementTransactionId,
    unlinkedAt: p.unlinkedAt?.toISOString() ?? null,
    unlinkReason: p.unlinkReason,
    createdAt: p.createdAt.toISOString(),
    version: p.version,
  };
}

function priceDto(p: PurchasePricePayments) {
  return { amount: p.amount.toJSON(), paidAmount: p.paidAmount.toJSON(), paymentStatus: p.paymentStatus };
}

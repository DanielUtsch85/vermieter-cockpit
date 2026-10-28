import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  ACQUISITION_STATUSES,
  checkBusinessDate,
  formatShare,
  parseShare,
  transferDate,
  type Acquisition,
  type CancelAcquisition,
  type ConfirmAcquisition,
  type CreateAcquisition,
  type GetAcquisition,
  type ListAcquisitions,
  type ListPropertyAcquisitions,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { RESOURCE_ID, fieldErrors, money, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

export const businessDate = z.string().transform((value, ctx) => {
  const result = checkBusinessDate(value);
  if ('date' in result) return result.date;
  ctx.addIssue({ code: 'custom', params: { code: result.error } });
  return z.NEVER;
});

const share = z.string().transform((value, ctx) => {
  const result = parseShare(value);
  if ('share' in result) return result.share;
  ctx.addIssue({ code: 'custom', params: { code: result.error } });
  return z.NEVER;
});

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value));

const partyIds = (min: number) =>
  z
    .array(
      z
        .string()
        .regex(RESOURCE_ID)
        .transform((id) => id.toLowerCase()),
    )
    .min(min)
    .max(20);

const createBody = z
  .object({
    propertyReferenceId: z.string().regex(RESOURCE_ID),
    purchasePrice: money,
    acquiredShare: share.optional(),
    contractDate: businessDate,
    economicTransferDate: businessDate.nullish(),
    landRegistryTransferDate: businessDate.nullish(),
    buyerPartyIds: partyIds(1),
    sellerPartyIds: partyIds(0).optional(),
    sourceReferences: z.array(optionalText(500)).max(10).optional(),
    notes: optionalText(2000).nullish(),
    // Documents do not exist yet: refused, never stored unchecked (as §33.2).
    notarialDocumentId: z.unknown().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.notarialDocumentId !== undefined) ctx.addIssue({ code: 'custom', path: ['notarialDocumentId'], params: { code: 'NOT_SUPPORTED' } });
    // Refinements run even after a field failed to parse: only check what parsed.
    if (body.purchasePrice instanceof Money && !body.purchasePrice.isPositive()) {
      ctx.addIssue({ code: 'custom', path: ['purchasePrice', 'amount'], params: { code: 'NOT_POSITIVE' } });
    }
    for (const field of ['economicTransferDate', 'landRegistryTransferDate'] as const) {
      const date = body[field];
      if (typeof date === 'string' && typeof body.contractDate === 'string' && date < body.contractDate)
        ctx.addIssue({ code: 'custom', path: [field], params: { code: 'BEFORE_CONTRACT_DATE' } });
    }
    const buyers = Array.isArray(body.buyerPartyIds) ? body.buyerPartyIds : [];
    const sellers = Array.isArray(body.sellerPartyIds) ? body.sellerPartyIds : [];
    buyers.forEach((id, i) => {
      if (buyers.indexOf(id) !== i) ctx.addIssue({ code: 'custom', path: ['buyerPartyIds', i], params: { code: 'DUPLICATE' } });
    });
    sellers.forEach((id, i) => {
      if (sellers.indexOf(id) !== i) ctx.addIssue({ code: 'custom', path: ['sellerPartyIds', i], params: { code: 'DUPLICATE' } });
      else if (buyers.includes(id)) ctx.addIssue({ code: 'custom', path: ['sellerPartyIds', i], params: { code: 'BUYER_IS_SELLER' } });
    });
  });

const cancelBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const confirmBody = z.object({}).strict();

const paging = {
  status: z.enum(ACQUISITION_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
};
const listQuery = z
  .object({
    ...paging,
    propertyReferenceId: z
      .string()
      .regex(RESOURCE_ID)
      .transform((id) => id.toLowerCase())
      .optional(),
    partyId: z
      .string()
      .regex(RESOURCE_ID)
      .transform((id) => id.toLowerCase())
      .optional(),
  })
  .strict();
const propertyListQuery = z.object(paging).strict();

export interface AcquisitionCommands {
  readonly create: CreateAcquisition;
  readonly get: GetAcquisition;
  readonly list: ListAcquisitions;
  readonly listForPropertyReference: ListPropertyAcquisitions;
  readonly cancel: CancelAcquisition;
  readonly confirm: ConfirmAcquisition;
}

/** Acquisition API (api-design.md §27.1, backlog VC-2-05). */
export function acquisitionRoutes(commands: AcquisitionCommands): Router {
  const router = express.Router();

  router.post('/acquisitions', express.json({ limit: '32kb' }), (req, res, next) => {
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    commands
      .create({
        principal: principalOf(res),
        propertyReferenceId: body.propertyReferenceId.toLowerCase(),
        purchasePrice: body.purchasePrice,
        acquiredShare: body.acquiredShare ?? { numerator: 1, denominator: 1 },
        contractDate: body.contractDate,
        economicTransferDate: body.economicTransferDate ?? null,
        landRegistryTransferDate: body.landRegistryTransferDate ?? null,
        buyerPartyIds: body.buyerPartyIds,
        sellerPartyIds: body.sellerPartyIds ?? [],
        sourceReferences: (body.sourceReferences ?? []).filter((reference): reference is string => reference !== null),
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ acquisition, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendAcquisition(res.status(201), acquisition);
      })
      .catch(next);
  });

  router.get('/acquisitions', (req, res, next) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { page, pageSize, ...filter } = parsed.data;
    commands
      .list({ principal: principalOf(res), filter: definedOnly(filter), page: { page, pageSize } })
      .then((result) => res.json({ ...result, items: result.items.map(toDto) }))
      .catch(next);
  });

  router.get('/acquisitions/:acquisitionId', (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    commands
      .get({ principal: principalOf(res), acquisitionId })
      .then((acquisition) => sendAcquisition(res, acquisition))
      .catch(next);
  });

  router.post('/acquisitions/:acquisitionId/cancel', express.json({ limit: '16kb' }), (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = cancelBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .cancel({
        principal: principalOf(res),
        acquisitionId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ acquisition }) => sendAcquisition(res, acquisition))
      .catch(next);
  });

  router.post('/acquisitions/:acquisitionId/confirm', express.json({ limit: '16kb' }), (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    // No body, or an empty object (§28.1).
    const parsed = confirmBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .confirm({ principal: principalOf(res), acquisitionId, ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }) })
      .then(({ acquisition, changed }) => {
        if (!changed) res.setHeader('Idempotent-Replayed', 'true');
        sendAcquisition(res, acquisition);
      })
      .catch(next);
  });

  router.get('/property-references/:propertyReferenceId/acquisitions', (req, res, next) => {
    const propertyReferenceId = readId(req.params['propertyReferenceId'], 'propertyReferenceId', res);
    if (propertyReferenceId === undefined) return;
    const parsed = propertyListQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { page, pageSize, ...filter } = parsed.data;
    commands
      .listForPropertyReference({ principal: principalOf(res), propertyReferenceId, filter: definedOnly(filter), page: { page, pageSize } })
      .then((result) => res.json({ ...result, items: result.items.map(toDto) }))
      .catch(next);
  });

  return router;
}

/** Leaves out the filters that were not given (exactOptionalPropertyTypes). */
export function definedOnly<T extends Record<string, unknown>>(filter: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

export function readId(value: string | undefined, field: string, res: Response): string | undefined {
  if (value !== undefined && RESOURCE_ID.test(value)) return value.toLowerCase();
  sendValidationError(res, [{ field, code: 'INVALID_FORMAT' }]);
  return undefined;
}

/** A single Acquisition with its version as `ETag` for the next `If-Match` (api-design.md §16.1). */
function sendAcquisition(res: Response, acquisition: Acquisition): void {
  res.setHeader('ETag', `"${acquisition.version}"`);
  res.json(toDto(acquisition));
}

function toDto(a: Acquisition) {
  return {
    acquisitionId: a.id,
    mreRealmId: a.mreRealmId,
    propertyReferenceId: a.propertyReferenceId,
    status: a.status,
    purchasePrice: { amount: a.purchasePrice.amount, currency: a.purchasePrice.currency },
    acquiredShare: formatShare(a.acquiredShare),
    contractDate: a.contractDate,
    economicTransferDate: a.economicTransferDate,
    landRegistryTransferDate: a.landRegistryTransferDate,
    transferDate: transferDate(a),
    buyerPartyIds: a.buyerPartyIds,
    sellerPartyIds: a.sellerPartyIds,
    sourceReferences: a.sourceReferences,
    notes: a.notes,
    cancelledAt: a.cancelledAt?.toISOString() ?? null,
    cancellationReason: a.cancellationReason,
    confirmedAt: a.confirmedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    version: a.version,
  };
}

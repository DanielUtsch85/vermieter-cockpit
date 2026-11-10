import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  ACQUISITION_STATUSES,
  checkBusinessDate,
  formatShare,
  ownershipStart,
  parseShare,
  type Acquisition,
  type CancelAcquisition,
  type ConfirmAcquisition,
  type CreateAcquisition,
  type GetAcquisition,
  type ListAcquisitions,
  type ListPropertyAcquisitions,
  type RecordEconomicTransferDate,
  type AlignOwnershipsToTransfer,
} from '../application/index.js';
import { Money, zod3 } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { toDto as ownershipDto } from './ownerships.js';
import {
  jsonBody,
  money,
  NO_QUERY,
  PAGING,
  readBody,
  readIdempotencyKey,
  readIfMatch,
  readQuery,
  refuseQuery,
  RESOURCE_ID,
  sendValidationError,
} from './validation.js';

export const businessDate = zod3.transform(z.string(), (value, ctx) => {
  const result = checkBusinessDate(value);
  if ('date' in result) return result.date;
  ctx.addIssue({ code: 'custom', params: { code: result.error } });
  return z.NEVER;
});

const share = zod3.transform(z.string(), (value, ctx) => {
  const result = parseShare(value);
  if ('share' in result) return result.share;
  ctx.addIssue({ code: 'custom', params: { code: result.error } });
  return z.NEVER;
});

export const optionalText = (max: number) => zod3.transform(z.string().trim().max(max), (value) => (value === '' ? null : value));

const partyIds = (min: number) =>
  zod3
    .array(zod3.transform(z.string().regex(RESOURCE_ID), (id) => id.toLowerCase()))
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
    sourceReferences: zod3.array(optionalText(500)).max(10).optional(),
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
/** §58N: the evidence is required (the tax review's „Eingabe mit Belegquelle“): an empty list is `REQUIRED`. */
const transferDateBody = z
  .object({
    economicTransferDate: businessDate,
    sourceReferences: zod3.array(z.string().trim().min(1).max(500)).max(10),
    notes: optionalText(2000).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Array.isArray(body.sourceReferences) && body.sourceReferences.length === 0)
      ctx.addIssue({ code: 'custom', path: ['sourceReferences'], params: { code: 'REQUIRED' } });
  });
const confirmBody = z.object({}).strict();
/** §58Q: no date (every new date follows from X); the evidence is new and required (open question 5). */
const alignBody = z
  .object({
    sourceReferences: zod3.array(z.string().trim().min(1).max(500)).max(10),
    notes: optionalText(2000).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Array.isArray(body.sourceReferences) && body.sourceReferences.length === 0)
      ctx.addIssue({ code: 'custom', path: ['sourceReferences'], params: { code: 'REQUIRED' } });
  });

const statusAndPaging = { status: z.enum(ACQUISITION_STATUSES).optional(), ...PAGING };
const listQuery = z.object({
  ...statusAndPaging,
  propertyReferenceId: zod3.transform(z.string().regex(RESOURCE_ID), (id) => id.toLowerCase()).optional(),
  partyId: zod3.transform(z.string().regex(RESOURCE_ID), (id) => id.toLowerCase()).optional(),
});
const propertyListQuery = z.object(statusAndPaging);

export interface AcquisitionCommands {
  readonly create: CreateAcquisition;
  readonly get: GetAcquisition;
  readonly list: ListAcquisitions;
  readonly listForPropertyReference: ListPropertyAcquisitions;
  readonly cancel: CancelAcquisition;
  readonly confirm: ConfirmAcquisition;
  /** §58N (VC-X-52). */
  readonly recordEconomicTransferDate: RecordEconomicTransferDate;
  /** §58Q (VC-X-55). */
  readonly alignOwnershipsToTransfer: AlignOwnershipsToTransfer;
}

/** Acquisition API (api-design.md §27.1, backlog VC-2-05). */
export function acquisitionRoutes(commands: AcquisitionCommands): Router {
  const router = express.Router();

  router.post('/acquisitions', jsonBody('32kb'), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(createBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
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
    const parsed = readQuery(listQuery, req);
    if (refuseQuery(res, parsed)) return;
    const { page, pageSize, ...filter } = parsed.data;
    commands
      .list({ principal: principalOf(res), filter: definedOnly(filter), page: { page, pageSize } })
      .then((result) => res.json({ ...result, items: result.items.map(toDto) }))
      .catch(next);
  });

  router.get('/acquisitions/:acquisitionId', (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    if (refuseQuery(res, query)) return;
    commands
      .get({ principal: principalOf(res), acquisitionId })
      .then((acquisition) => sendAcquisition(res, acquisition))
      .catch(next);
  });

  router.post('/acquisitions/:acquisitionId/cancel', jsonBody('16kb'), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(cancelBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
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

  router.post('/acquisitions/:acquisitionId/confirm', jsonBody('16kb'), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    // No body, or an empty object (§28.1).
    if (refuseQuery(res, query)) return;
    const parsed = readBody(confirmBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
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

  // §58N (VC-X-52): the transfer of economic ownership recorded later, with its evidence; status unchanged.
  router.post('/acquisitions/:acquisitionId/economic-transfer-date', jsonBody('32kb'), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(transferDateBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    commands
      .recordEconomicTransferDate({
        principal: principalOf(res),
        acquisitionId,
        record: { economicTransferDate: parsed.data.economicTransferDate, sourceReferences: parsed.data.sourceReferences, notes: parsed.data.notes ?? null },
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ acquisition, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendAcquisition(res, acquisition);
      })
      .catch(next);
  });

  // §58Q (VC-X-55): the seller's Ownership extended up to the transfer, the buyers' moved to it, in one act with evidence.
  router.post('/acquisitions/:acquisitionId/align-ownerships-to-transfer', jsonBody('32kb'), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(alignBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    commands
      .alignOwnershipsToTransfer({
        principal: principalOf(res),
        acquisitionId,
        align: { sourceReferences: parsed.data.sourceReferences, notes: parsed.data.notes ?? null },
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ result, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        // The ETag is X's version (decided question 9: `If-Match` on X).
        res.setHeader('ETag', `"${result.acquisition.version}"`);
        res.json({
          acquisition: toDto(result.acquisition),
          extended: result.extended.map(ownershipDto),
          moved: result.moved.map(ownershipDto),
          completeness: result.completeness,
          shareSum: formatShare(result.shareSum),
        });
      })
      .catch(next);
  });

  router.get('/property-references/:propertyReferenceId/acquisitions', (req, res, next) => {
    const parsed = readQuery(propertyListQuery, req);
    const propertyReferenceId = readId(req.params['propertyReferenceId'], 'propertyReferenceId', res);
    if (propertyReferenceId === undefined) return;
    if (refuseQuery(res, parsed)) return;
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

export function toDto(a: Acquisition) {
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
    // §58N (b), §58Q: `transferDate` is `ownershipStart`, the day the buyers' Ownerships begin (the transfer once aligned).
    transferDate: ownershipStart(a),
    economicTransferRecordedAt: a.economicTransferRecordedAt?.toISOString() ?? null,
    economicTransferSourceReferences: a.economicTransferSourceReferences,
    // §58Q (VC-X-55): additive.
    ownershipAlignedAt: a.ownershipAlignedAt?.toISOString() ?? null,
    ownershipAlignmentSourceReferences: a.ownershipAlignmentSourceReferences,
    buyerPartyIds: a.buyerPartyIds,
    sellerPartyIds: a.sellerPartyIds,
    sourceReferences: a.sourceReferences,
    notes: a.notes,
    cancelledAt: a.cancelledAt?.toISOString() ?? null,
    cancellationReason: a.cancellationReason,
    confirmedAt: a.confirmedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    version: a.version,
    flags: a.flags,
  };
}

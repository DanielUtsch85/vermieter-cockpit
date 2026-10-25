import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  IdempotencyKeyConflictError,
  InvalidOwnershipError,
  OverlappingOwnershipError,
  OwnerInactiveError,
  AcquisitionNotDraftError,
  AcquisitionNotFoundError,
  OwnershipIncompleteError,
  OwnershipNotFoundError,
  OwnershipTotalExceedsOneError,
  PartyNotFoundError,
  PropertyReferenceNotFoundError,
  VersionConflictError,
  checkBusinessDate,
  formatShare,
  parseShare,
  type ChangeOwnership,
  type ChangeResult,
  type CloseOwnership,
  type CreateOwnership,
  type GetOwnership,
  type Ownership,
  type ReadPropertyOwnerships,
  type RealmPrincipal,
  type VoidOwnership,
} from '../application/index.js';
import { sendError } from './errors.js';
import { RESOURCE_ID, fieldErrors, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const businessDate = z.string().transform((value, ctx) => {
  const result = checkBusinessDate(value);
  if ('date' in result) return result.date;
  ctx.addIssue({ code: 'custom', params: { code: result.error } });
  return z.NEVER;
});

/** `"n/d"`, reduced here (api-design.md §26.1, P2-D3). */
const share = z.string().transform((value, ctx) => {
  const result = parseShare(value);
  if ('share' in result) return result.share;
  ctx.addIssue({ code: 'custom', params: { code: result.error } });
  return z.NEVER;
});

/** Trimmed; empty becomes absent. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value));

const createBody = z
  .object({
    propertyReferenceId: z.string().regex(RESOURCE_ID),
    ownerPartyId: z.string().regex(RESOURCE_ID),
    share,
    validFrom: businessDate,
    validUntil: businessDate.nullish(),
    // The Acquisition this Ownership results from (P2-D8, §27.1): a DRAFT of the same Realm and PropertyReference.
    acquisitionId: z.string().regex(RESOURCE_ID).transform((id) => id.toLowerCase()).nullish(),
    sourceReferences: z.array(optionalText(500)).max(10).optional(),
    notes: optionalText(2000).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.validUntil != null && body.validUntil < body.validFrom) {
      ctx.addIssue({ code: 'custom', path: ['validUntil'], params: { code: 'BEFORE_VALID_FROM' } });
    }
  });

const changeBody = z
  .object({
    effectiveDate: businessDate,
    reason: z.string().trim().min(1).max(500),
    close: z.array(z.string().regex(RESOURCE_ID).transform((id) => id.toLowerCase())).max(50).default([]),
    create: z
      .array(
        z
          .object({
            ownerPartyId: z.string().regex(RESOURCE_ID).transform((id) => id.toLowerCase()),
            share,
            sourceReferences: z.array(optionalText(500)).max(10).optional(),
            notes: optionalText(2000).nullish(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    // The Acquisition every created Ownership results from (P2-D8, §27.1).
    acquisitionId: z.string().regex(RESOURCE_ID).transform((id) => id.toLowerCase()).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.close.length === 0 && body.create.length === 0) ctx.addIssue({ code: 'custom', path: ['create'], params: { code: 'REQUIRED' } });
    body.close.forEach((id, i) => {
      if (body.close.indexOf(id) !== i) ctx.addIssue({ code: 'custom', path: ['close', i], params: { code: 'DUPLICATE' } });
    });
    body.create.forEach((c, i) => {
      if (body.create.findIndex((other) => other.ownerPartyId === c.ownerPartyId) !== i) {
        ctx.addIssue({ code: 'custom', path: ['create', i, 'ownerPartyId'], params: { code: 'DUPLICATE' } });
      }
    });
  });

const closeBody = z.object({ validUntil: businessDate }).strict();
const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const readQuery = z
  .object({
    asOf: businessDate.optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict()
  // A day's ownership is not paged (§26.1): paging parameters belong to the history only.
  .refine((query) => query.asOf === undefined || (query.page === undefined && query.pageSize === undefined), {
    path: ['page'],
    params: { code: 'NOT_SUPPORTED' },
  });

export interface OwnershipCommands {
  readonly create: CreateOwnership;
  readonly get: GetOwnership;
  readonly close: CloseOwnership;
  readonly void: VoidOwnership;
  readonly read: ReadPropertyOwnerships;
  readonly change: ChangeOwnership;
}

/** Ownership API (api-design.md §25–26, backlog VC-2-03). */
export function ownershipRoutes(commands: OwnershipCommands): Router {
  const router = express.Router();
  const principalOf = (res: Response) => res.locals['principal'] as RealmPrincipal;

  router.post('/ownerships', express.json({ limit: '32kb' }), (req, res, next) => {
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
        ownerPartyId: body.ownerPartyId.toLowerCase(),
        share: body.share,
        validFrom: body.validFrom,
        validUntil: body.validUntil ?? null,
        acquisitionId: body.acquisitionId ?? null,
        sourceReferences: (body.sourceReferences ?? []).filter((reference): reference is string => reference !== null),
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ ownership, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendOwnership(res.status(201), ownership);
      })
      .catch((error: unknown) => {
        if (!sendOwnershipError(res, error)) next(error);
      });
  });

  router.get('/ownerships/:ownershipId', (req, res, next) => {
    const ownershipId = readId(req.params['ownershipId'], 'ownershipId', res);
    if (ownershipId === undefined) return;
    commands
      .get({ principal: principalOf(res), ownershipId })
      .then((ownership) => sendOwnership(res, ownership))
      .catch((error: unknown) => {
        if (!sendOwnershipError(res, error)) next(error);
      });
  });

  router.post('/ownerships/:ownershipId/close', express.json({ limit: '16kb' }), (req, res, next) => {
    const ownershipId = readId(req.params['ownershipId'], 'ownershipId', res);
    if (ownershipId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = closeBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .close({
        principal: principalOf(res),
        ownershipId,
        validUntil: parsed.data.validUntil,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ ownership }) => sendOwnership(res, ownership))
      .catch((error: unknown) => {
        if (!sendOwnershipError(res, error)) next(error);
      });
  });

  router.post('/ownerships/:ownershipId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const ownershipId = readId(req.params['ownershipId'], 'ownershipId', res);
    if (ownershipId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = voidBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .void({
        principal: principalOf(res),
        ownershipId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ ownership }) => sendOwnership(res, ownership))
      .catch((error: unknown) => {
        if (!sendOwnershipError(res, error)) next(error);
      });
  });

  router.post('/property-references/:propertyReferenceId/ownership-changes', express.json({ limit: '64kb' }), (req, res, next) => {
    const propertyReferenceId = readId(req.params['propertyReferenceId'], 'propertyReferenceId', res);
    if (propertyReferenceId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = changeBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    commands
      .change({
        principal: principalOf(res),
        propertyReferenceId,
        effectiveDate: body.effectiveDate,
        reason: body.reason,
        close: body.close,
        acquisitionId: body.acquisitionId ?? null,
        create: body.create.map((c) => ({
          ownerPartyId: c.ownerPartyId,
          share: c.share,
          sourceReferences: (c.sourceReferences ?? []).filter((reference): reference is string => reference !== null),
          notes: c.notes ?? null,
        })),
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ result, status }) => {
        if (status === 'REPLAYED') res.setHeader('Idempotent-Replayed', 'true');
        res.status(status === 'UNCHANGED' ? 200 : 201).json(toChangeDto(result));
      })
      .catch((error: unknown) => {
        if (!sendOwnershipError(res, error)) next(error);
      });
  });

  router.get('/property-references/:propertyReferenceId/ownerships', (req, res, next) => {
    const propertyReferenceId = readId(req.params['propertyReferenceId'], 'propertyReferenceId', res);
    if (propertyReferenceId === undefined) return;
    const parsed = readQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { asOf, page, pageSize } = parsed.data;
    commands
      .read(
        asOf === undefined
          ? { principal: principalOf(res), propertyReferenceId, page: { page: page ?? 1, pageSize: pageSize ?? 50 } }
          : { principal: principalOf(res), propertyReferenceId, asOf },
      )
      .then((result) => {
        if ('day' in result) {
          res.json({
            propertyReferenceId,
            asOf: result.day.asOf,
            completeness: result.day.completeness,
            shareSum: formatShare(result.day.shareSum),
            items: result.day.items.map(toDto),
          });
        } else {
          const { items, ...paging } = result.history;
          res.json({ items: items.map(toDto), ...paging });
        }
      })
      .catch((error: unknown) => {
        if (!sendOwnershipError(res, error)) next(error);
      });
  });

  return router;
}

function readId(value: string | undefined, field: string, res: Response): string | undefined {
  if (value !== undefined && RESOURCE_ID.test(value)) return value.toLowerCase();
  sendValidationError(res, [{ field, code: 'INVALID_FORMAT' }]);
  return undefined;
}

/** A single Ownership with its version as `ETag` for the next `If-Match` (api-design.md §16.1). */
function sendOwnership(res: Response, ownership: Ownership): void {
  res.setHeader('ETag', `"${ownership.version}"`);
  res.json(toDto(ownership));
}

/** The refusals of §26.1; false for anything else (→ the error handler). */
function sendOwnershipError(res: Response, error: unknown): boolean {
  if (error instanceof OwnershipNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Ownership not found.', { ownershipId: error.ownershipId });
  } else if (error instanceof PropertyReferenceNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'PropertyReference not found.', { propertyReferenceId: error.propertyReferenceId });
  } else if (error instanceof PartyNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Party not found.', { partyId: error.partyId });
  } else if (error instanceof OwnerInactiveError) {
    sendError(res, 422, 'PARTY_INACTIVE', 'A new owner must be an active Party.', { partyId: error.partyId });
  } else if (error instanceof OverlappingOwnershipError) {
    sendError(res, 422, 'OVERLAPPING_OWNERSHIP', 'The owner already holds an overlapping Ownership of this PropertyReference.', {
      ownershipId: error.ownershipId,
    });
  } else if (error instanceof OwnershipTotalExceedsOneError) {
    sendError(res, 422, 'OWNERSHIP_TOTAL_EXCEEDS_ONE', 'The shares would sum above 1.', { date: error.date, shareSum: formatShare(error.shareSum) });
  } else if (error instanceof AcquisitionNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Acquisition not found for this PropertyReference.', { acquisitionId: error.acquisitionId });
  } else if (error instanceof AcquisitionNotDraftError) {
    sendError(res, 422, 'ACQUISITION_NOT_DRAFT', 'Only a DRAFT Acquisition takes new Ownerships.', {
      acquisitionId: error.acquisitionId,
      status: error.status,
    });
  } else if (error instanceof OwnershipIncompleteError) {
    sendError(res, 422, 'OWNERSHIP_INCOMPLETE', 'The ownership was complete and would no longer be.', {
      date: error.date,
      shareSum: formatShare(error.shareSum),
    });
  } else if (error instanceof InvalidOwnershipError) {
    sendError(res, 422, 'INVALID_OWNERSHIP', 'The Ownership cannot be closed so.', { ownershipId: error.ownershipId, reason: error.reason });
  } else if (error instanceof VersionConflictError) {
    sendError(res, 412, 'VERSION_CONFLICT', 'The Ownership changed since the version given in If-Match.', {
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

function toDto(ownership: Ownership) {
  return {
    ownershipId: ownership.id,
    mreRealmId: ownership.mreRealmId,
    propertyReferenceId: ownership.propertyReferenceId,
    ownerPartyId: ownership.ownerPartyId,
    share: formatShare(ownership.share),
    validFrom: ownership.validFrom,
    validUntil: ownership.validUntil,
    status: ownership.status,
    voidedAt: ownership.voidedAt?.toISOString() ?? null,
    voidReason: ownership.voidReason,
    acquisitionId: ownership.acquisitionId,
    sourceReferences: ownership.sourceReferences,
    notes: ownership.notes,
    createdAt: ownership.createdAt.toISOString(),
    version: ownership.version,
  };
}

function toChangeDto(result: ChangeResult) {
  return {
    propertyReferenceId: result.propertyReferenceId,
    effectiveDate: result.effectiveDate,
    reason: result.reason,
    closed: result.closed.map(toDto),
    created: result.created.map(toDto),
    completeness: result.completeness,
    shareSum: formatShare(result.shareSum),
  };
}

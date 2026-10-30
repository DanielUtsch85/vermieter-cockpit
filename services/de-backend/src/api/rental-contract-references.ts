import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  MAX_RENT_DUE_DAYS,
  MRE_EXTERNAL_ID,
  rentDueDaysError,
  type AmendRentalContractReference,
  type CreateRentalContractReference,
  type GetRentalContractReference,
  type ListRentalContractReferences,
  type RentDueDay,
  type RentalContractReference,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, optionalText, readId } from './acquisitions.js';
import { dayOfMonth, fieldErrors, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const mreTenantId = z.string().regex(MRE_EXTERNAL_ID);

/** The due day over time (§58A): `validFrom` unique and ascending, each day 1–31, at most 20 entries. */
const rentDueDays = z.array(z.object({ validFrom: businessDate, day: dayOfMonth }).strict()).superRefine((days, ctx) => {
  // Refinements run even after an entry failed to parse: only check a list that parsed.
  if (days.some((d) => typeof d.validFrom !== 'string' || typeof d.day !== 'number')) return;
  if (days.length > MAX_RENT_DUE_DAYS) {
    ctx.addIssue({ code: 'custom', params: { code: 'OUT_OF_RANGE' } });
    return;
  }
  // A day out of range is answered at its entry already (`dayOfMonth`); here only the order.
  const error = rentDueDaysError(days as RentDueDay[]);
  if (error?.code === 'NOT_ASCENDING') ctx.addIssue({ code: 'custom', path: [error.index, 'validFrom'], params: { code: error.code } });
});
const sourceReferences = z.array(z.string().trim().min(1).max(500)).max(10);

const createBody = z
  .object({ mreTenantId, rentDueDays: rentDueDays.optional(), notes: optionalText(2000).nullish(), sourceReferences: sourceReferences.optional() })
  .strict();

/** `mreTenantId` never changes (§58A): named in an amend, it is `400 NOT_AMENDABLE`, not an unknown key. */
const amendBody = z
  .object({
    rentDueDays: rentDueDays.optional(),
    notes: optionalText(2000).nullish(),
    sourceReferences: sourceReferences.optional(),
    mreTenantId: z.unknown().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.mreTenantId !== undefined) ctx.addIssue({ code: 'custom', path: ['mreTenantId'], params: { code: 'NOT_AMENDABLE' } });
  });

const listQuery = z.object({ mreTenantId }).strict();

export interface RentalContractReferenceCommands {
  readonly create: CreateRentalContractReference;
  readonly get: GetRentalContractReference;
  readonly list: ListRentalContractReferences;
  readonly amend: AmendRentalContractReference;
}

/** The minimal RentalContractReference API (api-design.md §58A, backlog VC-7-02). */
export function rentalContractReferenceRoutes(commands: RentalContractReferenceCommands): Router {
  const router = express.Router();

  router.post('/rental-contract-references', express.json({ limit: '32kb' }), (req, res, next) => {
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
        authorizationHeader: req.headers.authorization ?? '',
        mreTenantId: body.mreTenantId,
        rentDueDays: body.rentDueDays ?? [],
        notes: body.notes ?? null,
        sourceReferences: body.sourceReferences ?? [],
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ reference, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.setHeader('Location', `/api/v1/rental-contract-references/${reference.id}`);
        sendReference(res.status(201), reference);
      })
      .catch(next);
  });

  router.get('/rental-contract-references', (req, res, next) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .list({ principal: principalOf(res), mreTenantId: parsed.data.mreTenantId })
      .then((items) => res.json({ items: items.map(referenceDto) }))
      .catch(next);
  });

  router.get('/rental-contract-references/:rentalContractReferenceId', (req, res, next) => {
    const rentalContractReferenceId = readId(req.params['rentalContractReferenceId'], 'rentalContractReferenceId', res);
    if (rentalContractReferenceId === undefined) return;
    commands
      .get({ principal: principalOf(res), rentalContractReferenceId })
      .then((reference) => sendReference(res, reference))
      .catch(next);
  });

  router.post('/rental-contract-references/:rentalContractReferenceId/amend', express.json({ limit: '32kb' }), (req, res, next) => {
    const rentalContractReferenceId = readId(req.params['rentalContractReferenceId'], 'rentalContractReferenceId', res);
    if (rentalContractReferenceId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = amendBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    commands
      .amend({
        principal: principalOf(res),
        rentalContractReferenceId,
        ...(body.rentDueDays === undefined ? {} : { rentDueDays: body.rentDueDays }),
        ...(body.notes === undefined ? {} : { notes: body.notes }),
        ...(body.sourceReferences === undefined ? {} : { sourceReferences: body.sourceReferences }),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ reference }) => sendReference(res, reference))
      .catch(next);
  });

  return router;
}

/** A single reference with its version as `ETag` for the next `If-Match` (api-design.md §16.1). */
function sendReference(res: Response, reference: RentalContractReference): void {
  res.setHeader('ETag', `"${reference.version}"`);
  res.json(referenceDto(reference));
}

function referenceDto(r: RentalContractReference) {
  return {
    rentalContractReferenceId: r.id,
    mreRealmId: r.mreRealmId,
    mreTenantId: r.mreTenantId,
    rentDueDays: r.rentDueDays.map((e) => ({ validFrom: e.validFrom, day: e.day })),
    notes: r.notes,
    sourceReferences: r.sourceReferences,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    version: r.version,
  };
}

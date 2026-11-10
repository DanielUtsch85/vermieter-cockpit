import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  MAX_EVIDENCE_REFERENCE,
  MAX_RENT_DUE_DAYS,
  MRE_EXTERNAL_ID,
  dueDaysEvidenceRecommended,
  rentDueDaysError,
  type AmendRentalContractReference,
  type CreateRentalContractReference,
  type GetRentalContractReference,
  type ListRentalContractReferences,
  type RentDueDay,
  type RentalContractReference,
} from '../application/index.js';
import { zod3 } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, optionalText, readId } from './acquisitions.js';
import { dayOfMonth, jsonBody, NO_QUERY, readBody, readIdempotencyKey, readIfMatch, readQuery, refuseQuery, sendValidationError } from './validation.js';

const mreTenantId = z.string().regex(MRE_EXTERNAL_ID);

/** The due day over time (§58A): `validFrom` unique and ascending, each day 1–31, at most 20 entries. */
/** §58F (0057): the optional evidence of an entry, trimmed, 1–500 characters; `null` is the same as omitted. */
const evidenceReference = z.string().trim().min(1).max(MAX_EVIDENCE_REFERENCE).nullish();
const rentDueDays = zod3.array(z.object({ validFrom: businessDate, day: dayOfMonth, evidenceReference }).strict()).superRefine((days, ctx) => {
  // Refinements run even after an entry failed to parse: only check a list that parsed.
  if (days.some((d) => typeof d.validFrom !== 'string' || typeof d.day !== 'number')) return;
  if (days.length > MAX_RENT_DUE_DAYS) {
    ctx.addIssue({ code: 'custom', params: { code: 'OUT_OF_RANGE' } });
    return;
  }
  // A day out of range is answered at its entry already (`dayOfMonth`); here only the order.
  const error = rentDueDaysError(entriesOf(days));
  if (error?.code === 'NOT_ASCENDING') ctx.addIssue({ code: 'custom', path: [error.index, 'validFrom'], params: { code: error.code } });
});
const sourceReferences = zod3.array(z.string().trim().min(1).max(500)).max(10);

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

const listQuery = z.object({ mreTenantId });

export interface RentalContractReferenceCommands {
  readonly create: CreateRentalContractReference;
  readonly get: GetRentalContractReference;
  readonly list: ListRentalContractReferences;
  readonly amend: AmendRentalContractReference;
}

/** The minimal RentalContractReference API (api-design.md §58A, backlog VC-7-02). */
export function rentalContractReferenceRoutes(commands: RentalContractReferenceCommands): Router {
  const router = express.Router();

  router.post('/rental-contract-references', jsonBody('32kb'), (req, res, next) => {
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
        authorizationHeader: req.headers.authorization ?? '',
        mreTenantId: body.mreTenantId,
        rentDueDays: entriesOf(body.rentDueDays ?? []),
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
    const parsed = readQuery(listQuery, req);
    if (refuseQuery(res, parsed)) return;
    commands
      .list({ principal: principalOf(res), mreTenantId: parsed.data.mreTenantId })
      .then((items) => res.json({ items: items.map(referenceDto) }))
      .catch(next);
  });

  router.get('/rental-contract-references/:rentalContractReferenceId', (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const rentalContractReferenceId = readId(req.params['rentalContractReferenceId'], 'rentalContractReferenceId', res);
    if (rentalContractReferenceId === undefined) return;
    if (refuseQuery(res, query)) return;
    commands
      .get({ principal: principalOf(res), rentalContractReferenceId })
      .then((reference) => sendReference(res, reference))
      .catch(next);
  });

  router.post('/rental-contract-references/:rentalContractReferenceId/amend', jsonBody('32kb'), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const rentalContractReferenceId = readId(req.params['rentalContractReferenceId'], 'rentalContractReferenceId', res);
    if (rentalContractReferenceId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(amendBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    const body = parsed.data;
    commands
      .amend({
        principal: principalOf(res),
        rentalContractReferenceId,
        ...(body.rentDueDays === undefined ? {} : { rentDueDays: entriesOf(body.rentDueDays) }),
        ...(body.notes === undefined ? {} : { notes: body.notes }),
        ...(body.sourceReferences === undefined ? {} : { sourceReferences: body.sourceReferences }),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ reference }) => sendReference(res, reference))
      .catch(next);
  });

  return router;
}

/** The parsed entries as the domain holds them: an evidence of `null` is omitted. */
function entriesOf(days: readonly { validFrom: string; day: number; evidenceReference?: string | null | undefined }[]): RentDueDay[] {
  return days.map((d) => ({
    validFrom: d.validFrom as RentDueDay['validFrom'],
    day: d.day,
    ...(d.evidenceReference === null || d.evidenceReference === undefined ? {} : { evidenceReference: d.evidenceReference }),
  }));
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
    rentDueDays: r.rentDueDays.map((e) => ({ validFrom: e.validFrom, day: e.day, evidenceReference: e.evidenceReference ?? null })),
    notes: r.notes,
    sourceReferences: r.sourceReferences,
    // §58F: the due days decide a tax year; an evidenceReference on each entry is recommended, never required.
    evidenceRecommended: dueDaysEvidenceRecommended(r),
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    version: r.version,
  };
}

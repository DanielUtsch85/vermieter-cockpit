import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  EXTERNAL_REFERENCE_STATUSES,
  MRE_EXTERNAL_ID,
  type CreateExternalReference,
  type EndExternalReference,
  type ListExternalReferences,
  type PartyExternalReference,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { RESOURCE_ID, fieldErrors, readIfMatch, sendValidationError } from './validation.js';

/** Phase 2: MRE Tenants only (api-design.md §20.1); `metadata` is not accepted yet. */
const createBody = z
  .object({
    system: z.literal('MRE'),
    entityType: z.literal('tenant'),
    mreRealmId: z.string().min(1),
    externalId: z.string().regex(MRE_EXTERNAL_ID),
  })
  .strict();

const listQuery = z
  .object({
    status: z.enum(EXTERNAL_REFERENCE_STATUSES).optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export interface ExternalReferenceCommands {
  readonly create: CreateExternalReference;
  readonly end: EndExternalReference;
  readonly list: ListExternalReferences;
}

/** Party external references (api-design.md §20.1, backlog VC-2-02). */
export function externalReferenceRoutes(commands: ExternalReferenceCommands): Router {
  const router = express.Router();

  router.post('/parties/:partyId/external-references', express.json({ limit: '16kb' }), (req, res, next) => {
    const partyId = readId(req.params['partyId'], 'partyId', res);
    if (partyId === undefined) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .create({
        principal: principalOf(res),
        // Present: the access guard has already verified it.
        authorizationHeader: req.headers.authorization ?? '',
        partyId,
        mreRealmId: parsed.data.mreRealmId,
        externalId: parsed.data.externalId,
      })
      .then(({ reference, created }) => sendReference(res.status(created ? 201 : 200), reference))
      .catch(next);
  });

  // Takes no body: ending only sets the status (§20.1).
  router.post('/parties/:partyId/external-references/:externalReferenceId/end', (req, res, next) => {
    const partyId = readId(req.params['partyId'], 'partyId', res);
    if (partyId === undefined) return;
    const externalReferenceId = readId(req.params['externalReferenceId'], 'externalReferenceId', res);
    if (externalReferenceId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    commands
      .end({
        principal: principalOf(res),
        partyId,
        externalReferenceId,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ reference }) => sendReference(res, reference))
      .catch(next);
  });

  router.get('/parties/:partyId/external-references', (req, res, next) => {
    const partyId = readId(req.params['partyId'], 'partyId', res);
    if (partyId === undefined) return;
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { page, pageSize, status } = parsed.data;
    commands
      .list({ principal: principalOf(res), partyId, filter: status === undefined ? {} : { status }, page: { page, pageSize } })
      .then((result) => {
        res.json({ items: result.items.map(toDto), page: result.page, pageSize: result.pageSize, total: result.total });
      })
      .catch(next);
  });

  return router;
}

function readId(value: string | undefined, field: string, res: Response): string | undefined {
  if (value !== undefined && RESOURCE_ID.test(value)) return value.toLowerCase();
  sendValidationError(res, [{ field, code: 'INVALID_FORMAT' }]);
  return undefined;
}

/** A single reference with its version as `ETag` for the next `If-Match` (api-design.md §16.1). */
function sendReference(res: Response, reference: PartyExternalReference): void {
  res.setHeader('ETag', `"${reference.version}"`);
  res.json(toDto(reference));
}

function toDto(reference: PartyExternalReference) {
  return {
    externalReferenceId: reference.id,
    partyId: reference.partyId,
    system: reference.system,
    mreRealmId: reference.mreRealmId,
    entityType: reference.entityType,
    externalId: reference.externalId,
    status: reference.status,
    endedAt: reference.endedAt?.toISOString() ?? null,
    createdAt: reference.createdAt.toISOString(),
    version: reference.version,
  };
}

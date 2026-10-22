import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  AccessError,
  ConcurrentUpdateError,
  EXTERNAL_REFERENCE_STATUSES,
  ExternalReferenceInUseError,
  ExternalReferenceNotFoundError,
  MRE_EXTERNAL_ID,
  MreTenantNotFoundError,
  MreUnavailableError,
  PartyInactiveError,
  PartyNotFoundError,
  VersionConflictError,
  type CreateExternalReference,
  type EndExternalReference,
  type ListExternalReferences,
  type PartyExternalReference,
  type RealmPrincipal,
} from '../application/index.js';
import { sendAccessError, sendError } from './errors.js';
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
  const principalOf = (res: Response) => res.locals['principal'] as RealmPrincipal;

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
      .catch((error: unknown) => {
        if (!sendReferenceError(res, error, { partyId })) next(error);
      });
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
      .catch((error: unknown) => {
        if (!sendReferenceError(res, error, { partyId, externalReferenceId })) next(error);
      });
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
      .catch((error: unknown) => {
        if (!sendReferenceError(res, error, { partyId })) next(error);
      });
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

/** The refusals of §20.1; false for anything else (→ the error handler). */
function sendReferenceError(res: Response, error: unknown, ids: { partyId: string; externalReferenceId?: string }): boolean {
  if (error instanceof PartyNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Party not found.', { partyId: ids.partyId });
  } else if (error instanceof ExternalReferenceNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'External reference not found.', { externalReferenceId: ids.externalReferenceId });
  } else if (error instanceof MreTenantNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'MRE Tenant not found in this Realm.', { externalId: error.externalId });
  } else if (error instanceof ExternalReferenceInUseError) {
    sendError(res, 409, 'CONFLICT', 'Another Party holds this external reference.', { reason: 'REFERENCE_IN_USE', partyId: error.partyId });
  } else if (error instanceof PartyInactiveError) {
    sendError(res, 409, 'CONFLICT', 'An inactive Party gets no new external reference.', { reason: 'PARTY_INACTIVE', partyId: error.partyId });
  } else if (error instanceof VersionConflictError) {
    sendError(res, 412, 'VERSION_CONFLICT', 'The external reference changed since the version given in If-Match.', {
      expectedVersions: error.expectedVersions,
      currentVersion: error.currentVersion,
    });
  } else if (error instanceof AccessError) {
    sendAccessError(res, error.code);
  } else if (error instanceof MreUnavailableError) {
    sendError(res, 503, 'EXTERNAL_SYSTEM_ERROR', 'MRE is unavailable; nothing was written.');
  } else if (error instanceof ConcurrentUpdateError) {
    // Not a server fault: concurrent claims kept winning; nothing was written and a retry is safe (review on #41).
    res.setHeader('Retry-After', '1');
    sendError(res, 503, 'CONCURRENT_UPDATE', 'The external reference kept changing concurrently; nothing was written. Retry.');
  } else {
    return false;
  }
  return true;
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

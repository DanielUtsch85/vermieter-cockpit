import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import { zod3 } from '../shared/index.js';
import {
  EXTERNAL_REFERENCE_STATES,
  MRE_OBJECT_ID,
  MreUnavailableError,
  type GetPropertyReference,
  type LinkPropertyReference,
  type ListPropertyReferences,
  type PropertyReference,
  type RefreshPropertyReference,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { sendError } from './errors.js';
import { EMPTY_BODY, NO_QUERY, PAGING, readBody, readQuery, refuseQuery, RESOURCE_ID, sendValidationError } from './validation.js';

/** A malformed MRE id would end in a 500 upstream, so it is rejected here (mre-integration.md §21.1). */
const linkBody = z
  .object({
    mreRealmId: z.string().min(1),
    mrePropertyId: z.string().regex(MRE_OBJECT_ID),
  })
  .strict();

/** api-design.md §23.3; unknown parameters are `400`. */
const listQuery = z.object({
  externalReferenceState: zod3
    .transform(z.string(), (value) => value.split(','))
    .pipe(zod3.array(z.enum(EXTERNAL_REFERENCE_STATES)).min(1))
    .optional(),
  ...PAGING,
});

export interface PropertyReferenceCommands {
  readonly link: LinkPropertyReference;
  readonly refresh: RefreshPropertyReference;
  readonly get: GetPropertyReference;
  readonly list: ListPropertyReferences;
}

/** Property Reference API (api-design.md §22–23). */
export function propertyReferenceRoutes(commands: PropertyReferenceCommands): Router {
  const router = express.Router();

  router.post('/property-references/link', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    if (refuseQuery(res, query)) return;
    const parsed = readBody(linkBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }

    commands
      .link({
        principal: principalOf(res),
        // Present: the access guard has already verified it.
        authorizationHeader: req.headers.authorization ?? '',
        ...parsed.data,
      })
      .then(({ reference, created }) => {
        res.status(created ? 201 : 200).json(toDto(reference));
      })
      .catch((error: unknown) => {
        if (!sendCommonError(res, error, 'nothing was linked')) {
          next(error);
        }
      });
  });

  // Both reads answer from DE's cached data and never call MRE (§23.3).
  router.get('/property-references', (req, res, next) => {
    const parsed = readQuery(listQuery, req);
    if (refuseQuery(res, parsed)) return;
    const { page, pageSize, externalReferenceState } = parsed.data;
    commands
      .list({
        principal: principalOf(res),
        filter: externalReferenceState === undefined ? {} : { states: externalReferenceState },
        page: { page, pageSize },
      })
      .then((result) => {
        res.json({ items: result.items.map(toDto), page: result.page, pageSize: result.pageSize, total: result.total });
      })
      .catch(next);
  });

  router.get('/property-references/:propertyReferenceId', (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const { propertyReferenceId } = req.params;
    if (!RESOURCE_ID.test(propertyReferenceId)) {
      sendValidationError(res, [{ field: 'propertyReferenceId', code: 'INVALID_FORMAT' }]);
      return;
    }
    if (refuseQuery(res, query)) return;
    commands
      .get({ principal: principalOf(res), propertyReferenceId: propertyReferenceId.toLowerCase() })
      .then((reference) => {
        // Its version as `ETag` (api-design.md §16.1).
        res.setHeader('ETag', `"${reference.version}"`);
        res.json(toDto(reference));
      })
      .catch(next);
  });

  // Takes no body (no body, an empty one or `{}`; a field is unknown, §58X rule 3); a refresh only re-reads MRE (VC-1-02).
  router.post('/property-references/:propertyReferenceId/refresh', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const { propertyReferenceId } = req.params;
    if (!RESOURCE_ID.test(propertyReferenceId)) {
      sendValidationError(res, [{ field: 'propertyReferenceId', code: 'INVALID_FORMAT' }]);
      return;
    }

    if (refuseQuery(res, query)) return;
    const empty = readBody(EMPTY_BODY, req);
    if (!empty.ok) {
      sendValidationError(res, empty.errors);
      return;
    }
    commands
      .refresh({
        principal: principalOf(res),
        authorizationHeader: req.headers.authorization ?? '',
        propertyReferenceId,
      })
      .then((reference) => {
        res.status(200).json(toDto(reference));
      })
      .catch((error: unknown) => {
        if (!sendCommonError(res, error, 'nothing was changed')) {
          next(error);
        }
      });
  });

  return router;
}

/** Access and MRE availability errors shared by the commands; false if `error` is neither. */
function sendCommonError(res: Response, error: unknown, outcome: string): boolean {
  if (error instanceof MreUnavailableError) {
    sendError(res, 503, 'EXTERNAL_SYSTEM_ERROR', `MRE is unavailable; ${outcome}.`);
    return true;
  }
  return false;
}

export function toDto(reference: PropertyReference) {
  return {
    propertyReferenceId: reference.id,
    mreRealmId: reference.mreRealmId,
    mrePropertyId: reference.mrePropertyId,
    externalReferenceState: reference.externalReferenceState,
    displayName: reference.displayName,
    cachedAddress: reference.cachedAddress,
    // Decimal string, never a JSON number (exactness, api-design.md).
    cachedSurface: reference.cachedSurface?.toString() ?? null,
    lastRefreshedAt: reference.lastRefreshedAt?.toISOString() ?? null,
    lastObservedAt: reference.lastObservedAt?.toISOString() ?? null,
    createdAt: reference.createdAt.toISOString(),
    version: reference.version,
  };
}

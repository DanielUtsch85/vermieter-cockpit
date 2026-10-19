import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  AccessError,
  MRE_OBJECT_ID,
  MrePropertyNotFoundError,
  MreUnavailableError,
  PropertyReferenceNotFoundError,
  type LinkPropertyReference,
  type PropertyReference,
  type RealmPrincipal,
  type RefreshPropertyReference,
} from '../application/index.js';
import { sendAccessError, sendError } from './errors.js';

/** A malformed MRE id would end in a 500 upstream, so it is rejected here (mre-integration.md §21.1). */
const linkBody = z.object({
  mreRealmId: z.string().min(1),
  mrePropertyId: z.string().regex(MRE_OBJECT_ID),
});

const PROPERTY_REFERENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PropertyReferenceCommands {
  readonly link: LinkPropertyReference;
  readonly refresh: RefreshPropertyReference;
}

/** Property Reference API (api-design.md §22–23). */
export function propertyReferenceRoutes(commands: PropertyReferenceCommands): Router {
  const router = express.Router();

  router.post('/property-references/link', express.json({ limit: '16kb' }), (req, res, next) => {
    const parsed = linkBody.safeParse(req.body);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(body)',
        code: issue.code === 'invalid_type' && issue.received === 'undefined' ? 'REQUIRED' : 'INVALID_FORMAT',
      }));
      sendError(res, 400, 'VALIDATION_ERROR', 'Validation failed.', { fields });
      return;
    }

    commands
      .link({
        principal: res.locals['principal'] as RealmPrincipal,
        // Present: the access guard has already verified it.
        authorizationHeader: req.headers.authorization ?? '',
        ...parsed.data,
      })
      .then(({ reference, created }) => {
        res.status(created ? 201 : 200).json(toDto(reference));
      })
      .catch((error: unknown) => {
        if (error instanceof MrePropertyNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'MRE Property not found in this Realm.', {
            mreRealmId: error.mreRealmId,
            mrePropertyId: error.mrePropertyId,
          });
        } else if (!sendCommonError(res, error, 'nothing was linked')) {
          next(error);
        }
      });
  });

  // Takes no body; a refresh only re-reads MRE (VC-1-02).
  router.post('/property-references/:propertyReferenceId/refresh', (req, res, next) => {
    const { propertyReferenceId } = req.params;
    if (!PROPERTY_REFERENCE_ID.test(propertyReferenceId)) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Validation failed.', {
        fields: [{ field: 'propertyReferenceId', code: 'INVALID_FORMAT' }],
      });
      return;
    }

    commands
      .refresh({
        principal: res.locals['principal'] as RealmPrincipal,
        authorizationHeader: req.headers.authorization ?? '',
        propertyReferenceId,
      })
      .then((reference) => {
        res.status(200).json(toDto(reference));
      })
      .catch((error: unknown) => {
        if (error instanceof PropertyReferenceNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'PropertyReference not found.', { propertyReferenceId });
        } else if (!sendCommonError(res, error, 'nothing was changed')) {
          next(error);
        }
      });
  });

  return router;
}

/** Access and MRE availability errors shared by the commands; false if `error` is neither. */
function sendCommonError(res: Response, error: unknown, outcome: string): boolean {
  if (error instanceof AccessError) {
    sendAccessError(res, error.code);
    return true;
  }
  if (error instanceof MreUnavailableError) {
    sendError(res, 503, 'EXTERNAL_SYSTEM_ERROR', `MRE is unavailable; ${outcome}.`);
    return true;
  }
  return false;
}

function toDto(reference: PropertyReference) {
  return {
    id: reference.id,
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

import express, { type Router } from 'express';
import { z } from 'zod';
import {
  AccessError,
  MRE_OBJECT_ID,
  MrePropertyNotFoundError,
  MreUnavailableError,
  type LinkPropertyReference,
  type PropertyReference,
  type RealmPrincipal,
} from '../application/index.js';
import { sendAccessError, sendError } from './errors.js';

/** A malformed MRE id would end in a 500 upstream, so it is rejected here (mre-integration.md §21.1). */
const linkBody = z.object({
  mreRealmId: z.string().min(1),
  mrePropertyId: z.string().regex(MRE_OBJECT_ID),
});

/** Property Reference API (api-design.md §22–23). */
export function propertyReferenceRoutes(link: LinkPropertyReference): Router {
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

    link({
      principal: res.locals['principal'] as RealmPrincipal,
      // Present: the access guard has already verified it.
      authorizationHeader: req.headers.authorization ?? '',
      ...parsed.data,
    })
      .then(({ reference, created }) => {
        res.status(created ? 201 : 200).json(toDto(reference));
      })
      .catch((error: unknown) => {
        if (error instanceof AccessError) {
          sendAccessError(res, error.code);
        } else if (error instanceof MrePropertyNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'MRE Property not found in this Realm.', {
            mreRealmId: error.mreRealmId,
            mrePropertyId: error.mrePropertyId,
          });
        } else if (error instanceof MreUnavailableError) {
          sendError(res, 503, 'EXTERNAL_SYSTEM_ERROR', 'MRE is unavailable; nothing was linked.');
        } else {
          next(error);
        }
      });
  });

  return router;
}

function toDto(reference: PropertyReference) {
  return {
    id: reference.id,
    mreRealmId: reference.mreRealmId,
    mrePropertyId: reference.mrePropertyId,
    externalReferenceState: reference.externalReferenceState,
    displayName: reference.displayName,
    cachedAddress: reference.cachedAddress,
    lastRefreshedAt: reference.lastRefreshedAt?.toISOString() ?? null,
    createdAt: reference.createdAt.toISOString(),
  };
}

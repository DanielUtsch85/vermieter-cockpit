import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AccessError, assertDeAccess, type PrincipalVerifier, type RealmPrincipal } from '../application/index.js';
import { sendAccessError } from './errors.js';

/**
 * Guards every DE business endpoint (VC-0-08): the caller must present a valid
 * MRE landlord token (`Authorization: Bearer …`) and the Realm in the
 * `organizationid` header (same header as the MRE landlord API, API-OPEN-002),
 * must be a member of that Realm, and must hold a role with DE access.
 *
 * On success the principal is available as `res.locals.principal`.
 */

export function requireDeAccess(verify: PrincipalVerifier): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const realmHeader = req.headers['organizationid'];
    const mreRealmId = typeof realmHeader === 'string' ? realmHeader : undefined;
    verify(req.headers.authorization, mreRealmId)
      .then((principal) => {
        assertDeAccess(principal);
        res.locals['principal'] = principal satisfies RealmPrincipal;
        next();
      })
      .catch((error: unknown) => {
        // Anything that is not a recognised access outcome fails closed as 503.
        sendAccessError(res, error instanceof AccessError ? error.code : 'AUTH_UNAVAILABLE');
      });
  };
}

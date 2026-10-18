import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AccessError, assertDeAccess, type PrincipalVerifier, type RealmPrincipal } from '../application/index.js';

/**
 * Guards every DE business endpoint (VC-0-08): the caller must present a valid
 * MRE landlord token (`Authorization: Bearer …`) and the Realm in the
 * `organizationid` header (same header as the MRE landlord API, API-OPEN-002),
 * must be a member of that Realm, and must hold a role with DE access.
 *
 * On success the principal is available as `res.locals.principal`.
 */

const STATUS: Record<AccessError['code'], { status: number; code: string }> = {
  UNAUTHENTICATED: { status: 401, code: 'UNAUTHORIZED' },
  FORBIDDEN: { status: 403, code: 'FORBIDDEN' },
  AUTH_UNAVAILABLE: { status: 503, code: 'EXTERNAL_SYSTEM_ERROR' },
};

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
        const code = error instanceof AccessError ? error.code : 'AUTH_UNAVAILABLE';
        const mapped = STATUS[code];
        if (mapped.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
        res.status(mapped.status).json({ error: { code: mapped.code, message: messageFor(code) } });
      });
  };
}

function messageFor(code: AccessError['code']): string {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 'A valid MRE access token is required.';
    case 'FORBIDDEN':
      return 'No access to this Realm.';
    case 'AUTH_UNAVAILABLE':
      return 'Authentication service unavailable.';
  }
}

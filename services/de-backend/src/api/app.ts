import express, { type Express } from 'express';
import type { PrincipalVerifier, RealmPrincipal } from '../application/index.js';
import { requireDeAccess } from './access-middleware.js';

/**
 * HTTP application (ADR-026, api-design.md). Infrastructure is injected by the
 * composition root (`main.ts`), so the API layer never imports adapters directly.
 */
export interface AppDependencies {
  /** Resolves true when the DE backend can serve requests (e.g. PostgreSQL reachable). */
  readonly isReady: () => Promise<boolean>;
  /** Verifies MRE identity and Realm membership (VC-0-08). */
  readonly verifyPrincipal: PrincipalVerifier;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  // Liveness: the process is up. Unauthenticated and free of data, for orchestrators.
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: dependencies are reachable. A failing or throwing check is "not ready".
  app.get('/health/ready', (_req, res) => {
    deps
      .isReady()
      .catch(() => false)
      .then((ready) => {
        res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable' });
      });
  });

  // Business API: every route below requires a verified principal with DE access.
  const api = express.Router();
  api.use(requireDeAccess(deps.verifyPrincipal));
  api.get('/health', (_req, res) => {
    const principal = res.locals['principal'] as RealmPrincipal;
    res.json({ status: 'ok', mreRealmId: principal.mreRealmId });
  });
  app.use('/api/v1', api);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  return app;
}

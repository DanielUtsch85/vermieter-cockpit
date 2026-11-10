import type { RequestHandler, Router } from 'express';

/**
 * VC-X-66 (Express 4 → 5): the two routing answers Express 5 gives differently, kept as Express 4 gave them, so that no
 * client sees a change (`express-behaviour-unchanged.test.ts`). The JSON body parser is `jsonBody` (validation.ts).
 */

/**
 * Express 4 mounted `/api/v1` with the matcher `^\/api\/v1\/?(?=\/|$)`, which also took one slash of `/api/v1//x`, so
 * `/api/v1//health` reached `/health`. Express 5 takes `/api/v1` only and `//health` matches no route (`404`). The first
 * layer of the API router takes that one slash again.
 */
export const slashAfterMountAsExpress4: RequestHandler = (req, _res, next) => {
  if (req.url.startsWith('//')) req.url = req.url.slice(1);
  next();
};

interface Layer {
  readonly name?: string;
  readonly slash?: boolean;
  readonly route?: { readonly methods: Readonly<Record<string, boolean>> };
  readonly handle?: { readonly stack?: readonly Layer[] };
  match(path: string): boolean;
}

/** A route's methods as Express 4 listed them for OPTIONS: in order, upper case, `HEAD` after a `GET` without one. */
function methodsOf(route: NonNullable<Layer['route']>): string[] {
  const methods = Object.keys(route.methods).filter((m) => route.methods[m] === true);
  if (route.methods['get'] === true && route.methods['head'] !== true) methods.push('head');
  return methods.map((m) => m.toUpperCase());
}

/**
 * Express 4's answer to an OPTIONS request, router by router: each router collects the methods of its routes that match
 * the path, in order; a nested router with any answers for itself, first (so a path served by two routers lists the
 * first one's methods only); otherwise its parent answers with its own. `undefined` when none matches.
 */
function allowed(stack: readonly Layer[], path: string): string[] | undefined {
  const own: string[] = [];
  for (const layer of stack) {
    if (layer.route !== undefined) {
      if (!layer.match(path)) continue;
      // A route with its own OPTIONS handler answers itself (none has one): leave it to Express.
      if (layer.route.methods['options'] === true || layer.route.methods['_all'] === true) throw new Error('OPTIONS handled by a route');
      for (const method of methodsOf(layer.route)) if (!own.includes(method)) own.push(method);
    } else if (layer.name === 'router' && layer.handle?.stack !== undefined) {
      if (layer.slash !== true) throw new Error('a router mounted under a path');
      const inner = allowed(layer.handle.stack, path);
      if (inner !== undefined) return inner;
    }
  }
  return own.length > 0 ? own : undefined;
}

/**
 * Express 4 answered OPTIONS with `Allow: GET,HEAD` and the same text as body, sent by `res.send` (`text/html`, an
 * `ETag`); Express 5 sends `Allow: GET, HEAD` sorted, `text/plain`, `nosniff`, no `ETag`. This handler, placed in the API
 * router after the access check and before the routes, answers as Express 4 did. When nothing matches, or a path cannot
 * be decoded, Express goes on as before (the app's `404`, or the error handler).
 */
export function optionsAsExpress4(router: Router): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'OPTIONS') {
      next();
      return;
    }
    let methods: string[] | undefined;
    try {
      methods = allowed((router as unknown as { stack: readonly Layer[] }).stack, req.path);
    } catch {
      next();
      return;
    }
    if (methods === undefined) {
      next();
      return;
    }
    const body = methods.join(',');
    res.set('Allow', body);
    res.send(body);
  };
}

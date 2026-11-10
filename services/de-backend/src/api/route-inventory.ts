import type { Express } from 'express';
import { createApp, type AppDependencies } from './app.js';

/**
 * The route inventory (ui-guide.md §2): every route the running app registers, read from Express's router stack, so a
 * route registered with a template literal or a variable is listed like any other (review on #175). Implemented routes
 * only, never the specification. Written to docs/development/api-inventory.md by `yarn api:inventory` (src/route-inventory.test.ts with API_INVENTORY_WRITE=1).
 */
export interface InventoryRoute {
  readonly method: string;
  readonly path: string;
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

interface Layer {
  readonly name?: string;
  /** Express 5 (router 2): `true` for a layer mounted without a path (`router.use(fn)`). */
  readonly slash?: boolean;
  /** Express 5 (router 2): the layer's path matchers; a mount path is no longer kept as text. */
  readonly matchers?: readonly ((path: string) => false | { readonly path: string })[];
  readonly route?: { readonly path: unknown; readonly methods: Record<string, boolean> };
  readonly handle?: { readonly stack?: readonly Layer[] };
}

/** The mount paths the app uses (`app.use('/api/v1', api)`); a router layer mounted elsewhere fails the inventory. */
export const MOUNT_PATHS: readonly string[] = ['/api/v1'];

/**
 * The mount path of a router layer (`app.use('/api/v1', router)`). Express 5 keeps only a matcher, so the path is the one
 * candidate of `MOUNT_PATHS` the layer matches exactly (as a whole, not a prefix of it); none or more than one fails.
 */
export function mountPathOf(layer: Layer, candidates: readonly string[] = MOUNT_PATHS): string {
  if (layer.slash === true) return '';
  const matchers = layer.matchers;
  if (matchers === undefined || matchers.length !== 1) throw new Error('route inventory: a router layer without one matcher');
  const matcher = matchers[0] as NonNullable<Layer['matchers']>[number];
  const found = candidates.filter((candidate) => {
    const match = matcher(candidate);
    return match !== false && match.path === candidate;
  });
  if (found.length !== 1) throw new Error(`route inventory: a mount path it cannot read (${found.length} of ${candidates.join(', ')} match)`);
  return found[0] as string;
}

/** Every route of the app's router stack, nested routers included, sorted by path and method. */
export function listRoutes(app: Express): InventoryRoute[] {
  const stack = (app as unknown as { router?: { stack?: readonly Layer[] } }).router?.stack;
  if (!stack) throw new Error('route inventory: the app has no router');
  const routes: InventoryRoute[] = [];
  const walk = (layers: readonly Layer[], prefix: string): void => {
    for (const layer of layers) {
      if (layer.route) {
        if (typeof layer.route.path !== 'string') throw new Error(`route inventory: a route path that is not a string under ${prefix || '/'}`);
        for (const [method, on] of Object.entries(layer.route.methods)) {
          if (on) routes.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPathOf(layer));
      }
    }
  };
  walk(stack, '');
  const rank = (m: string) => (METHOD_ORDER.includes(m) ? METHOD_ORDER.indexOf(m) : METHOD_ORDER.length);
  return routes.sort((a, b) => (a.path === b.path ? rank(a.method) - rank(b.method) : a.path < b.path ? -1 : 1));
}

/** The app as served, wired with inert dependencies: the routes are registered when the app is built, never called here. */
export function appForInventory(): Express {
  const inert: object = new Proxy(() => inert, { get: (_target, key) => (key === 'then' ? undefined : inert) });
  return createApp(inert as AppDependencies);
}

/** The module of a route: its first path segment under /api/v1, or "health" for the server-root probes. */
function moduleOf(path: string): string {
  const rest = path.startsWith('/api/v1/') ? path.slice('/api/v1/'.length) : path.slice(1);
  return rest.split('/')[0] || 'health';
}

/** The inventory as Markdown (docs/development/api-inventory.md). */
export function renderInventory(routes: readonly InventoryRoute[]): string {
  const byModule = new Map<string, InventoryRoute[]>();
  for (const r of routes) byModule.set(moduleOf(r.path), [...(byModule.get(moduleOf(r.path)) ?? []), r]);
  const lines = [
    '# API inventory (generated)',
    '',
    'Every route the DE backend registers, read from the router of the app as `createApp` builds it',
    '(`services/de-backend/src/api/route-inventory.ts`). Regenerate with `yarn api:inventory`; the backend test',
    '`route-inventory.test.ts` (CI: `yarn api:inventory:check` and the full suite) fails when it differs. Do not edit by hand.',
    '',
    'Implemented routes only: a route in `docs/architecture/api-design.md` that is not listed here is specified, not available.',
    'Contracts, payloads and error codes are in `api-design.md`; the business routes need `Authorization: Bearer <MRE token>` and',
    '`organizationid: <mreRealmId>` (`mre-integration.md` §47.2).',
    '',
    `Routes: ${routes.length}.`,
    '',
    '| Method | Path |',
    '|---|---|',
    ...routes.map((r) => `| ${r.method} | \`${r.path}\` |`),
    '',
    '## By module',
    '',
  ];
  for (const [module, list] of [...byModule.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`### \`${module}\``, '', ...list.map((r) => `- ${r.method} \`${r.path}\``), '');
  }
  return lines.join('\n');
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BACKEND_PIN, USED_ROUTES } from './backend-pin';

const repository = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repository), 'utf8');
const inventory = read('docs/development/api-inventory.md');

/** The routes of the inventory's table, as `METHOD path`. */
function inventoryRoutes(text: string): Set<string> {
  return new Set([...text.matchAll(/^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \|$/gm)].map((match) => `${match[1]} ${match[2]}`));
}

/** The routes the cockpit calls that the inventory does not list. */
function missingRoutes(text: string, used: typeof USED_ROUTES): string[] {
  const routes = inventoryRoutes(text);
  return used.map(([method, path]) => `${method} ${path}`).filter((route) => !routes.has(route));
}

describe('integration gate: the pinned backend state (ui-guide.md §10)', () => {
  it('the route inventory is the pinned one; a change means checking routes and DTOs and moving the pin', () => {
    const sha256 = createHash('sha256').update(inventory).digest('hex');
    expect(sha256, 'docs/development/api-inventory.md differs from the pinned inventory: re-check the routes the cockpit uses, then move BACKEND_PIN').toBe(
      BACKEND_PIN.inventorySha256,
    );
    expect(inventory).toContain(`Routes: ${BACKEND_PIN.routes}.`);
    expect(inventoryRoutes(inventory).size).toBe(BACKEND_PIN.routes);
  });

  it('every route the cockpit calls is in the inventory', () => {
    expect(USED_ROUTES.length).toBeGreaterThan(0);
    expect(missingRoutes(inventory, USED_ROUTES)).toEqual([]);
  });

  it('counter-check: a route that is not in the inventory is found missing', () => {
    expect(missingRoutes(inventory, [...USED_ROUTES, ['GET', '/api/v1/portfolio-kpis']])).toEqual(['GET /api/v1/portfolio-kpis']);
    expect(missingRoutes(inventory.replace('| GET | `/api/v1/health` |', ''), USED_ROUTES)).toEqual(['GET /api/v1/health']);
  });

  it('the pin is a full commit id', () => {
    expect(BACKEND_PIN.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('one Vitest and one TypeScript for the repository (Entscheidung des Projektinhabers, 2026-11-09)', () => {
  it('the cockpit asks for the same Vitest and TypeScript as the backend', () => {
    type Manifest = { devDependencies: Record<string, string> };
    const backend = JSON.parse(read('services/de-backend/package.json')) as Manifest;
    const cockpit = JSON.parse(read('webapps/cockpit/package.json')) as Manifest;
    expect(cockpit.devDependencies['vitest']).toBe(backend.devDependencies['vitest']);
    expect(cockpit.devDependencies['typescript']).toBe(backend.devDependencies['typescript']);
  });

  it('the lockfile resolves Vitest to exactly one version', () => {
    const entries = [...read('yarn.lock').matchAll(/^"vitest@npm:[^\n]*\n {2}version: (\S+)$/gm)].map((match) => match[1]);
    expect(entries).toHaveLength(1);
  });
});

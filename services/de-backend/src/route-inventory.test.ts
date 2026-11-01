import { readFileSync, writeFileSync } from 'node:fs';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { appForInventory, listRoutes, mountPathOf, renderInventory } from './api/route-inventory.js';

const inventoryFile = new URL('../../../docs/development/api-inventory.md', import.meta.url);

describe('the route inventory (ui-guide §2; review on #175)', () => {
  // `yarn api:inventory` runs this file with API_INVENTORY_WRITE=1 and writes the file; otherwise it is the check.
  it('docs/development/api-inventory.md lists exactly the routes the app registers', () => {
    const expected = renderInventory(listRoutes(appForInventory()));
    if (process.env.API_INVENTORY_WRITE === '1') writeFileSync(inventoryFile, expected);
    expect(readFileSync(inventoryFile, 'utf8')).toBe(expected);
  });

  it('a route registered with a template literal or a variable is listed, under its mount path, and its absence is a drift', () => {
    const segment = 'tax-years';
    const nested = express.Router();
    nested.get(`/property-references/:id/${segment}/:year`, (_req, res) => res.end());
    const path = '/loans/:id';
    nested.post(path, (_req, res) => res.end());
    const api = express.Router();
    api.use(nested);
    const app = express();
    app.get('/health/live', (_req, res) => res.end());
    app.use('/api/v1', api);
    const routes = listRoutes(app);
    expect(routes).toEqual([
      { method: 'POST', path: '/api/v1/loans/:id' },
      { method: 'GET', path: '/api/v1/property-references/:id/tax-years/:year' },
      { method: 'GET', path: '/health/live' },
    ]);
    // The check compares the rendered file with the app: an inventory without the template-literal route differs.
    const withoutIt = renderInventory(routes.filter((r) => !r.path.includes(segment)));
    expect(withoutIt).not.toBe(renderInventory(routes));
  });

  it('a mount path it cannot read fails loudly instead of listing the route under a wrong path', () => {
    expect(mountPathOf({ regexp: Object.assign(/^\/api\/v1\/?(?=\/|$)/i, { fast_slash: false }) })).toBe('/api/v1');
    expect(mountPathOf({ regexp: Object.assign(/^\/?(?=\/|$)/i, { fast_slash: true }) })).toBe('');
    expect(() => mountPathOf({ regexp: Object.assign(/^\/items\/(?:([^/]+?))\/?(?=\/|$)/i, { fast_slash: false }) })).toThrow(/cannot read/);
  });

  it('a route path that is not a string (a regular expression or a list) fails loudly', () => {
    const app = express();
    app.get(/^\/anything$/, (_req, res) => res.end());
    expect(() => listRoutes(app)).toThrow(/not a string/);
  });
});

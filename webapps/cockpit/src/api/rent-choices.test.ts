import { describe, expect, it } from 'vitest';
import { rentTenant, TENANT, TENANT_2, TERM, tenantTerms } from '../rent/fixtures.test-support';
import { REALM_A } from '../transactions/fixtures.test-support';
import { USED_ROUTES } from '../gate/backend-pin';
import { createDeClient } from './client';
import { ApiError, CLIENT_CODES } from './errors';
import { countingTokens, json, scriptedFetch } from './fetch.test-support';
import { getTenantTerms, listRentTenants, TENANT_PAGE_SIZE } from './rent-reconciliations';

/**
 * Client contract of #364 (api-design.md §37.7; Entscheidung des Projektinhabers, 2026-11-16): the Realm's Tenants and a
 * Tenant's terms as they leave the browser, and the answers the client accepts. Synthetic ids only.
 */
function client(...answers: Parameters<typeof scriptedFetch>) {
  const { fetch, calls } = scriptedFetch(...answers);
  return { client: createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch }), calls };
}
const refused = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).code;
};
const WINDOW = { from: '2026-02', to: '2026-04' };
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, page: 1, pageSize: TENANT_PAGE_SIZE, total: items.length, ...extra });

describe('#364: GET /rent-reconciliations/tenants (§37.7 (a))', () => {
  it('a read of the first page at the largest page size; nothing else in the query, no body', async () => {
    const answer = page([rentTenant(), rentTenant({ mreTenantId: TENANT_2 })]);
    const { client: de, calls } = client(json(200, answer));
    expect(await listRentTenants(de)).toEqual(answer);
    const url = new URL(calls[0]?.url ?? '', 'https://cockpit.internal');
    expect([calls[0]?.method, url.pathname, [...url.searchParams.entries()]]).toEqual([
      'GET',
      '/api/v1/rent-reconciliations/tenants',
      [
        ['page', '1'],
        ['pageSize', '200'],
      ],
    ]);
    expect(calls[0]?.headers.get('organizationid')).toBe(REALM_A);
    expect(calls[0]?.body).toBeUndefined();
  });

  it('another page, an id that is no MRE id or one listed twice is refused, never shown', async () => {
    for (const answer of [page([rentTenant()], { page: 2 }), page([rentTenant({ mreTenantId: 'Erika Beispiel' })]), page([rentTenant(), rentTenant()])]) {
      const { client: de } = client(json(200, answer));
      expect(await refused(listRentTenants(de))).toBe(CLIENT_CODES.unexpected);
    }
  });
});

describe('#364: GET /rent-reconciliations/terms/{mreTenantId}?from&to (§37.7 (b))', () => {
  it('the Tenant in the path, exactly from and to in the query', async () => {
    const { client: de, calls } = client(json(200, tenantTerms()));
    expect(await getTenantTerms(de, TENANT, WINDOW)).toEqual(tenantTerms());
    const url = new URL(calls[0]?.url ?? '', 'https://cockpit.internal');
    expect([calls[0]?.method, url.pathname, [...url.searchParams.entries()]]).toEqual([
      'GET',
      `/api/v1/rent-reconciliations/terms/${TENANT}`,
      [
        ['from', '2026-02'],
        ['to', '2026-04'],
      ],
    ]);
  });

  it('another Tenant or window, a term outside it, a term twice, a month that is not the key, or MRE values without MRE are refused', async () => {
    const [april, march] = tenantTerms().items;
    if (april === undefined || march === undefined) throw new Error('fixture');
    for (const answer of [
      tenantTerms({ mreTenantId: TENANT_2 }),
      tenantTerms({ from: '2026-01' }),
      tenantTerms({ items: [{ ...march, mreRentTerm: '2026010100', month: '2026-01' }] }),
      tenantTerms({ items: [march, march] }),
      tenantTerms({ items: [{ ...march, month: '2026-04' }] }),
      tenantTerms({ mreStatus: 'UNAVAILABLE' }),
    ]) {
      const { client: de } = client(json(200, answer));
      expect(await refused(getTenantTerms(de, TENANT, WINDOW))).toBe(CLIENT_CODES.unexpected);
    }
    const deOnly = { ...march, inMre: null, amountDue: null, coverage: null, openAmount: null };
    const { client: ok } = client(json(200, tenantTerms({ mreStatus: 'NOT_RETURNED', items: [deOnly] })));
    expect((await getTenantTerms(ok, TENANT, WINDOW)).items).toEqual([deOnly]);
    expect(deOnly.mreRentTerm).toBe(TERM);
  });

  it('both routes are in USED_ROUTES', () => {
    const used = USED_ROUTES.map(([method, path]) => `${method} ${path}`);
    expect(used).toContain('GET /api/v1/rent-reconciliations/tenants');
    expect(used).toContain('GET /api/v1/rent-reconciliations/terms/:mreTenantId');
  });
});

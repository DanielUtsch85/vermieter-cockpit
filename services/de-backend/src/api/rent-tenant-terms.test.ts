import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessError, type GetTenantTerms, type ListRentTenants, type PrincipalVerifier, type TenantTerms } from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** §37.7's HTTP contract (#364, VC-X-72): the two reads' queries, answers and route order. Synthetic values only. */
const REALM = '64b0c0ffee00000000000017';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
const eur = (amount: string) => Money.of(amount, 'EUR');

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });
let server: Server | undefined;

async function start(commands: CommandOverrides): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith(commands) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const call = (base: string, path: string) => fetch(`${base}/api/v1${path}`, { headers: { authorization: 'Bearer a.b.c', organizationid: REALM } });
const fieldsOf = async (res: Response) => ((await res.json()) as { error: { details?: { fields?: unknown } } }).error.details?.fields;

describe('GET /api/v1/rent-reconciliations/tenants (§37.7 (a))', () => {
  it('200 with the page; ids, counts and dates only; the paging passed on', async () => {
    const seen: Parameters<ListRentTenants>[0][] = [];
    const base = await start({
      rentReconciliations: {
        tenants: async (input) => {
          seen.push(input);
          return {
            items: [{ mreTenantId: TENANT, latestMreRentTerm: '2027020100', reconciliationCount: 3, latestCreatedAt: new Date('2027-02-03T10:00:00Z') }],
            page: 2,
            pageSize: 1,
            total: 2,
          };
        },
      },
    });
    const res = await call(base, '/rent-reconciliations/tenants?page=2&pageSize=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ mreTenantId: TENANT, latestMreRentTerm: '2027020100', reconciliationCount: 3, latestCreatedAt: '2027-02-03T10:00:00.000Z' }],
      page: 2,
      pageSize: 1,
      total: 2,
    });
    expect(seen).toEqual([{ principal: expect.objectContaining({ mreRealmId: REALM }), page: { page: 2, pageSize: 1 } }]);
  });

  it('the route is not swallowed by /{reconciliationId}; an unknown parameter or a filter is 400 and no command runs', async () => {
    let tenantsCalls = 0;
    let getCalls = 0;
    const base = await start({
      rentReconciliations: {
        tenants: async () => (tenantsCalls++, { items: [], page: 1, pageSize: 50, total: 0 }),
        get: async () => (getCalls++, Promise.reject(new Error('not this route'))),
      },
    });
    expect(await (await call(base, '/rent-reconciliations/tenants')).json()).toEqual({ items: [], page: 1, pageSize: 50, total: 0 });
    for (const query of ['zzz=1', `mreTenantId=${TENANT}`, 'status=CONFIRMED', 'pageSize=201']) {
      const res = await call(base, `/rent-reconciliations/tenants?${query}`);
      expect(res.status, query).toBe(400);
    }
    expect([tenantsCalls, getCalls]).toEqual([1, 0]);
  });
});

const terms: TenantTerms = {
  mreTenantId: TENANT,
  from: '2027-01',
  to: '2027-03',
  mreStatus: 'AVAILABLE',
  items: [
    {
      mreRentTerm: '2027020100',
      month: '2027-02',
      inMre: true,
      amountDue: eur('800.00'),
      matchedTotal: eur('300.00'),
      reconciliationCount: 2,
      coverage: 'PARTIALLY_MATCHED',
      openAmount: eur('500.00'),
    },
    {
      mreRentTerm: '2027010100',
      month: '2027-01',
      inMre: false,
      amountDue: null,
      matchedTotal: eur('0.00'),
      reconciliationCount: 1,
      coverage: null,
      openAmount: null,
    },
  ],
};

describe('GET /api/v1/rent-reconciliations/terms/{mreTenantId}?from&to (§37.7 (b))', () => {
  it('200 with the terms as Money; the Authorization header of the caller, the Tenant and the window passed on', async () => {
    const seen: Parameters<GetTenantTerms>[0][] = [];
    const base = await start({ rentReconciliations: { tenantTerms: async (input) => (seen.push(input), terms) } });
    const res = await call(base, `/rent-reconciliations/terms/${TENANT}?from=2027-01&to=2027-03`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mreTenantId: TENANT,
      from: '2027-01',
      to: '2027-03',
      mreStatus: 'AVAILABLE',
      items: [
        {
          mreRentTerm: '2027020100',
          month: '2027-02',
          inMre: true,
          amountDue: { amount: '800.00', currency: 'EUR' },
          matchedTotal: { amount: '300.00', currency: 'EUR' },
          reconciliationCount: 2,
          coverage: 'PARTIALLY_MATCHED',
          openAmount: { amount: '500.00', currency: 'EUR' },
        },
        {
          mreRentTerm: '2027010100',
          month: '2027-01',
          inMre: false,
          amountDue: null,
          matchedTotal: { amount: '0.00', currency: 'EUR' },
          reconciliationCount: 1,
          coverage: null,
          openAmount: null,
        },
      ],
    });
    expect(seen).toEqual([
      { principal: expect.objectContaining({ mreRealmId: REALM }), authorizationHeader: 'Bearer a.b.c', mreTenantId: TENANT, from: '2027-01', to: '2027-03' },
    ]);
  });

  it('the window rules and codes of suggest; a malformed Tenant first; an unknown parameter by name; no command runs', async () => {
    let calls = 0;
    const base = await start({ rentReconciliations: { tenantTerms: async () => (calls++, terms) } });
    const cases: [string, unknown][] = [
      [
        `${TENANT}`,
        [
          { field: 'from', code: 'REQUIRED' },
          { field: 'to', code: 'REQUIRED' },
        ],
      ],
      [`${TENANT}?from=2027-01`, [{ field: 'to', code: 'REQUIRED' }]],
      [`${TENANT}?from=2027-00&to=2027-02`, [{ field: 'from', code: 'INVALID_FORMAT' }]],
      [`${TENANT}?from=2027-1&to=2027-02`, [{ field: 'from', code: 'INVALID_FORMAT' }]],
      [`${TENANT}?from=2027-03&to=2027-02`, [{ field: 'to', code: 'INVALID_RANGE' }]],
      [`${TENANT}?from=2027-01&to=2027-1x`, [{ field: 'to', code: 'INVALID_FORMAT' }]],
      [`${TENANT}?from=2027-01&to=2028-01`, [{ field: 'to', code: 'RANGE_TOO_LONG' }]],
      [`${TENANT}?from=2027-01&to=2027-02&zzz=1`, [{ field: 'zzz', code: 'INVALID_FORMAT' }]],
      [`Tina?from=2027-01&to=2027-02`, [{ field: 'mreTenantId', code: 'INVALID_FORMAT' }]],
      [`${TENANT.toUpperCase()}?from=2027-01&to=2027-02`, [{ field: 'mreTenantId', code: 'INVALID_FORMAT' }]],
    ];
    for (const [path, fields] of cases) {
      const res = await call(base, `/rent-reconciliations/terms/${path}`);
      expect(res.status, path).toBe(400);
      expect(await fieldsOf(res), path).toEqual(fields);
    }
    expect(calls).toBe(0);
    // Twelve months inclusive is the longest window.
    expect((await call(base, `/rent-reconciliations/terms/${TENANT}?from=2027-01&to=2027-12`)).status).toBe(200);
    expect(calls).toBe(1);
  });

  it('a refused token or caller is passed through (401, 403), never degraded', async () => {
    for (const [error, status] of [
      [new AccessError('UNAUTHENTICATED', 'x'), 401],
      [new AccessError('FORBIDDEN', 'x'), 403],
    ] as const) {
      const base = await start({ rentReconciliations: { tenantTerms: async () => Promise.reject(error) } });
      expect((await call(base, `/rent-reconciliations/terms/${TENANT}?from=2027-01&to=2027-02`)).status).toBe(status);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});

import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal stand-in for the MRE gateway + API `GET /api/v2/realms`, mirroring the
 * pinned baseline (479d0ad) middleware chain: HS256 JWT verified with the access
 * token secret (401 on failure/expiry), tenant tokens refused (403), realms
 * filtered by member email for account tokens; application and service tokens
 * get 200 with their associated realm, as `checkOrganization` does.
 *
 * `GET /api/v2/properties` (account tokens) answers the properties of the Realm
 * in the `organizationid` header; a missing header or a Realm the account is
 * not a member of is a 404, as upstream (mre-integration.md §21.1). `GET /api/v2/tenants` does the
 * same with the Realm's tenants, ignoring any query string as upstream does (§20.1).
 *
 * `GET /api/v2/rents/tenant/:id/:term` answers one rent term of a Tenant of the Realm in `organizationid`, as
 * `_rentOfOccupant` does: the Tenant is looked up together with `rents.term = term`, so an unknown Tenant, an unknown
 * term and a Tenant of another Realm are all `404` (api-design.md §37.1). `GET /api/v2/rents/:year/:month` answers
 * `{ overview, rents }` with every Tenant's rent of that month and its occupant (§37.3). Test support only.
 */

export const FAKE_SECRET = 'test-access-token-secret';

export function signJwt(payload: Record<string, unknown>, secret = FAKE_SECRET, expiresInSeconds = 30): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSeconds })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token: string): Record<string, unknown> | undefined {
  const [header, body, signature] = token.split('.');
  if (header === undefined || body === undefined || signature === undefined) return undefined;
  const expected = createHmac('sha256', FAKE_SECRET).update(`${header}.${body}`).digest('base64url');
  if (expected !== signature) return undefined;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (typeof payload['exp'] !== 'number' || payload['exp'] * 1000 <= Date.now()) return undefined;
  return payload;
}

export interface FakeRealm {
  _id: string;
  name: string;
  members: { name: string; email: string; role: 'administrator' | 'renter'; registered: boolean }[];
  applications: { clientId: string; [extra: string]: unknown }[];
  /** Served by GET /properties only, never as part of the realm. */
  properties?: Record<string, unknown>[];
  /** Served by GET /tenants only, never as part of the realm. */
  tenants?: Record<string, unknown>[];
  /** Rent terms (`YYYYMMDDHH` numbers) per Tenant `_id`, served by GET /rents/tenant/:id/:term only. */
  rents?: Record<string, number[]>;
  /**
   * The fields of a rent term per `tenantId/term`, as MRE's `toRentData` answers them; a term without an entry answers
   * `totalWithoutBalanceAmount` 800 and no payments. Values are sent as given, floats included.
   */
  rentTerms?: Record<string, { totalWithoutBalanceAmount?: unknown; payments?: unknown }>;
  [extra: string]: unknown;
}

export interface FakeMre {
  apiBaseUrl: string;
  requests: { path: string; authorization: string | undefined; organizationid: string | undefined }[];
  close(): Promise<void>;
}

export async function startFakeMre(realms: FakeRealm[]): Promise<FakeMre> {
  const requests: FakeMre['requests'] = [];
  const server: Server = createServer((req, res) => {
    const organizationid = req.headers['organizationid'];
    const realmHeader = typeof organizationid === 'string' ? organizationid : undefined;
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization, organizationid: realmHeader });
    // MRE's list routes take no filter: a query string is ignored (mre-integration.md §20.1).
    const path = (req.url ?? '').split('?')[0];
    const rentTerm = /^\/api\/v2\/rents\/tenant\/([^/]+)\/([^/]+)$/.exec(path ?? '');
    const rentMonth = /^\/api\/v2\/rents\/(\d{4})\/(\d{1,2})$/.exec(path ?? '');
    if (path !== '/api/v2/realms' && path !== '/api/v2/properties' && path !== '/api/v2/tenants' && rentTerm === null && rentMonth === null) {
      res.writeHead(404).end();
      return;
    }
    const token = req.headers.authorization?.split(' ')[1];
    const payload = token === undefined ? undefined : verifyJwt(token);
    const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (rentMonth !== null) {
      const account = payload?.['account'] as { email?: string } | undefined;
      if (account === undefined) {
        res.writeHead(401).end('Unauthorized');
        return;
      }
      const realm = realms.find((r) => r._id === realmHeader && r.members.some((m) => m.email === account.email));
      if (realm === undefined) {
        res.writeHead(404).end();
        return;
      }
      // _getRentsDataByTerm: every Tenant's rents with a term inside the month, as toRentData with the occupant.
      const prefix = `${rentMonth[1]}${String(Number(rentMonth[2])).padStart(2, '0')}`;
      const rents = Object.entries(realm.rents ?? {}).flatMap(([tenantId, terms]) =>
        terms
          .filter((t) => String(t).startsWith(prefix))
          .map((t) => ({
            _id: tenantId,
            term: t,
            totalWithoutBalanceAmount: 800,
            payments: [],
            ...(realm.rentTerms?.[`${tenantId}/${t}`] ?? {}),
            occupant: { _id: tenantId, name: 'not read by DE', contacts: [{ email: 'tenant@example.com' }] },
          })),
      );
      json({ overview: { countAll: rents.length }, rents });
      return;
    }
    if (rentTerm !== null) {
      const account = payload?.['account'] as { email?: string } | undefined;
      if (account === undefined) {
        res.writeHead(401).end('Unauthorized');
        return;
      }
      const realm = realms.find((r) => r._id === realmHeader && r.members.some((m) => m.email === account.email));
      const [, tenantId = '', term = ''] = rentTerm;
      // Tenant and term in one lookup, as `_findOccupants(realm, tenantId, Number(term))` filters on `rents.term`.
      const found = realm?.rents?.[tenantId]?.includes(Number(term)) === true;
      if (!found) {
        res.writeHead(404).end();
        return;
      }
      const fields = realm?.rentTerms?.[`${tenantId}/${term}`] ?? {};
      json({
        term: Number(term),
        month: Number(term.slice(4, 6)),
        year: Number(term.slice(0, 4)),
        totalWithoutBalanceAmount: 800,
        payments: [],
        ...fields,
        occupant: { name: 'not read by DE', contacts: [{ email: 'tenant@example.com' }] },
      });
      return;
    }
    if (path === '/api/v2/properties' || path === '/api/v2/tenants') {
      const account = payload?.['account'] as { email?: string } | undefined;
      if (account === undefined) {
        res.writeHead(401).end('Unauthorized');
        return;
      }
      const realm = realms.find((r) => r._id === realmHeader && r.members.some((m) => m.email === account.email));
      if (realm === undefined) {
        res.writeHead(404).end();
        return;
      }
      json((path === '/api/v2/tenants' ? realm.tenants : realm.properties) ?? []);
      return;
    }
    const visible = (list: FakeRealm[]) => list.map(({ properties: _properties, tenants: _tenants, rents: _rents, rentTerms: _rentTerms, ...realm }) => realm);
    const application = payload?.['application'] as { clientId?: string } | undefined;
    if (application !== undefined) {
      json(visible(realms.filter((r) => r.applications.some((a) => a.clientId === application.clientId))));
      return;
    }
    const service = payload?.['service'] as { realmId?: string } | undefined;
    if (service !== undefined) {
      json(visible(realms.filter((r) => r._id === service.realmId)));
      return;
    }
    const account = payload?.['account'] as { email?: string; role?: string } | undefined;
    if (account === undefined) {
      res.writeHead(401).end('Unauthorized');
      return;
    }
    if (account.role === 'tenant') {
      res.writeHead(403).end('Forbidden');
      return;
    }
    json(visible(realms.filter((r) => r.members.some((m) => m.email === account.email))));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiBaseUrl: `http://127.0.0.1:${port}/api/v2`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

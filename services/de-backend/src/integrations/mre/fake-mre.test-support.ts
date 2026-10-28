import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
 * `{ overview, rents }` with every Tenant's rent of that month and its occupant (§37.3).
 *
 * `PATCH /api/v2/rents/payment/:id/:term` behaves as `_updateByTerm` (§37.4): the Tenant comes from the body's `_id`
 * (`500` without it, for another Realm's Tenant or a term it does not have); the settlement is replaced: payments
 * with `amount` > 0 normalised (`date || ''`, `Number(amount)`, …), `promo` and `extracharge` divided by
 * `1 + vatRatio`, the description; the answer is the saved term. A term reads `promo` and `extracharge` multiplied back
 * and rounded to the cent under VAT, notes each ended by `\n`, as `toRentData` does. Test support only.
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
  rentTerms?: Record<string, FakeRentTerm>;
  [extra: string]: unknown;
}

/** A term's stored fields: the settlement as MRE keeps it (discounts and debts net of VAT), read through `termView`. */
export interface FakeRentTerm {
  totalWithoutBalanceAmount?: unknown;
  payments?: unknown;
  /** The Tenant's `vatRatio`, kept per term here. */
  vatRatio?: number;
  /** Settlement discounts (`promo`) and debts (`extracharge`), net amounts as stored. */
  discounts?: { amount: number; description: string }[];
  debts?: { amount: number; description: string }[];
  description?: string;
}

/** Switches for the next PATCHes, taken in order: fail with `500` unapplied, or apply and drop the answer. */
export type FakePatchFault = 'FAIL' | 'DROP_ANSWER';

export interface FakeMre {
  apiBaseUrl: string;
  requests: { path: string; authorization: string | undefined; organizationid: string | undefined }[];
  /** The bodies of every PATCH MRE applied, in order. */
  patches: unknown[];
  /** Faults for the next PATCHes, consumed one per PATCH. */
  faults: FakePatchFault[];
  close(): Promise<void>;
}

/** A term as `toRentData` answers it, with `_id` and `vatRatio` (§37.4). */
function termView(tenantId: string, term: number, fields: FakeRentTerm = {}): Record<string, unknown> {
  const vat = fields.vatRatio ?? 0;
  const gross = (amount: number) => (vat && amount > 0 ? Math.round(amount * (1 + vat) * 100) / 100 : amount);
  const promo = (fields.discounts ?? []).reduce((sum, d) => sum + d.amount, 0);
  const extracharge = (fields.debts ?? []).reduce((sum, d) => sum + d.amount, 0);
  return {
    _id: tenantId,
    term,
    month: Number(String(term).slice(4, 6)),
    year: Number(String(term).slice(0, 4)),
    totalWithoutBalanceAmount: fields.totalWithoutBalanceAmount ?? 800,
    payments: fields.payments ?? [],
    promo: gross(promo),
    notepromo: (fields.discounts ?? []).map((d) => `${d.description}\n`).join(''),
    extracharge: gross(extracharge),
    noteextracharge: (fields.debts ?? []).map((d) => `${d.description}\n`).join(''),
    description: fields.description,
    vatRatio: vat,
    occupant: { _id: tenantId, name: 'not read by DE', contacts: [{ email: 'tenant@example.com' }] },
  };
}

export async function startFakeMre(realms: FakeRealm[]): Promise<FakeMre> {
  const requests: FakeMre['requests'] = [];
  const patches: unknown[] = [];
  const faults: FakePatchFault[] = [];
  const server: Server = createServer((req, res) => {
    const organizationid = req.headers['organizationid'];
    const realmHeader = typeof organizationid === 'string' ? organizationid : undefined;
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization, organizationid: realmHeader });
    // MRE's list routes take no filter: a query string is ignored (mre-integration.md §20.1).
    const path = (req.url ?? '').split('?')[0];
    const rentTerm = /^\/api\/v2\/rents\/tenant\/([^/]+)\/([^/]+)$/.exec(path ?? '');
    const rentMonth = /^\/api\/v2\/rents\/(\d{4})\/(\d{1,2})$/.exec(path ?? '');
    const rentPayment = req.method === 'PATCH' ? /^\/api\/v2\/rents\/payment\/([^/]+)\/([^/]+)$/.exec(path ?? '') : null;
    if (rentPayment !== null) {
      patchTerm(req, res, rentPayment[2] ?? '');
      return;
    }
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
        terms.filter((t) => String(t).startsWith(prefix)).map((t) => termView(tenantId, t, realm.rentTerms?.[`${tenantId}/${t}`])),
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
      json(termView(tenantId, Number(term), realm?.rentTerms?.[`${tenantId}/${term}`]));
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
  /** `_updateByTerm`: the Tenant from the body's `_id`, never from the path; the whole settlement replaced. */
  function patchTerm(req: IncomingMessage, res: ServerResponse, term: string): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const token = req.headers.authorization?.split(' ')[1];
      const account = (token === undefined ? undefined : verifyJwt(token))?.['account'] as { email?: string } | undefined;
      if (account === undefined) {
        res.writeHead(401).end('Unauthorized');
        return;
      }
      const realm = realms.find((r) => r._id === req.headers['organizationid'] && r.members.some((m) => m.email === account.email));
      if (realm === undefined) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      const tenantId = typeof body['_id'] === 'string' ? body['_id'] : undefined;
      // findOne({ _id: body._id, realmId }) finds nothing → occupant.frequency throws; payTerm throws outside the contract.
      if (tenantId === undefined || realm.rents?.[tenantId]?.includes(Number(term)) !== true) {
        res.writeHead(500).end('Internal Server Error');
        return;
      }
      const fault = faults.shift();
      if (fault === 'FAIL') {
        res.writeHead(500).end('Internal Server Error');
        return;
      }
      const key = `${tenantId}/${term}`;
      const stored: FakeRentTerm = (realm.rentTerms ??= {})[key] ?? {};
      const vat = stored.vatRatio ?? 0;
      const net = (amount: number) => amount * (vat ? 1 / (1 + vat) : 1);
      const payments = Array.isArray(body['payments']) ? (body['payments'] as Record<string, unknown>[]) : [];
      const promo = Number(body['promo'] ?? 0);
      const extracharge = Number(body['extracharge'] ?? 0);
      realm.rentTerms[key] = {
        ...stored,
        payments: payments
          .filter(({ amount }) => amount && Number(amount) > 0)
          .map((p) => ({
            date: p['date'] || '',
            amount: Number(p['amount']),
            type: p['type'] || '',
            reference: p['reference'] || '',
            description: p['description'] || '',
          })),
        discounts: promo ? [{ amount: net(promo), description: String(body['notepromo'] || '') }] : [],
        debts: extracharge ? [{ amount: net(extracharge), description: String(body['noteextracharge'] || '') }] : [],
        description: typeof body['description'] === 'string' && body['description'] !== '' ? body['description'] : '',
      };
      patches.push(body);
      if (fault === 'DROP_ANSWER') {
        res.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(termView(tenantId, Number(term), realm.rentTerms[key])));
    });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiBaseUrl: `http://127.0.0.1:${port}/api/v2`,
    requests,
    patches,
    faults,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

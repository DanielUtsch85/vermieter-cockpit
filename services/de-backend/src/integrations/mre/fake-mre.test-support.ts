import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal stand-in for the MRE gateway + API `GET /api/v2/realms`, mirroring the
 * pinned baseline (479d0ad) middleware chain: HS256 JWT verified with the access
 * token secret (401 on failure/expiry), tenant tokens refused (403), realms
 * filtered by member email. Test support only.
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
  applications: unknown[];
  [extra: string]: unknown;
}

export interface FakeMre {
  apiBaseUrl: string;
  requests: { path: string; authorization: string | undefined }[];
  close(): Promise<void>;
}

export async function startFakeMre(realms: FakeRealm[]): Promise<FakeMre> {
  const requests: FakeMre['requests'] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization });
    if (req.url !== '/api/v2/realms') {
      res.writeHead(404).end();
      return;
    }
    const token = req.headers.authorization?.split(' ')[1];
    const payload = token === undefined ? undefined : verifyJwt(token);
    const account = payload?.['account'] as { email?: string; role?: string } | undefined;
    if (account === undefined) {
      res.writeHead(401).end('Unauthorized');
      return;
    }
    if (account.role === 'tenant') {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const visible = realms.filter((r) => r.members.some((m) => m.email === account.email));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(visible));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiBaseUrl: `http://127.0.0.1:${port}/api/v2`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

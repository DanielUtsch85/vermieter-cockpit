import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { optionsAsExpress4, slashAfterMountAsExpress4 } from './express-compat.js';

/**
 * VC-X-66: the OPTIONS answer and the slash after the mount path as Express 4 gave them, on routers shaped beyond the
 * app's own (a path in several routers, a nested router, an explicit HEAD, a malformed segment). The expected lines were
 * produced by Express 4.22.3 with the same routers and no `express-compat` (a scratch install, not committed).
 */
const ok: RequestHandler = (_req, res) => {
  res.json({ ok: 1 });
};

function build(compat: boolean) {
  const app = express();
  const api = express.Router();
  if (compat) api.use(slashAfterMountAsExpress4);
  api.use((_req, _res, next) => next());
  if (compat) api.use(optionsAsExpress4(api));
  api.get('/x', ok);
  const a = express.Router();
  a.get('/x', ok);
  a.post('/x', ok);
  const b = express.Router();
  b.put('/x', ok);
  b.get('/y/:id', ok);
  const c = express.Router();
  c.head('/z', ok);
  c.get('/z', ok);
  c.delete('/w', ok);
  const nested = express.Router();
  const inner = express.Router();
  inner.get('/n', ok);
  nested.use(inner);
  nested.post('/n', ok);
  nested.post('/m', ok);
  const d = express.Router();
  d.patch('/m', ok);
  for (const router of [a, b, c, nested, d]) api.use(router);
  app.use('/api/v1', api);
  app.use((_req, res) => {
    res.status(404).json({ nf: 1 });
  });
  app.use(((error: { status?: number }, _req, res, _next) => {
    res.status(500).json({ err: String(error.status) });
  }) as express.ErrorRequestHandler);
  return app;
}

const PATHS = ['/x', '/x/', '/X', '//x', '/y/1', '/y/%E0', '/z', '/w', '/n', '/m', '/none', '/y/1?q=1'];

/** Express 4.22.3's answers to OPTIONS on these paths (status, Allow, Content-Type, ETag, body). */
const EXPRESS_4 = [
  '/x 200 allow=GET,HEAD,POST type=text/html; charset=utf-8 etag=W/"d-bMedpZYGrVt1nR4x+qdNZ2GqyRo" GET,HEAD,POST',
  '/x/ 200 allow=GET,HEAD,POST type=text/html; charset=utf-8 etag=W/"d-bMedpZYGrVt1nR4x+qdNZ2GqyRo" GET,HEAD,POST',
  '/X 200 allow=GET,HEAD,POST type=text/html; charset=utf-8 etag=W/"d-bMedpZYGrVt1nR4x+qdNZ2GqyRo" GET,HEAD,POST',
  '//x 200 allow=GET,HEAD,POST type=text/html; charset=utf-8 etag=W/"d-bMedpZYGrVt1nR4x+qdNZ2GqyRo" GET,HEAD,POST',
  '/y/1 200 allow=GET,HEAD type=text/html; charset=utf-8 etag=W/"8-ZRAf8oNBS3Bjb/SU2GYZCmbtmXg" GET,HEAD',
  '/y/%E0 500 allow=undefined type=application/json; charset=utf-8 etag=W/"d-6KevGTd1CIuA2lKiRCKWXBZ1jbs" {"err":"400"}',
  '/z 200 allow=HEAD,GET type=text/html; charset=utf-8 etag=W/"8-W8GC7mglJig04RCk3Z9BnsjLGts" HEAD,GET',
  '/w 200 allow=DELETE type=text/html; charset=utf-8 etag=W/"6-1vVjYJjNRYzp0ik5+OPo3qsOm9A" DELETE',
  '/n 200 allow=GET,HEAD type=text/html; charset=utf-8 etag=W/"8-ZRAf8oNBS3Bjb/SU2GYZCmbtmXg" GET,HEAD',
  '/m 200 allow=POST type=text/html; charset=utf-8 etag=W/"4-Yf+Bwwqjx254r+pisuO9HfpJ6FQ" POST',
  '/none 404 allow=undefined type=application/json; charset=utf-8 etag=W/"8-bcCOANMMpgGoXSdLl1lff6L+SdY" {"nf":1}',
  '/y/1?q=1 200 allow=GET,HEAD type=text/html; charset=utf-8 etag=W/"8-ZRAf8oNBS3Bjb/SU2GYZCmbtmXg" GET,HEAD',
];

const servers: Record<string, { server: Server; base: string }> = {};
beforeAll(async () => {
  for (const compat of [true, false]) {
    const server = build(compat).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    servers[String(compat)] = { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
});
afterAll(async () => {
  for (const { server } of Object.values(servers)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function answers(compat: boolean): Promise<string[]> {
  const base = servers[String(compat)]?.base ?? '';
  const out: string[] = [];
  for (const path of PATHS) {
    const res = await fetch(`${base}/api/v1${path}`, { method: 'OPTIONS' });
    const h = (name: string) => res.headers.get(name) ?? 'undefined';
    out.push(`${path} ${res.status} allow=${h('allow')} type=${h('content-type')} etag=${h('etag')} ${await res.text()}`);
  }
  return out;
}

describe('express-compat (VC-X-66)', () => {
  it('answers OPTIONS and the slash after the mount as Express 4 did: the first router with a match, in order', async () => {
    expect(await answers(true)).toEqual(EXPRESS_4);
  });

  it('counter-check: Express 5 without it answers otherwise (sorted, text/plain, no ETag, 404 after a double slash)', async () => {
    const plain = await answers(false);
    expect(plain[0]).toBe('/x 200 allow=GET, HEAD, POST type=text/plain etag=undefined GET, HEAD, POST');
    expect(plain[3]).toMatch(/^\/\/x 404 /);
    expect(plain.filter((line, i) => line !== EXPRESS_4[i]).length).toBeGreaterThan(8);
  });

  it('leaves other methods alone', async () => {
    const res = await fetch(`${servers['true']?.base ?? ''}/api/v1//x`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
  });
});

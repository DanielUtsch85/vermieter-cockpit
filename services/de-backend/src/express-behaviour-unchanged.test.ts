import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appForInventory, listRoutes } from './api/route-inventory.js';
import { countedApp, fill, malformed, paramsOf, UUID, valueOf } from './api/route-walk.test-support.js';
import { REALM } from './api/transactions.test-support.js';

/**
 * VC-X-66 (Express 4 → 5): what Express itself decides answers as before the upgrade, status, headers and body, byte for
 * byte: unknown routes, wrong methods, HEAD and OPTIONS, trailing and double slashes, case, encoded and malformed path
 * segments, the JSON body parser (no body, wrong or odd content types, charsets, encodings, malformed, too large) and the
 * upload route's refusals (`Connection: close`). No database: every command rejects and is counted (`route-walk`).
 *
 * `express-behaviour-golden/before-vc-x-66.json` was recorded by this file on main 5abb3f1 (Express 4.22.3) with
 * `VC_X66_RECORD_BEFORE=1`. Every answer is kept as a line (request, status, every response header but `Date`, the raw
 * body and the commands reached), grouped by section, so a difference names the request. Synthetic values only.
 */
const golden = join(dirname(fileURLToPath(import.meta.url)), 'express-behaviour-golden', 'before-vc-x-66.json');
const RECORD = process.env['VC_X66_RECORD_BEFORE'] === '1';
/** A file to write every line of the route section to, for finding a difference (not committed). */
const DUMP = process.env['VC_X66_DUMP'];
const dump: string[] = [];
type Hashed = { requests: number; sha256: string; first: string; last: string };
type Golden = { express: string; routes: Record<string, Hashed> } & Record<string, unknown>;

const { calls, origin, start, stop } = countedApp();
beforeAll(start);
afterAll(stop);
const routes = listRoutes(appForInventory());
const AUTH = { authorization: 'Bearer a.b.c', organizationid: REALM };

type Probe = { method: string; path: string; headers?: Record<string, string>; body?: Buffer | string; auth?: boolean };

/** One raw request on its own connection (no keep-alive between probes): the answer as one line. */
function send(p: Probe): Promise<string> {
  const { hostname, port } = new URL(origin());
  const body = p.body === undefined ? undefined : Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body, 'utf8');
  const headers: Record<string, string> = {
    connection: 'keep-alive',
    ...(p.auth === false ? {} : AUTH),
    ...(body === undefined ? {} : { 'content-length': String(body.length) }),
    ...p.headers,
  };
  calls.length = 0;
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, method: p.method, path: p.path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const shown = Object.entries(res.headers)
          .filter(([name]) => name !== 'date')
          .map(([name, value]) => `${name}: ${String(value)}`)
          .join('; ');
        const text = Buffer.concat(chunks).toString('utf8');
        const reached = calls.map((c) => `${c.module}.${c.command}`).join(',');
        const sent = Object.entries(p.headers ?? {})
          .map(([n, v]) => `${n}=${v}`)
          .join(' ');
        const shownBody =
          body === undefined
            ? ''
            : body.length > 200
              ? `<${body.length} bytes sha256 ${createHash('sha256').update(body).digest('hex').slice(0, 16)}>`
              : JSON.stringify(body.toString('latin1'));
        resolve(
          `${p.method} ${p.path}${p.auth === false ? ' (no auth)' : ''} [${sent}] ${shownBody} -> ${res.statusCode} {${shown}} ${text}${reached === '' ? '' : ` commands=${reached}`}`,
        );
        req.destroy();
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const PATHS = [
  '/',
  '/nope',
  '/api',
  '/api/v1',
  '/api/v1/',
  '/api/v1/nope',
  '/health',
  '/health/live',
  '/health/live/',
  '/HEALTH/LIVE',
  '//health/live',
  '/health//live',
  '/health/live?x=1',
  '/health/live/.',
  '/health/./live',
  '/health/%6Cive',
  '/health%2Flive',
  '/health/ready',
  '/api/v1/health',
  '/api/v1/health/',
  '/API/V1/HEALTH',
  '/api/v1//health',
  '//api/v1/health',
  '/api/v1/Health',
  '/api/v1/health%2F',
  '/api/v1/%68ealth',
  '/api/v1/health;x',
  '/api/v1/health#x',
  '/api/v1/health?',
  '/api/v1/health?x=1',
  '/api/v1/health/x',
  '/api/v1/../v1/health',
  '*',
];

/** The JSON routes the parser is probed on: a normal command, a command without a body and a 64 kB one. */
const JSON_ROUTES = [
  { method: 'POST', path: '/api/v1/transactions', limit: 16 * 1024 },
  { method: 'POST', path: `/api/v1/financial-accounts/${UUID}/close`, limit: 16 * 1024 },
  { method: 'PUT', path: `/api/v1/transactions/${UUID}/splits`, limit: 64 * 1024 },
];
const JSON_TYPE = { 'content-type': 'application/json' };
const BODIES: { headers?: Record<string, string>; body?: Buffer | string }[] = [
  {},
  { headers: JSON_TYPE },
  { headers: JSON_TYPE, body: '' },
  { body: '{}' },
  { headers: JSON_TYPE, body: '{}' },
  { headers: { 'content-type': 'text/plain' }, body: '{}' },
  { headers: { 'content-type': 'text/plain' }, body: '{"zzz":1}' },
  { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'zzz=1' },
  { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: '--x--' },
  { headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"zzz":1}' },
  { headers: { 'content-type': 'application/json; charset=UTF-8' }, body: '{"zzz":1}' },
  { headers: { 'content-type': 'application/json; charset=latin1' }, body: '{"zzz":1}' },
  { headers: { 'content-type': 'application/json; charset=utf-16' }, body: '{"zzz":1}' },
  { headers: { 'content-type': 'APPLICATION/JSON' }, body: '{"zzz":1}' },
  { headers: { 'content-type': 'application/vnd.api+json' }, body: '{"zzz":1}' },
  { headers: { 'content-type': 'application/merge-patch+json' }, body: '{"zzz":1}' },
  { headers: { 'content-type': 'application/json-seq' }, body: '{"zzz":1}' },
  { headers: { 'content-type': 'json' }, body: '{"zzz":1}' },
  { headers: { 'content-type': '' }, body: '{"zzz":1}' },
  { headers: JSON_TYPE, body: '{' },
  { headers: JSON_TYPE, body: '{"a":}' },
  { headers: JSON_TYPE, body: '{"zzz":1}x' },
  { headers: JSON_TYPE, body: 'null' },
  { headers: JSON_TYPE, body: '"x"' },
  { headers: JSON_TYPE, body: '1' },
  { headers: JSON_TYPE, body: 'true' },
  { headers: JSON_TYPE, body: ' ' },
  { headers: JSON_TYPE, body: '\n{}\n' },
  { headers: JSON_TYPE, body: '﻿{}' },
  { headers: JSON_TYPE, body: '[]' },
  { headers: JSON_TYPE, body: '[1]' },
  { headers: JSON_TYPE, body: '{"__proto__":{"zzz":1}}' },
  { headers: JSON_TYPE, body: '{"constructor":{"prototype":{"zzz":1}}}' },
  { headers: JSON_TYPE, body: '{"zzz":1,"zzz":2}' },
  { headers: JSON_TYPE, body: '{"zzz":"\\ud800"}' },
  { headers: { ...JSON_TYPE, 'content-encoding': 'gzip' }, body: gzipSync('{"zzz":1}') },
  { headers: { ...JSON_TYPE, 'content-encoding': 'deflate' }, body: deflateSync('{"zzz":1}') },
  { headers: { ...JSON_TYPE, 'content-encoding': 'br' }, body: brotliCompressSync('{"zzz":1}') },
  { headers: { ...JSON_TYPE, 'content-encoding': 'identity' }, body: '{"zzz":1}' },
  { headers: { ...JSON_TYPE, 'content-encoding': 'x-unknown' }, body: '{"zzz":1}' },
  { headers: { ...JSON_TYPE, 'content-encoding': 'gzip' }, body: 'not gzip' },
  { headers: { ...JSON_TYPE, 'content-encoding': 'GZIP' }, body: gzipSync('{"zzz":1}') },
  { headers: { ...JSON_TYPE, 'content-encoding': 'gzip, identity' }, body: gzipSync('{"zzz":1}') },
];

/** Sizes around a limit: the body `{"zzz":"…"}` of exactly `n` bytes. */
const sized = (n: number) => `{"zzz":"${'x'.repeat(n - 10)}"}`;

/** The sections kept line by line: paths at and around the health routes, the JSON body parser, the upload route. */
async function section(name: string): Promise<string[]> {
  const lines: string[] = [];
  const add = async (p: Probe) => lines.push(await send(p));
  if (name === 'paths') {
    for (const path of PATHS)
      for (const method of METHODS) await add({ method, path, ...(method === 'POST' || method === 'PUT' ? { headers: JSON_TYPE, body: '{}' } : {}) });
    for (const path of ['/health/live', '/api/v1/health', '/nope'])
      for (const auth of [false, true]) for (const method of ['GET', 'HEAD', 'OPTIONS']) await add({ method, path, auth });
    // Conditional GET: Express's ETag and freshness (304) on the two answers that succeed without a command.
    for (const path of ['/health/live', '/api/v1/health']) {
      const etag = / etag: ([^;}]+)/.exec(await send({ method: 'GET', path }))?.[1] ?? '';
      for (const value of [etag, `W/"x"`, '*', etag.replace('W/', '')]) await add({ method: 'GET', path, headers: { 'if-none-match': value } });
      await add({ method: 'HEAD', path, headers: { 'if-none-match': etag } });
      await add({ method: 'GET', path, headers: { 'if-modified-since': 'Wed, 01 Jan 2031 00:00:00 GMT' } });
    }
  }
  if (name === 'bodies') {
    for (const route of JSON_ROUTES) {
      for (const b of BODIES) await add({ method: route.method, path: route.path, ...b });
      for (const n of [route.limit - 1, route.limit, route.limit + 1, route.limit * 4])
        await add({ method: route.method, path: route.path, headers: JSON_TYPE, body: sized(n) });
      await add({ method: route.method, path: `${route.path}?zzz=1`, headers: JSON_TYPE, body: '{' });
      await add({ method: route.method, path: `${route.path}?zzz=1`, headers: JSON_TYPE, body: sized(route.limit + 1) });
      await add({ method: route.method, path: `${route.path}?zzz=1`, headers: { 'content-type': 'text/plain' }, body: '{' });
    }
    // A body on a read and on a route without a parser.
    for (const b of [
      { headers: JSON_TYPE, body: '{"zzz":1}' },
      { headers: JSON_TYPE, body: '{' },
      { headers: JSON_TYPE, body: sized(64 * 1024) },
    ])
      for (const path of ['/api/v1/transactions', '/health/live', '/api/v1/health']) await add({ method: 'GET', path, ...b });
  }
  if (name === 'upload') {
    const path = '/api/v1/imports/bank-transactions';
    const part = (fields: string) =>
      `--x\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${fields}\r\n--x\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\ndate;amount\r\n--x--\r\n`;
    const multipart = { 'content-type': 'multipart/form-data; boundary=x' };
    for (const query of ['', '?zzz=1', '?zzz=1&zzz=2'])
      for (const b of [
        {},
        { headers: JSON_TYPE, body: '{}' },
        { headers: { 'content-type': 'text/plain' }, body: 'x' },
        { headers: multipart, body: '--x--\r\n' },
        { headers: multipart, body: part('{') },
        { headers: multipart, body: part('{}') },
        { headers: multipart, body: part(`{"financialAccountId":"${UUID}","adapterId":"x","adapterVersion":"1"}`) },
        { headers: { ...multipart, 'content-length': String(6 * 1024 * 1024) }, body: part('{}') },
      ])
        await add({ method: 'POST', path: `${path}${query}`, ...b });
  }
  return lines;
}

/** Every route path of the inventory: OPTIONS, the methods it does not have, HEAD, slashes, case and encoded segments. */
async function routeSection(): Promise<Record<string, Hashed>> {
  const out: Record<string, Hashed> = {};
  for (const path of [...new Set(routes.map((r) => r.path))]) {
    const lines: string[] = [];
    const add = async (p: Probe) => lines.push(await send(p));
    const url = fill(path, valueOf);
    const own = routes.filter((r) => r.path === path).map((r) => r.method);
    await add({ method: 'OPTIONS', path: url });
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((m) => !own.includes(m))) await add({ method, path: url });
    if (own.includes('GET')) await add({ method: 'HEAD', path: url });
    for (const method of own) {
      const withBody = method === 'POST' || method === 'PUT' ? { headers: JSON_TYPE, body: '{}' } : {};
      for (const variant of [`${url}/`, url.toUpperCase(), url.replace('/api/v1/', '/api/v1//'), `${url}//`, `${url}/x`])
        await add({ method, path: variant, ...withBody });
      for (const name of paramsOf(path)) {
        const values = [
          'a%2Fb',
          '%2F',
          `%3${valueOf(name).slice(0, 1)}${valueOf(name).slice(1)}`,
          'a%20b',
          '%C3%A4',
          '%E0%A4%A',
          '%',
          '%00',
          malformed(name) ?? 'x',
        ];
        for (const value of values) await add({ method, path: fill(path, (n) => (n === name ? value : valueOf(n))), ...withBody });
      }
    }
    if (DUMP !== undefined) dump.push(...lines);
    out[path] = {
      requests: lines.length,
      sha256: createHash('sha256').update(lines.join('\n')).digest('hex'),
      first: lines[0] ?? '',
      last: lines.at(-1) ?? '',
    };
  }
  return out;
}

const SECTIONS = ['paths', 'bodies', 'upload'];

describe('what Express decides answers as before Express 5 (VC-X-66)', () => {
  const before = RECORD ? undefined : (JSON.parse(readFileSync(golden, 'utf8')) as Golden);

  it('every probe answers as recorded on Express 4, status, headers and body', { timeout: 300_000 }, async () => {
    const now: Golden = { express: process.env['VC_X66_EXPRESS'] ?? '', routes: {} };
    for (const name of SECTIONS) now[name] = await section(name);
    now.routes = await routeSection();
    if (DUMP !== undefined) writeFileSync(DUMP, `${dump.join('\n')}\n`);
    if (RECORD) {
      writeFileSync(golden, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    for (const name of SECTIONS) {
      const recorded = (before?.[name] ?? []) as string[];
      const answered = now[name] as string[];
      expect(answered.length, name).toBe(recorded.length);
      answered.forEach((line, i) => expect(line, `${name} #${i}`).toBe(recorded[i]));
    }
    expect(Object.keys(now.routes)).toEqual(Object.keys(before?.routes ?? {}));
    for (const [path, hashed] of Object.entries(now.routes)) expect(hashed, path).toEqual(before?.routes[path]);
  });

  it('counter-check: the record holds the answers the probes are about', () => {
    const recorded = JSON.parse(readFileSync(golden, 'utf8')) as Golden;
    const all = SECTIONS.flatMap((name) => (recorded[name] ?? []) as string[]);
    expect(all.length).toBeGreaterThan(400);
    expect(Object.values(recorded.routes).reduce((n, r) => n + r.requests, 0)).toBeGreaterThan(3000);
    const find = (prefix: string) => all.find((line) => line.startsWith(prefix)) ?? '';
    expect(find('GET /nope []')).toContain('-> 404 ');
    expect(find('GET /nope []')).toContain('{"error":{"code":"NOT_FOUND","message":"Not found"}}');
    expect(find('HEAD /api/v1/health []')).toMatch(/-> 200 \{[^}]*etag: W\//);
    // Express's own OPTIONS answer under the API router; at the root the app's 404 comes first.
    expect(find('OPTIONS /api/v1/health []')).toContain('allow: GET,HEAD');
    expect(find('OPTIONS /health/live []')).toContain('-> 404 ');
    expect(find('POST /api/v1/transactions [content-type=application/json] "{"')).toContain('-> 400 ');
    expect(find(`POST /api/v1/transactions [content-type=application/json] <${16 * 1024 + 1} bytes`)).toContain('-> 413 ');
    expect(find('POST /api/v1/imports/bank-transactions?zzz=1 [content-type=multipart')).toContain('connection: close');
    expect(recorded.routes['/api/v1/acquisitions/:acquisitionId']?.first).toContain('allow: GET,HEAD');
    expect(find('POST /api/v1/transactions [content-type=text/plain] "{}"')).toContain('"code":"VALIDATION_ERROR"');
  });
});

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appForInventory, listRoutes, type InventoryRoute } from './api/route-inventory.js';
import { countedApp, fill, key, UUID, valueOf } from './api/route-walk.test-support.js';

/**
 * VC-X-65 (Zod 3 → 4): every accepted and refused input of every route answers as before the upgrade, byte for byte.
 *
 * `before-vc-x-65.json` was recorded by this file on main b97f2d7 (Zod 3.25.76) with `VC_X65_RECORD_BEFORE=1`. No
 * database: the app runs with every command rejecting and counted (the walk of VC-X-61 and VC-X-69), so an input the
 * route accepts reaches its command (`500`) and the command's arguments are recorded beside the answer.
 *
 * Bodies (the 91 JSON commands): from `{}`, every field an answer names is set to each value of a fixed list (wrong
 * types, `null`, arrays, objects, unknown fields, dates, ids, amounts with bad scale, sign, currency, number) and then to
 * each candidate string of the record (the upper-case literals of the sources on b97f2d7, for enumerations); the value
 * that leaves the fewest errors is kept and the walk goes on, so nested objects and arrays are reached, until the
 * command runs or nothing improves. Then every field of the last body is set to each fixed value once more, and an
 * unknown field is put into every object of it. Queries (every GET): each parameter name of §58W's catalogue with
 * probe values; the names a route knows are then sent with every value of a fixed list, alone and all at once.
 *
 * Each route's requests and answers (status, raw text, the command's arguments) are hashed in order; the record keeps
 * the hash, the number of requests, the first and the last answer, so a difference names the route. Instants and today's
 * date are marked. Synthetic values only.
 */
const golden = join(dirname(fileURLToPath(import.meta.url)), 'error-answers-golden', 'before-vc-x-65.json');
const RECORD = process.env['VC_X65_RECORD_BEFORE'] === '1';
/** A file to write every request and answer to, for finding a difference (not committed). */
const DUMP = process.env['VC_X65_DUMP'];

const TENANT = '6512f0c2a1b2c3d4e5f60a61';
const EXEMPT_BODY = ['/api/v1/imports/bank-transactions'];
const EXEMPT_QUERY = ['/health/live', '/health/ready'];

/** The required parameters of the routes that have any, at valid values (as in `api/query-parameters.test.ts`). */
const REQUIRED: Readonly<Record<string, string>> = {
  'GET /api/v1/loans/:loanId/payment-proposal': `transactionId=${UUID}`,
  'GET /api/v1/loans/:loanId/payments': 'year=2027',
  'GET /api/v1/property-references/:propertyReferenceId/tax-meanings': 'year=2027',
  'GET /api/v1/rent-reconciliations/split-proposal': `transactionId=${UUID}&mreTenantId=${TENANT}&mreRentTerm=2027010100`,
  'GET /api/v1/rental-contract-references': `mreTenantId=${TENANT}`,
  'GET /api/v1/tax-classifications': `sourceType=TRANSACTION_SPLIT&sourceId=${UUID}`,
  'GET /api/v1/transactions/:transactionId/settlement-proposal': `statementId=${UUID}`,
};

/** §58W's parameter catalogue (the route table), every name once, and a few names no route knows. */
const QUERY_NAMES = [
  'accountType',
  'acquisitionCostId',
  'acquisitionId',
  'administratorPartyId',
  'asOf',
  'bookingDateFrom',
  'bookingDateTo',
  'checkMre',
  'counting',
  'current',
  'dialect',
  'externalId',
  'externalReferenceState',
  'externalSystem',
  'financialAccountId',
  'financialCategoryCode',
  'financialYear',
  'from',
  'holdingFinancialAccountId',
  'loanId',
  'mreRentTerm',
  'mreTenantId',
  'name',
  'origin',
  'ownerPartyId',
  'page',
  'pageSize',
  'partyId',
  'partyType',
  'perProperty',
  'propertyReferenceId',
  'provenance',
  'purpose',
  'reviewState',
  'reviewable',
  'rows',
  'sourceId',
  'sourcePosition',
  'sourceType',
  'state',
  'statementId',
  'status',
  'taxCategory',
  'to',
  'transactionId',
  'year',
  'include',
  'sort',
];

/** Probe values: a name is known to a route when one of them answers otherwise than an unknown name. */
const PROBES = ['', 'x', '1', '2027', UUID, 'true', 'ACTIVE', '2027-01-15', 'null', TENANT, '2027010100', 'TRANSACTION_SPLIT'];

/** The values every known parameter is sent with. */
const QUERY_VALUES = [
  ...PROBES,
  ' ',
  '0',
  '-1',
  '1.5',
  '2',
  '50',
  '199',
  '200',
  '201',
  '999999',
  '1000000',
  '1000001',
  '1e3',
  '0x10',
  ' 1',
  'Infinity',
  'NaN',
  'false',
  'TRUE',
  'yes',
  '2027-02-30',
  '2027-13-01',
  '27-01-15',
  '2027-01-15T00:00:00Z',
  '1999',
  '9999',
  '10000',
  'not-an-id',
  UUID.toUpperCase(),
  `${UUID},${UUID}`,
  'ACTIVE,CLOSED',
  'ACTIVE,',
  ',',
  'ACTIVE,ACTIVE',
  'CLOSED',
  'VOIDED',
  'DRAFT',
  'CONFIRMED',
  'CANCELLED',
  'PERSON',
  'ORGANIZATION',
  'IMPORTED',
  'MANUAL',
  'OPEN',
  'RESOLVED',
  'WITHDRAWN',
  'CURRENT',
  'SUPERSEDED',
  'BANK_ACCOUNT',
  'CASH',
  'MRE',
  'ALL',
  'DETAIL',
  'SUMMARY',
  'EXCEL_DE',
  'RFC4180',
  'a%2Cb',
  'ä',
];

const MONEY = (amount: unknown, currency: unknown = 'EUR') => ({ amount, currency });
/** The values every body field is set to. */
const BODY_VALUES: unknown[] = [
  'x',
  '',
  1,
  0,
  -1,
  1.5,
  2027,
  1e21,
  true,
  false,
  null,
  [],
  {},
  [{}],
  ['x'],
  [UUID],
  { zzz: 1 },
  [{ zzz: 1 }],
  '2027-01-15',
  '2027-01-01',
  '2027-02-30',
  '2027-01-15T00:00:00Z',
  '2027',
  '2027-01',
  UUID,
  'not-an-id',
  TENANT,
  '2027010100',
  '1',
  '0.5',
  '1/2',
  '1/1',
  '100.00',
  'a'.repeat(64),
  '0'.repeat(64),
  MONEY('100.00'),
  MONEY('0.00'),
  MONEY('1.005'),
  MONEY('-1.00'),
  MONEY(100),
  MONEY('abc'),
  MONEY('100.00', 'USD'),
  MONEY('100.00', 'eur'),
  MONEY('99999999999999999999.00'),
  { amount: '100.00' },
  { currency: 'EUR' },
  { ...MONEY('100.00'), zzz: 1 },
  { ...MONEY('1.005'), zzz: 1 },
  { ...MONEY(100), zzz: 1 },
  [{ day: 1, from: '2027-01-01' }],
  // Lengths, ranges and counts around the bounds the schemas use (a trimmed text, a position, a month, a year).
  '  ',
  'x'.repeat(201),
  'x'.repeat(2001),
  'x'.repeat(10001),
  12.5,
  13,
  40.5,
  1001,
  1000.5,
  1899,
  2200.5,
  -0.5,
  Array.from({ length: 11 }, () => 'x'),
  Array.from({ length: 11 }, () => UUID),
  // Over a bound with wrong elements: Zod 4 stops an array at its maximum, Zod 3 also checked every element.
  Array.from({ length: 11 }, () => 1),
  Array.from({ length: 51 }, () => ({})),
  Array.from({ length: 51 }, () => 'x'),
  [1],
  [null],
  [UUID, UUID],
];

/** The body or query value of a path: `a.0.b` sets `a[0].b`, creating arrays for numeric segments. */
function setAt(body: unknown, path: string, value: unknown): unknown {
  const root = structuredClone(body) as Record<string, unknown>;
  const parts = path.split('.');
  let at: Record<string, unknown> = root;
  parts.forEach((part, i) => {
    if (i === parts.length - 1) {
      at[part] = structuredClone(value);
      return;
    }
    const next = at[part];
    if (typeof next !== 'object' || next === null) at[part] = /^\d+$/.test(parts[i + 1] as string) ? [] : {};
    at = at[part] as Record<string, unknown>;
  });
  return root;
}

/** Every leaf path of a body (an empty object or array is a leaf), and every object path ('' the body itself). */
function pathsOf(value: unknown, at = ''): { leaves: string[]; objects: string[] } {
  const out = { leaves: [] as string[], objects: [] as string[] };
  const join = (k: string) => (at === '' ? k : `${at}.${k}`);
  if (Array.isArray(value) && value.length > 0) value.forEach((item, i) => merge(out, pathsOf(item, join(String(i)))));
  else if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
    out.objects.push(at);
    for (const [k, v] of Object.entries(value)) merge(out, pathsOf(v, join(k)));
  } else if (at !== '') out.leaves.push(at);
  return out;
}
function merge(into: { leaves: string[]; objects: string[] }, from: { leaves: string[]; objects: string[] }) {
  into.leaves.push(...from.leaves);
  into.objects.push(...from.objects);
}

const today = new Date().toISOString().slice(0, 10);
/** Instants and today's date marked, so a record stays valid on another day. */
const normalize = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})/g, '<instant>').replaceAll(today, '<today>');

type Recorded = { requests: number; sha256: string; first: string; last: string; known?: string[] };
type Golden = { zod: string; candidates: string[]; bodies: Record<string, Recorded>; queries: Record<string, Recorded> };

/** The upper-case string literals of the sources (enumeration candidates), harvested at the record only. */
function harvestCandidates(): string[] {
  const src = dirname(fileURLToPath(import.meta.url));
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.includes('.test'))
        for (const m of readFileSync(path, 'utf8').matchAll(/'([A-Z][A-Z0-9_]+)'/g)) found.add(m[1] as string);
    }
  };
  walk(src);
  return [...found].sort();
}

const before: Golden | undefined = RECORD ? undefined : (JSON.parse(readFileSync(golden, 'utf8')) as Golden);
const candidates = before?.candidates ?? harvestCandidates();

const { calls, raw, start, stop } = countedApp();
beforeAll(start);
afterAll(stop);
const routes = listRoutes(appForInventory());
const dump: string[] = [];

/** One route's log: every request and its answer, hashed in order. */
class Log {
  readonly lines: string[] = [];
  constructor(readonly route: string) {}
  add(request: string, status: number, text: string, args?: string) {
    this.lines.push(normalize(`${request} -> ${status} ${text}${args === undefined ? '' : ` args=${args}`}`));
  }
  done(first: string, last: string, known?: string[]): Recorded {
    if (DUMP !== undefined) dump.push(...this.lines.map((l) => `${this.route} ${l}`));
    const sha256 = createHash('sha256').update(this.lines.join('\n')).digest('hex');
    return { requests: this.lines.length, sha256, first: normalize(first), last: normalize(last), ...(known === undefined ? {} : { known }) };
  }
}

type Probe = { status: number; text: string; errors: number; fields: string[] };
const parse = (status: number, text: string): Probe => {
  const fields = text.startsWith('{') ? ((JSON.parse(text) as { error?: { details?: { fields?: { field: string }[] } } }).error?.details?.fields ?? []) : [];
  // A request that reached its command (500 after the checks) counts as better than any refusal.
  return { status, text, errors: status === 500 ? -1 : fields.length, fields: fields.map((f) => f.field) };
};

/** Sends one request alone and records the command's arguments when it reached one. */
async function sequential(log: Log, method: string, url: string, body?: unknown): Promise<Probe> {
  calls.length = 0;
  const { status, text } = await raw(method, url, body === undefined ? undefined : JSON.stringify(body));
  const args = calls.length === 0 ? undefined : JSON.stringify(calls, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
  log.add(`${method} ${url} ${body === undefined ? '' : JSON.stringify(body)}`, status, text, args);
  return parse(status, text);
}

/** Sends many requests at once (no arguments recorded: calls of parallel requests cannot be told apart). */
async function parallel(log: Log, method: string, requests: { url: string; body?: unknown }[]): Promise<Probe[]> {
  const out: Probe[] = [];
  for (let i = 0; i < requests.length; i += 32) {
    const chunk = requests.slice(i, i + 32);
    const answers = await Promise.all(chunk.map((r) => raw(method, r.url, r.body === undefined ? undefined : JSON.stringify(r.body))));
    answers.forEach((a, j) => {
      const r = chunk[j] as { url: string; body?: unknown };
      log.add(`${method} ${r.url} ${r.body === undefined ? '' : JSON.stringify(r.body)}`, a.status, a.text);
      out.push(parse(a.status, a.text));
    });
  }
  calls.length = 0;
  return out;
}

/**
 * The index of the probe to keep for `field`, or -1: the one with the fewest errors among those that leave nothing at or
 * under the field, if it is better than `current`; else (once per field, `deeper`) the first that clears the field with
 * as many errors as before, or the first that leaves the field itself without an error but names fields under it (an
 * object or array whose own fields the walk then reaches).
 */
function best(probes: Probe[], current: Probe, field: string, deeper: Set<string>): number {
  let at = -1;
  probes.forEach((p, i) => {
    const under = p.fields.some((f) => f === field || f.startsWith(`${field}.`));
    if (!under && p.errors < (at === -1 ? current.errors : (probes[at] as Probe).errors)) at = i;
  });
  if (at !== -1 || deeper.has(field)) return at;
  deeper.add(field);
  // Once per field: a value that clears the field as many errors as before (the next required field shows) counts too.
  at = probes.findIndex((p) => p.errors === current.errors && !p.fields.some((f) => f === field || f.startsWith(`${field}.`)));
  if (at !== -1) return at;
  return probes.findIndex((p) => p.status !== 500 && !p.fields.includes(field) && p.fields.some((f) => f.startsWith(`${field}.`)));
}

/** Bodies an amend starts from when `{}` is refused as empty (`(body)` REQUIRED): one field each. */
const SEEDS: unknown[] = [{ description: 'x' }, { displayName: 'x' }, { notes: 'x' }, { name: 'x' }, { reason: 'x' }];

async function walkBody(r: InventoryRoute): Promise<Recorded> {
  const log = new Log(key(r));
  const url = fill(r.path, valueOf);
  let body: unknown = {};
  let current = await sequential(log, r.method, url, body);
  const first = current.text;
  for (const shape of [[], { zzz: 1 }, { zzz: 1, yyy: 2 }]) await sequential(log, r.method, url, shape);
  // A field no value improves is not tried again (each candidate sweep is a thousand requests).
  const hopeless = new Set<string>();
  const deeper = new Set<string>();
  if (current.fields.length === 1 && current.fields[0] === '(body)') {
    const seeds = SEEDS.map((seed) => ({ url, body: seed }));
    const at = best(await parallel(log, r.method, seeds), current, '(body)', deeper);
    if (at !== -1) {
      body = seeds[at]?.body;
      current = await sequential(log, r.method, url, body);
    }
  }
  for (let round = 0; round < 60 && current.status !== 500; round++) {
    const fields = [...new Set(current.fields)].filter((f) => f !== '(body)' && !f.endsWith('zzz') && !hopeless.has(f));
    let improved = false;
    for (const field of fields) {
      const fixed = BODY_VALUES.map((v) => ({ url, body: setAt(body, field, v) }));
      let probes = await parallel(log, r.method, fixed);
      let at = best(probes, current, field, deeper);
      let chosen = at === -1 ? undefined : fixed[at]?.body;
      if (chosen === undefined) {
        const named = candidates.map((v) => ({ url, body: setAt(body, field, v) }));
        probes = await parallel(log, r.method, named);
        at = best(probes, current, field, deeper);
        chosen = at === -1 ? undefined : named[at]?.body;
      }
      if (chosen !== undefined) {
        body = chosen;
        current = await sequential(log, r.method, url, body);
        improved = true;
        break;
      }
      hopeless.add(field);
    }
    if (!improved) break;
  }
  // The last body, every field at every fixed value, and an unknown field in every object.
  const { leaves, objects } = pathsOf(body);
  for (const leaf of leaves)
    await parallel(
      log,
      r.method,
      BODY_VALUES.map((v) => ({ url, body: setAt(body, leaf, v) })),
    );
  for (const object of objects) await sequential(log, r.method, url, setAt(body, object === '' ? 'zzz' : `${object}.zzz`, 1));
  const last = await sequential(log, r.method, url, body);
  return log.done(first, `${JSON.stringify(body)} -> ${last.status} ${last.text}`);
}

async function walkQuery(r: InventoryRoute): Promise<Recorded> {
  const log = new Log(key(r));
  const required = REQUIRED[key(r)];
  const base = fill(r.path, valueOf);
  const url = (query: string) => `${base}?${[required, query].filter((q) => q !== undefined && q !== '').join('&')}`;
  const first = await sequential(log, r.method, required === undefined ? base : url(''));
  await sequential(log, r.method, base);
  const known: string[] = [];
  for (const name of QUERY_NAMES) {
    if (required?.split('&').some((p) => p.startsWith(`${name}=`))) {
      known.push(name);
      continue;
    }
    // An unknown name is refused after the schema's own errors, in the order sent: `zzz` then the name. A known name
    // is checked by the schema (its error before `zzz`) or accepted (only `zzz`): either way the answer differs.
    const unknown = (await parallel(log, r.method, [{ url: url('zzz=1&yyyy=x') }]))[0] as Probe;
    const probes = await parallel(log, r.method, [{ url: url(`zzz=1&${name}=x`) }, ...PROBES.map((v) => ({ url: url(`${name}=${encodeURIComponent(v)}`) }))]);
    const asUnknown = unknown.text.replace('"yyyy"', JSON.stringify(name));
    if ((probes[0] as Probe).text !== asUnknown) {
      known.push(name);
      continue;
    }
    // Counter-check of the order rule: a probe the schema accepts also marks the name known.
    if (probes.slice(1).some((p) => p.status !== 400)) known.push(name);
  }
  for (const name of known) {
    const others = (required ?? '').split('&').filter((p) => p !== '' && !p.startsWith(`${name}=`));
    const at = (v: string) => `${base}?${[...others, `${name}=${encodeURIComponent(v)}`].join('&')}`;
    for (const v of QUERY_VALUES) await sequential(log, r.method, at(v));
    await sequential(log, r.method, `${base}?${others.join('&')}`);
  }
  for (const v of ['x', '', '0', '2027', 'ACTIVE']) await sequential(log, r.method, `${base}?${known.map((n) => `${n}=${encodeURIComponent(v)}`).join('&')}`);
  const last = await sequential(log, r.method, url('zzz=1&yyy=2'));
  return log.done(first.text, last.text, known);
}

describe('every answer of every route is unchanged by Zod 4 (VC-X-65)', () => {
  const bodyRoutes = routes.filter((r) => (r.method === 'POST' || r.method === 'PUT') && !EXEMPT_BODY.includes(r.path));
  const queryRoutes = routes.filter((r) => r.method === 'GET' && !EXEMPT_QUERY.includes(r.path));

  it('the walk covers the 91 JSON commands and the 80 GET routes of the inventory', () => {
    expect(bodyRoutes).toHaveLength(91);
    expect(queryRoutes).toHaveLength(80);
  });

  it('every body answers as recorded before the upgrade, byte for byte', { timeout: 600_000 }, async () => {
    const now: Record<string, Recorded> = {};
    for (const r of bodyRoutes) now[key(r)] = await walkBody(r);
    if (RECORD) {
      const record: Golden = { zod: process.env['VC_X65_ZOD'] ?? '', candidates, bodies: now, queries: {} };
      writeFileSync(golden, `${JSON.stringify(record, null, 2)}\n`);
    } else {
      expect(Object.keys(now)).toEqual(Object.keys(before?.bodies ?? {}));
      for (const [route, recorded] of Object.entries(now)) expect(recorded, route).toEqual(before?.bodies[route]);
    }
  });

  it('every query answers as recorded before the upgrade, byte for byte', { timeout: 600_000 }, async () => {
    const now: Record<string, Recorded> = {};
    for (const r of queryRoutes) now[key(r)] = await walkQuery(r);
    if (DUMP !== undefined) writeFileSync(DUMP, `${dump.join('\n')}\n`);
    if (RECORD) {
      const record = JSON.parse(readFileSync(golden, 'utf8')) as Golden;
      writeFileSync(golden, `${JSON.stringify({ ...record, queries: now }, null, 2)}\n`);
    } else {
      expect(Object.keys(now)).toEqual(Object.keys(before?.queries ?? {}));
      for (const [route, recorded] of Object.entries(now)) expect(recorded, route).toEqual(before?.queries[route]);
    }
  });

  it('counter-check: the walk reached commands and refusals on many routes, and knows parameters on the lists', () => {
    const golden =
      before ?? (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'error-answers-golden', 'before-vc-x-65.json'), 'utf8')) as Golden);
    const reached = Object.values(golden.bodies).filter((b) => / -> 500 /.test(b.last)).length;
    expect(reached).toBeGreaterThan(60);
    expect(Object.values(golden.bodies).filter((b) => b.first.startsWith('{"error":{"code":"VALIDATION_ERROR"')).length).toBeGreaterThan(60);
    expect(golden.queries['GET /api/v1/transactions']?.known).toEqual(expect.arrayContaining(['page', 'pageSize', 'status', 'provenance', 'bookingDateFrom']));
  });
});

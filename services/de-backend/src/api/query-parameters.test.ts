import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppCommands } from './app.js';
import { unusedCommands } from './app.test-support.js';
import { appForInventory, listRoutes, type InventoryRoute } from './route-inventory.js';
import { REALM, admin } from './transactions.test-support.js';

/**
 * VC-X-61 (api-design.md §58W, "Tests the implementation needs" (1), (4), (5)): every route of the inventory, with every
 * command rejecting and counted, answers an unknown query parameter by its name before any command runs; the body of a
 * command never displaces the query's errors; a malformed path id and the query's errors come in one answer; the paged
 * routes share one paging. No database. Synthetic values only.
 */

/** The two server-root probes outside the API (§58W rule 3, Entscheidung des Projektinhabers, 2026-11-09, question 2). */
const EXEMPT = ['/health/live', '/health/ready'];

const UUID = '0000f061-0000-4000-8000-000000000001';
/** One valid value per path parameter, by name: a name missing here fails the walk (a new route cannot slip through). */
const PATH_VALUES: Readonly<Record<string, string>> = {
  acknowledgementId: UUID,
  acquisitionId: UUID,
  allocationSetId: UUID,
  assessmentId: UUID,
  assetId: UUID,
  classificationId: UUID,
  code: 'RENT_BASE',
  confirmationId: UUID,
  costId: UUID,
  depositId: UUID,
  externalReferenceId: UUID,
  financialAccountId: UUID,
  importBatchId: UUID,
  loanId: UUID,
  membershipId: UUID,
  mreRentTerm: '2027010100',
  mreTenantId: '6512f0c2a1b2c3d4e5f60a61',
  ownershipId: UUID,
  partyId: UUID,
  paymentId: UUID,
  planId: UUID,
  position: '1',
  propertyReferenceId: UUID,
  reconciliationId: UUID,
  recordId: UUID,
  rentalContractReferenceId: UUID,
  reviewItemId: UUID,
  ruleCode: 'DE_82B_DISTRIBUTION',
  securityDepositId: UUID,
  splitId: UUID,
  statementId: UUID,
  termsId: UUID,
  transactionId: UUID,
  versionId: UUID,
  wegId: UUID,
  year: '2027',
};

/** The required parameters of the routes that have any, at valid values (§58W's route table). */
const REQUIRED: Readonly<Record<string, string>> = {
  'GET /api/v1/loans/:loanId/payment-proposal': `transactionId=${UUID}`,
  'GET /api/v1/loans/:loanId/payments': 'year=2027',
  'GET /api/v1/property-references/:propertyReferenceId/tax-meanings': 'year=2027',
  'GET /api/v1/rent-reconciliations/split-proposal': `transactionId=${UUID}&mreTenantId=6512f0c2a1b2c3d4e5f60a61&mreRentTerm=2027010100`,
  'GET /api/v1/rental-contract-references': 'mreTenantId=6512f0c2a1b2c3d4e5f60a61',
  'GET /api/v1/tax-classifications': `sourceType=TRANSACTION_SPLIT&sourceId=${UUID}`,
  'GET /api/v1/transactions/:transactionId/settlement-proposal': `statementId=${UUID}`,
};

const paramsOf = (path: string) => [...path.matchAll(/:(\w+)/g)].map((m) => m[1] as string);
const fill = (path: string, value: (name: string) => string) => path.replace(/:(\w+)/g, (_m, name: string) => value(name));
const valueOf = (name: string) => {
  const value = PATH_VALUES[name];
  if (value === undefined) throw new Error(`no test value for the path parameter ${name}`);
  return value;
};
const key = (r: InventoryRoute) => `${r.method} ${r.path}`;
/** The route's required parameters (valid) and then `query`: `?transactionId=…&zzz=1&yyy=2`. */
const withQuery = (r: InventoryRoute, query: string) => `?${[REQUIRED[key(r)], query].filter((q) => q !== undefined && q !== '').join('&')}`;

/** Every command of every module, rejecting, with each call (module, command, arguments) recorded. */
const calls: { module: string; command: string; args: unknown }[] = [];
const counted = Object.fromEntries(
  Object.entries(unusedCommands).map(([module, commands]) => [
    module,
    Object.fromEntries(
      Object.keys(commands as object).map((command) => [
        command,
        (args: unknown) => {
          calls.push({ module, command, args });
          return Promise.reject(new Error('not used in this test'));
        },
      ]),
    ),
  ]),
) as unknown as AppCommands;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...counted }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const routes = listRoutes(appForInventory());
const apiRoutes = routes.filter((r) => !EXEMPT.includes(r.path));
const withBody = (method: string) => method === 'POST' || method === 'PUT';

type Answer = { status: number; code: string | undefined; fields: { field: string; code: string }[] | undefined };
async function send(method: string, url: string, body?: string, contentType = 'application/json'): Promise<Answer> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { authorization: 'Bearer a.b.c', organizationid: REALM, ...(body === undefined ? {} : { 'content-type': contentType }) },
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  const json = text.startsWith('{') ? (JSON.parse(text) as { error?: { code?: string; details?: { fields?: Answer['fields'] } } }) : {};
  return { status: res.status, code: json.error?.code, fields: json.error?.details?.fields };
}

const UNKNOWN = [
  { field: 'zzz', code: 'INVALID_FORMAT' },
  { field: 'yyy', code: 'INVALID_FORMAT' },
];

describe('every route refuses an unknown query parameter by its name (§58W rules 1–3)', () => {
  it('the inventory has 174 routes and exactly the two probes outside /api/v1, exempted by a literal', () => {
    expect(routes).toHaveLength(174);
    expect(routes.filter((r) => !r.path.startsWith('/api/v1/')).map((r) => r.path)).toEqual(EXEMPT);
    // Counter-check: every path parameter of the inventory has a value, so the walk below reaches every handler.
    for (const r of routes) for (const name of paramsOf(r.path)) expect(PATH_VALUES, `${key(r)}: ${name}`).toHaveProperty(name);
  });

  it('?zzz=1&yyy=2 with valid path ids is 400 INVALID_FORMAT naming zzz and yyy on every route but the probes, and no command runs', async () => {
    const wrong: string[] = [];
    for (const r of apiRoutes) {
      calls.length = 0;
      const answer = await send(r.method, `${fill(r.path, valueOf)}${withQuery(r, 'zzz=1&yyy=2')}`, withBody(r.method) ? '{}' : undefined);
      const ok = answer.status === 400 && answer.code === 'VALIDATION_ERROR' && JSON.stringify(answer.fields) === JSON.stringify(UNKNOWN) && calls.length === 0;
      if (!ok) wrong.push(`${key(r)}: ${answer.status} ${JSON.stringify(answer.fields)} calls=${calls.length}`);
    }
    expect(wrong).toEqual([]);
    expect(apiRoutes).toHaveLength(172);
  });

  it('without a query the same requests reach their command (the refusal above is the query, not the path or the body)', async () => {
    const refused: string[] = [];
    for (const r of apiRoutes.filter((x) => x.method === 'GET')) {
      calls.length = 0;
      const required = REQUIRED[key(r)];
      const answer = await send('GET', `${fill(r.path, valueOf)}${required === undefined ? '' : `?${required}`}`);
      // `/api/v1/health` answers itself; every other read calls its rejecting command (500).
      const expected = r.path === '/api/v1/health' ? 200 : 500;
      if (answer.status !== expected || (expected === 500 && calls.length === 0)) refused.push(`${key(r)}: ${answer.status} ${JSON.stringify(answer.fields)}`);
    }
    expect(refused).toEqual([]);
  });

  it('the two probes keep ignoring the query (the exemption is real, not a missing route)', async () => {
    for (const path of EXEMPT) expect((await send('GET', `${path}?zzz=1`)).status).toBe(200);
  });
});

describe('the body never displaces the query error (§58W rule 5; review hint (b))', () => {
  const bodies: [string, string | undefined, string?][] = [
    ['no body', undefined],
    ['an empty object', '{}'],
    ['an unknown body field', '{"zzz":1}'],
    ['malformed JSON', '{"a":'],
    ['a JSON array', '[1]'],
    ['a body over every limit', `{"a":"${'x'.repeat(300 * 1024)}"}`],
    ['a text body', 'zzz', 'text/plain'],
  ];
  it.each(bodies)('every POST and PUT with %s and ?zzz=1&yyy=2 answers the query errors only', async (_label, body, contentType) => {
    const wrong: string[] = [];
    for (const r of apiRoutes.filter((x) => withBody(x.method))) {
      calls.length = 0;
      const answer = await send(r.method, `${fill(r.path, valueOf)}?zzz=1&yyy=2`, body, contentType);
      if (answer.status !== 400 || JSON.stringify(answer.fields) !== JSON.stringify(UNKNOWN) || calls.length > 0)
        wrong.push(`${key(r)}: ${answer.status} ${JSON.stringify(answer.fields)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('counter-check: without the query, malformed JSON and an oversized body keep their answers', async () => {
    const r = { method: 'POST', path: '/api/v1/transactions' };
    expect(await send(r.method, r.path, '{"a":')).toEqual({ status: 400, code: 'VALIDATION_ERROR', fields: undefined });
    expect(await send(r.method, r.path, `{"a":"${'x'.repeat(300 * 1024)}"}`)).toEqual({ status: 413, code: 'VALIDATION_ERROR', fields: undefined });
  });
});

/** A malformed value per path parameter that is checked for its format (`ruleCode` is looked up, never malformed). */
const MALFORMED: Readonly<Record<string, string>> = { code: 'x', mreRentTerm: '2027', mreTenantId: 'x', position: 'x', year: 'x' };
const malformed = (name: string) => (PATH_VALUES[name] === UUID ? 'not-an-id' : MALFORMED[name]);

describe('a malformed path id and the query errors in one answer, path first (§58W rule 5)', () => {
  it('every route with a checked parameter in its path: the path field(s), then zzz and yyy, no command', async () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const r of apiRoutes) {
      const names = paramsOf(r.path).filter((name) => malformed(name) !== undefined);
      if (names.length === 0) continue;
      checked += 1;
      calls.length = 0;
      const path = fill(r.path, (name) => malformed(name) ?? valueOf(name));
      const answer = await send(r.method, `${path}${withQuery(r, 'zzz=1&yyy=2')}`, withBody(r.method) ? '{}' : undefined);
      const fields = answer.fields ?? [];
      const ok =
        answer.status === 400 &&
        fields.length >= 3 &&
        JSON.stringify(fields.slice(-2)) === JSON.stringify(UNKNOWN) &&
        fields.slice(0, -2).every((f) => names.includes(f.field)) &&
        calls.length === 0;
      if (!ok) wrong.push(`${key(r)}: ${answer.status} ${JSON.stringify(fields)}`);
    }
    expect(wrong).toEqual([]);
    // Every route with a parameter in its path whose format is checked was walked.
    expect(checked).toBe(apiRoutes.filter((r) => paramsOf(r.path).some((n) => n !== 'ruleCode')).length);
  });
});

/** The object in a command's arguments that holds `page` and `pageSize` (`{ page: { page, pageSize } }` or flat). */
function pagingIn(value: unknown): { page: unknown; pageSize: unknown } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (Object.hasOwn(value, 'page') && Object.hasOwn(value, 'pageSize') && typeof (value as { page: unknown }).page !== 'object')
    return value as { page: unknown; pageSize: unknown };
  for (const inner of Object.values(value)) {
    const found = pagingIn(inner);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe('one paging on every paged route (§58W "Pagination consistent across routes")', () => {
  const getRoutes = apiRoutes.filter((r) => r.method === 'GET');
  const url = (r: InventoryRoute, query: string) => `${fill(r.path, valueOf)}${withQuery(r, query)}`;
  const paged: InventoryRoute[] = [];

  beforeAll(async () => {
    for (const r of getRoutes) if ((await send('GET', url(r, 'page=1000000&pageSize=200'))).status === 500) paged.push(r);
  });

  it('19 routes take page and pageSize at their maxima; every other read refuses both by name', async () => {
    expect(paged).toHaveLength(19);
    for (const r of getRoutes.filter((x) => !paged.includes(x) && x.path !== '/api/v1/health')) {
      const answer = await send('GET', url(r, 'page=1&pageSize=200'));
      expect(answer.fields?.slice(-2), key(r)).toEqual([
        { field: 'page', code: 'INVALID_FORMAT' },
        { field: 'pageSize', code: 'INVALID_FORMAT' },
      ]);
    }
  });

  it('on each paged route the same bounds and codes, and the defaults 1 and 50', async () => {
    for (const r of paged) {
      for (const [query, field] of [
        ['pageSize=201', 'pageSize'],
        ['pageSize=0', 'pageSize'],
        ['pageSize=1.5', 'pageSize'],
        ['page=0', 'page'],
        ['page=1000001', 'page'],
        ['page=', 'page'],
        ['page=x', 'page'],
      ] as const) {
        expect(await send('GET', url(r, query)), `${key(r)} ${query}`).toMatchObject({ status: 400, fields: [{ field, code: 'INVALID_FORMAT' }] });
      }
      calls.length = 0;
      await send('GET', url(r, ''));
      expect(pagingIn(calls[0]?.args), key(r)).toEqual(expect.objectContaining({ page: 1, pageSize: 50 }));
    }
  });
});

describe('only validation.ts reads a request query (§58W test 8)', () => {
  it("the ESLint rule refuses .query, ['query'] and a destructured query in src/api but validation.ts and the tests", () => {
    const config = readFileSync(new URL('../../../../eslint.config.mjs', import.meta.url), 'utf8');
    const block = config.slice(config.indexOf("files: ['services/de-backend/src/api/**/*.ts']"));
    expect(block).toMatch(
      /^files: \['services\/de-backend\/src\/api\/\*\*\/\*\.ts'\],\n\s*ignores: \['services\/de-backend\/src\/api\/validation\.ts', '\*\*\/\*\.test\.ts', '\*\*\/\*\.test-support\.ts'\],/,
    );
    for (const selector of [
      "MemberExpression[property.name='query']",
      "MemberExpression[property.value='query']",
      "ObjectPattern > Property[key.name='query']",
    ])
      expect(block.slice(0, block.indexOf('},\n  },')), selector).toContain(`{ selector: "${selector}"`);
  });

  it('and no production file of src/api but validation.ts mentions a query member (a second guard, by source)', () => {
    const dir = new URL('.', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.test-support.ts') && f !== 'validation.ts');
    expect(files.length).toBeGreaterThan(40);
    for (const f of files) expect(readFileSync(new URL(f, dir), 'utf8'), f).not.toMatch(/\.query\b|\[['"]query['"]\]|\{\s*query\b[^}]*\}\s*=\s*req\b/);
  });
});

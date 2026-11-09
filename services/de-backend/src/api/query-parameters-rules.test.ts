import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { commandsWith } from './app.test-support.js';
import { REALM, admin } from './transactions.test-support.js';

/**
 * VC-X-61 (api-design.md §58W "Tests the implementation needs" (2), (5), (6) and the edge cases): the rules of
 * `readQuery` per kind of route, each answer exact. Every command rejects (`500`) and counts its calls, so a request
 * that passes the query check is told from one refused by it. No database. Synthetic values only.
 */
const ID = '0000f061-0000-4000-8000-000000000002';
let calls = 0;
const counting = () => {
  calls += 1;
  return Promise.reject(new Error('not used in this test'));
};

let server: Server;
let base: string;
beforeAll(async () => {
  const app = createApp({
    isReady: async () => true,
    verifyPrincipal: admin,
    ...commandsWith({
      transactions: { list: counting, get: counting, confirm: counting },
      exports: { transactions: counting },
      financialAccounts: { list: counting },
      securityDeposits: { list: counting },
      wegs: { listWegs: counting, listMemberships: counting },
      rentReconciliations: { list: counting },
      wegAnnualStatements: { list: counting },
      wegEconomicPlans: { list: counting },
      wegSpecialAssessments: { list: counting },
      depreciationAssets: { listForPropertyReference: counting, listVersions: counting },
      propertyReferences: { list: counting },
      taxation: { taxMeanings: counting },
      taxStatements: { listAcknowledgements: counting },
      loanDebt: { payments: counting },
    }),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function send(method: string, path: string, init: { body?: string; contentType?: string } = {}) {
  calls = 0;
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      authorization: 'Bearer a.b.c',
      organizationid: REALM,
      ...(init.body === undefined ? {} : { 'content-type': init.contentType ?? 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const text = await res.text();
  const fields = text.startsWith('{') ? (JSON.parse(text) as { error?: { details?: { fields?: unknown } } }).error?.details?.fields : undefined;
  return { status: res.status, fields, calls };
}
const named = (...names: string[]) => names.map((field) => ({ field, code: 'INVALID_FORMAT' }));

/** A paged list, a single read, a command and the export (§58W test 2): their path and method. */
const KINDS: [string, string, string][] = [
  ['a paged list', 'GET', '/transactions'],
  ['a single read', 'GET', `/transactions/${ID}`],
  ['a command', 'POST', `/transactions/${ID}/confirm`],
  ['the export', 'GET', '/exports/transactions.csv'],
];

/** The query as sent and the fields it is refused with, on every kind (none of them knows any of these keys). */
const REFUSED: [string, ReturnType<typeof named>][] = [
  ['zzz=1', named('zzz')],
  ['zzz=1&zzz=2', named('zzz')],
  ['zzz=1&zzz=1', named('zzz')],
  ['zzz=1&yyy=2&zzz=3', named('zzz', 'yyy')],
  ['zzz=', named('zzz')],
  ['zzz', named('zzz')],
  ['Page=1', named('Page')],
  ['page[]=2', named('page[]')],
  ['a[b]=1', named('a[b]')],
  ['%7A%7A%7A=1', named('zzz')],
  ['z+z=1', named('z z')],
  ['z%20z=1', named('z z')],
  ['%zz=1', named('%zz')],
  ['=1', named('')],
  ['&&zzz=1&&', named('zzz')],
  ['limit=10&offset=5&cursor=x&after=x&sort=x', named('limit', 'offset', 'cursor', 'after', 'sort')],
  // Prototype names are keys like any other (review hint (a)): named, never found on an object's prototype.
  ['__proto__=1', named('__proto__')],
  ['constructor=1', named('constructor')],
  ['toString=1', named('toString')],
  ['hasOwnProperty=1', named('hasOwnProperty')],
  ['valueOf=1&__proto__[page]=2', named('valueOf', '__proto__[page]')],
];

describe('unknown and repeated keys, read from the raw query string (§58W rules 1, 2, 4; edge cases)', () => {
  for (const [kind, method, path] of KINDS) {
    it.each(REFUSED)(`${kind}: ?%s is refused with exactly its fields, no command`, async (query, fields) => {
      expect(await send(method, `${path}?${query}`)).toEqual({ status: 400, fields, calls: 0 });
    });

    it(`${kind}: no query, a bare ? and ?&& pass the check (the command runs)`, async () => {
      for (const suffix of ['', '?', '?&&', '?&']) expect(await send(method, `${path}${suffix}`), suffix).toMatchObject({ status: 500, calls: 1 });
    });

    it(`${kind}: 1,001 unknown pairs are 1,001 entries, nothing dropped`, async () => {
      const keys = Array.from({ length: 1001 }, (_, i) => `k${i}`);
      const answer = await send(method, `${path}?${keys.map((k) => `${k}=1`).join('&')}`);
      expect(answer).toEqual({ status: 400, fields: named(...keys), calls: 0 });
    });
  }

  it('a known key given twice is one entry, equal values or not; its own error is not added', async () => {
    expect(await send('GET', '/transactions?page=1&page=1')).toEqual({ status: 400, fields: named('page'), calls: 0 });
    expect(await send('GET', '/transactions?status=CONFIRMED&status=IGNORED')).toEqual({ status: 400, fields: named('status'), calls: 0 });
    expect(await send('GET', '/transactions?page=x&page=x')).toEqual({ status: 400, fields: named('page'), calls: 0 });
    expect(await send('GET', '/exports/transactions.csv?rows=splits&rows=splits')).toEqual({ status: 400, fields: named('rows'), calls: 0 });
    // Counter-check: a list is one parameter with commas, and passes.
    expect(await send('GET', '/transactions?status=CONFIRMED,IGNORED')).toMatchObject({ status: 500, calls: 1 });
  });

  it('a known parameter is checked by its schema first, then the unknown and repeated keys in the order sent', async () => {
    expect(await send('GET', '/transactions?zzz=1&page=0&pageSize=1&pageSize=2')).toEqual({
      status: 400,
      fields: [
        { field: 'page', code: 'INVALID_FORMAT' },
        { field: 'zzz', code: 'INVALID_FORMAT' },
        { field: 'pageSize', code: 'INVALID_FORMAT' },
      ],
      calls: 0,
    });
    // A known parameter on another route is unknown here (`page` on the export, the single read and the command).
    for (const [, method, path] of KINDS.slice(1)) expect(await send(method, `${path}?page=1`)).toEqual({ status: 400, fields: named('page'), calls: 0 });
    // An empty value of a known parameter is a value, refused by its schema, never read as absent.
    expect(await send('GET', '/transactions?page=')).toEqual({ status: 400, fields: named('page'), calls: 0 });
    expect(await send('GET', '/transactions?reviewable=')).toEqual({ status: 400, fields: named('reviewable'), calls: 0 });
  });

  it('HEAD is answered through the GET route, so the same check applies (no body)', async () => {
    expect(await send('HEAD', '/transactions?zzz=1')).toEqual({ status: 400, fields: undefined, calls: 0 });
    expect(await send('HEAD', '/transactions')).toMatchObject({ status: 500, calls: 1 });
  });

  it('an unknown parameter beside a missing required one gives both', async () => {
    expect(await send('GET', `/loans/${ID}/payments?zzz=1`)).toEqual({
      status: 400,
      fields: [
        { field: 'year', code: 'REQUIRED' },
        { field: 'zzz', code: 'INVALID_FORMAT' },
      ],
      calls: 0,
    });
  });
});

describe('a comma list names the parameter alone, without an index (§58W rule 7)', () => {
  const P = ID;
  const LISTS: [string, string][] = [
    ['/financial-accounts', 'status'],
    ['/financial-accounts', 'accountType'],
    ['/security-deposits', 'status'],
    ['/security-deposits', 'state'],
    ['/wegs', 'status'],
    [`/wegs/${P}/memberships`, 'status'],
    ['/rent-reconciliations', 'status'],
    [`/weg-memberships/${P}/annual-statements`, 'status'],
    [`/weg-memberships/${P}/economic-plans`, 'status'],
    [`/weg-memberships/${P}/special-assessments`, 'status'],
    [`/weg-memberships/${P}/special-assessments`, 'purpose'],
    [`/property-references/${P}/depreciation-assets`, 'status'],
    ['/property-references', 'externalReferenceState'],
    [`/property-references/${P}/tax-meanings?year=2027`, 'reviewState'],
    [`/property-references/${P}/tax-meanings?year=2027`, 'origin'],
    [`/property-references/${P}/tax-meanings?year=2027`, 'taxCategory'],
    [`/property-references/${P}/tax-meanings?year=2027`, 'sourceType'],
    ['/transactions', 'status'],
    ['/transactions', 'provenance'],
    ['/exports/transactions.csv', 'status'],
    [`/depreciation-assets/${P}/schedule-versions`, 'status'],
    [`/property-references/${P}/tax-years/2027/acknowledgements`, 'status'],
  ];
  it.each(LISTS)('%s: a bad value of %s is named by the parameter', async (path, param) => {
    const join = path.includes('?') ? '&' : '?';
    expect(await send('GET', `${path}${join}${param}=NOPE`)).toEqual({ status: 400, fields: named(param), calls: 0 });
    expect(await send('GET', `${path}${join}${param}=`)).toEqual({ status: 400, fields: named(param), calls: 0 });
  });

  it('the two status lists of §58E and §60 name an unknown parameter by itself, a bad status still status', async () => {
    for (const path of [`/depreciation-assets/${P}/schedule-versions`, `/property-references/${P}/tax-years/2027/acknowledgements`]) {
      expect(await send('GET', `${path}?zzz=1`)).toEqual({ status: 400, fields: named('zzz'), calls: 0 });
      expect(await send('GET', `${path}?status=NOPE&zzz=1`)).toEqual({ status: 400, fields: named('status', 'zzz'), calls: 0 });
    }
  });
});

describe('the order of path, query and body (§58W rules 5, 6)', () => {
  it('a malformed path id and an unknown parameter: both, path first, on a read and on a command', async () => {
    expect(await send('GET', '/transactions/x?zzz=1')).toEqual({ status: 400, fields: named('transactionId', 'zzz'), calls: 0 });
    expect(await send('POST', '/transactions/x/confirm?zzz=1')).toEqual({ status: 400, fields: named('transactionId', 'zzz'), calls: 0 });
    // Counter-check: without the query only the path, without the bad id only the query.
    expect(await send('GET', '/transactions/x')).toEqual({ status: 400, fields: named('transactionId'), calls: 0 });
    expect(await send('GET', `/transactions/${ID}?zzz=1`)).toEqual({ status: 400, fields: named('zzz'), calls: 0 });
  });

  it('a command with an unknown parameter and an invalid, malformed or oversized body: the query only (the body is not read)', async () => {
    const path = `/transactions/${ID}/amend?zzz=1`;
    for (const body of ['{"description":5}', '{"zzz":1}', '{', `{"a":"${'x'.repeat(64 * 1024)}"}`]) {
      expect(await send('POST', path, { body }), body.slice(0, 20)).toEqual({ status: 400, fields: named('zzz'), calls: 0 });
    }
    // Counter-check: with a valid query, the body's own answer, unchanged.
    expect((await send('POST', `/transactions/${ID}/amend`, { body: '{"description":5}' })).fields).toEqual(named('description'));
  });

  it('the bank import refuses the query before reading the upload', async () => {
    const answer = await send('POST', '/imports/bank-transactions?zzz=1', { body: '--x--', contentType: 'multipart/form-data; boundary=x' });
    expect(answer).toEqual({ status: 400, fields: named('zzz'), calls: 0 });
  });
});

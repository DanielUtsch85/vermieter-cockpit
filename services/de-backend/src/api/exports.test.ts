import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExportTooLargeError,
  PropertyReferenceNotFoundError,
  exportTransactions,
  type ExportProperty,
  type ExportTransactions,
  type ListTransactions,
  type TransactionFilter,
  type TransactionWithSplits,
} from '../application/index.js';
import { createApp } from './app.js';
import { commandsWith } from './app.test-support.js';
import { REALM, ACCOUNT, PROPERTY, transaction, admin } from './transactions.test-support.js';

/** The routes of `exports.ts` (api-design.md §58S, VC-X-04) against fake commands: parameters, headers, errors, streaming. */
let server: Server | undefined;
const GENERATED_AT = new Date('2026-11-06T23:59:59.999Z');

async function start(commands: { transactions?: ExportTransactions; property?: ExportProperty; list?: ListTransactions; logError?: (line: string) => void }) {
  server = createApp({
    isReady: async () => true,
    verifyPrincipal: admin,
    ...commandsWith({
      exports: {
        ...(commands.transactions === undefined ? {} : { transactions: commands.transactions }),
        ...(commands.property === undefined ? {} : { property: commands.property }),
        ...(commands.logError === undefined ? {} : { logError: commands.logError }),
      },
      ...(commands.list === undefined ? {} : { transactions: { list: commands.list } }),
    }),
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  // A stream broken off on purpose leaves its socket to the keep-alive timeout otherwise.
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const get = (base: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}/api/v1${path}`, { ...init, headers: { authorization: 'Bearer a.b.c', organizationid: REALM } });
const item: TransactionWithSplits = { transaction, splits: [] };

/** An export command that answers `batches` after a head with their count, recording the filter it was given. */
function fake(batches: (readonly TransactionWithSplits[])[] = [], seen: TransactionFilter[] = [], rowCount?: number): ExportTransactions {
  return async ({ filter, withSplits, sink }) => {
    seen.push(filter);
    await sink.begin({
      generatedAt: GENERATED_AT,
      transactionCount: batches.flat().length,
      rowCount: withSplits ? (rowCount ?? batches.flat().length) : undefined,
    });
    for (const batch of batches) await sink.batch(batch);
  };
}

describe('GET /api/v1/exports/transactions.csv', () => {
  it('every 30.1 filter, alone and combined, reaches the export as the list gets it (the same schema and listFilter)', async () => {
    const exported: TransactionFilter[] = [];
    const listed: TransactionFilter[] = [];
    const base = await start({
      transactions: fake([], exported),
      list: async ({ filter }) => (listed.push(filter), { items: [], page: 1, pageSize: 50, total: 0 }),
    });
    const queries = [
      '',
      `financialAccountId=${ACCOUNT.toUpperCase()}`,
      'status=IMPORTED,CONFIRMED',
      'provenance=BANK_CSV,MANUAL',
      'reviewable=true',
      'reviewable=true&status=CONFIRMED,IMPORTED',
      'current=true',
      `propertyReferenceId=${PROPERTY.toUpperCase()}`,
      'financialCategoryCode=RENT_BASE',
      'bookingDateFrom=2026-09-01',
      'bookingDateTo=2026-09-30',
      `financialAccountId=${ACCOUNT}&status=CONFIRMED&current=true&propertyReferenceId=${PROPERTY}&financialCategoryCode=RENT_BASE&provenance=MANUAL&bookingDateFrom=2026-01-01&bookingDateTo=2026-12-31`,
    ];
    for (const query of queries) {
      expect((await get(base, `/exports/transactions.csv?${query}`)).status, query).toBe(200);
      expect((await get(base, `/transactions?${query}`)).status, query).toBe(200);
    }
    expect(exported).toEqual(listed);
    expect(exported[1]).toEqual({ financialAccountId: ACCOUNT });
    expect(exported[5]).toEqual({ statuses: ['IMPORTED'] });
    expect(exported[6]).toEqual({ current: true });
  });

  it.each([
    ['page', 'page=2', [{ field: 'page', code: 'INVALID_FORMAT' }]],
    ['pageSize', 'pageSize=10', [{ field: 'pageSize', code: 'INVALID_FORMAT' }]],
    ['an unknown parameter', 'foo=1', [{ field: 'foo', code: 'INVALID_FORMAT' }]],
    ['include=audit', 'include=audit', [{ field: 'include', code: 'INVALID_FORMAT' }]],
    ['rows=all', 'rows=all', [{ field: 'rows', code: 'INVALID_FORMAT' }]],
    ['an inverted range', 'bookingDateFrom=2026-10-01&bookingDateTo=2026-09-01', [{ field: 'bookingDateTo', code: 'INVALID_RANGE' }]],
    ['a malformed account id', 'financialAccountId=x', [{ field: 'financialAccountId', code: 'INVALID_FORMAT' }]],
    ['an unknown status', 'status=NOPE', [{ field: 'status', code: 'INVALID_FORMAT' }]],
    ['dialect=excel', 'dialect=excel', [{ field: 'dialect', code: 'INVALID_FORMAT' }]],
    ['dialect=EXCEL-DE', 'dialect=EXCEL-DE', [{ field: 'dialect', code: 'INVALID_FORMAT' }]],
    ['dialect empty', 'dialect=', [{ field: 'dialect', code: 'INVALID_FORMAT' }]],
    ['dialect twice', 'dialect=excel-de&dialect=excel-de', [{ field: 'dialect', code: 'INVALID_FORMAT' }]],
  ])('400 VALIDATION_ERROR for %s, as JSON without BOM, before any count', async (_label, query, fields) => {
    let called = false;
    const base = await start({ transactions: async () => void (called = true) });
    const res = await get(base, `/exports/transactions.csv?${query}`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const text = await res.text();
    expect(text.startsWith('{')).toBe(true);
    expect(JSON.parse(text)).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed.', details: { fields } } });
    expect(called).toBe(false);
  });

  it('the headers per dialect and rows: type, disposition, no-store, the X-Export headers; no ETag', async () => {
    const base = await start({ transactions: fake([[item]], [], 4) });
    const cases = [
      ['', 'kassenbuch-2026-11-06.csv', 'rows=transactions; dialect=rfc4180'],
      ['dialect=rfc4180', 'kassenbuch-2026-11-06.csv', 'rows=transactions; dialect=rfc4180'],
      ['dialect=excel-de', 'kassenbuch-2026-11-06-excel-de.csv', 'rows=transactions; dialect=excel-de'],
      ['rows=splits', 'kassenbuch-2026-11-06.csv', 'rows=splits; dialect=rfc4180'],
      ['rows=splits&dialect=excel-de', 'kassenbuch-2026-11-06-excel-de.csv', 'rows=splits; dialect=excel-de'],
    ] as const;
    for (const [query, file, format] of cases) {
      const res = await get(base, `/exports/transactions.csv?${query}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8; header=present');
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${file}"`);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-export-format')).toBe(`vermieter-cockpit.transactions-csv; version=1; ${format}`);
      expect(res.headers.get('x-export-generated-at')).toBe('2026-11-06T23:59:59.999Z');
      expect(res.headers.get('x-export-realm')).toBe(REALM);
      expect(res.headers.get('x-export-transaction-count')).toBe('1');
      expect(res.headers.get('x-export-row-count')).toBe(query.includes('splits') ? '4' : null);
      expect(res.headers.get('etag')).toBeNull();
      await res.arrayBuffer();
    }
  });

  it('an empty result is the header line with its CRLF and count 0; in excel-de the BOM, the header and CRLF', async () => {
    const base = await start({ transactions: fake([]) });
    const rfc = await get(base, '/exports/transactions.csv');
    expect(rfc.headers.get('x-export-transaction-count')).toBe('0');
    const text = Buffer.from(await rfc.arrayBuffer()).toString('utf8');
    expect(text).toMatch(/^transactionId,bookingDate,.*,createdAt,version\r\n$/);
    const de = Buffer.from(await (await get(base, '/exports/transactions.csv?dialect=excel-de')).arrayBuffer());
    expect([...de.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(de.subarray(3).toString('utf8')).toBe(text.replaceAll(',', ';'));
  });

  it('more than one batch in excel-de: the BOM exactly once, at the start; every record whole, no comma as a delimiter', async () => {
    const batches = [[item, item], [item], [item, item]];
    const base = await start({ transactions: fake(batches) });
    const body = Buffer.from(await (await get(base, '/exports/transactions.csv?dialect=excel-de')).arrayBuffer()).toString('utf8');
    expect(body.split('\uFEFF')).toHaveLength(2);
    expect(body.startsWith('\uFEFF')).toBe(true);
    const lines = body.slice(1).split('\r\n');
    expect(lines).toHaveLength(1 + 5 + 1);
    expect(lines.at(-1)).toBe('');
    for (const line of lines.slice(0, -1)) expect(line.split(';')).toHaveLength(23);
  });

  it('409 EXPORT_TOO_LARGE above the limit, as JSON, before the first byte (the limit injected small)', async () => {
    let batches = 0;
    const base = await start({
      transactions: exportTransactions({
        limit: 2,
        queries: {
          exportAll: async (_realm, _filter, _options, sink) => {
            await sink.begin({ generatedAt: GENERATED_AT, transactionCount: 3, rowCount: undefined });
            batches++;
            await sink.batch([item, item, item]);
          },
        },
      }),
    });
    const res = await get(base, '/exports/transactions.csv?dialect=excel-de');
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('x-export-transaction-count')).toBeNull();
    expect(await res.json()).toEqual({
      error: {
        code: 'CONFLICT',
        message: 'The export is too large; narrow the filter (e.g. by year).',
        details: { reason: 'EXPORT_TOO_LARGE', total: 3, limit: 2 },
      },
    });
    expect(batches).toBe(0);
  });

  it('a failure after the first batch ends the response without the closing chunk; it is logged without data', async () => {
    const logged: string[] = [];
    const base = await start({
      logError: (line) => logged.push(line),
      transactions: async ({ sink }) => {
        await sink.begin({ generatedAt: GENERATED_AT, transactionCount: 2, rowCount: undefined });
        await sink.batch([item]);
        throw new Error('the database went away');
      },
    });
    const res = await get(base, '/exports/transactions.csv');
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logged).toEqual(['export aborted after the first byte: GET /api/v1/exports/transactions.csv (Error)']);
  });

  it('a client that disconnects ends the read: the next write rejects, and nothing is logged', async () => {
    const logged: string[] = [];
    let ended: unknown;
    let firstWritten: () => void = () => undefined;
    const written = new Promise<void>((resolve) => (firstWritten = resolve));
    const big = { ...item, transaction: { ...transaction, description: 'x'.repeat(400) } } as TransactionWithSplits;
    const base = await start({
      logError: (line) => logged.push(line),
      transactions: async ({ sink }) => {
        await sink.begin({ generatedAt: GENERATED_AT, transactionCount: 0, rowCount: undefined });
        firstWritten();
        try {
          for (let i = 0; i < 10_000; i++) await sink.batch(Array(50).fill(big));
        } catch (error) {
          ended = error;
          throw error;
        }
      },
    });
    const controller = new AbortController();
    const res = await get(base, '/exports/transactions.csv', { signal: controller.signal });
    await written;
    controller.abort();
    await res.arrayBuffer().catch(() => undefined);
    for (let i = 0; i < 100 && ended === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect((ended as Error).name).toBe('ClientGoneError');
    expect(logged).toEqual([]);
  });
});

describe('GET /api/v1/property-references/{id}/export.json', () => {
  const doc = {
    generatedAt: new Date('2026-11-06T12:00:00.000Z'),
    mreRealmId: REALM,
    propertyReference: {
      id: PROPERTY,
      mreRealmId: REALM,
      mrePropertyId: '6b0000000000000000000001',
      externalReferenceState: 'ACTIVE',
      displayName: null,
      cachedAddress: null,
      cachedSurface: null,
      lastRefreshedAt: null,
      lastObservedAt: null,
      createdAt: new Date('2026-09-30T18:00:00.000Z'),
      version: 1,
    },
    ownerships: [],
    acquisitions: [],
    loans: [],
    wegMemberships: [],
    securityDeposits: [],
    securityDepositsNotAttributed: [{ securityDepositId: 'd-1', reason: 'SEVERAL_PROPERTY_REFERENCES' as const, candidates: [PROPERTY, 'q'] }],
    parties: [],
  };

  it('200 with the document, its headers and no ETag; the id lower-cased', async () => {
    const seen: string[] = [];
    const base = await start({ property: async ({ propertyReferenceId }) => (seen.push(propertyReferenceId), doc as never) });
    const res = await get(base, `/property-references/${PROPERTY.toUpperCase()}/export.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="objekt-${PROPERTY}-2026-11-06.json"`);
    expect(res.headers.get('x-export-format')).toBe('vermieter-cockpit.property-export; version=1');
    expect(res.headers.get('x-export-generated-at')).toBe('2026-11-06T12:00:00.000Z');
    expect(res.headers.get('etag')).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      'exportFormat',
      'exportFormatVersion',
      'generatedAt',
      'mreRealmId',
      'propertyReference',
      'ownerships',
      'acquisitions',
      'loans',
      'wegMemberships',
      'securityDeposits',
      'securityDepositsNotAttributed',
      'parties',
    ]);
    expect(body).toMatchObject({ exportFormat: 'vermieter-cockpit.property-export', exportFormatVersion: 1, generatedAt: '2026-11-06T12:00:00.000Z' });
    expect(seen).toEqual([PROPERTY]);
  });

  it('400 for a malformed id or any parameter (include=audit, asOf), 404 for an unknown one, 409 above the limit', async () => {
    const base = await start({
      property: async ({ propertyReferenceId }) => {
        if (propertyReferenceId === PROPERTY) throw new ExportTooLargeError(10_001, 10_000);
        throw new PropertyReferenceNotFoundError(propertyReferenceId);
      },
    });
    const fields = async (res: Response) => ((await res.json()) as { error: { details: { fields: unknown } } }).error.details.fields;
    expect(await fields(await get(base, '/property-references/x/export.json'))).toEqual([{ field: 'propertyReferenceId', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, `/property-references/${PROPERTY}/export.json?include=audit`))).toEqual([{ field: 'include', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, `/property-references/${PROPERTY}/export.json?asOf=2026-10-01`))).toEqual([{ field: 'asOf', code: 'INVALID_FORMAT' }]);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const missing = await get(base, `/property-references/${unknown}/export.json`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'PropertyReference not found.', details: { propertyReferenceId: unknown } } });
    const large = await get(base, `/property-references/${PROPERTY}/export.json`);
    expect(large.status).toBe(409);
    expect(((await large.json()) as { error: { details: unknown } }).error.details).toEqual({ reason: 'EXPORT_TOO_LARGE', total: 10_001, limit: 10_000 });
  });
});

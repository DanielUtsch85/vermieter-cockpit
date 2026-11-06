import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { parse } from 'csv-parse/sync';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  exportProperty,
  exportTransactions,
  getParty,
  getPropertyReference,
  getTransaction,
  listTransactions,
  readPropertyOwnerships,
} from './application/index.js';
import {
  PostgresOwnershipRepository,
  PostgresPartyRepository,
  PostgresPropertyExportSnapshots,
  PostgresPropertyReferenceRepository,
  PostgresTransactionExport,
  PostgresTransactionQueries,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { Money } from './shared/index.js';
import { mrePrincipalVerifier } from './wiring.js';
import { ACCOUNT_A, DEPOSIT, EXAMPLE_REALM, GENERATED_AT, OWNER, P, Q, T1, T2, T3, book, golden, seedExample } from './export-golden.test-support.js';

/**
 * VC-X-04 end to end (api-design.md §58S): the spec's synthetic example seeded with its fixed ids and times, both
 * routes wired as in main.ts against a fake MRE. The two CSV files are compared byte for byte with the golden files cut
 * from the spec (1,098 and 1,103 bytes), the property file with the spec's JSON document; Realm isolation, no MRE call,
 * no write. Synthetic data only.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM_B = '64b0c0ffee00000000058b0b';
const B_ACCOUNT = '0b1c2d3e-0000-4000-8000-0000000000b1';
const B_PROPERTY = '7e000000-0000-4000-8000-0000000000b0';
const EXAMPLE_FILTER = `financialAccountId=${ACCOUNT_A}&bookingDateFrom=2026-10-01&bookingDateTo=2026-10-31`;

describe.skipIf(databaseUrl === undefined)('the data export of the spec example end to end (VC-X-04, 58S)', () => {
  const schema = testSchemaName('export_golden_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    await seedExample(pool);
    // Realm B: an account with an October booking, a property and a Party; none of it may reach A's files.
    await pool.query(
      `INSERT INTO financial_account (id, mre_realm_id, account_type, display_name, currency, status, created_by) VALUES ($1, $2, 'BANK', 'Giro B', 'EUR', 'OPEN', 'seed')`,
      [B_ACCOUNT, REALM_B],
    );
    await pool.query(
      `INSERT INTO property_reference (id, mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, '6b00000000000000000000b0', 'ACTIVE', 'seed')`,
      [B_PROPERTY, REALM_B],
    );
    await book(pool, REALM_B, {
      id: '5d2c0f1e-0000-4000-8000-0000000000b1',
      account: B_ACCOUNT,
      bookingDate: '2026-10-02',
      valueDate: null,
      direction: 'INFLOW',
      amount: '99.00',
      provenance: 'MANUAL',
      description: 'Realm B',
      createdAt: '2026-10-02T10:00:00.000Z',
      splits: [],
    });

    const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
    mre = await startFakeMre([
      { _id: EXAMPLE_REALM, name: 'Beispiel', members: member, applications: [] },
      { _id: REALM_B, name: 'B', members: member, applications: [] },
    ]);
    const db = createDatabase(pool);
    const queries = new PostgresTransactionQueries(db);
    server = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 })),
      ...commandsWith({
        exports: {
          transactions: exportTransactions({ queries: new PostgresTransactionExport(db) }),
          property: exportProperty({ snapshots: new PostgresPropertyExportSnapshots(db, () => GENERATED_AT) }),
        },
        transactions: { get: getTransaction({ queries }), list: listTransactions({ queries }) },
        propertyReferences: { get: getPropertyReference({ repository: new PostgresPropertyReferenceRepository(db) }) },
        ownerships: { read: readPropertyOwnerships({ repository: new PostgresOwnershipRepository(db) }) },
        parties: { get: getParty({ repository: new PostgresPartyRepository(db) }) },
      }),
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.end();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 600);
  const get = (path: string, realm = EXAMPLE_REALM) => fetch(`${base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}`, organizationid: realm } });
  const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());
  const records = (csv: Buffer, delimiter = ',') => parse(csv, { delimiter, bom: delimiter === ';', relax_column_count: false, record_delimiter: '\r\n' });
  /** MRE calls other than the per-request token check (`GET /realms`). */
  const mreDataCalls = () => mre.requests.filter((r) => !r.path.startsWith('/api/v2/realms')).length;

  it('the default CSV of the example is the golden file byte for byte: 1098 bytes, no BOM, CRLF, no formula guard', async () => {
    const res = await get(`/exports/transactions.csv?${EXAMPLE_FILTER}`);
    expect(res.status).toBe(200);
    const body = await bytes(res);
    expect(golden('kassenbuch-rfc4180.csv').length).toBe(1098);
    expect(body.equals(golden('kassenbuch-rfc4180.csv'))).toBe(true);
    expect(body.subarray(0, 3).toString('latin1')).toBe('tra');
    expect(res.headers.get('x-export-transaction-count')).toBe('3');
    expect(res.headers.get('x-export-format')).toBe('vermieter-cockpit.transactions-csv; version=1; rows=transactions; dialect=rfc4180');
    expect(res.headers.get('x-export-realm')).toBe(EXAMPLE_REALM);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8; header=present');
    expect(res.headers.get('transfer-encoding')).toBe('chunked');
    expect(res.headers.get('etag')).toBeNull();
    const generatedAt = res.headers.get('x-export-generated-at') ?? '';
    expect(generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="kassenbuch-${generatedAt.slice(0, 10)}.csv"`);
    // `dialect=rfc4180` given explicitly is the same file.
    expect((await bytes(await get(`/exports/transactions.csv?${EXAMPLE_FILTER}&dialect=rfc4180`))).equals(body)).toBe(true);
  });

  it('the excel-de CSV of the example is the second golden file byte for byte: 1103 bytes, BOM once, semicolons, decimal comma, the guard', async () => {
    const res = await get(`/exports/transactions.csv?${EXAMPLE_FILTER}&dialect=excel-de`);
    expect(res.status).toBe(200);
    const body = await bytes(res);
    expect(golden('kassenbuch-excel-de.csv').length).toBe(1103);
    expect(body.equals(golden('kassenbuch-excel-de.csv'))).toBe(true);
    expect([...body.subarray(0, 6)]).toEqual([0xef, 0xbb, 0xbf, 0x74, 0x72, 0x61]);
    expect(res.headers.get('x-export-format')).toBe('vermieter-cockpit.transactions-csv; version=1; rows=transactions; dialect=excel-de');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8; header=present');
    expect(res.headers.get('x-export-transaction-count')).toBe('3');
    const day = (res.headers.get('x-export-generated-at') ?? '').slice(0, 10);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="kassenbuch-${day}-excel-de.csv"`);
  });

  it('parsed back, every field equals the DTO of GET /transactions/{id}; the header names and dates are the same in both dialects', async () => {
    const rfc = records(await bytes(await get(`/exports/transactions.csv?${EXAMPLE_FILTER}`)));
    const de = records(await bytes(await get(`/exports/transactions.csv?${EXAMPLE_FILTER}&dialect=excel-de`)), ';');
    const [header = [], ...rows] = rfc;
    expect(de[0]).toEqual(header);
    for (const [i, row] of rows.entries()) {
      const dto = (await (await get(`/transactions/${row[0]}`)).json()) as Record<string, unknown> & { amount: { amount: string; currency: string } };
      const value = (name: string) => row[header.indexOf(name)];
      for (const name of header) {
        if (['amount', 'signedAmount', 'currency', 'splitCount'].includes(name)) continue;
        expect(value(name), name).toBe(dto[name] === null ? '' : String(dto[name]));
      }
      expect(value('amount')).toBe(dto.amount.amount);
      expect(value('currency')).toBe(dto.amount.currency);
      expect(value('splitCount')).toBe(String((dto['splits'] as unknown[]).length));
      // excel-de: the guard stripped and the comma read as the decimal point give the same values.
      const deRow = de[i + 1] ?? [];
      header.forEach((name, c) => {
        const cell = deRow[c] ?? '';
        const unguarded = ['description', 'counterpartyNameRaw', 'counterpartyIbanRaw'].includes(name) && /^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell;
        expect(['amount', 'signedAmount'].includes(name) ? unguarded.replace(',', '.') : unguarded, name).toBe(row[c]);
      });
    }
  });

  it('rows=splits: four rows, the split columns as the example; the sums are exact and as the spec computes them', async () => {
    const res = await get(`/exports/transactions.csv?${EXAMPLE_FILTER}&rows=splits`);
    expect(res.headers.get('x-export-row-count')).toBe('4');
    expect(res.headers.get('x-export-transaction-count')).toBe('3');
    expect(res.headers.get('x-export-format')).toBe('vermieter-cockpit.transactions-csv; version=1; rows=splits; dialect=rfc4180');
    const text = (await bytes(res)).toString('utf8');
    const lines = text.split('\r\n');
    expect(lines[1]).toMatch(/,1,1000\.00,1000\.00,RENT_BASE,7e000000-0000-4000-8000-0000000000aa,,,,,$/);
    expect(lines[2]).toMatch(/,2,250\.00,250\.00,RENT_OPERATING_COST_ADVANCE,7e000000-0000-4000-8000-0000000000aa,,,,,$/);
    expect(lines[3]).toMatch(/,1,312\.40,-312\.40,WEG_NON_RECOVERABLE,7e000000-0000-4000-8000-0000000000aa,,,,,$/);
    // T3, unsplit: one row, the ten split columns empty.
    expect(lines[4]).toMatch(/^5d2c0f1e-0000-4000-8000-000000000103,.*,2026-10-08T07:30:00\.000Z,1,{10}$/);
    const [header = [], ...rows] = records(Buffer.from(text));
    expect(header).toHaveLength(33);
    const sum = (list: string[][], column: string) =>
      Money.sum(
        list.filter((r) => r[header.indexOf(column)] !== '').map((r) => Money.of(r[header.indexOf(column)] ?? '', 'EUR')),
        'EUR',
      ).amount;
    expect(sum(rows, 'signedSplitAmount')).toBe('937.60');
    const de = (await bytes(await get(`/exports/transactions.csv?${EXAMPLE_FILTER}&rows=splits&dialect=excel-de`))).toString('utf8').split('\r\n');
    expect(de[1]).toMatch(/;1;1000,00;1000,00;RENT_BASE;7e000000-0000-4000-8000-0000000000aa;;;;;$/);
    expect(de[3]).toMatch(/;1;312,40;-312,40;WEG_NON_RECOVERABLE;7e000000-0000-4000-8000-0000000000aa;;;;;$/);
  });

  it('the raw set sums to 987.60, current=true to 937.60, equal to the list API; page and another Realm account as filter', async () => {
    const signedSum = async (query: string) => {
      const [header = [], ...rows] = records(await bytes(await get(`/exports/transactions.csv?${query}`)));
      const signed = rows.map((r) => Money.of(r[header.indexOf('signedAmount')] ?? '', 'EUR'));
      return { ids: rows.map((r) => r[0]), sum: Money.sum(signed, 'EUR').amount };
    };
    expect(await signedSum(EXAMPLE_FILTER)).toEqual({ ids: [T1, T2, T3], sum: '987.60' });
    const current = await signedSum(`${EXAMPLE_FILTER}&current=true`);
    expect(current).toEqual({ ids: [T1, T2], sum: '937.60' });
    // §35.3's net effect from the list API for the same filter.
    const list = (await (await get(`/transactions?${EXAMPLE_FILTER}&current=true`)).json()) as { items: { direction: string; amount: { amount: string } }[] };
    const net = Money.sum(
      list.items.map((t) => (t.direction === 'OUTFLOW' ? Money.of(t.amount.amount, 'EUR').negate() : Money.of(t.amount.amount, 'EUR'))),
      'EUR',
    );
    expect(net.amount).toBe(current.sum);

    const paged = await get(`/exports/transactions.csv?${EXAMPLE_FILTER}&page=2`);
    expect(paged.status).toBe(400);
    expect(((await paged.json()) as { error: { details: unknown } }).error.details).toEqual({ fields: [{ field: 'page', code: 'INVALID_FORMAT' }] });
    const foreign = await get(`/exports/transactions.csv?financialAccountId=${B_ACCOUNT}`);
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get('x-export-transaction-count')).toBe('0');
    expect((await bytes(foreign)).toString('utf8')).toBe(golden('kassenbuch-rfc4180.csv').toString('utf8').split('\r\n')[0] + '\r\n');
  });

  it('the property file of the example is the spec document; every element is its single read; Q lists the same deposit', async () => {
    const res = await get(`/property-references/${P}/export.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-export-format')).toBe('vermieter-cockpit.property-export; version=1');
    expect(res.headers.get('x-export-generated-at')).toBe('2026-11-06T12:00:00.000Z');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="objekt-${P}-2026-11-06.json"`);
    expect(res.headers.get('etag')).toBeNull();
    const doc = (await res.json()) as Record<string, unknown>;
    const expected = JSON.parse(golden('objekt-example.json').toString('utf8')) as Record<string, unknown>;
    expect(doc).toStrictEqual(expected);
    // Keys in the order of the table and of each DTO (jsonb keeps `cachedAddress` in its own order, MRE's cached value).
    expect(Object.keys(doc)).toEqual(Object.keys(expected));
    for (const key of ['propertyReference', 'parties', 'ownerships'] as const) {
      const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) as Record<string, unknown>;
      expect(Object.keys(first(doc[key]))).toEqual(Object.keys(first(expected[key])));
    }
    // Every element deep-equal to the single-read route's body.
    expect(doc['propertyReference']).toEqual(await (await get(`/property-references/${P}`)).json());
    expect(doc['ownerships']).toEqual(((await (await get(`/property-references/${P}/ownerships`)).json()) as { items: unknown }).items);
    expect(doc['parties']).toEqual([await (await get(`/parties/${OWNER}`)).json()]);
    const q = (await (await get(`/property-references/${Q}/export.json`)).json()) as Record<string, unknown>;
    expect(q['securityDepositsNotAttributed']).toEqual([{ securityDepositId: DEPOSIT, reason: 'SEVERAL_PROPERTY_REFERENCES', candidates: [P, Q] }]);
    expect(q['securityDeposits']).toEqual([]);
  });

  it('the JSON route: a parameter is 400, a malformed id 400, an unknown or other-Realm id 404; include=audit 400 on both routes', async () => {
    const asOf = await get(`/property-references/${P}/export.json?asOf=2026-10-01`);
    expect(asOf.status).toBe(400);
    expect(((await asOf.json()) as { error: { details: unknown } }).error.details).toEqual({ fields: [{ field: 'asOf', code: 'INVALID_FORMAT' }] });
    expect((await get(`/property-references/not-a-uuid/export.json`)).status).toBe(400);
    for (const [id, realm] of [
      [P, REALM_B],
      [B_PROPERTY, EXAMPLE_REALM],
      ['7e000000-0000-4000-8000-0000000000ff', EXAMPLE_REALM],
    ] as const) {
      const res = await get(`/property-references/${id}/export.json`, realm);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'PropertyReference not found.', details: { propertyReferenceId: id } } });
    }
    expect((await get(`/property-references/${P}/export.json?include=audit`)).status).toBe(400);
    expect((await get(`/exports/transactions.csv?include=audit`)).status).toBe(400);
  });

  it('Realm isolation: no row of Realm B in A files, and none of A in B files', async () => {
    const all = (await bytes(await get('/exports/transactions.csv?rows=splits'))).toString('utf8');
    expect(all).not.toContain(B_ACCOUNT);
    expect(all).not.toContain('Realm B');
    expect(all.split('\r\n').filter((l) => l !== '')).toHaveLength(1 + 6);
    const b = (await bytes(await get('/exports/transactions.csv', REALM_B))).toString('utf8');
    expect(b).toContain(B_ACCOUNT);
    expect(b).not.toContain(ACCOUNT_A);
    expect(b.split('\r\n').filter((l) => l !== '')).toHaveLength(2);
    const doc = JSON.stringify(await (await get(`/property-references/${P}/export.json`)).json());
    expect(doc).not.toContain(REALM_B);
    expect(doc).not.toContain(B_PROPERTY);
  });

  it('both exports only read: no MRE call, no AuditRecord, every table row count and version sum unchanged', async () => {
    const { rows: tables } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [schema],
    );
    const state = async () => {
      const out: Record<string, string> = {};
      for (const { table_name } of tables) {
        const hasVersion = (
          await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'version'`, [
            schema,
            table_name,
          ])
        ).rowCount;
        const { rows } = await pool.query(`SELECT count(*)::text AS n${hasVersion ? ', coalesce(sum(version), 0)::text AS v' : ''} FROM "${table_name}"`);
        out[table_name] = `${rows[0].n}/${rows[0].v ?? '-'}`;
      }
      return out;
    };
    const before = await state();
    const calls = mreDataCalls();
    expect((await get(`/exports/transactions.csv?rows=splits&dialect=excel-de`)).status).toBe(200);
    expect((await get(`/property-references/${P}/export.json`)).status).toBe(200);
    expect(mreDataCalls()).toBe(calls);
    expect(await state()).toEqual(before);
  });
});

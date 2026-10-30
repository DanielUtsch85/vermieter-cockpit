import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import type { FinancialAccountId } from './domains/ledger/index.js';
import { commandsWith, unusedCommands } from './api/app.test-support.js';
import { getFinancialAccount, getPropertyReference, listFinancialAccounts, listPropertyReferences } from './application/index.js';
import { PostgresFinancialAccountRepository, PostgresPropertyReferenceRepository, createDatabase, migrateToLatest } from './infrastructure/postgres/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';

/**
 * VC-X-25 (issue #160) end to end: the PropertyReference and FinancialAccount reads of api-design.md §23.3 and §29.3,
 * wired as in main.ts against a fake MRE. Rows are seeded through the repositories; all data is synthetic.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000000a';
const REALM_B = '64b0c0ffee0000000000000b';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const actor = { actorType: 'USER' as const, actorId: 'anna@example.com' };

describe.skipIf(databaseUrl === undefined)('reads of PropertyReferences and FinancialAccounts end to end', () => {
  const schema = testSchemaName('reads_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let base: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });

    const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
    mre = await startFakeMre([
      { _id: REALM_A, name: 'A', members: member, applications: [] },
      { _id: REALM_B, name: 'B', members: member, applications: [] },
    ]);
    const db = createDatabase(pool);
    const references = new PostgresPropertyReferenceRepository(db);
    const accounts = new PostgresFinancialAccountRepository(db);

    // Mixed case on purpose: a byte-order sort would put "Beta" and "Gamma" before "alpha".
    const refreshedAt = new Date('2026-10-01T00:00:00Z');
    const properties: [string, string, string | null][] = [
      ['gamma', REALM_A, 'Gamma'],
      ['none', REALM_A, null],
      ['alpha', REALM_A, 'alpha'],
      ['beta', REALM_A, 'Beta'],
      ['other', REALM_B, 'Aaa other Realm'],
    ];
    for (const [key, realm, displayName] of properties) {
      const { reference } = await references.linkOnce(
        {
          mreRealmId: realm,
          mrePropertyId: `6512f0c2a1b2c3d4e5f6070${Object.keys(ids).length}`,
          displayName,
          cachedAddress: null,
          cachedSurface: null,
          refreshedAt,
        },
        actor,
      );
      ids[key] = reference.id;
    }
    await pool.query(`UPDATE property_reference SET external_reference_state = 'MISSING' WHERE id = $1`, [ids['beta']]);

    const newAccounts: [string, string, 'BANK' | 'SECURITY_DEPOSIT' | 'CASH', string][] = [
      ['giro', REALM_A, 'BANK', 'girokonto'],
      ['deposit', REALM_A, 'SECURITY_DEPOSIT', 'Kaution'],
      ['old', REALM_A, 'BANK', 'Altes Konto'],
      ['cash', REALM_A, 'CASH', 'bar'],
      ['foreign', REALM_B, 'BANK', 'Aaa other Realm'],
    ];
    for (const [key, realm, accountType, displayName] of newAccounts) {
      const outcome = await accounts.create({ mreRealmId: realm, accountType, displayName, currency: 'EUR', iban: null }, actor);
      if (outcome.kind !== 'CREATED') throw new Error('seed failed');
      ids[key] = outcome.account.id;
    }
    await accounts.close(ids['old'] as FinancialAccountId, REALM_A, new Date(), actor);

    server = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 })),
      ...commandsWith({
        propertyReferences: {
          ...unusedCommands.propertyReferences,
          get: getPropertyReference({ repository: references }),
          list: listPropertyReferences({ repository: references }),
        },
        financialAccounts: {
          ...unusedCommands.financialAccounts,
          get: getFinancialAccount({ repository: accounts }),
          list: listFinancialAccounts({ repository: accounts }),
        },
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

  const get = async (path: string, realm = REALM_A) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      headers: { authorization: `Bearer ${signJwt({ account: { email: 'anna@example.com' } })}`, organizationid: realm },
    });
    return { status: res.status, etag: res.headers.get('etag'), body: (await res.json()) as Record<string, unknown> & { items?: Record<string, unknown>[] } };
  };
  /** MRE calls other than the per-request token check (`GET /realms`). */
  const mreDataCalls = () => mre.requests.filter((r) => !r.path.startsWith('/api/v2/realms')).length;

  describe('GET /property-references (§23.3)', () => {
    it('lists the Realm only, case-insensitively by displayName with null last, over more than one page', async () => {
      const first = await get('/property-references?pageSize=2');
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ page: 1, pageSize: 2, total: 4 });
      const second = await get('/property-references?pageSize=2&page=2');
      expect(second.body).toMatchObject({ page: 2, pageSize: 2, total: 4 });
      expect([...(first.body.items ?? []), ...(second.body.items ?? [])].map((i) => i['propertyReferenceId'])).toEqual([
        ids['alpha'],
        ids['beta'],
        ids['gamma'],
        ids['none'],
      ]);
      expect((await get('/property-references?page=3&pageSize=2')).body).toMatchObject({ items: [], total: 4 });
    });

    it('filters by externalReferenceState, any of a comma-separated list', async () => {
      expect((await get('/property-references?externalReferenceState=MISSING')).body.items?.map((i) => i['propertyReferenceId'])).toEqual([ids['beta']]);
      expect((await get('/property-references?externalReferenceState=ACTIVE,MISSING')).body).toMatchObject({ total: 4 });
      expect((await get('/property-references?externalReferenceState=UNRESOLVED')).body).toMatchObject({ items: [], total: 0 });
    });

    it.each([
      ['a misspelled parameter', '?externalReferenceStates=ACTIVE'],
      ['an unknown state', '?externalReferenceState=GONE'],
      ['page 0', '?page=0'],
      ['pageSize 201', '?pageSize=201'],
    ])('%s → 400 VALIDATION_ERROR', async (_label, query) => {
      const { status, body } = await get(`/property-references${query}`);
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    });

    it('a single read answers the cached data with its version as ETag', async () => {
      const { status, etag, body } = await get(`/property-references/${ids['alpha']}`);
      expect(status).toBe(200);
      expect(etag).toBe('"1"');
      expect(body).toMatchObject({
        propertyReferenceId: ids['alpha'],
        mreRealmId: REALM_A,
        displayName: 'alpha',
        externalReferenceState: 'ACTIVE',
        version: 1,
      });
    });

    it("another Realm's id and an unknown id are 404; a malformed id is 400", async () => {
      expect((await get(`/property-references/${ids['other']}`)).status).toBe(404);
      expect((await get(`/property-references/${ids['alpha']}`, REALM_B)).status).toBe(404);
      expect((await get(`/property-references/${UNKNOWN_ID}`)).status).toBe(404);
      expect((await get('/property-references/not-a-uuid')).status).toBe(400);
    });

    it('neither read calls MRE beyond the token check', async () => {
      const before = mreDataCalls();
      await get('/property-references');
      await get(`/property-references/${ids['alpha']}`);
      expect(mreDataCalls()).toBe(before);
    });
  });

  describe('GET /financial-accounts (§29.3)', () => {
    it('lists the Realm only, case-insensitively by displayName, over more than one page', async () => {
      const first = await get('/financial-accounts?pageSize=3');
      expect(first.body).toMatchObject({ page: 1, pageSize: 3, total: 4 });
      const second = await get('/financial-accounts?pageSize=3&page=2');
      expect([...(first.body.items ?? []), ...(second.body.items ?? [])].map((i) => i['displayName'])).toEqual(['Altes Konto', 'bar', 'girokonto', 'Kaution']);
    });

    it('filters by status and accountType, combined with AND', async () => {
      const ofIds = async (query: string) => (await get(`/financial-accounts${query}`)).body.items?.map((i) => i['financialAccountId']);
      expect(await ofIds('?status=CLOSED')).toEqual([ids['old']]);
      expect(await ofIds('?accountType=BANK,CASH')).toEqual([ids['old'], ids['cash'], ids['giro']]);
      expect(await ofIds('?accountType=BANK&status=OPEN')).toEqual([ids['giro']]);
    });

    it.each([
      ['a misspelled parameter', '?statuss=CLOSED'],
      ['an unknown status', '?status=FROZEN'],
      ['an unknown accountType', '?accountType=BROKERAGE'],
      ['an empty list', '?status='],
    ])('%s → 400 VALIDATION_ERROR', async (_label, query) => {
      const { status, body } = await get(`/financial-accounts${query}`);
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    });

    it('a single read answers §29.2 with its version as ETag', async () => {
      const { status, etag, body } = await get(`/financial-accounts/${ids['old']}`);
      expect(status).toBe(200);
      expect(etag).toBe('"2"');
      expect(body).toMatchObject({ financialAccountId: ids['old'], accountType: 'BANK', status: 'CLOSED', currency: 'EUR', iban: null, version: 2 });
      expect(body['closedAt']).toEqual(expect.any(String));
    });

    it("another Realm's id and an unknown id are 404; a malformed id is 400", async () => {
      expect((await get(`/financial-accounts/${ids['foreign']}`)).status).toBe(404);
      expect((await get(`/financial-accounts/${ids['giro']}`, REALM_B)).status).toBe(404);
      expect((await get(`/financial-accounts/${UNKNOWN_ID}`)).status).toBe(404);
      expect((await get('/financial-accounts/not-a-uuid')).status).toBe(400);
    });

    it('the other Realm sees only its own account', async () => {
      expect((await get('/financial-accounts', REALM_B)).body.items?.map((i) => i['financialAccountId'])).toEqual([ids['foreign']]);
      expect((await get('/property-references', REALM_B)).body.items?.map((i) => i['propertyReferenceId'])).toEqual([ids['other']]);
    });
  });
});

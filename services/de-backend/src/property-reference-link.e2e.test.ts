import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { linkPropertyReference } from './application/index.js';
import {
  PostgresPropertyReferenceRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier, mrePropertyLookup } from './wiring.js';

/**
 * VC-1-01 end to end, wired as in main.ts: real HTTP app, MRE client and
 * PostgreSQL repository against a fake MRE that mirrors the pinned baseline.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000000a';
const REALM_B = '64b0c0ffee0000000000000b';
const PROPERTY_A = '6512f0c2a1b2c3d4e5f60718';
const PROPERTY_B = '6512f0c2a1b2c3d4e5f60719';

describe.skipIf(databaseUrl === undefined)('POST /api/v1/property-references/link end to end', () => {
  const schema = `link_e2e_${process.pid}_${Date.now()}`;
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

    mre = await startFakeMre([
      {
        _id: REALM_A,
        name: 'A',
        members: [{ name: 'Anna', email: 'anna@example.com', role: 'administrator', registered: true }],
        applications: [],
        properties: [{ _id: PROPERTY_A, name: 'Wohnung 1', price: 950, address: { city: 'Berlin' } }],
      },
      {
        _id: REALM_B,
        name: 'B',
        members: [{ name: 'Anna', email: 'anna@example.com', role: 'administrator', registered: true }],
        applications: [],
        properties: [{ _id: PROPERTY_B, name: 'Wohnung B' }],
      },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    server = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      linkPropertyReference: linkPropertyReference({
        repository: new PostgresPropertyReferenceRepository(createDatabase(pool)),
        lookupMreProperty: mrePropertyLookup(client),
      }),
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });

  const link = (realmHeader: string, body: unknown) =>
    fetch(`${base}/api/v1/property-references/link`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signJwt({ account: { email: 'anna@example.com' } })}`,
        organizationid: realmHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

  it('links once (201), then returns the same reference (200) without asking MRE again', async () => {
    const first = await link(REALM_A, { mreRealmId: REALM_A, mrePropertyId: PROPERTY_A });
    expect(first.status).toBe(201);
    const created = (await first.json()) as Record<string, unknown>;
    expect(created).toMatchObject({
      mreRealmId: REALM_A,
      mrePropertyId: PROPERTY_A,
      externalReferenceState: 'ACTIVE',
      displayName: 'Wohnung 1',
      cachedAddress: { city: 'Berlin' },
    });
    expect(JSON.stringify(created)).not.toContain('950'); // MRE price is never cached

    const propertyCalls = () => mre.requests.filter((r) => r.path === '/api/v2/properties').length;
    const before = propertyCalls();
    const repeat = await link(REALM_A, { mreRealmId: REALM_A, mrePropertyId: PROPERTY_A });
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as { id: string }).id).toBe(created['id']);
    expect(propertyCalls()).toBe(before);
    expect(await count('property_reference')).toBe(1);
    expect(await count('audit_record')).toBe(1);
  });

  it('a Property of another Realm is not found in this Realm (404), nothing written', async () => {
    const res = await link(REALM_A, { mreRealmId: REALM_A, mrePropertyId: PROPERTY_B });
    expect(res.status).toBe(404);
    expect(await count('property_reference')).toBe(1);
  });

  it('a body Realm other than the organizationid header → 403', async () => {
    const res = await link(REALM_A, { mreRealmId: REALM_B, mrePropertyId: PROPERTY_B });
    expect(res.status).toBe(403);
    expect(await count('property_reference')).toBe(1);
  });

  it('a malformed mrePropertyId → 400 without calling MRE /properties', async () => {
    const before = mre.requests.filter((r) => r.path === '/api/v2/properties').length;
    const res = await link(REALM_A, { mreRealmId: REALM_A, mrePropertyId: 'abc' });
    expect(res.status).toBe(400);
    expect(mre.requests.filter((r) => r.path === '/api/v2/properties').length).toBe(before);
  });
});
